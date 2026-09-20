import { createHash } from "node:crypto";
import { isNativeObservation, mergeOwnedUsage, nativeLeaf, normalizeCommandCorrelation, unavailableObservation, type NativeObservation, type ObservedUsage } from "../../../../extensions/subagents/observability.ts";
import { isLocalTiming, spanDuration } from "../../../../extensions/subagents/telemetry.ts";
import type { TimeSpan } from "../../../../extensions/subagents/contracts.ts";

/** Read-only, cumulative owned evidence. These are not bills per tool invocation. */
export interface ObservationMetrics {
	available: boolean;
	parentDispositionScope: "explicit-entry-range" | "unavailable";
	observedSessions: number;
	observedEpisodes: number;
	actions: Record<"create" | "continue" | "inspect" | "apply" | "close", number>;
	outcomes: { executionSucceeded: number; reportComplete: number; candidatesApplied: number; parentAccepted: boolean | null; semanticRepairs: number | null; takeovers: number | null; acceptedDeliveryWallMs: number | null };
	usage: { parent: ObservedUsage; children: ObservedUsage; total: ObservedUsage };
	timing: Record<"workerEffortMs" | "workerOccupiedMs" | "parentWallMs" | "parentActiveMs" | "parentLocalToolMs" | "parentDelegationWaitMs" | "parentReasoningMs" | "parentCompactionMs" | "unattributedMs", number | null>;
	childCapabilities: { manifestIdentities: number | null; contextWindows: number[] | null; configuredToolSets: string[][] | null };
	childTiming: Record<"episodeWallMs" | "activeEffortMs" | "reasoningEffortMs" | "localToolEffortMs" | "compactionEffortMs", number | null>;
	commands: { coverage: "complete" | "partial" | "unavailable"; observed: number | null; succeeded: number | null; failed: number | null; aborted: number | null; timeout: number | null; unknown: number | null; durationEffortMs: number | null; sourceEndpointChanges: number | null; environmentEndpointChanges: number | null };
	modelCoverage: "complete" | "unavailable";
	models: Array<{ modelKey: string | null; usage: ObservedUsage }>;
}
export interface ParentDisposition {
	version: 1;
	parentSessionId: string;
	startEntryId: string;
	endEntryId: string;
	outcome: "accepted" | "rejected";
	startedAtMs?: number | null;
	acceptedAtMs?: number | null;
	semanticRepairs?: number | null;
	takeovers?: number | null;
}
type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const id = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	const data = object(value);
	return data ? `{${Object.keys(data).sort().map((key) => `${JSON.stringify(key)}:${canonical(data[key])}`).join(",")}}` : JSON.stringify(value);
}
const usageKeys = ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost"] as const;
const nullUsage = (): ObservedUsage => unavailableObservation().usage;
function empty(): ObservationMetrics {
	return {
		available: false, parentDispositionScope: "unavailable", observedSessions: 0, observedEpisodes: 0,
		actions: { create: 0, continue: 0, inspect: 0, apply: 0, close: 0 },
		outcomes: { executionSucceeded: 0, reportComplete: 0, candidatesApplied: 0, parentAccepted: null, semanticRepairs: null, takeovers: null, acceptedDeliveryWallMs: null },
		usage: { parent: nullUsage(), children: nullUsage(), total: nullUsage() },
		timing: { workerEffortMs: null, workerOccupiedMs: null, parentWallMs: null, parentActiveMs: null, parentLocalToolMs: null, parentDelegationWaitMs: null, parentReasoningMs: null, parentCompactionMs: null, unattributedMs: null },
		childCapabilities: { manifestIdentities: null, contextWindows: null, configuredToolSets: null },
		childTiming: { episodeWallMs: null, activeEffortMs: null, reasoningEffortMs: null, localToolEffortMs: null, compactionEffortMs: null },
		commands: { coverage: "unavailable", observed: null, succeeded: null, failed: null, aborted: null, timeout: null, unknown: null, durationEffortMs: null, sourceEndpointChanges: null, environmentEndpointChanges: null }, modelCoverage: "unavailable", models: [],
	};
}
function parse(text: string): { header: RecordValue; body: RecordValue[]; positions: Map<string, number> } | undefined {
	// Share the producer's bounded physical-native validator; no partial tail repair.
	if (nativeLeaf(text) === undefined || !text) return undefined;
	const [header, ...body] = text.trimEnd().split("\n").map((line) => JSON.parse(line) as RecordValue);
	if (!header) return undefined;
	return { header, body, positions: new Map(body.map((entry, index) => [entry.id as string, index])) };
}
export function validateParentDisposition(value: unknown, text: string): ParentDisposition {
	const data = object(value); const parsed = parse(text);
	const keys = new Set(["version", "parentSessionId", "startEntryId", "endEntryId", "outcome", "startedAtMs", "acceptedAtMs", "semanticRepairs", "takeovers"]);
	if (!data || !parsed || Object.keys(data).some((key) => !keys.has(key)) || data.version !== 1 || data.parentSessionId !== parsed.header.id
		|| !id(data.startEntryId) || !id(data.endEntryId) || !parsed.positions.has(data.startEntryId) || !parsed.positions.has(data.endEntryId)
		|| parsed.positions.get(data.startEntryId)! > parsed.positions.get(data.endEntryId)!
		|| (data.outcome !== "accepted" && data.outcome !== "rejected")) throw new Error("invalid_parent_disposition_scope");
	for (const key of ["startedAtMs", "acceptedAtMs", "semanticRepairs", "takeovers"]) {
		if (key in data && data[key] !== null && (!finite(data[key]) || ((key === "semanticRepairs" || key === "takeovers") && !Number.isSafeInteger(data[key])))) throw new Error("invalid_parent_disposition_metric");
	}
	if (finite(data.startedAtMs) && finite(data.acceptedAtMs) && data.acceptedAtMs < data.startedAtMs) throw new Error("invalid_parent_disposition_metric");
	return data as unknown as ParentDisposition;
}
function union(spans: readonly TimeSpan[]): number {
	const sorted = spans.map((span) => ({ start: span.startMs as number, end: span.endMs as number })).sort((a, b) => a.start - b.start);
	let end = 0; let total = 0;
	for (const span of sorted) { total += Math.max(0, span.end - Math.max(end, span.start)); end = Math.max(end, span.end); }
	return total;
}
function directRowMatches(row: NativeObservation["entries"][number], source: RecordValue): boolean {
	const message = object(source.message);
	const failed = source.type === "custom" && source.customType === "csheng-compaction-unavailable";
	const kind = source.type === "message" && message?.role === "assistant" ? "assistant" : source.type === "compaction" || failed ? "compaction" : source.type === "branch_summary" ? "branch-summary" : null;
	if (kind !== row.kind) return false;
	const owner = source.type === "message" ? message! : source;
	const usage = object(owner.usage);
	const cost = object(usage?.cost);
	const values = Object.fromEntries(usageKeys.map((key) => {
		const value = failed ? null : key === "cost" ? cost?.total ?? usage?.cost : usage?.[key];
		return [key, finite(value) ? value : null];
	}));
	const modelKey = !failed && typeof owner.provider === "string" && owner.provider && typeof owner.model === "string" && owner.model
		? createHash("sha256").update(JSON.stringify([owner.provider, owner.model])).digest("hex") : null;
	return row.modelKey === modelKey && usageKeys.every((key) => row.usage[key] === values[key]);
}

function observationSignature(item: NativeObservation): string {
	item = normalizeCommandCorrelation(item);
	return canonical({ entries: item.entries, commands: item.commands, timing: item.timing ?? null, commandCoverage: item.commandCoverage ?? null,
		capabilityKey: item.capabilityKey, contextWindow: item.contextWindow, toolNames: item.toolNames });
}
function summarizeChildren(observations: NativeObservation[], result: ObservationMetrics): void {
	const episodes = new Map<string, NativeObservation>();
	const commands = new Map<string, NativeObservation["commands"][number]>();
	let commandConflict = false; let commandComplete = true;
	for (const raw of observations) {
		const observation = normalizeCommandCorrelation(raw);
		const key = canonical([observation.ownerSessionId, observation.entries.map((entry) => entry.entryId)]);
		const prior = episodes.get(key);
		if (prior && observationSignature(prior) !== observationSignature(observation)) return;
		episodes.set(key, observation); commandComplete &&= observation.commandCoverage === "complete";
		for (const command of observation.commands) {
			const key = canonical([command.ownerSessionId, command.entryId]); const prior = commands.get(key);
			if (prior && canonical(prior) !== canonical(command)) commandConflict = true;
			commands.set(key, command);
		}
	}
	const evidence = [...episodes.values()];
	if (evidence.every((item) => item.capabilityKey !== null)) result.childCapabilities.manifestIdentities = new Set(evidence.map((item) => item.capabilityKey)).size;
	if (evidence.every((item) => item.contextWindow !== null)) result.childCapabilities.contextWindows = [...new Set(evidence.map((item) => item.contextWindow!))].sort((a, b) => a - b);
	if (evidence.every((item) => item.toolNames !== null)) result.childCapabilities.configuredToolSets = [...new Set(evidence.map((item) => JSON.stringify([...item.toolNames!].sort())))].sort().map((item) => JSON.parse(item) as string[]);
	let wallKnown = true; let phasesKnown = true;
	const sums = { episodeWallMs: 0, activeEffortMs: 0, reasoningEffortMs: 0, localToolEffortMs: 0, compactionEffortMs: 0 };
	for (const observation of episodes.values()) {
		const timing = observation.timing;
		if (!isLocalTiming(timing) || spanDuration(timing.boundary) === null) wallKnown = false;
		else sums.episodeWallMs += spanDuration(timing.boundary)!;
		if (!isLocalTiming(timing) || !timing.complete) { phasesKnown = false; continue; }
		sums.activeEffortMs += union([...timing.spans.assistant, ...timing.spans.localTool, ...timing.spans.compaction]);
		sums.reasoningEffortMs += union(timing.spans.reasoning); sums.localToolEffortMs += union(timing.spans.localTool); sums.compactionEffortMs += union(timing.spans.compaction);
	}
	for (const key of Object.keys(sums) as Array<keyof typeof sums>) result.childTiming[key] = (key === "episodeWallMs" ? wallKnown : phasesKnown) && finite(sums[key]) ? sums[key] : null;
	if (commandConflict) return;
	const rows = [...commands.values()];
	result.commands.coverage = commandComplete ? "complete" : "partial"; result.commands.observed = rows.length;
	for (const status of ["succeeded", "failed", "aborted", "timeout", "unknown"] as const) result.commands[status] = rows.filter((row) => row.status === status).length;
	const durations = rows.map(spanDuration);
	const total = durations.reduce<number>((sum, value) => sum + (value ?? 0), 0);
	result.commands.durationEffortMs = commandComplete && durations.every((value) => value !== null) && finite(total) ? total : null;
	for (const [before, after, output] of [["sourceBeforeKey", "sourceAfterKey", "sourceEndpointChanges"], ["environmentBeforeKey", "environmentAfterKey", "environmentEndpointChanges"]] as const) {
		result.commands[output] = commandComplete && rows.every((row) => typeof row[before] === "string" && typeof row[after] === "string") ? rows.filter((row) => row[before] !== row[after]).length : null;
	}
}

export function extractObservationMetrics(text: string, disposition?: unknown): ObservationMetrics {
	const result = empty();
	const declared = disposition === undefined ? undefined : validateParentDisposition(disposition, text);
	if (declared) {
		result.parentDispositionScope = "explicit-entry-range";
		result.outcomes.parentAccepted = declared.outcome === "accepted";
		result.outcomes.semanticRepairs = declared.semanticRepairs ?? null; result.outcomes.takeovers = declared.takeovers ?? null;
		result.outcomes.acceptedDeliveryWallMs = declared.outcome === "accepted" && finite(declared.startedAtMs) && finite(declared.acceptedAtMs) ? declared.acceptedAtMs - declared.startedAtMs : null;
	}
	const parsed = parse(text); if (!parsed) return result;
	const parents: NativeObservation[] = []; const children: NativeObservation[] = [];
	const episodeObservations = new Map<string, NativeObservation>();
	const claimed = new Set<number>(); const ranges = new Map<string, string>();
	const sessions = new Set<string>(); const episodes = new Map<string, { succeeded: boolean; complete: boolean }>(); const applied = new Set<string>();
	let validTiming = true; let validWall = true; let validWorkers = true; let invalidEvidence = false;
	const totals = { workerEffortMs: 0, workerOccupiedMs: 0, parentWallMs: 0, parentActiveMs: 0, parentLocalToolMs: 0, parentDelegationWaitMs: 0, parentReasoningMs: 0, parentCompactionMs: 0, unattributedMs: 0 };
	// Async completions may arrive outside every parent interaction range. Their
	// owner-tagged native observations remain owned usage, not receipt usage.
	const eventIds = new Map<string, string>();
	for (const entry of parsed.body) {
		if (entry.type !== "custom" || entry.customType !== "csheng.subagents.execution.v3") continue;
		const event = object(entry.data);
		if (object(event?.owner)?.sessionId !== parsed.header.id) continue;
		if (!event || event.version !== 3 || !id(event.eventId) || !Array.isArray(event.sessions) || event.sessions.length > 10) { invalidEvidence = true; continue; }
		const serialized = canonical(event); const priorEvent = eventIds.get(event.eventId);
		if (priorEvent) { if (priorEvent !== serialized) invalidEvidence = true; continue; }
		eventIds.set(event.eventId, serialized);
		for (const raw of event.sessions) {
			const view = object(raw), task = object(view?.result);
			if (!view || !id(view.handle) || !Number.isSafeInteger(view.episode) || !task) { invalidEvidence = true; continue; }
			sessions.add(view.handle);
			const key = JSON.stringify([view.handle, view.episode]);
			const outcome = { succeeded: task.status === "succeeded", complete: view.reportComplete === true };
			if (episodes.has(key) && canonical(episodes.get(key)) !== canonical(outcome)) invalidEvidence = true;
			episodes.set(key, outcome);
			if (object(task.telemetry)?.childStarted !== false && view.execution) {
				const observation = isNativeObservation(task.observation) && task.observation.ownerSessionId !== parsed.header.id ? task.observation : unavailableObservation();
				const prior = episodeObservations.get(key);
				if (prior?.available && observation.available && observationSignature(prior) !== observationSignature(observation)) invalidEvidence = true;
				if (!prior?.available) episodeObservations.set(key, observation);
				// Legacy interaction-local occupancy cannot describe cross-turn jobs.
				// V3 queue/workspace/child/lifecycle timings are reported separately.
				if (event.foreground !== true) validWorkers = false;
			}
		}
	}
	for (const [position, entry] of parsed.body.entries()) {
		if (entry.type !== "custom" || entry.customType !== "csheng-parent-observation") continue;
		const data = object(entry.data); const native = data?.native;
		// A copied parent marker cannot grant its old child's usage to this fork.
		if (isNativeObservation(native) && native.ownerSessionId !== null && native.ownerSessionId !== parsed.header.id) continue;
		if (!data || Object.keys(data).some((key) => !["version", "native", "range", "timing", "runs"].includes(key)) || data.version !== 1 || !isNativeObservation(native) || native.ownerSessionId !== parsed.header.id
			|| !Array.isArray(data.runs) || data.runs.length > 32) { invalidEvidence = true; continue; }
		const range = object(data.range);
		const start = range?.startLeaf === null ? -1 : typeof range?.startLeaf === "string" ? parsed.positions.get(range.startLeaf) : undefined;
		const end = typeof range?.endLeaf === "string" ? parsed.positions.get(range.endLeaf) : undefined;
		if (!range || Object.keys(range).length !== 2 || start === undefined || end === undefined || end < start || end >= position || (parsed.header.parentSession !== undefined && start === -1)) { invalidEvidence = true; continue; }
		const key = JSON.stringify([start, end]); const serialized = JSON.stringify(data);
		if (ranges.has(key)) { if (ranges.get(key) !== serialized) invalidEvidence = true; continue; }
		ranges.set(key, serialized);
		const scope = parsed.body.slice(start + 1, end + 1);
		if (scope.some((_item, index) => claimed.has(start + index + 1))) { invalidEvidence = true; continue; }
		for (let index = start + 1; index <= end; index++) claimed.add(index);
		const expectedRows = scope.filter((item) => (item.type === "message" && object(item.message)?.role === "assistant") || item.type === "compaction" || item.type === "branch_summary" || (item.type === "custom" && item.customType === "csheng-compaction-unavailable"));
		const rowIds = new Set(native.entries.map((row) => row.entryId));
		if (native.available && (rowIds.size !== expectedRows.length || native.entries.length !== expectedRows.length || native.entries.some((row) => {
			const rowPosition = parsed.positions.get(row.entryId);
			return rowPosition === undefined || rowPosition <= start || rowPosition > end || !directRowMatches(row, parsed.body[rowPosition]!);
		}))) { invalidEvidence = true; continue; }
		parents.push(native);
		const windowEpisodes = new Map<string, NativeObservation>();
		for (const item of scope) {
			const message = object(item.message); const details = object(message?.details);
			if (item.type !== "message" || message?.role !== "toolResult" || !details) continue;
			if (message.toolName === "csheng_subagent_sessions" && (details.schemaVersion === 1 || details.schemaVersion === 2 || details.schemaVersion === 3) && typeof details.action === "string" && Object.hasOwn(result.actions, details.action) && Array.isArray(details.sessions) && details.sessions.length <= 10) {
				result.actions[details.action as keyof typeof result.actions]++;
				if (details.schemaVersion === 3 && details.kind === "submission") continue;
				for (const raw of details.sessions) {
					const view = object(raw); if (!view || !id(view.handle) || !Number.isSafeInteger(view.episode) || (view.episode as number) < 0) { invalidEvidence = true; continue; }
					sessions.add(view.handle);
					const task = object(view.result);
					if (task) {
						const episodeKey = JSON.stringify([view.handle, view.episode]);
						const outcome = { succeeded: task.status === "succeeded", complete: view.reportComplete === true };
						const prior = episodes.get(episodeKey);
						if (prior && JSON.stringify(prior) !== JSON.stringify(outcome)) invalidEvidence = true;
						episodes.set(episodeKey, outcome);
						if (object(task.telemetry)?.childStarted !== false) {
							const observation = isNativeObservation(task.observation) && task.observation.ownerSessionId !== parsed.header.id ? task.observation : unavailableObservation();
							const priorObservation = episodeObservations.get(episodeKey);
							if (observation.available && priorObservation?.available) {
								if (observationSignature(observation) !== observationSignature(priorObservation)) invalidEvidence = true;
							}
							if (!priorObservation?.available) episodeObservations.set(episodeKey, observation);
							windowEpisodes.set(episodeKey, episodeObservations.get(episodeKey)!);
						}
					}
					const candidate = object(view.candidate); if (candidate?.status === "applied" && id(candidate.id)) applied.add(candidate.id);
				}
			} else if (message.toolName === "csheng_subagents" && Array.isArray(details.tasks) && details.tasks.length <= 10) {
				for (const task of details.tasks) {
					const value = object(task);
					if (value && object(value.telemetry)?.childStarted !== false) {
						const observation = isNativeObservation(value.observation) && value.observation.ownerSessionId !== parsed.header.id ? value.observation : unavailableObservation();
						children.push(observation);
						windowEpisodes.set(JSON.stringify([item.id, value.id]), observation);
					}
				}
			}
		}
		// A later tool-result handler may remove views even when the launch observer saw children.
		// Do not turn that loss into a complete zero-cost prefix.
		const availableOwners = new Map<string, number>();
		for (const observation of windowEpisodes.values()) if (observation.available && observation.ownerSessionId) availableOwners.set(observation.ownerSessionId, (availableOwners.get(observation.ownerSessionId) ?? 0) + 1);
		for (const raw of data.runs) {
			const telemetry = object(object(raw)?.telemetry); const spans = object(telemetry?.timing)?.children;
			if (!telemetry || !Number.isSafeInteger(telemetry.launchedChildren) || (telemetry.launchedChildren as number) < 0 || !Array.isArray(spans) || spans.length !== telemetry.launchedChildren) { children.push(unavailableObservation()); continue; }
			for (const span of spans) {
				const owner = object(span)?.taskId; const count = typeof owner === "string" ? availableOwners.get(owner) ?? 0 : 0;
				if (count === 0) children.push(unavailableObservation());
				else availableOwners.set(owner as string, count - 1);
			}
		}
		const timing = data.timing;
		if (!isLocalTiming(timing) || spanDuration(timing.boundary) === null) validWall = false;
		else totals.parentWallMs += spanDuration(timing.boundary)!;
		if (!isLocalTiming(timing) || !timing.complete) { validTiming = false; validWorkers = false; continue; }
		const active = [...timing.spans.assistant, ...timing.spans.localTool, ...timing.spans.compaction];
		const wall = spanDuration(timing.boundary)!;
		totals.parentActiveMs += union(active); totals.parentLocalToolMs += union(timing.spans.localTool);
		totals.parentReasoningMs += union(timing.spans.reasoning); totals.parentCompactionMs += union(timing.spans.compaction);
		totals.parentDelegationWaitMs += union(timing.spans.delegationWait);
		totals.unattributedMs += wall - union([...active, ...timing.spans.delegationWait]);
		const workers: TimeSpan[] = [];
		for (const rawRun of data.runs) {
			const run = object(rawRun); const telemetry = object(run?.telemetry); const runTiming = object(telemetry?.timing);
			if (!run || run.clockKey !== timing.clockKey || !finite(run.originMs) || !finite(timing.originMs) || !telemetry || telemetry.schemaVersion !== 4
				|| !runTiming || runTiming.complete !== true || !Array.isArray(runTiming.children) || runTiming.children.length > 10
				|| telemetry.launchedChildren !== runTiming.children.length || !finite(telemetry.runDurationMs)) { validWorkers = false; continue; }
			for (const childValue of runTiming.children) {
				const child = object(childValue); const duration = child ? spanDuration(child as unknown as TimeSpan) : null;
				if (!child || duration === null || !["worker", "reviewer", "explorer"].includes(child.role as string) || (child.endMs as number) > telemetry.runDurationMs) { validWorkers = false; continue; }
				const startMs = run.originMs - timing.originMs + (child.startMs as number); const endMs = startMs + duration;
				if (!finite(startMs) || !finite(endMs) || startMs < timing.boundary.startMs! || endMs > timing.boundary.endMs!) { validWorkers = false; continue; }
				if (child.role === "worker") workers.push({ startMs, endMs });
			}
		}
		totals.workerEffortMs += workers.reduce((sum, span) => sum + spanDuration(span)!, 0); totals.workerOccupiedMs += union(workers);
	}
	result.observedSessions = sessions.size; result.observedEpisodes = episodes.size;
	result.outcomes.executionSucceeded = [...episodes.values()].filter((value) => value.succeeded).length;
	result.outcomes.reportComplete = [...episodes.values()].filter((value) => value.complete).length; result.outcomes.candidatesApplied = applied.size;
	if (invalidEvidence || parents.length === 0) return result;
	result.available = true; children.push(...episodeObservations.values());
	result.usage.parent = mergeOwnedUsage(parents).usage; result.usage.children = mergeOwnedUsage(children).usage;
	const merged = mergeOwnedUsage([...parents, ...children]); result.usage.total = merged.usage;
	if (mergeOwnedUsage(children).available) summarizeChildren(children, result);
	const models = new Map<string | null, NativeObservation[]>();
	for (const row of merged.entries) {
		const group = models.get(row.modelKey) ?? [];
		group.push({ ...unavailableObservation(), available: true, ownerSessionId: row.ownerSessionId, entries: [row] }); models.set(row.modelKey, group);
	}
	if (merged.available && models.size <= 1000) result.modelCoverage = "complete";
	if (result.modelCoverage === "complete") result.models = [...models].map(([modelKey, observations]) => ({ modelKey, usage: mergeOwnedUsage(observations).usage })).sort((a, b) => (a.modelKey ?? "").localeCompare(b.modelKey ?? ""));
	for (const key of Object.keys(totals) as Array<keyof typeof totals>) {
		const known = key.startsWith("worker") ? validWorkers : key === "parentWallMs" ? validWall : validTiming;
		result.timing[key] = known && finite(totals[key]) ? totals[key] : null;
	}
	return result;
}
