import { createHash } from "node:crypto";
import { AsyncDispatchCollector, type AsyncDispatchMetrics } from "./async-dispatch.ts";
import { nativeLeaf } from "../../../../extensions/subagents/observability.ts";
import type { ManagedRequestTelemetry } from "../../../../extensions/subagents/session-contracts.ts";

export interface DispatchEpoch { extensionEpoch: string; configurationEpoch: string; extensionActivatedAtMs: number; configurationActivatedAtMs: number }
type Group = { action: string; status: string; count: number };
export interface ManagedDispatchMetrics {
	recordedResults: number; ownedRequests: number; selectedRequests: number; excludedRequests: number; unassignedRequests: number;
	legacyResults: number; invalidRecords: number; conflictingRequests: number; duplicateRecords: number; copiedRecords: number;
	actions: Group[]; legacyActions: Group[]; errors: Array<{ code: string; count: number }>;
	launchedChildren: { known: number; unavailableRequests: number };
	replayedEpisodes: { known: number; unavailableRequests: number };
	async?: AsyncDispatchMetrics;
}
const actions = new Set(["create", "continue", "inspect", "apply", "close", "refresh", "join", "cancel"]);
const statuses = new Set(["accepted", "succeeded", "partial", "failed", "aborted"]);
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const id = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 10;
const keys = new Set(["version", "ownerSessionId", "invocationId", "startedAtMs", "durationMs", "extensionEpoch", "configurationEpoch", "requestedTasks", "admittedTasks", "launchedChildren", "replayedEpisodes"]);
function valid(value: unknown): value is ManagedRequestTelemetry {
	const data = object(value);
	return !!data && Object.keys(data).length === keys.size && Object.keys(data).every(key => keys.has(key))
		&& data.version === 1 && id(data.ownerSessionId) && id(data.invocationId) && finite(data.startedAtMs)
		&& (data.durationMs === null || finite(data.durationMs))
		&& [data.extensionEpoch, data.configurationEpoch].every(value => value === null || id(value))
		&& [data.requestedTasks, data.admittedTasks].every(value => value === null || count(value))
		&& count(data.launchedChildren) && count(data.replayedEpisodes)
		&& (data.requestedTasks === null ? data.launchedChildren === 0 && data.replayedEpisodes === 0 : data.launchedChildren + data.replayedEpisodes <= (data.requestedTasks as number))
		&& (data.configurationEpoch === null || data.extensionEpoch !== null)
		&& (data.admittedTasks === null ? data.launchedChildren === 0 : data.launchedChildren <= (data.admittedTasks as number))
		&& (data.requestedTasks === null || data.admittedTasks === null || (data.admittedTasks as number) <= (data.requestedTasks as number));
}
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	const row = object(value);
	return row ? `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonical(row[key])}`).join(",")}}` : JSON.stringify(value);
}
function group(rows: Array<{ action: string; status: string }>): Group[] {
	const groups = new Map<string, Group>();
	for (const row of rows) { const key = `${row.action}:${row.status}`; const prior = groups.get(key); if (prior) prior.count++; else groups.set(key, { action: row.action, status: row.status, count: 1 }); }
	return [...groups.values()].sort((a, b) => `${a.action}:${a.status}`.localeCompare(`${b.action}:${b.status}`));
}
type Request = { action: string; status: string; v3: boolean; telemetry: ManagedRequestTelemetry; code?: string; signature: string; conflict: boolean };
/** Counts transport evidence only; never parses prompts or grants billing/acceptance. */
export class ManagedDispatchCollector {
	private asynchronous = new AsyncDispatchCollector();
	private records = 0;
	private invalid = 0;
	private duplicates = 0;
	private copied = 0;
	private legacy: Array<{ action: string; status: string }> = [];
	private requests = new Map<string, Request>();
	private epoch: DispatchEpoch | undefined;
	constructor(epoch?: DispatchEpoch) { this.epoch = epoch; }
	add(text: string): void {
		const physical = text.length > 0 && nativeLeaf(text) !== undefined;
		let owner: unknown;
		for (const [index, line] of text.split("\n").entries()) {
			if (!line.trim()) continue;
			if (Buffer.byteLength(line) > 1024 * 1024) throw new Error("line_too_large");
			let row: Record<string, unknown> | undefined;
			try { row = object(JSON.parse(line)); } catch { continue; }
			if (index === 0 && row?.type === "session") owner = row.id;
			if (row?.type === "custom" && row.customType === "csheng.subagents.execution.v3") {
				if (physical) this.asynchronous.event(row.data, owner); else this.invalid++;
				continue;
			}
			const message = object(row?.message), details = object(message?.details);
			if (row?.type !== "message" || message?.role !== "toolResult" || message.toolName !== "csheng_subagent_sessions") continue;
			if (++this.records > 100000) throw new Error("too_many_runs");
			const action = details?.action === null ? "invalid-request" : details?.action;
			const status = details?.status;
			if (typeof action !== "string" || (action !== "invalid-request" && !actions.has(action)) || typeof status !== "string" || !statuses.has(status)) { this.invalid++; continue; }
			if (details?.schemaVersion === 1) { this.legacy.push({ action, status }); continue; }
			const telemetry = details?.requestTelemetry;
			if (!details || ![2, 3].includes(Number(details.schemaVersion)) || !physical || !Array.isArray(details.sessions) || details.sessions.length > 10 || !valid(telemetry)) { this.invalid++; continue; }
			if (telemetry.ownerSessionId !== owner) { this.copied++; continue; }
			if (!actions.has(action) && (status !== "failed" || telemetry.launchedChildren !== 0)) { this.invalid++; continue; }
			if (!["create", "continue"].includes(action) && (telemetry.launchedChildren !== 0 || telemetry.replayedEpisodes !== 0)) { this.invalid++; continue; }
			const signature = createHash("sha256").update(canonical(details)).digest("hex");
			const key = `${telemetry.ownerSessionId}:${telemetry.invocationId}`;
			const prior = this.requests.get(key);
			if (prior) { if (prior.signature !== signature) prior.conflict = true; else this.duplicates++; continue; }
			const rawCode = object(details?.error)?.code;
			const code = typeof rawCode === "string" && /^[a-z][a-z0-9_]{0,80}$/.test(rawCode) ? rawCode : undefined;
			if (details!.schemaVersion === 3) {
				if (details!.kind === "submission" && telemetry.launchedChildren !== 0) { this.invalid++; continue; }
				this.asynchronous.receipt(details!);
			}
			this.requests.set(key, { action, status, v3: details!.schemaVersion === 3, telemetry, signature, conflict: false, ...(code ? { code } : {}) });
		}
	}
	result(): ManagedDispatchMetrics {
		const selected: Request[] = [];
		let excluded = 0, unassigned = 0, conflicts = 0;
		for (const row of this.requests.values()) {
			if (row.conflict) { conflicts++; continue; }
			const t = row.telemetry, e = this.epoch;
			if (!e) { selected.push(row); continue; }
			if (t.extensionEpoch === null || t.configurationEpoch === null) { unassigned++; continue; }
			if (t.extensionEpoch !== e.extensionEpoch || t.configurationEpoch !== e.configurationEpoch || t.startedAtMs < Math.max(e.extensionActivatedAtMs, e.configurationActivatedAtMs)) { excluded++; continue; }
			selected.push(row);
		}
		const errors = new Map<string, number>();
		for (const row of selected) if (row.code) { const code = errors.size < 1000 || errors.has(row.code) ? row.code : "other"; errors.set(code, (errors.get(code) ?? 0) + 1); }
		const async = this.asynchronous.result(this.epoch);
		return { ...(async ? { async } : {}), recordedResults: this.records, ownedRequests: this.requests.size - conflicts, selectedRequests: selected.length, excludedRequests: excluded, unassignedRequests: unassigned,
			legacyResults: this.legacy.length, invalidRecords: this.invalid, conflictingRequests: conflicts, duplicateRecords: this.duplicates, copiedRecords: this.copied,
			actions: group(selected), legacyActions: group(this.legacy), errors: [...errors].map(([code, count]) => ({ code, count })).sort((a,b) => a.code.localeCompare(b.code)),
			launchedChildren: { known: selected.reduce((sum, row) => sum + (row.v3 ? 0 : row.telemetry.launchedChildren), 0) + (async?.launchedChildren.known ?? 0), unavailableRequests: this.legacy.length + this.invalid + conflicts },
			replayedEpisodes: { known: selected.reduce((sum, row) => sum + row.telemetry.replayedEpisodes, 0), unavailableRequests: this.legacy.length + this.invalid + conflicts },
		};
	}
}
export function extractManagedDispatch(text: string): ManagedDispatchMetrics { const collector = new ManagedDispatchCollector(); collector.add(text); return collector.result(); }
