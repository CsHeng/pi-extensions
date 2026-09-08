import { HARD_LIMITS, emptyUsage, type ChildActivity, type UsageTotals } from "./contracts.ts";

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
			if (this.discardingLine) this.discardingLine = false;
			else this.processLine(line);
		}
		if (Buffer.byteLength(this.buffer) > HARD_LIMITS.maxProtocolLineBytes) {
			this.buffer = "";
			this.discardingLine = true;
			this.protocolInvalid = true;
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
		return Object.freeze({
			phase: this.phase,
			assistantTurns: this.messageCount,
			activeTools: Object.freeze(activeTools) as unknown as string[],
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
			this.protocolInvalid = true;
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
		this.onActivity?.(this.snapshot(observedAt));
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
			if (id && tool) this.trackTool(id, tool);
			else this.protocolInvalid = true;
			this.agentSettledObserved = false;
			this.finalOutput = "";
			if (!this.agentSettledObserved) this.phase = "running";
		} else if (eventType === "tool_execution_end") {
			this.agentSettledObserved = false;
			this.finalOutput = "";
			const id = stringField(event, "toolCallId");
			if (id) this.activeToolCalls.delete(id);
			else this.protocolInvalid = true;
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
			if (part.type === "toolCall") {
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
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
	return typeof record[key] === "string" ? record[key] : undefined;
}

function finiteNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
