import { emptyUsage, type ChildActivity, type UsageTotals } from "./contracts.ts";

const KNOWN_EVENT_TYPES = new Set([
	"session", "agent_start", "agent_end", "agent_settled", "turn_start", "turn_end",
	"message_start", "message_update", "message_end", "tool_execution_start",
	"tool_execution_update", "tool_execution_end", "queue_update", "compaction_start", "compaction_end",
]);
const KNOWN_STOP_REASONS = new Set(["stop", "length", "toolUse", "error", "aborted", "pending"]);

interface AssistantPart {
	type?: string;
	text?: string;
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
}

export interface ProtocolParserOptions {
	now?: () => number;
	allowedTools?: readonly string[];
	onActivity?(activity: Readonly<ChildActivity>): void;
}

export class JsonlProtocolParser {
	private buffer = "";
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
		this.now = options.now ?? Date.now;
		this.startedAt = this.now();
		this.lastActivityAt = this.startedAt;
		this.allowedTools = options.allowedTools ? new Set(options.allowedTools) : undefined;
		this.onActivity = options.onActivity;
	}

	push(chunk: string): void {
		this.buffer += chunk;
		const lines = this.buffer.split("\n");
		this.buffer = lines.pop() ?? "";
		for (const line of lines) this.processLine(line);
	}

	finish(): ParsedChildStream {
		if (this.buffer.trim()) this.processLine(this.buffer);
		this.buffer = "";
		return {
			output: this.finalOutput,
			usage: { ...this.totals },
			...(this.stopReason === undefined ? {} : { stopReason: this.stopReason }),
			...(this.errorMessage === undefined ? {} : { errorMessage: this.errorMessage }),
			messageCount: this.messageCount,
			malformedLines: this.malformedLines,
		};
	}

	snapshot(at = this.now()): Readonly<ChildActivity> {
		const activeTools = [...new Set(this.activeToolCalls.values())].sort();
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
		let event: unknown;
		try {
			event = JSON.parse(line) as unknown;
		} catch {
			this.malformedLines += 1;
			return;
		}
		if (!isRecord(event)) return;
		const observedAt = this.now();
		this.lastActivityAt = observedAt;
		const eventType = typeof event.type === "string" && KNOWN_EVENT_TYPES.has(event.type) ? event.type : "unknown";
		this.latestEventType = eventType;
		this.projectEvent(eventType, event);
		this.onActivity?.(this.snapshot(observedAt));
	}

	private projectEvent(eventType: string, event: Record<string, unknown>): void {
		if (eventType === "agent_start") {
			this.phase = "running";
		} else if (eventType === "agent_end") {
			this.agentEndObserved = true;
			this.phase = "settling";
		} else if (eventType === "agent_settled") {
			this.agentSettledObserved = true;
			this.phase = "settled-awaiting-exit";
		} else if (eventType === "tool_execution_start") {
			const id = stringField(event, "toolCallId");
			const tool = stringField(event, "toolName");
			if (id && tool && (!this.allowedTools || this.allowedTools.has(tool))) this.activeToolCalls.set(id, tool);
			if (!this.agentSettledObserved) this.phase = "running";
		} else if (eventType === "tool_execution_end") {
			const id = stringField(event, "toolCallId");
			if (id) this.activeToolCalls.delete(id);
			if (event.isError === true) {
				this.errorObserved = true;
				this.errorCount += 1;
			}
			if (!this.agentSettledObserved) this.phase = "running";
		}

		if (eventType !== "message_end" || !isRecord(event.message)) return;
		const message = event.message as AssistantMessage;
		if (message.role !== "assistant") return;
		this.messageCount += 1;
		this.totals.turns += 1;
		this.totals.input += finiteNumber(message.usage?.input);
		this.totals.output += finiteNumber(message.usage?.output);
		this.totals.cacheRead += finiteNumber(message.usage?.cacheRead);
		this.totals.cacheWrite += finiteNumber(message.usage?.cacheWrite);
		this.totals.cost += finiteNumber(message.usage?.cost?.total);
		const text = message.content?.find((part) => part.type === "text" && typeof part.text === "string")?.text;
		if (text !== undefined) this.finalOutput = text;
		this.stopReason = typeof message.stopReason === "string" && KNOWN_STOP_REASONS.has(message.stopReason) ? message.stopReason : undefined;
		this.errorMessage = typeof message.errorMessage === "string" ? message.errorMessage : undefined;
		if (message.stopReason === "error" || typeof message.errorMessage === "string") {
			this.errorObserved = true;
			this.errorCount += 1;
		}
		if (!this.agentSettledObserved) this.phase = "running";
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
