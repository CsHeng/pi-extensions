import { emptyUsage, type UsageTotals } from "./contracts.ts";

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

export class JsonlProtocolParser {
	private buffer = "";
	private finalOutput = "";
	private readonly totals = emptyUsage();
	private stopReason: string | undefined;
	private errorMessage: string | undefined;
	private messageCount = 0;
	private malformedLines = 0;

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

	private processLine(line: string): void {
		if (!line.trim()) return;
		let event: unknown;
		try {
			event = JSON.parse(line) as unknown;
		} catch {
			this.malformedLines += 1;
			return;
		}
		if (!isRecord(event) || event.type !== "message_end" || !isRecord(event.message)) return;
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
		if (typeof message.stopReason === "string") this.stopReason = message.stopReason;
		if (typeof message.errorMessage === "string") this.errorMessage = message.errorMessage;
	}
}

function finiteNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
