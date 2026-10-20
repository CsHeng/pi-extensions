import { HARD_LIMITS, emptyUsage, truncateUtf8, type ChildActivity, type ChildToolCall, type ChildToolCallStatus, type UsageTotals } from "./contracts.ts";

const KNOWN_EVENT_TYPES = new Set([
	"session", "agent_start", "agent_end", "agent_settled", "turn_start", "turn_end",
	"message_start", "message_update", "message_end", "tool_execution_start",
	"tool_execution_update", "tool_execution_end", "queue_update", "compaction_start", "compaction_end",
]);
const KNOWN_STOP_REASONS = new Set(["stop", "length", "toolUse", "error", "aborted", "pending"]);

interface AssistantPart {
	type?: string;
	text?: string;
	id?: string;
	name?: string;
}

interface AssistantMessage {
	role?: string;
	content?: AssistantPart[];
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		cost?: { total?: number };
	};
	stopReason?: string;
	errorMessage?: string;
}

export interface ParsedChildStream {
	output: string;
	usage: UsageTotals;
	stopReason?: string;
	errorMessage?: string;
	messageCount: number;
	malformedLines: number;
	reportComplete: boolean;
}

export interface ProtocolParserOptions {
	now?: () => number;
	allowedTools?: readonly string[];
	onActivity?(activity: Readonly<ChildActivity>): void;
}

export class JsonlProtocolParser {
	private buffer = "";
	private discardingLine = false;
	private discardedAggregate = false;
	private assistantOpen = false;
	private compactionOpen = false;
	private protocolInvalid = false;
	private finalOutput = "";
	private readonly totals = emptyUsage();
	private stopReason: string | undefined;
	private errorMessage: string | undefined;
	private messageCount = 0;
	private malformedLines = 0;
	private readonly now: () => number;
	private readonly startedAt: number;
	private lastActivityAt: number;
	private readonly allowedTools: ReadonlySet<string> | undefined;
	private readonly onActivity: ProtocolParserOptions["onActivity"];
	private phase: ChildActivity["phase"] = "starting";
	private latestEventType: string | undefined;
	private errorObserved = false;
	private errorCount = 0;
	private agentEndObserved = false;
	private agentSettledObserved = false;
	private readonly activeToolCalls = new Map<string, string>();
	private readonly calls = new Map<string, TrackedCall>();
	private finished: TrackedCall[] = [];
	private callsAdmissionLimited = false;

	constructor(options: ProtocolParserOptions = {}) {
		this.now = options.now ?? (() => performance.now());
		this.startedAt = this.now();
		this.lastActivityAt = this.startedAt;
		this.allowedTools = options.allowedTools ? new Set(options.allowedTools) : undefined;
		this.onActivity = options.onActivity;
	}

	push(chunk: string): void {
		this.buffer += chunk;
		const lines = this.buffer.split("\n");
		this.buffer = lines.pop() ?? "";
		for (const line of lines) {
			if (this.discardingLine) {
				this.discardingLine = false;
				if (this.discardedAggregate) this.processLine('{"type":"agent_end"}');
				this.discardedAggregate = false;
			} else this.processLine(line);
		}
		if (Buffer.byteLength(this.buffer) > HARD_LIMITS.maxProtocolLineBytes) {
			if (!this.discardingLine) this.discardedAggregate = isRedundantAggregate(this.buffer);
			this.buffer = "";
			this.discardingLine = true;
			if (!this.discardedAggregate) this.protocolInvalid = true;
		}
	}

	finish(): ParsedChildStream {
		if (this.buffer.trim() || this.discardingLine) this.protocolInvalid = true;
		this.buffer = "";
		return {
			output: this.finalOutput,
			usage: { ...this.totals },
			...(this.stopReason === undefined ? {} : { stopReason: this.stopReason }),
			...(this.errorMessage === undefined ? {} : { errorMessage: this.errorMessage }),
			messageCount: this.messageCount,
			malformedLines: this.malformedLines,
			reportComplete: !this.protocolInvalid && this.malformedLines === 0 && !this.assistantOpen && !this.compactionOpen &&
				this.agentSettledObserved && this.stopReason === "stop" && !this.errorMessage &&
				this.activeToolCalls.size === 0 && this.finalOutput.trim().length > 0,
		};
	}

	snapshot(at = this.now()): Readonly<ChildActivity> {
		const activeTools = [...new Set([...this.activeToolCalls.values()].filter((tool) => !this.allowedTools || this.allowedTools.has(tool)))].sort();
		const projected = this.projectedCalls();
		return Object.freeze({
			phase: this.phase,
			assistantTurns: this.messageCount,
			activeTools: Object.freeze(activeTools) as unknown as string[],
			calls: Object.freeze(projected.calls.map((call) => Object.freeze({ ...call }))) as unknown as ChildToolCall[],
			callsTruncated: projected.callsTruncated,
			...(this.latestEventType === undefined ? {} : { latestEventType: this.latestEventType }),
			...(this.stopReason === undefined ? {} : { latestStopReason: this.stopReason }),
			errorObserved: this.errorObserved,
			errorCount: this.errorCount,
			agentEndObserved: this.agentEndObserved,
			agentSettledObserved: this.agentSettledObserved,
			elapsedMs: Math.max(0, at - this.startedAt),
			inactiveForMs: Math.max(0, at - this.lastActivityAt),
		});
	}

	private processLine(line: string): void {
		if (!line.trim()) return;
		if (Buffer.byteLength(line) > HARD_LIMITS.maxProtocolLineBytes) {
			if (isRedundantAggregate(line)) this.processLine('{"type":"agent_end"}');
			else this.protocolInvalid = true;
			return;
		}
		let event: unknown;
		try {
			event = JSON.parse(line) as unknown;
		} catch {
			this.malformedLines += 1;
			return;
		}
		if (!isRecord(event)) { this.protocolInvalid = true; return; }
		const observedAt = this.now();
		this.lastActivityAt = observedAt;
		const eventType = typeof event.type === "string" && KNOWN_EVENT_TYPES.has(event.type) ? event.type : "unknown";
		this.latestEventType = eventType;
		this.projectEvent(eventType, event);
		try { this.onActivity?.(this.snapshot(observedAt)); }
		catch { /* Optional observation must not stop protocol consumption or later settlement. */ }
	}

	private projectEvent(eventType: string, event: Record<string, unknown>): void {
		if (eventType === "message_update") {
			// Native print JSON carries a delta, not a full message envelope.
			if (!isRecord(event.assistantMessageEvent) || typeof event.assistantMessageEvent.type !== "string" || !event.assistantMessageEvent.type) this.protocolInvalid = true;
			this.assistantOpen = true;
			this.finalOutput = "";
			this.agentSettledObserved = false;
			this.phase = "running";
			return;
		}
		if ((eventType === "message_start" || eventType === "message_end") &&
			(!isRecord(event.message) || typeof event.message.role !== "string" || !event.message.role)) {
			this.protocolInvalid = true;
			this.finalOutput = "";
			this.agentSettledObserved = false;
			return;
		}
		if (eventType === "compaction_start") {
			if (this.compactionOpen || typeof event.reason !== "string" || !["manual", "threshold", "overflow"].includes(event.reason)) this.protocolInvalid = true;
			this.compactionOpen = true;
			this.agentSettledObserved = false;
			this.phase = "running";
		} else if (eventType === "compaction_end") {
			const failed = event.aborted === true || typeof event.errorMessage === "string" && event.errorMessage.length > 0;
			const resultValid = isRecord(event.result) && typeof event.result.summary === "string" && event.result.summary.trim().length > 0 &&
				typeof event.result.firstKeptEntryId === "string" && event.result.firstKeptEntryId.length > 0 && typeof event.result.tokensBefore === "number" && Number.isFinite(event.result.tokensBefore) && event.result.tokensBefore >= 0;
			if ((event.errorMessage !== undefined && typeof event.errorMessage !== "string") || (!this.compactionOpen && !failed) || typeof event.reason !== "string" || !["manual", "threshold", "overflow"].includes(event.reason) || typeof event.aborted !== "boolean" || typeof event.willRetry !== "boolean" || (!failed && !resultValid)) this.protocolInvalid = true;
			this.compactionOpen = false;
			this.agentSettledObserved = false;
			// Quiet native history maintenance does not replace a completed answer.
			// Failed maintenance or a promised retry cannot reuse that answer.
			if (failed || event.willRetry) { this.finalOutput = ""; this.stopReason = undefined; }
		} else if (eventType === "agent_start") {
			this.agentSettledObserved = false;
			this.finalOutput = "";
			this.stopReason = undefined;
			this.phase = "running";
		} else if (eventType === "message_start" && isRecord(event.message) && event.message.role === "assistant") {
			this.assistantOpen = true;
			this.agentSettledObserved = false;
			this.finalOutput = "";
		} else if (eventType === "agent_end") {
			this.agentEndObserved = true;
			this.phase = "settling";
		} else if (eventType === "agent_settled") {
			this.agentSettledObserved = true;
			this.phase = "settled-awaiting-exit";
		} else if (eventType === "tool_execution_start") {
			const id = stringField(event, "toolCallId");
			const tool = stringField(event, "toolName");
			if (id && tool) {
				this.trackTool(id, tool);
				if (this.activeToolCalls.has(id)) this.observeCallStart(id, tool, event);
			} else this.protocolInvalid = true;
			this.agentSettledObserved = false;
			this.finalOutput = "";
			if (!this.agentSettledObserved) this.phase = "running";
		} else if (eventType === "tool_execution_update") {
			this.observeCallUpdate(event);
		} else if (eventType === "tool_execution_end") {
			this.agentSettledObserved = false;
			this.finalOutput = "";
			const id = stringField(event, "toolCallId");
			if (id) {
				this.activeToolCalls.delete(id);
				this.finishObservedCall(id, event);
			} else this.protocolInvalid = true;
			if (event.isError === true) {
				this.errorObserved = true;
				this.errorCount += 1;
			}
			if (!this.agentSettledObserved) this.phase = "running";
		}

		if (eventType !== "message_end" || !isRecord(event.message)) return;
		const message = event.message as AssistantMessage;
		if (message.role !== "assistant") {
			this.finalOutput = "";
			this.agentSettledObserved = false;
			return;
		}
		if (!Array.isArray(message.content) || message.content.some((part) => !isRecord(part))) {
			this.protocolInvalid = true;
			this.finalOutput = "";
			return;
		}
		this.assistantOpen = false;
		this.agentSettledObserved = false;
		for (const part of message.content ?? []) {
			// Failed response proposals were never admitted for execution. An actual
			// tool_execution_start remains fenced independently of this response.
			if (part.type === "toolCall" && message.stopReason !== "error" && message.stopReason !== "aborted" && !message.errorMessage) {
				if (typeof part.id === "string" && typeof part.name === "string") this.trackTool(part.id, part.name);
				else this.protocolInvalid = true;
			}
		}
		this.messageCount += 1;
		this.totals.turns += 1;
		this.totals.input += finiteNumber(message.usage?.input);
		this.totals.output += finiteNumber(message.usage?.output);
		this.totals.cacheRead += finiteNumber(message.usage?.cacheRead);
		this.totals.cacheWrite += finiteNumber(message.usage?.cacheWrite);
		this.totals.cost += finiteNumber(message.usage?.cost?.total);
		this.finalOutput = message.content?.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n\n") ?? "";
		this.stopReason = typeof message.stopReason === "string" && KNOWN_STOP_REASONS.has(message.stopReason) ? message.stopReason : undefined;
		this.errorMessage = typeof message.errorMessage === "string" ? message.errorMessage : undefined;
		if (message.stopReason === "error" || typeof message.errorMessage === "string") {
			this.errorObserved = true;
			this.errorCount += 1;
		}
		if (!this.agentSettledObserved) this.phase = "running";
	}
	private trackTool(id: string, tool: string): void {
		if (this.activeToolCalls.size >= HARD_LIMITS.maxPendingToolCalls && !this.activeToolCalls.has(id)) {
			this.protocolInvalid = true;
			return;
		}
		this.activeToolCalls.set(id, tool);
	}

	private elapsed(at: number): number {
		return Math.max(0, at - this.startedAt);
	}

	private observeCallStart(id: string, tool: string, event: Record<string, unknown>): void {
		try {
			const at = this.elapsed(this.lastActivityAt);
			const described = describeCall(tool, event.args);
			const parentId = callParent(event);
			const existing = this.calls.get(id);
			this.finished = this.finished.filter((item) => item.id !== id);
			this.calls.set(id, {
				id,
				tool,
				...(parentId ? { parentId } : existing?.parentId ? { parentId: existing.parentId } : {}),
				...(described.summary ? { summary: described.summary } : existing?.summary ? { summary: existing.summary } : {}),
				...(described.deadlineMs !== undefined ? { deadlineMs: described.deadlineMs } : existing?.deadlineMs !== undefined ? { deadlineMs: existing.deadlineMs } : {}),
				startedMs: existing?.startedMs ?? at,
				updatedMs: at,
				status: "running",
				tail: existing?.tail ?? "",
				truncated: existing?.truncated ?? false,
			});
		} catch { /* A summary failure must not invalidate the execution. */ }
	}

	private observeCallUpdate(event: Record<string, unknown>): void {
		try {
			const id = stringField(event, "toolCallId");
			if (!id) return;
			const at = this.elapsed(this.lastActivityAt);
			let call = this.calls.get(id);
			if (!call) {
				const tool = stringField(event, "toolName");
				if (!tool) return;
				// Unmatched updates are optional. Do not consume the mandatory pending-tool fence.
				if (this.calls.size >= HARD_LIMITS.maxPendingToolCalls) {
					this.callsAdmissionLimited = true;
					return;
				}
				call = { id, tool, updatedMs: at, status: "running", tail: "", truncated: false };
			}
			const described = describeCall(call.tool, event.args);
			const observed = outputObservation(resultText(event.partialResult), at);
			const parentId = callParent(event);
			this.calls.set(id, {
				...call,
				updatedMs: at,
				...(parentId ? { parentId } : {}),
				...(described.summary ? { summary: described.summary } : {}),
				...(described.deadlineMs !== undefined ? { deadlineMs: described.deadlineMs } : {}),
				...(observed ? { tail: observed.tail, truncated: observed.truncated, outputMs: observed.outputMs } : {}),
			});
		} catch { /* Optional output projection. */ }
	}

	private finishObservedCall(id: string, event: Record<string, unknown>): void {
		try {
			const call = this.calls.get(id);
			if (!call) return;
			const at = this.elapsed(this.lastActivityAt);
			const observed = outputObservation(resultText(event.result), at);
			const parentId = callParent(event);
			const status: ChildToolCallStatus = event.isError === true ? "failed" : event.isError === false ? "succeeded" : "unknown";
			const finished = {
				...call,
				updatedMs: at,
				status,
				tail: observed ? observed.tail : call.tail,
				truncated: observed ? observed.truncated : call.truncated,
				...(observed ? { outputMs: observed.outputMs } : {}),
				...(parentId ? { parentId } : {}),
			};
			this.calls.delete(id);
			this.finished = [finished, ...this.finished.filter((item) => item.id !== id)].slice(0, HARD_LIMITS.maxObservedCalls);
		} catch { /* Optional terminal projection. */ }
	}

	private projectedCalls(): { calls: ChildToolCall[]; callsTruncated: boolean } {
		const visible = (call: TrackedCall) => !this.allowedTools || this.allowedTools.has(call.tool);
		const combined = [...[...this.calls.values()].filter(visible), ...this.finished.filter(visible)];
		return {
			calls: combined.slice(0, HARD_LIMITS.maxObservedCalls).map(publicCall),
			callsTruncated: combined.length > HARD_LIMITS.maxObservedCalls || this.callsAdmissionLimited,
		};
	}
}

// Native print JSON emits the discriminant first. The redundant run aggregate
// is not a completion oracle: message_end + agent_settled remain indispensable.
function isRedundantAggregate(prefix: string): boolean {
	return /^\s*\{\s*"type"\s*:\s*"agent_end"\s*[,}]/.test(prefix);
}

interface TrackedCall {
	id: string;
	tool: string;
	parentId?: string;
	summary?: string;
	startedMs?: number;
	updatedMs: number;
	outputMs?: number;
	status: ChildToolCallStatus;
	deadlineMs?: number;
	tail: string;
	truncated: boolean;
}

const SHELL_TOOLS = new Set(["bash", "powershell"]);
const SUMMARY_FIELDS = ["command", "pattern", "path", "query", "url"] as const;
const SENSITIVE_ARG = /password|passwd|secret|token|credential|authorization|api[_-]?key|private[_-]?key|cookie|^env$/i;
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/;

function stringField(record: Record<string, unknown>, key: string): string | undefined {
	return typeof record[key] === "string" ? record[key] : undefined;
}

function callParent(event: Record<string, unknown>): string | undefined {
	const parent = event.parentToolCallId;
	return typeof parent === "string" && parent.length > 0 && Buffer.byteLength(parent) <= HARD_LIMITS.maxCallIdBytes && !CONTROL.test(parent) ? parent : undefined;
}

function describeCall(tool: string, args: unknown): { summary?: string; deadlineMs?: number } {
	if (!isRecord(args)) return {};
	const deadlineMs = shellDeadline(tool, args);
	const parts: string[] = [];
	for (const key of SUMMARY_FIELDS) {
		if (SHELL_TOOLS.has(tool) && key !== "command") continue;
		if (!SHELL_TOOLS.has(tool) && key === "command") continue;
		const value = args[key];
		if (typeof value !== "string" || !value.trim() || SENSITIVE_ARG.test(key)) continue;
		parts.push(redactText(value));
	}
	const summary = boundStart(parts.join(" ").replace(/[\u0000-\u001F\u007F-\u009F]+/g, " ").replace(/\s+/g, " ").trim());
	return {
		...(summary ? { summary } : {}),
		...(deadlineMs === undefined ? {} : { deadlineMs }),
	};
}

function shellDeadline(tool: string, args: Record<string, unknown>): number | undefined {
	if (!SHELL_TOOLS.has(tool) || typeof args.timeout !== "number" || !Number.isFinite(args.timeout) || args.timeout < 0) return undefined;
	const ms = Math.round(args.timeout * 1000);
	return Number.isSafeInteger(ms) ? ms : undefined;
}

function resultText(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (!isRecord(value) || !Array.isArray(value.content)) return undefined;
	const texts = value.content.flatMap((part) => isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []);
	return texts.length > 0 ? texts.join("\n") : undefined;
}

function redactText(value: string): string {
	return value
		.replace(/(^|[\s;&|`(?&])((?:--?)?(?:password|passwd|secret|token|api-key|apikey|access-token|authorization)|[A-Za-z0-9_]*(?:PASSWORD|TOKEN|SECRET|API_KEY|CREDENTIAL|AUTHORIZATION)[A-Za-z0-9_]*)(=|\s+)([^\s;&|]+)/gi, "$1$2$3[redacted]")
		.replace(/\/\/([^/\s:@]+):([^@\s/]+)@/g, "//$1:[redacted]@")
		.replace(/\bBearer\s+\S+/gi, "Bearer [redacted]");
}

function boundStart(value: string): string {
	if (!value) return "";
	const bounded = truncateUtf8(value, HARD_LIMITS.maxCallSummaryBytes);
	return bounded.truncatedBytes > 0 ? `${truncateUtf8(value, HARD_LIMITS.maxCallSummaryBytes - 3).text.trimEnd()}…` : bounded.text;
}

function outputObservation(text: string | undefined, at: number): { tail: string; truncated: boolean; outputMs: number } | undefined {
	if (!text || !text.trim()) return undefined;
	const bounded = boundTail(text);
	if (!bounded.tail) return undefined;
	return { ...bounded, outputMs: at };
}

function boundTail(value: string): { tail: string; truncated: boolean } {
	const single = redactText(value).replace(/[\u0000-\u001F\u007F-\u009F]+/g, " ").replace(/\s+/g, " ").trim();
	const size = Buffer.byteLength(single);
	if (size <= HARD_LIMITS.maxCallTailBytes) return { tail: single, truncated: false };
	const bytes = Buffer.from(single);
	let start = bytes.length - HARD_LIMITS.maxCallTailBytes;
	while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
	return { tail: bytes.subarray(start).toString("utf8").trimStart(), truncated: true };
}

function publicCall(call: TrackedCall): ChildToolCall {
	return {
		id: call.id,
		tool: call.tool,
		status: call.status,
		tail: call.tail,
		truncated: call.truncated,
		...(call.parentId ? { parentId: call.parentId } : {}),
		...(call.summary ? { summary: call.summary } : {}),
		...(call.startedMs !== undefined ? { startedMs: call.startedMs } : {}),
		...(call.updatedMs !== undefined ? { updatedMs: call.updatedMs } : {}),
		...(call.outputMs !== undefined ? { outputMs: call.outputMs } : {}),
		...(call.deadlineMs !== undefined ? { deadlineMs: call.deadlineMs } : {}),
	};
}

function finiteNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
