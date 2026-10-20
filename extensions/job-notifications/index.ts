/** Sole owner of main-model Job Notifications for Async Bash and Agents. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { LOOP_DELIVERY_CHANGED, LOOP_DELIVERY_REQUEST, LOOP_FACTS_EVENT, LOOP_NOTICE_ACK, LOOP_NOTICE_TYPE, LOOP_SNAPSHOT_REQUEST, parseLoopFacts, type LoopDeliveryRequest, type LoopDeliverySnapshot, type LoopExecutionReference, type LoopFacts, type LoopNoticeAck, type LoopSnapshotRequest } from "../shared/loop-facts.ts";
import { registerSettlementBarrier, releaseModelWake, reserveModelWake } from "../shared/settlement.ts";
import { decideDelivery, noticeKey, type DeliveryDecision, type DeliveryView } from "./policy.ts";

const WAIT_COMMAND = "csheng-loop-notifications-wait";

export default function loopNotifications(pi: ExtensionAPI): void {
	const facts = new Map<string, LoopFacts>();
	const seen = new Set<string>();
	const consumed = new Set<string>();
	const suppressed = new Set<string>();
	let wakeStopped = false;
	let sendBlocked = false;
	let deliveryEpoch = 0;
	let scheduled: LoopExecutionReference[] = [];
	let context: ExtensionContext | undefined;
	const view = (): DeliveryView => ({ facts, seen, consumed, suppressed });
	const requestSnapshots = (): void => {
		pi.events.emit(LOOP_SNAPSHOT_REQUEST, { version: 1, accept: (reply: LoopFacts) => remember(reply) } satisfies LoopSnapshotRequest);
	};
	const remember = (reply: LoopFacts | undefined): void => {
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
		const notices = next.notices.filter(notice => tools.includes(notice.producer === "retained-shell" ? "bash" : "agent"));
		if (notices.length === next.notices.length) return next;
		if (notices.length === 0) return { kind: "none", text: "", notices: [] };
		return { kind: "notices", text: notices.map(notice => notice.summary.trim()).join("\n"), notices };
	};
	const reference = ({ producer, id, toolCallId, runId }: LoopExecutionReference): LoopExecutionReference => ({ producer, id, ...(toolCallId ? { toolCallId } : {}), ...(runId ? { runId } : {}) });
	const publishDelivery = (): void => {
		try { pi.events.emit(LOOP_DELIVERY_CHANGED, { version: 1, sessionId: context?.sessionManager.getSessionId() ?? null }); }
		catch { /* A passive timing/display observer cannot change delivery. */ }
	};
	pi.events.on(LOOP_DELIVERY_REQUEST, (raw) => {
		const request = raw as Partial<LoopDeliveryRequest> | undefined;
		if (request?.version !== 1 || typeof request.accept !== "function") return;
		// This is observation, NOT a no-new-result continuation policy. Results still
		// deliver while siblings run; any future autonomous continuation must separately
		// require the shared execution-quiescence boundary and explicit enablement.
		request.accept({ version: 1, sessionId: context?.sessionManager.getSessionId() ?? null,
			branchAnchor: context?.sessionManager.getLeafId() ?? null,
			pending: context ? allowed(decision()).notices.map(reference) : [],
			scheduled: scheduled.map(reference), blocked: !context || wakeStopped || sendBlocked,
		} satisfies LoopDeliverySnapshot);
	});
	const consume = (next: DeliveryDecision): void => {
		for (const notice of next.notices) consumed.add(noticeKey(notice.producer, notice.id));
		sendBlocked = false;
		scheduled = [];
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
	const send = (ctx: ExtensionContext): void => {
		if (wakeStopped || sendBlocked || ctx.signal?.aborted || barrier.aborted || !ctx.isIdle() || ctx.hasPendingMessages() || !ctx.isProjectTrusted() || !eligibleHost(ctx)) return;
		const next = allowed(decision());
		if (next.kind === "none") return;
		if (!reserveModelWake(pi, ctx)) return;
		scheduled = next.notices.map(reference);
		publishDelivery();
		const attemptEpoch = deliveryEpoch;
		const fail = (): void => {
			if (attemptEpoch !== deliveryEpoch) return;
			releaseModelWake(pi);
			sendBlocked = true;
			scheduled = [];
			publishDelivery();
			// A bounded diagnostic, not a retry or a result acknowledgment.
			try { pi.appendEntry("csheng.loop-notifications.delivery-error", { reason: "send-failed" }); } catch { /* notification failure must not stop execution */ }
		};
		try {
			void Promise.resolve(pi.sendMessage({ customType: LOOP_NOTICE_TYPE, content: next.text, display: false, details: { version: 1 } }, { triggerTurn: true })).catch(fail);
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
	pi.events.on(LOOP_FACTS_EVENT, (raw) => {
		remember(parseLoopFacts(raw));
		if (context) schedule(context);
		publishDelivery();
	});
	const reset = (): void => {
		deliveryEpoch += 1;
		facts.clear();
		seen.clear();
		consumed.clear();
		suppressed.clear();
		wakeStopped = false;
		sendBlocked = false;
		scheduled = [];
	};
	const bind = (ctx: ExtensionContext): void => {
		reset();
		context = ctx;
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
		if (event.message.role === "assistant" && (event.message.stopReason === "aborted" || event.message.stopReason === "error")) { wakeStopped = true; publishDelivery(); }
	});
	pi.on("agent_end", (event) => {
		if (event.messages.some(message => message.role === "assistant" && (message.stopReason === "aborted" || message.stopReason === "error"))) {
			wakeStopped = true;
			for (const notice of pendingKeys()) suppressed.add(notice);
			publishDelivery();
		}
	});
	pi.on("agent_settled", (_event, ctx) => {
		context = ctx;
		if (!wakeStopped && !ctx.signal?.aborted && !barrier.aborted) schedule(ctx);
		publishDelivery();
	});
	pi.on("context_with_system", (event, ctx) => {
		const messages = event.messages.filter(message => !(message.role === "custom" && message.customType === LOOP_NOTICE_TYPE));
		if (ctx.signal?.aborted || !ctx.isProjectTrusted() || wakeStopped || !eligibleHost(ctx)) return { messages };
		const next = allowed(decision());
		if (next.kind === "notices") {
			messages.push({ role: "custom", customType: LOOP_NOTICE_TYPE, content: next.text, display: false, timestamp: Date.now() });
			consume(next);
			const ids = next.notices.filter((notice) => notice.producer === "retained-shell").map((notice) => notice.id);
			if (ids.length > 0) {
				try { pi.events.emit(LOOP_NOTICE_ACK, { version: 1, producer: "retained-shell", ids } satisfies LoopNoticeAck); } catch { /* Ack failure leaves the notice pending for a later projection. */ }
			}
		} else if (scheduled.length > 0) {
			// A source can become observed/suppressed after reserving the carrier wake.
			// Its projection still resolves that handoff even when no notice remains.
			scheduled = [];
			publishDelivery();
		}
		return { messages };
	});
	pi.on("session_shutdown", () => { reset(); context = undefined; publishDelivery(); });

	function pendingKeys(): string[] {
		return decideDelivery(view()).notices.map(notice => noticeKey(notice.producer, notice.id));
	}
}
