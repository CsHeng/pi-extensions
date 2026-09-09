import { commandCorrelationKey } from "./command-correlation.ts";
import { createHash } from "node:crypto";
import { MANAGED_LIMITS } from "./session-contracts.ts";
import { isLocalTiming, type LocalTiming } from "./telemetry.ts";

export interface ObservedUsage {
	input: number | null;
	output: number | null;
	cacheRead: number | null;
	cacheWrite: number | null;
	totalTokens: number | null;
	cost: number | null;
}

export interface NativeUsageRow {
	ownerSessionId: string;
	entryId: string;
	kind: "assistant" | "compaction" | "branch-summary";
	modelKey: string | null;
	usage: ObservedUsage;
}

export interface NativeCommandRow {
	toolCallId?: string | null;
	ownerSessionId: string;
	entryId: string;
	startMs: number | null;
	endMs: number | null;
	exitCode: number | null;
	status: "succeeded" | "failed" | "aborted" | "timeout" | "unknown";
	sourceBeforeKey: string | null;
	sourceAfterKey: string | null;
	environmentBeforeKey?: string | null;
	environmentAfterKey?: string | null;
}

export interface NativeObservation {
	available: boolean;
	ownerSessionId: string | null;
	entries: NativeUsageRow[];
	commands: NativeCommandRow[];
	usage: ObservedUsage;
	contextWindow: number | null;
	toolNames: string[] | null;
	capabilityKey: string | null;
	timing?: LocalTiming | null;
	commandCoverage?: "complete" | "partial";
	commandCorrelationVersion?: 2;
}

const OPAQUE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const SHA256_KEY = /^[a-f0-9]{64}$/;
const TOOL_NAMES = new Set(["read", "grep", "find", "ls", "edit", "write", "bash"]);
const NATIVE_ENTRY_TYPES = new Set([
	"message", "thinking_level_change", "model_change", "compaction",
	"branch_summary", "custom", "label", "session_info", "custom_message",
]);
const COMMAND_STATUSES = new Set(["succeeded", "failed", "aborted", "timeout", "unknown"]);
const MAX_TOOL_NAMES = 16;
const MAX_OBSERVATION_BYTES = 64 * 1024;
const OBSERVATION_KEYS = new Set([
	"available", "ownerSessionId", "entries", "commands", "usage", "contextWindow",
	"toolNames", "capabilityKey", "timing", "commandCoverage", "commandCorrelationVersion",
]);
const USAGE_ROW_KEYS = new Set(["ownerSessionId", "entryId", "kind", "modelKey", "usage"]);
const COMMAND_ROW_KEYS = new Set([
	"ownerSessionId", "entryId", "startMs", "endMs", "exitCode", "status",
	"sourceBeforeKey", "sourceAfterKey", "environmentBeforeKey", "environmentAfterKey", "toolCallId",
]);

type CommandStatus = NativeCommandRow["status"];
type ParsedNative = {
	ownerSessionId: string;
	fork: boolean;
	body: Array<{ id: string; entry: Record<string, unknown> }>;
};

export function collectNativeObservation(text: string, selection: { startLeaf: string | null; endLeaf: string | null; launched: boolean }): NativeObservation {
	if (typeof text !== "string" || !isSelection(selection)) return unavailable();
	if (text.length === 0) return selection.launched || selection.startLeaf !== null || selection.endLeaf !== null ? unavailable() : emptyObservation(null);
	const parsed = parseNativeSession(text);
	if (parsed === undefined) return unavailable();
	// A copied fork prefix has no intrinsic billing owner. Callers must select
	// their newly appended range rather than attributing that prefix to the fork.
	if (parsed.fork && selection.startLeaf === null) return unavailable();
	const ownerSessionId = parsed.ownerSessionId;
	const selected = selectRange(parsed.body, selection.startLeaf, selection.endLeaf);
	if (selected === undefined) return unavailable();
	const entries: NativeUsageRow[] = [];
	const commands: NativeCommandRow[] = [];
	let contextWindow: number | null = null;
	let toolNames: string[] | null = null;
	let capabilityKey: string | null = null;
	let timing: LocalTiming | null | undefined;
	const pendingCommands = new Set<string>();
	const seenCommands = new Set<string>();
	let commandCoverage = true;
	for (const { id, entry } of selected) {
		if (entry.type === "message") {
			const message = isRecord(entry.message) ? entry.message : undefined;
			if (message?.role === "assistant") {
				entries.push({
					ownerSessionId, entryId: id, kind: "assistant",
					modelKey: modelKey(message.provider, message.model),
					usage: parseUsage(message.usage),
				});
				if (!Array.isArray(message.content)) commandCoverage = false;
				else for (const part of message.content) {
					if (!isRecord(part) || part.type !== "toolCall" || part.name !== "bash") continue;
					const callId = commandCorrelationKey(part.id);
					if (!callId || seenCommands.has(callId)) commandCoverage = false;
					else { pendingCommands.add(callId); seenCommands.add(callId); }
				}
			}
		} else if (entry.type === "compaction" || entry.type === "branch_summary") {
			entries.push({
				ownerSessionId, entryId: id, kind: entry.type === "compaction" ? "compaction" : "branch-summary",
				modelKey: modelKey(entry.provider, entry.model),
				usage: parseUsage(entry.usage),
			});
		} else if (entry.type === "custom" && entry.customType === "csheng-worker-command") {
			const command = parseCommand(ownerSessionId, id, entry.data);
			if (!command.toolCallId || !pendingCommands.delete(command.toolCallId) || !completeCommandEvidence(command)) commandCoverage = false;
			commands.push(command);
		} else if (entry.type === "custom" && entry.customType === "csheng-episode-observation") {
			const data = isRecord(entry.data) ? entry.data : undefined;
			contextWindow = positiveFinite(data?.contextWindow);
			toolNames = parseToolNames(data?.toolNames);
			capabilityKey = sha256Key(data?.capabilityKey);
		} else if (entry.type === "custom" && entry.customType === "csheng-episode-timing") {
			timing = isLocalTiming(entry.data) ? entry.data : null;
		} else if (entry.type === "custom" && entry.customType === "csheng-compaction-unavailable") {
			entries.push({
				ownerSessionId, entryId: id, kind: "compaction",
				modelKey: null, usage: nullUsage(),
			});
		}
	}
	const observation: NativeObservation = {
		available: true, ownerSessionId, entries, commands, commandCorrelationVersion: 2,
		usage: sumUsage(entries), contextWindow, toolNames, capabilityKey,
	};
	if (timing !== undefined) observation.timing = timing;
	observation.commandCoverage = commandCoverage && pendingCommands.size === 0 ? "complete" : "partial";
	return observation;
}

export function mergeOwnedUsage(observations: readonly NativeObservation[]): { available: boolean; usage: ObservedUsage; entries: NativeUsageRow[] } {
	if (!Array.isArray(observations) || observations.length > MANAGED_LIMITS.maxEntries || observations.some((item) => !isNativeObservation(item) || !item.available)) return { available: false, usage: nullUsage(), entries: [] };
	const unique: NativeUsageRow[] = [];
	const index = new Map<string, number>();
	let count = 0;
	for (const observation of observations) {
		for (const row of observation.entries) {
			if (++count > MANAGED_LIMITS.maxEntries * MANAGED_LIMITS.maxSessions) return { available: false, usage: nullUsage(), entries: [] };
			const key = `${row.ownerSessionId}\0${row.entryId}`;
			const existing = index.get(key);
			if (existing === undefined) {
				index.set(key, unique.length);
				unique.push(copyRow(row));
				continue;
			}
			if (!sameRow(unique[existing]!, row)) return { available: false, usage: nullUsage(), entries: [] };
		}
	}
	return { available: true, usage: sumUsage(unique), entries: unique };
}

export function isNativeObservation(value: unknown): value is NativeObservation {
	if (!isRecord(value) || Object.keys(value).some((key) => !OBSERVATION_KEYS.has(key))
		|| typeof value.available !== "boolean" || (value.ownerSessionId !== null && (typeof value.ownerSessionId !== "string" || !OPAQUE_ID.test(value.ownerSessionId)))
		|| !Array.isArray(value.entries) || value.entries.length > MANAGED_LIMITS.maxEntries || !Array.isArray(value.commands) || value.commands.length > MANAGED_LIMITS.maxEntries
		|| !validUsage(value.usage) || (value.contextWindow !== null && positiveFinite(value.contextWindow) === null)
		|| (value.toolNames !== null && parseToolNames(value.toolNames) === null) || (value.capabilityKey !== null && sha256Key(value.capabilityKey) === null)
		|| (value.timing !== undefined && value.timing !== null && !isLocalTiming(value.timing))
		|| (value.commandCorrelationVersion !== undefined && value.commandCorrelationVersion !== 2)
		|| (value.commandCoverage !== undefined && value.commandCoverage !== "complete" && value.commandCoverage !== "partial")) return false;
	const ownerSessionId = value.ownerSessionId as string | null;
	return value.entries.every((row) => isUsageRow(row, ownerSessionId))
		&& value.commands.every((row) => isCommandRow(row, ownerSessionId) && (value.commandCorrelationVersion !== 2 || row.toolCallId == null || sha256Key(row.toolCallId) !== null));
}

export function unavailableObservation(): NativeObservation {
	return unavailable();
}

function completeCommandEvidence(row: NativeCommandRow): boolean {
	return !!row.toolCallId && row.status !== "unknown" && row.startMs !== null && row.endMs !== null && row.endMs >= row.startMs
		&& row.sourceBeforeKey !== null && row.sourceAfterKey !== null
		&& typeof row.environmentBeforeKey === "string" && typeof row.environmentAfterKey === "string";
}

export function normalizeCommandCorrelation(value: NativeObservation): NativeObservation {
	if (!isNativeObservation(value)) return unavailable();
	const commands = value.commandCorrelationVersion === 2 ? value.commands : value.commands.map((row) => ({ ...row, ...(row.toolCallId === undefined ? {} : { toolCallId: commandCorrelationKey(row.toolCallId) }) }));
	return { ...value, commandCorrelationVersion: 2, commands,
		...(value.commandCoverage === "complete" && commands.some(row => !completeCommandEvidence(row)) ? { commandCoverage: "partial" } : {}),
	};
}

export function boundNativeObservation(value: NativeObservation): NativeObservation {
	if (!isNativeObservation(value)) return unavailable();
	value = normalizeCommandCorrelation(value);
	try {
		if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_OBSERVATION_BYTES) return unavailable();
	} catch {
		return unavailable();
	}
	return value;
}

export function nativeLeaf(text: string): string | null | undefined {
	if (typeof text !== "string") return undefined;
	if (text.length === 0) return null;
	const parsed = parseNativeSession(text);
	if (parsed === undefined) return undefined;
	if (parsed.body.length === 0) return null;
	return parsed.body[parsed.body.length - 1]!.id;
}

function parseNativeSession(text: string): ParsedNative | undefined {
	if (!text.endsWith("\n") || Buffer.byteLength(text, "utf8") > MANAGED_LIMITS.maxNativeBytes) return undefined;
	const lines = text.slice(0, -1).split("\n");
	if (lines.length === 0 || lines.length > MANAGED_LIMITS.maxEntries) return undefined;
	const parsed: Record<string, unknown>[] = [];
	for (const line of lines) {
		if (Buffer.byteLength(line, "utf8") > MANAGED_LIMITS.maxNativeLineBytes) return undefined;
		try {
			const entry = JSON.parse(line) as unknown;
			if (!isRecord(entry)) return undefined;
			parsed.push(entry);
		} catch {
			return undefined;
		}
	}
	const header = parsed[0]!;
	if (header.type !== "session" || header.version !== 3 || typeof header.id !== "string" || !OPAQUE_ID.test(header.id)) return undefined;
	const ownerSessionId = header.id;
	const body: Array<{ id: string; entry: Record<string, unknown> }> = [];
	const seen = new Set<string>();
	for (const entry of parsed.slice(1)) {
		if (typeof entry.type !== "string" || !NATIVE_ENTRY_TYPES.has(entry.type) || typeof entry.id !== "string" || !OPAQUE_ID.test(entry.id) || entry.id === ownerSessionId || seen.has(entry.id)) return undefined;
		if (entry.parentId !== null && (typeof entry.parentId !== "string" || !seen.has(entry.parentId))) return undefined;
		if (entry.type === "message" && (!isRecord(entry.message) || typeof entry.message.role !== "string")) return undefined;
		seen.add(entry.id);
		body.push({ id: entry.id, entry });
	}
	return { ownerSessionId, fork: header.parentSession !== undefined, body };
}

function isUsageRow(row: unknown, ownerSessionId: string | null): row is NativeUsageRow {
	return isRecord(row) && Object.keys(row).every((key) => USAGE_ROW_KEYS.has(key))
		&& row.ownerSessionId === ownerSessionId && typeof row.entryId === "string" && OPAQUE_ID.test(row.entryId)
		&& typeof row.kind === "string" && ["assistant", "compaction", "branch-summary"].includes(row.kind)
		&& (row.modelKey === null || sha256Key(row.modelKey) !== null) && validUsage(row.usage);
}

function isCommandRow(row: unknown, ownerSessionId: string | null): row is NativeCommandRow {
	return isRecord(row) && Object.keys(row).every((key) => COMMAND_ROW_KEYS.has(key))
		&& row.ownerSessionId === ownerSessionId && typeof row.entryId === "string" && OPAQUE_ID.test(row.entryId)
		&& (row.toolCallId === undefined || row.toolCallId === null || opaqueId(row.toolCallId) !== null)
		&& typeof row.status === "string" && COMMAND_STATUSES.has(row.status) && (row.exitCode === null || Number.isSafeInteger(row.exitCode))
		&& (row.startMs === null || timestamp(row.startMs) !== null) && (row.endMs === null || timestamp(row.endMs) !== null)
		&& (row.sourceBeforeKey === null || sha256Key(row.sourceBeforeKey) !== null) && (row.sourceAfterKey === null || sha256Key(row.sourceAfterKey) !== null)
		&& (row.environmentBeforeKey === undefined || row.environmentBeforeKey === null || sha256Key(row.environmentBeforeKey) !== null)
		&& (row.environmentAfterKey === undefined || row.environmentAfterKey === null || sha256Key(row.environmentAfterKey) !== null);
}

function validUsage(value: unknown): value is ObservedUsage {
	return isRecord(value) && Object.keys(value).length === 6 && ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost"].every((key) => value[key] === null || metric(value[key]) !== null);
}

function isSelection(value: unknown): value is { startLeaf: string | null; endLeaf: string | null; launched: boolean } {
	return isRecord(value)
		&& (value.startLeaf === null || typeof value.startLeaf === "string")
		&& (value.endLeaf === null || typeof value.endLeaf === "string")
		&& typeof value.launched === "boolean";
}

function selectRange(
	body: ReadonlyArray<{ id: string; entry: Record<string, unknown> }>,
	startLeaf: string | null,
	endLeaf: string | null,
): Array<{ id: string; entry: Record<string, unknown> }> | undefined {
	if (startLeaf !== null && !OPAQUE_ID.test(startLeaf)) return undefined;
	if (endLeaf !== null && !OPAQUE_ID.test(endLeaf)) return undefined;
	const startIndex = startLeaf === null ? -1 : body.findIndex((item) => item.id === startLeaf);
	if (startLeaf !== null && startIndex < 0) return undefined;
	if (endLeaf === null) return startLeaf === null && body.length === 0 ? [] : undefined;
	const endIndex = body.findIndex((item) => item.id === endLeaf);
	if (endIndex < 0 || endIndex < startIndex) return undefined;
	return body.slice(startIndex + 1, endIndex + 1);
}

function parseUsage(value: unknown): ObservedUsage {
	const usage = isRecord(value) ? value : undefined;
	const costValue = usage?.cost;
	return {
		input: metric(usage?.input),
		output: metric(usage?.output),
		cacheRead: metric(usage?.cacheRead),
		cacheWrite: metric(usage?.cacheWrite),
		totalTokens: metric(usage?.totalTokens),
		cost: typeof costValue === "number" ? metric(costValue) : isRecord(costValue) ? metric(costValue.total) : null,
	};
}

function parseCommand(ownerSessionId: string, entryId: string, value: unknown): NativeCommandRow {
	const data = isRecord(value) ? value : undefined;
	let startMs = timestamp(data?.startMs);
	let endMs = timestamp(data?.endMs);
	if (startMs !== null && endMs !== null && endMs < startMs) { startMs = null; endMs = null; }
	const status = typeof data?.status === "string" && COMMAND_STATUSES.has(data.status) ? data.status as CommandStatus : "unknown";
	const exitCode = typeof data?.exitCode === "number" && Number.isSafeInteger(data.exitCode) ? data.exitCode : null;
	const row: NativeCommandRow = {
		ownerSessionId, entryId, startMs, endMs, exitCode, status,
		sourceBeforeKey: sha256Key(data?.sourceBeforeKey),
		sourceAfterKey: sha256Key(data?.sourceAfterKey),
	};
	if (data !== undefined && "toolCallId" in data) row.toolCallId = data.version === 2 ? sha256Key(data.toolCallId) : data.version === undefined || data.version === 1 ? commandCorrelationKey(opaqueId(data.toolCallId)) : null;
	if (data !== undefined && ("environmentBeforeKey" in data || "environmentAfterKey" in data)) {
		row.environmentBeforeKey = sha256Key(data.environmentBeforeKey);
		row.environmentAfterKey = sha256Key(data.environmentAfterKey);
	}
	return row;
}

function opaqueId(value: unknown): string | null {
	return typeof value === "string" && OPAQUE_ID.test(value) ? value : null;
}

function parseToolNames(value: unknown): string[] | null {
	if (!Array.isArray(value) || value.length > MAX_TOOL_NAMES) return null;
	const names: string[] = [];
	for (const item of value) {
		if (typeof item !== "string" || !TOOL_NAMES.has(item) || names.includes(item)) return null;
		names.push(item);
	}
	return names;
}

function modelKey(provider: unknown, model: unknown): string | null {
	if (typeof provider !== "string" || typeof model !== "string" || provider.length === 0 || model.length === 0) return null;
	return createHash("sha256").update(JSON.stringify([provider, model])).digest("hex");
}

function sha256Key(value: unknown): string | null {
	return typeof value === "string" && SHA256_KEY.test(value) ? value : null;
}

function metric(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function timestamp(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function positiveFinite(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function sumUsage(entries: readonly NativeUsageRow[]): ObservedUsage {
	if (entries.length === 0) return zeroUsage();
	let usage = zeroUsage();
	for (const row of entries) usage = addUsage(usage, row.usage);
	return usage;
}

function addUsage(left: ObservedUsage, right: ObservedUsage): ObservedUsage {
	const add = (first: number | null, second: number | null): number | null => first === null || second === null ? null : metric(first + second);
	return {
		input: add(left.input, right.input),
		output: add(left.output, right.output),
		cacheRead: add(left.cacheRead, right.cacheRead),
		cacheWrite: add(left.cacheWrite, right.cacheWrite),
		totalTokens: add(left.totalTokens, right.totalTokens),
		cost: add(left.cost, right.cost),
	};
}

function sameRow(left: NativeUsageRow, right: NativeUsageRow): boolean {
	return left.ownerSessionId === right.ownerSessionId && left.entryId === right.entryId && left.kind === right.kind
		&& left.modelKey === right.modelKey
		&& left.usage.input === right.usage.input && left.usage.output === right.usage.output
		&& left.usage.cacheRead === right.usage.cacheRead && left.usage.cacheWrite === right.usage.cacheWrite
		&& left.usage.totalTokens === right.usage.totalTokens && left.usage.cost === right.usage.cost;
}

function copyRow(row: NativeUsageRow): NativeUsageRow {
	return { ownerSessionId: row.ownerSessionId, entryId: row.entryId, kind: row.kind, modelKey: row.modelKey, usage: { ...row.usage } };
}

function emptyObservation(ownerSessionId: string | null): NativeObservation {
	return { available: true, ownerSessionId, entries: [], commands: [], usage: zeroUsage(), contextWindow: null, toolNames: null, capabilityKey: null, commandCoverage: "complete" };
}

function unavailable(): NativeObservation {
	return { available: false, ownerSessionId: null, entries: [], commands: [], usage: nullUsage(), contextWindow: null, toolNames: null, capabilityKey: null };
}

function zeroUsage(): ObservedUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
}

function nullUsage(): ObservedUsage {
	return { input: null, output: null, cacheRead: null, cacheWrite: null, totalTokens: null, cost: null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
