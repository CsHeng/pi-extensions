/** Sole owner of main-model Notices for Async Bash and Agents. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { NOTICE_DELIVERY_CHANGED, NOTICE_DELIVERY_REQUEST, EXECUTION_FACTS_EVENT, NOTICE_ACK, NOTICE_TYPE, EXECUTION_FACTS_REQUEST, parseProducerFacts, type NoticeDeliveryRequest, type NoticeDeliverySnapshot, type ExecutionRef, type ProducerFacts, type NoticeAck, type ProducerFactsRequest } from "../shared/execution-facts.ts";
import { registerSettlementBarrier, releaseModelWake, reserveModelWake } from "../shared/settlement.ts";
import { decideDelivery, noticeKey, type DeliveryDecision, type DeliveryView } from "./policy.ts";

const WAIT_COMMAND = "notices-wait";

interface NoticeDetails { version: 2; sessionId: string; notices: ExecutionRef[] }
function noticeReferences(message: { customType?: string; details?: unknown }, sessionId: string): ExecutionRef[] {
	if (message.customType !== NOTICE_TYPE || !message.details || typeof message.details !== "object") return [];
	const details = message.details as Partial<NoticeDetails>;
	if (details.version !== 2 || details.sessionId !== sessionId || !Array.isArray(details.notices)) return [];
	return details.notices.filter((notice): notice is ExecutionRef => !!notice &&
		(notice.producer === "async-bash" || notice.producer === "agents") && typeof notice.id === "string");
}

export default function noticesExtension(pi: ExtensionAPI): void {
	const facts = new Map<string, ProducerFacts>();
	const seen = new Set<string>();
	const consumed = new Set<string>();
	// Native history prevents duplicate sends; only request preparation acknowledges delivery.
	const admitted = new Set<string>();
	const suppressed = new Set<string>();
	let wakeStopped = false;
	let sendBlocked = false;
	let deliveryEpoch = 0;
	let scheduled: ExecutionRef[] = [];
	let context: ExtensionContext | undefined;
	const view = (): DeliveryView => ({ facts, seen, consumed, suppressed });
	const requestSnapshots = (): void => {
		pi.events.emit(EXECUTION_FACTS_REQUEST, { version: 1, accept: (reply: ProducerFacts) => remember(reply) } satisfies ProducerFactsRequest);
	};
	const remember = (reply: ProducerFacts | undefined): void => {
		if (!reply) return;
		facts.set(reply.producer, reply);
		seen.add(reply.producer);
	};
	const decision = (): DeliveryDecision => {
		requestSnapshots();
		return decideDelivery(view());
	};
	const allowed = (next: DeliveryDecision): DeliveryDecision => {
		if (next.kind !== "notices") return next;
		const tools = pi.getActiveTools();
		const reserved = new Set(scheduled.map(notice => noticeKey(notice.producer, notice.id)));
		const notices = next.notices.filter(notice => !admitted.has(noticeKey(notice.producer, notice.id)) && !reserved.has(noticeKey(notice.producer, notice.id)) && tools.includes(notice.producer === "async-bash" ? "bash" : "agent"));
		if (notices.length === next.notices.length) return next;
		if (notices.length === 0) return { kind: "none", text: "", notices: [] };
		return { kind: "notices", text: notices.map(notice => notice.summary.trim()).join("\n"), notices };
	};
	const reference = ({ producer, id, toolCallId, runId }: ExecutionRef): ExecutionRef => ({ producer, id, ...(toolCallId ? { toolCallId } : {}), ...(runId ? { runId } : {}) });
	const publishDelivery = (): void => {
		try { pi.events.emit(NOTICE_DELIVERY_CHANGED, { version: 1, sessionId: context?.sessionManager.getSessionId() ?? null }); }
		catch { /* A passive timing/display observer cannot change delivery. */ }
	};
	pi.events.on(NOTICE_DELIVERY_REQUEST, (raw) => {
		const request = raw as Partial<NoticeDeliveryRequest> | undefined;
		if (request?.version !== 1 || typeof request.accept !== "function") return;
		// This is observation, NOT a no-new-result continuation policy. Results still
		// deliver while siblings run; any future autonomous continuation must separately
		// require the shared execution-quiescence boundary and explicit enablement.
		request.accept({ version: 1, sessionId: context?.sessionManager.getSessionId() ?? null,
			branchAnchor: context?.sessionManager.getLeafId() ?? null,
			pending: context ? allowed(decision()).notices.map(reference) : [],
			scheduled: scheduled.map(reference), blocked: !context || wakeStopped || sendBlocked,
		} satisfies NoticeDeliverySnapshot);
	});
	const consume = (notices: ExecutionRef[]): void => {
		for (const notice of notices) consumed.add(noticeKey(notice.producer, notice.id));
		sendBlocked = false;
		scheduled = scheduled.filter(notice => !consumed.has(noticeKey(notice.producer, notice.id)));
		publishDelivery();
	};
	const eligibleHost = (ctx: ExtensionContext): boolean => ctx.mode === "tui" || ctx.mode === "rpc";
	const barrier = registerSettlementBarrier(pi, {
		command: WAIT_COMMAND,
		compaction: true,
		enabled: () => {
			if (!context || wakeStopped || !eligibleHost(context)) return false;
			return allowed(decision()).kind !== "none";
		},
	});
	const noticeMessage = (next: DeliveryDecision, ctx: ExtensionContext) => ({
		customType: NOTICE_TYPE, content: next.text, display: false,
		details: { version: 2, sessionId: ctx.sessionManager.getSessionId(), notices: next.notices.map(reference) } satisfies NoticeDetails,
	});
	const restoreAdmissions = (ctx: ExtensionContext): void => {
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom_message") continue;
			for (const notice of noticeReferences(entry, ctx.sessionManager.getSessionId())) admitted.add(noticeKey(notice.producer, notice.id));
		}
	};
	const send = (ctx: ExtensionContext): void => {
		if (wakeStopped || sendBlocked || ctx.signal?.aborted || barrier.aborted || !ctx.isIdle() || ctx.hasPendingMessages() || !ctx.isProjectTrusted() || !eligibleHost(ctx)) return;
		const next = allowed(decision());
		if (next.kind === "none") return;
		if (!reserveModelWake(pi, ctx)) return;
		const references = next.notices.map(reference);
		scheduled.push(...references);
		publishDelivery();
		const attemptEpoch = deliveryEpoch;
		const fail = (): void => {
			if (attemptEpoch !== deliveryEpoch || references.every(notice => consumed.has(noticeKey(notice.producer, notice.id)))) return;
			releaseModelWake(pi);
			sendBlocked = true;
			scheduled = scheduled.filter(notice => !references.some(sent => noticeKey(sent.producer, sent.id) === noticeKey(notice.producer, notice.id)));
			publishDelivery();
			// A bounded diagnostic, not a retry or a result acknowledgment.
			try { pi.appendEntry("notices.delivery-error", { reason: "send-failed" }); } catch { /* notice failure must not stop execution */ }
		};
		try {
			// Idle handoff only. Busy results use a native boundary draft, never a steering queue
			// whose admission could be delayed behind other custom messages.
			void Promise.resolve(pi.sendMessage(noticeMessage(next, ctx), { triggerTurn: true })).catch(fail);
		} catch { fail(); }
	};
	const schedule = (ctx: ExtensionContext): void => {
		context = ctx;
		if (!eligibleHost(ctx) || wakeStopped) return;
		barrier.arm();
		if (barrier.waiting) {
			barrier.schedule(idle => send(idle));
			return;
		}
		if (ctx.isIdle()) send(ctx);
	};
	pi.events.on(EXECUTION_FACTS_EVENT, (raw) => {
		remember(parseProducerFacts(raw));
		if (context) schedule(context);
		publishDelivery();
	});
	const reset = (): void => {
		deliveryEpoch += 1;
		facts.clear();
		seen.clear();
		consumed.clear();
		admitted.clear();
		suppressed.clear();
		wakeStopped = false;
		sendBlocked = false;
		scheduled = [];
	};
	const bind = (ctx: ExtensionContext): void => {
		reset();
		context = ctx;
		// Resume/tree restore only deduplication, never a new wake or a delivery acknowledgment.
		restoreAdmissions(ctx);
		requestSnapshots();
		publishDelivery();
	};
	pi.on("session_start", (_event, ctx) => bind(ctx));
	pi.on("session_tree", (_event, ctx) => bind(ctx));
	pi.on("agent_start", (_event, ctx) => {
		deliveryEpoch += 1;
		sendBlocked = false;
		wakeStopped = false;
		context = ctx;
		schedule(ctx);
		publishDelivery();
	});
	pi.on("input", (event) => {
		if (event.source !== "interactive" && event.source !== "rpc") return;
		deliveryEpoch += 1;
		wakeStopped = false;
		sendBlocked = false;
		for (const notice of pendingKeys()) suppressed.add(notice);
		scheduled = [];
		publishDelivery();
	});
	pi.on("message_end", (event) => {
		// Only a user abort stops result delivery. A provider error ends the request, not the
		// user's interest in results: Pi's retry or the idle settlement still delivers them.
		if (event.message.role === "assistant" && event.message.stopReason === "aborted") { wakeStopped = true; publishDelivery(); }
	});
	pi.on("agent_end", (event) => {
		if (event.messages.some(message => message.role === "assistant" && message.stopReason === "aborted")) {
			wakeStopped = true;
			for (const notice of pendingKeys()) suppressed.add(notice);
			publishDelivery();
		}
	});
	pi.on("session_compact", (_event, ctx) => {
		// A legitimate compaction can summarize a just-appended notice before its first request.
		restoreAdmissions(ctx);
		scheduled = [];
		publishDelivery();
	});
	pi.on("agent_settled", (event, ctx) => {
		context = ctx;
		if (scheduled.length > 0) restoreAdmissions(ctx);
		if (event.aborted) {
			wakeStopped = true;
			for (const notice of pendingKeys()) suppressed.add(notice);
			scheduled = [];
		}
		if (!wakeStopped && !ctx.signal?.aborted && !barrier.aborted) schedule(ctx);
		publishDelivery();
	});
	pi.on("turn_end", (event, ctx) => {
		// Revalidate after all foreground tools. The public boundary includes custom queues,
		// unlike hasPendingMessages(); let earlier queued work observe results before deciding.
		if (event.outcome !== "completed" || ctx.signal?.aborted || wakeStopped || sendBlocked || !ctx.isProjectTrusted() || !eligibleHost(ctx)
			|| ctx.hasPendingMessages() || event.context.pendingMessages.length > 0) return;
		const next = allowed(decision());
		if (next.kind === "none") return;
		scheduled.push(...next.notices.map(reference));
		publishDelivery();
		// Pi commits the draft after tool results and owns continuation/abort. Once committed,
		// this historical fact stays in place even if that request is aborted or retried.
		return { entries: [...event.entries, { type: "custom_message", ...noticeMessage(next, ctx) }], continue: true };
	});
	pi.on("context_with_system", (event, ctx) => {
		if (ctx.signal?.aborted || !ctx.isProjectTrusted() || wakeStopped || !eligibleHost(ctx)) return;
		const notices = event.messages.flatMap(message => message.role === "custom"
			? noticeReferences(message, ctx.sessionManager.getSessionId()) : [])
			.filter(notice => !consumed.has(noticeKey(notice.producer, notice.id)));
		if (notices.length === 0) return;
		for (const notice of notices) admitted.add(noticeKey(notice.producer, notice.id));
		consume(notices);
		for (const producer of ["async-bash", "agents"] as const) {
			const ids = notices.filter(notice => notice.producer === producer).map(notice => notice.id);
			if (ids.length === 0) continue;
			try { pi.events.emit(NOTICE_ACK, { version: 1, producer, ids } satisfies NoticeAck); } catch { /* Source evidence remains inspectable if acknowledgment fails. */ }
		}
		// Observation only: queued != prepared, and prepared != successful provider processing.
	});
	pi.on("session_shutdown", () => { reset(); context = undefined; publishDelivery(); });

	function pendingKeys(): string[] {
		return decideDelivery(view()).notices.map(notice => noticeKey(notice.producer, notice.id));
	}
}
