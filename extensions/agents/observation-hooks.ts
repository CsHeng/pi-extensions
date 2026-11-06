import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CHILD_CAPABILITY_FAILURE_EVENT, HARD_LIMITS, type RunTelemetry } from "./contracts.ts";
import { boundNativeObservation, collectNativeObservation, unavailableObservation, type NativeObservation } from "./observability.ts";
import { MANAGED_LIMITS, SUBAGENT_SESSION_TOOL_NAME } from "./session-contracts.ts";
import { LocalTimingRecorder, monotonicNow, type LocalTiming } from "./telemetry.ts";

/** Native audit is optional; inability to record must never permit a rejected tool. */
export function recordCapabilityInvalidation(pi: Pick<ExtensionAPI, "appendEntry">): void {
	try { pi.appendEntry(CHILD_CAPABILITY_FAILURE_EVENT, { version: 1, code: "capability_invalidated" }); } catch { /* Preserve fail-closed enforcement. */ }
}

const MAX_CUSTOM_BYTES = 64 * 1024;
const DELEGATION_TOOLS = new Set([SUBAGENT_SESSION_TOOL_NAME]);
export interface ObservedRun { telemetry: RunTelemetry; clockKey: string; originMs: number | null }
export interface ParentObservation {
	version: 1;
	native: NativeObservation;
	/** Physical append range, not the active tree branch or copied fork prefix. */
	range: { startLeaf: string | null; endLeaf: string | null } | null;
	timing: LocalTiming;
	runs: ObservedRun[];
}
interface MainRun { recorder: LocalTimingRecorder; startLeaf: string | null | undefined; relevant: boolean; assistant: number | undefined; sequence: number; runs: ObservedRun[]; endedThinking: Set<number>; delegationCalls: Set<string>; usedTools: Set<string>; failures: Array<{ reason: "manual" | "threshold" | "overflow"; aborted: boolean }>; usageComplete: boolean }

/** Diagnostic event consumer only: no loop, task decisions, tool/profile changes or UI. */
export function registerObservationHooks(pi: ExtensionAPI, options: { child?: boolean; capabilityKey?: string | null; now?: () => number } = {}): { recordRun(run: ObservedRun): void } {
	let mainRun: MainRun | undefined;
	const observe = (action: () => void) => { try { action(); } catch { mainRun?.recorder.invalidate(); } };
	const append = (type: string, data: unknown) => {
		try {
			if (Buffer.byteLength(JSON.stringify(data), "utf8") > MAX_CUSTOM_BYTES) return false;
			pi.appendEntry(type, data); return true;
		} catch { return false; /* Optional evidence must not break execution. */ }
	};
	const begin = (ctx: ExtensionContext) => {
		mainRun ??= { recorder: new LocalTimingRecorder(options.now ?? monotonicNow), startLeaf: physicalLast(ctx), relevant: false, assistant: undefined, sequence: 0, runs: [], endedThinking: new Set(), delegationCalls: new Set(), usedTools: new Set(), failures: [], usageComplete: true };
		return mainRun;
	};
	const settle = (ctx: ExtensionContext, shutdown = false) => {
		const current = mainRun; mainRun = undefined;
		if (!current) return;
		if (shutdown) current.recorder.invalidate();
		const timing = current.recorder.finish();
		if (options.child) { if (current.usageComplete) append("csheng-episode-timing", timing); return; }
		if (!current.relevant || !pi.getActiveTools().some((name) => current.usedTools.has(name))) return;
		for (const failure of current.failures) current.usageComplete = append("csheng-compaction-unavailable", failure) && current.usageComplete;
		const endLeaf = physicalLast(ctx);
		const range = current.startLeaf === undefined || endLeaf === undefined ? null : { startLeaf: current.startLeaf, endLeaf };
		append("csheng-parent-observation", { version: 1, native: current.usageComplete ? ownNative(ctx, range) : unavailableObservation(), range, timing, runs: current.runs } satisfies ParentObservation);
	};
	pi.on("before_agent_start", (_event, ctx) => observe(() => {
		begin(ctx);
		if (options.child) append("csheng-episode-observation", {
			contextWindow: ctx.model?.contextWindow ?? null,
			// Configured host tools, not a claim about later provider payload handlers.
			toolNames: pi.getActiveTools(), capabilityKey: options.capabilityKey ?? null,
		});
	}));
	pi.on("message_start", (event) => observe(() => {
		if (!mainRun || event.message.role !== "assistant") return;
		if (mainRun.assistant !== undefined) { mainRun.recorder.invalidate(); return; }
		mainRun.assistant = ++mainRun.sequence; mainRun.endedThinking.clear();
		mainRun.recorder.start("assistant", String(mainRun.assistant));
	}));
	pi.on("message_update", (event) => observe(() => {
		if (!mainRun) return;
		const update = event.assistantMessageEvent;
		if (update.type !== "thinking_start" && update.type !== "thinking_end" && update.type !== "thinking_delta") return;
		if (mainRun.assistant === undefined || !Number.isSafeInteger(update.contentIndex) || update.contentIndex < 0) { mainRun.recorder.invalidate(); return; }
		const key = `${mainRun.assistant}:${update.contentIndex}`;
		if (update.type === "thinking_start") mainRun.recorder.start("reasoning", key);
		else if (update.type === "thinking_end") {
			mainRun.recorder.end("reasoning", key);
			if (mainRun.endedThinking.size < HARD_LIMITS.maxWaitSpans) mainRun.endedThinking.add(update.contentIndex);
			else mainRun.recorder.invalidate();
		}
		else if (!mainRun.recorder.hasOpen("reasoning", key)) mainRun.recorder.invalidate();
	}));
	pi.on("message_end", (event) => observe(() => {
		if (!mainRun || event.message.role !== "assistant") return;
		if (mainRun.assistant === undefined) { mainRun.recorder.invalidate(); return; }
		if (!Array.isArray(event.message.content) || event.message.content.length > HARD_LIMITS.maxWaitSpans) mainRun.recorder.invalidate();
		else for (const [index, part] of event.message.content.entries()) {
			if (part.type === "thinking" && !mainRun.endedThinking.has(index)) mainRun.recorder.invalidate();
		}
		mainRun.recorder.end("assistant", String(mainRun.assistant)); mainRun.assistant = undefined;
	}));
	pi.on("tool_execution_start", (event) => observe(() => {
		if (!mainRun) return;
		const delegation = DELEGATION_TOOLS.has(event.toolName) && pi.getActiveTools().includes(event.toolName);
		if (delegation) {
			mainRun.relevant = true; mainRun.usedTools.add(event.toolName);
			if (mainRun.delegationCalls.size >= HARD_LIMITS.maxWaitSpans) { mainRun.recorder.invalidate(); return; }
			mainRun.delegationCalls.add(`${event.toolName}:${event.toolCallId}`);
		}
		mainRun.recorder.start(delegation ? "delegationWait" : "localTool", event.toolCallId);
	}));
	pi.on("tool_execution_end", (event) => observe(() => {
		if (!mainRun) return;
		const delegation = mainRun.delegationCalls.delete(`${event.toolName}:${event.toolCallId}`);
		mainRun.recorder.end(delegation ? "delegationWait" : "localTool", event.toolCallId);
	}));
	pi.on("session_before_compact", (_event, ctx) => observe(() => { begin(ctx).recorder.start("compaction", "compact"); }));
	pi.on("session_compact", () => observe(() => { mainRun?.recorder.end("compaction", "compact"); }));
	pi.on("session_compact_failed", (event) => observe(() => {
		mainRun?.recorder.end("compaction", "compact");
		const failure = { reason: event.reason, aborted: event.aborted };
		if (options.child) {
			if (!append("csheng-compaction-unavailable", failure) && mainRun) mainRun.usageComplete = false;
		} else if (mainRun) {
			if (mainRun.failures.length >= HARD_LIMITS.maxWaitSpans) { mainRun.usageComplete = false; mainRun.recorder.invalidate(); }
			else mainRun.failures.push(failure);
		}
	}));
	pi.on("agent_settled", (_event, ctx) => observe(() => { settle(ctx); }));
	pi.on("session_shutdown", (_event, ctx) => observe(() => { settle(ctx, true); }));
	return { recordRun(run) {
		if (!mainRun) return;
		try {
			if (mainRun.runs.length >= 32 || Buffer.byteLength(JSON.stringify(run)) > MAX_CUSTOM_BYTES) { mainRun.recorder.invalidate(); return; }
			mainRun.runs.push(structuredClone(run));
		} catch { mainRun.recorder.invalidate(); }
	} };
}
function physicalLast(ctx: ExtensionContext): string | null | undefined {
	try {
		const entries = ctx.sessionManager.getEntries();
		if (entries.length > MANAGED_LIMITS.maxEntries) return undefined;
		if (!entries.length) return null;
		const id = entries.at(-1)?.id;
		return typeof id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id) ? id : undefined;
	} catch { return undefined; }
}
function ownNative(ctx: ExtensionContext, range: ParentObservation["range"]): NativeObservation {
	if (!range) return unavailableObservation();
	try {
		const header = ctx.sessionManager.getHeader(); const entries = ctx.sessionManager.getEntries();
		if (!header || entries.length > MANAGED_LIMITS.maxEntries) return unavailableObservation();
		const lines: string[] = []; let bytes = 0;
		for (const entry of [header, ...entries]) {
			const line = JSON.stringify(entry); bytes += Buffer.byteLength(line) + 1;
			if (bytes > MANAGED_LIMITS.maxNativeBytes) return unavailableObservation();
			lines.push(line);
		}
		return boundNativeObservation(collectNativeObservation(`${lines.join("\n")}\n`, { ...range, launched: true }));
	} catch { return unavailableObservation(); }
}
