/** Sole owner of main-model notification delivery for workflow, retained shell, and subagents. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { LOOP_FACTS_EVENT, LOOP_NOTICE_ACK, LOOP_NOTICE_TYPE, LOOP_SNAPSHOT_REQUEST, parseLoopFacts, type LoopFacts, type LoopNoticeAck, type LoopSnapshotRequest } from "../shared/loop-facts.ts";
import { modelWakeReserved, registerSettlementBarrier, releaseModelWake, reserveModelWake } from "../shared/settlement.ts";
import { decideDelivery, noticeKey, type DeliveryDecision, type DeliveryView } from "./policy.ts";

const WAIT_COMMAND = "csheng-loop-notifications-wait";

export default function loopNotifications(pi: ExtensionAPI): void {
	const facts = new Map<string, LoopFacts>();
	const seen = new Set<string>();
	const consumed = new Set<string>();
	const suppressed = new Set<string>();
	let remindedSignature: string | null = null;
	let wakeStopped = false;
	let sendBlocked = false;
	let deliveryEpoch = 0;
	let context: ExtensionContext | undefined;
	const view = (): DeliveryView => ({ facts, seen, consumed, suppressed, remindedSignature });
	const requestSnapshots = (): void => {
		pi.events.emit(LOOP_SNAPSHOT_REQUEST, { version: 1, accept: (reply: LoopFacts) => remember(reply) } satisfies LoopSnapshotRequest);
	};
	const remember = (reply: LoopFacts | undefined): void => {
		if (!reply) return;
		facts.set(reply.producer, reply);
		seen.add(reply.producer);
	};
	const decision = (reason: "project" | "settle"): DeliveryDecision => {
		requestSnapshots();
		return decideDelivery(view(), reason);
	};
	const allowed = (next: DeliveryDecision): DeliveryDecision => {
		if (next.kind !== "notices") return next;
		const tools = pi.getActiveTools();
		const notices = next.notices.filter(notice => tools.includes(notice.producer === "retained-shell" ? "bash" : "csheng_subagent_sessions"));
		if (notices.length === next.notices.length) return next;
		if (notices.length === 0) return { kind: "none", text: "", notices: [], reminderSignature: null };
		return { kind: "notices", text: notices.map(notice => notice.summary.trim()).join("\n"), notices, reminderSignature: null };
	};
	const consume = (next: DeliveryDecision): void => {
		for (const notice of next.notices) consumed.add(noticeKey(notice.producer, notice.id));
		if (next.reminderSignature) remindedSignature = next.reminderSignature;
		sendBlocked = false;
	};
	const eligibleHost = (ctx: ExtensionContext): boolean => ctx.mode === "tui" || ctx.mode === "rpc";
	const barrier = registerSettlementBarrier(pi, {
		command: WAIT_COMMAND,
		compaction: true,
		enabled: () => {
			if (!context || wakeStopped || !eligibleHost(context)) return false;
			return allowed(decision("settle")).kind !== "none";
		},
	});
	const send = (ctx: ExtensionContext): void => {
		if (wakeStopped || sendBlocked || ctx.signal?.aborted || barrier.aborted || !ctx.isIdle() || ctx.hasPendingMessages() || !ctx.isProjectTrusted() || !eligibleHost(ctx)) return;
		const next = allowed(decision("settle"));
		if (next.kind === "none") return;
		if (next.kind === "reminder" && !pi.getActiveTools().includes("csheng_workflow")) return;
		if (!reserveModelWake(pi, ctx)) return;
		const attemptEpoch = deliveryEpoch;
		const fail = (): void => {
			if (attemptEpoch !== deliveryEpoch) return;
			releaseModelWake(pi);
			sendBlocked = true;
			// A bounded diagnostic, not a retry or a result acknowledgment.
			try { pi.appendEntry("csheng.loop-notifications.delivery-error", { reason: "send-failed" }); } catch { /* notification failure must not stop execution */ }
		};
		try {
			if (next.kind === "reminder") {
				pi.sendUserMessage(next.text, { deliverAs: "followUp" });
				remindedSignature = next.reminderSignature;
			} else {
				void Promise.resolve(pi.sendMessage({ customType: LOOP_NOTICE_TYPE, content: next.text, display: false, details: { version: 1 } }, { triggerTurn: true })).catch(fail);
			}
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
	});
	const reset = (): void => {
		deliveryEpoch += 1;
		facts.clear();
		seen.clear();
		consumed.clear();
		suppressed.clear();
		remindedSignature = null;
		wakeStopped = false;
		sendBlocked = false;
	};
	const bind = (ctx: ExtensionContext): void => {
		reset();
		context = ctx;
		requestSnapshots();
	};
	pi.on("session_start", (_event, ctx) => bind(ctx));
	pi.on("session_tree", (_event, ctx) => bind(ctx));
	pi.on("agent_start", (_event, ctx) => {
		deliveryEpoch += 1;
		sendBlocked = false;
		wakeStopped = false;
		context = ctx;
		schedule(ctx);
	});
	pi.on("input", (event) => {
		if (event.source !== "interactive" && event.source !== "rpc") return;
		deliveryEpoch += 1;
		wakeStopped = false;
		sendBlocked = false;
		remindedSignature = null;
		for (const notice of pendingKeys()) suppressed.add(notice);
	});
	pi.on("message_end", (event) => {
		if (event.message.role === "assistant" && (event.message.stopReason === "aborted" || event.message.stopReason === "error")) wakeStopped = true;
	});
	pi.on("agent_end", (event) => {
		if (event.messages.some(message => message.role === "assistant" && (message.stopReason === "aborted" || message.stopReason === "error"))) {
			wakeStopped = true;
			for (const notice of pendingKeys()) suppressed.add(notice);
		}
	});
	pi.on("agent_settled", (_event, ctx) => {
		context = ctx;
		if (wakeStopped || ctx.signal?.aborted || barrier.aborted) return;
		schedule(ctx);
	});
	pi.on("context_with_system", (event, ctx) => {
		const messages = event.messages.filter(message => !(message.role === "custom" && message.customType === LOOP_NOTICE_TYPE));
		if (ctx.signal?.aborted || !ctx.isProjectTrusted() || wakeStopped || !eligibleHost(ctx)) return { messages };
		const next = allowed(decision("project"));
		if (next.kind === "notices") {
			messages.push({ role: "custom", customType: LOOP_NOTICE_TYPE, content: next.text, display: false, timestamp: Date.now() });
			consume(next);
			const ids = next.notices.filter((notice) => notice.producer === "retained-shell").map((notice) => notice.id);
			if (ids.length > 0) {
				try { pi.events.emit(LOOP_NOTICE_ACK, { version: 1, producer: "retained-shell", ids } satisfies LoopNoticeAck); } catch { /* Ack failure leaves the notice pending for a later projection. */ }
			}
		} else if (modelWakeReserved(pi, ctx)) {
			const reminder = allowed(decision("settle"));
			if (reminder.kind === "reminder") consume(reminder);
		}
		return { messages };
	});
	pi.on("session_shutdown", () => { reset(); context = undefined; });

	function pendingKeys(): string[] {
		return decideDelivery(view(), "project").notices.map(notice => noticeKey(notice.producer, notice.id));
	}
}
