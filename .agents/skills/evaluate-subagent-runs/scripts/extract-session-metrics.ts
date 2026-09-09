import { lstat, opendir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractObservationMetrics, type ObservationMetrics } from "./observation-metrics.ts";
import { extractManagedDispatch, ManagedDispatchCollector, type ManagedDispatchMetrics } from "./managed-dispatch.ts";
import { workerIntervalTotals } from "../../../../extensions/subagents/telemetry.ts";

const OUTPUT_SCHEMA_VERSION = 4;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,127}$/;
const TOOL_NAME = "csheng_subagents";
const MAX_RUN_RECORDS = 1_000;
const ROLES = ["explorer", "reviewer", "worker"] as const;
const RUN_STATUSES = ["succeeded", "partial", "failed", "aborted"] as const;
const ROUTE_SOURCES = ["parent", "package-default", "user-config"] as const;
const SELECTION_SOURCES = ["role-default", "explicit-task"] as const;
type Role = (typeof ROLES)[number];
type RunStatus = (typeof RUN_STATUSES)[number];

interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

interface RoleMetrics {
	tasks: number;
	launchedChildren: number;
	succeeded: number;
	failed: number;
	durationMs: number;
	changedPaths: number;
	usage: Usage;
}

interface RouteMetrics extends RoleMetrics {
	provider: string;
	model: string;
	thinking: string;
	source: string;
	selectionSource: string;
}

interface EvidenceTotal {
	known: number;
	unavailableRuns: number;
}

interface RunMetrics {
	ordinal: number;
	status: RunStatus;
	telemetryAuthority: "authoritative" | "legacy-inferred";
	telemetrySchemaVersion: 1 | 2 | 3 | 4 | null;
	requestedTasks: number | null;
	admittedTasks: number | null;
	launchedChildren: number;
	requestedDependencyEdges: number | null;
	admittedDependencyEdges: number | null;
	explicitModelTasks: number | null;
	explicitThinkingTasks: number | null;
	runDurationMs: number | null;
	timing: TimingMetrics | null;
	peakConcurrency: number | null;
	roles: Record<Role, RoleMetrics>;
	errorCodes: string[];
}

export interface SessionMetrics {
	schemaVersion: typeof OUTPUT_SCHEMA_VERSION;
	/** Legacy counters above observations cover csheng_subagents only. */
	observations: ObservationMetrics;
	managedDispatch: ManagedDispatchMetrics;
	source: {
		legacyCountersScope: "csheng_subagents-only";
		sessionId: string;
		telemetryMode: "authoritative" | "legacy" | "mixed";
		selectionMode: "exact-session" | "current-epoch";
		scannedSessions: number;
		matchedSessions: number;
		selectedRuns: number;
		excludedRuns: number;
		unavailableProvenanceRuns: number;
		planEligibility: "unavailable";
	};
	totals: {
		toolCalls: number;
		succeededRuns: number;
		partialRuns: number;
		failedRuns: number;
		abortedRuns: number;
		requestedTasks: number;
		admittedTasks: number;
		tasks: number;
		launchedChildren: number;
		singletonRuns: number;
		zeroChangeWorkers: number;
		hardDependencyEdges: EvidenceTotal;
		explicitModelTasks: EvidenceTotal;
		explicitThinkingTasks: EvidenceTotal;
		mechanicalDispatchCorrectionCandidates: number;
		semanticRepairs: null;
		semanticRepairEvidence: "unavailable";
		durationMs: number;
		changedPaths: number;
		usage: Usage;
	};
	roles: Record<Role, RoleMetrics>;
	routes: RouteMetrics[];
	errors: Array<{ code: string; count: number }>;
	concurrency: {
		requestedPeak: number;
		observedPeak: number | null;
	};
	runs: RunMetrics[];
}

function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function emptyRoleMetrics(): RoleMetrics {
	return {
		tasks: 0,
		launchedChildren: 0,
		succeeded: 0,
		failed: 0,
		durationMs: 0,
		changedPaths: 0,
		usage: emptyUsage(),
	};
}

function emptyRunRoles(): Record<Role, RoleMetrics> {
	return {
		explorer: emptyRoleMetrics(),
		reviewer: emptyRoleMetrics(),
		worker: emptyRoleMetrics(),
	};
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function number(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

interface TimingMetrics {
	boundary: "tool-entry" | "scheduler";
	complete: boolean;
	schedulerMs: number | null;
	workerEffortMs: number | null;
	workerOccupiedMs: number | null;
	waitMsByReason: Record<string, number> | null;
}

function duration(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function timingMetrics(value: unknown, wall: number | null): TimingMetrics | null {
	const timing = record(value);
	if (!timing || (timing.boundary !== "tool-entry" && timing.boundary !== "scheduler") || typeof timing.complete !== "boolean") return null;
	const result: TimingMetrics = { boundary: timing.boundary, complete: false, schedulerMs: null, workerEffortMs: null, workerOccupiedMs: null, waitMsByReason: null };
	const span = (value: unknown): { start: number; end: number } | undefined => {
		const item = record(value);
		const start = duration(item?.startMs);
		const end = duration(item?.endMs);
		return start !== null && end !== null && end >= start && wall !== null && end <= wall ? { start, end } : undefined;
	};
	const scheduler = span(timing.scheduler);
	if (scheduler) result.schedulerMs = scheduler.end - scheduler.start;
	if (!timing.complete || wall === null || !Array.isArray(timing.children) || timing.children.length > 10 || !Array.isArray(timing.waits) || timing.waits.length > 2048) return result;
	if (timing.scheduler !== null && !scheduler) return result;
	const workers: Array<{ start: number; end: number }> = [];
	for (const child of timing.children) {
		const item = record(child);
		const interval = span(child);
		if (!item || !ROLES.includes(item.role as Role) || !interval) return result;
		if (item.role === "worker") workers.push(interval);
	}
	const waitMs: Record<string, number> = { dependency: 0, capacity: 0, "role-capacity": 0, "resource-lock": 0, ready: 0 };
	for (const wait of timing.waits) {
		const interval = span(wait);
		const reasons = record(wait)?.reasons;
		if (!interval || !Array.isArray(reasons) || reasons.length < 1 || reasons.length > 5 || new Set(reasons).size !== reasons.length) return result;
		for (const reason of reasons) {
			if (typeof reason !== "string" || !Object.hasOwn(waitMs, reason)) return result;
			waitMs[reason] = (waitMs[reason] ?? 0) + interval.end - interval.start;
		}
	}
	const totals = workerIntervalTotals({
		boundary: timing.boundary, complete: true, scheduler: null, waits: [],
		children: workers.map(({ start, end }) => ({ taskId: "redacted", role: "worker", startMs: start, endMs: end })),
	});
	if (![totals.effortMs, totals.occupiedMs, ...Object.values(waitMs)].every((value) => value !== null && Number.isFinite(value))) return result;
	return { ...result, complete: true, workerEffortMs: totals.effortMs, workerOccupiedMs: totals.occupiedMs, waitMsByReason: waitMs };
}

function nonNegativeInteger(value: unknown): number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function string(value: unknown, fallback = "unknown"): string {
	return typeof value === "string" && value ? value : fallback;
}

function runStatus(value: unknown): RunStatus {
	return typeof value === "string" && RUN_STATUSES.includes(value as RunStatus)
		? value as RunStatus
		: "failed";
}

function routeSource(value: unknown): string {
	return typeof value === "string" && ROUTE_SOURCES.includes(value as (typeof ROUTE_SOURCES)[number])
		? value
		: "unknown";
}

function selectionSource(value: unknown): string {
	return typeof value === "string" && SELECTION_SOURCES.includes(value as (typeof SELECTION_SOURCES)[number])
		? value
		: "unavailable";
}

function safeErrorCode(value: unknown): string | undefined {
	return typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : undefined;
}

function usage(value: unknown): Usage {
	const item = record(value);
	return {
		input: number(item?.input),
		output: number(item?.output),
		cacheRead: number(item?.cacheRead),
		cacheWrite: number(item?.cacheWrite),
		cost: number(item?.cost),
		turns: number(item?.turns),
	};
}

function addUsage(target: Usage, source: Usage): void {
	target.input += source.input;
	target.output += source.output;
	target.cacheRead += source.cacheRead;
	target.cacheWrite += source.cacheWrite;
	target.cost += source.cost;
	target.turns += source.turns;
}

function errorCodeFromContent(content: unknown): string | undefined {
	if (!Array.isArray(content)) return undefined;
	for (const part of content) {
		const text = record(part)?.text;
		if (typeof text !== "string") continue;
		const match = /\(([A-Za-z0-9_-]+)\):/.exec(text) ?? /Error \(([A-Za-z0-9_-]+)\):/.exec(text);
		const code = safeErrorCode(match?.[1]);
		if (code) return code;
	}
	return undefined;
}

function sessionIdFromPath(path: string): string {
	const name = basename(path, ".jsonl");
	const separator = name.lastIndexOf("_");
	return separator >= 0 ? name.slice(separator + 1) : name;
}

async function assertRegularFile(path: string): Promise<void> {
	const info = await lstat(path);
	if (info.isSymbolicLink() || !info.isFile()) throw new Error("session_must_be_regular_file");
}

async function findSessions(root: string, id: string, matches: string[]): Promise<void> {
	const directory = await opendir(root);
	for await (const entry of directory) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) await findSessions(path, id, matches);
		else if (entry.isFile() && entry.name.endsWith(`_${id}.jsonl`)) matches.push(path);
	}
}

export async function resolveSessionPath(input: string, sessionsRoot = join(homedir(), ".pi", "agent", "sessions")): Promise<string> {
	if (input.includes("/") || input.includes("\\") || input.endsWith(".jsonl")) {
		const path = resolve(input);
		await assertRegularFile(path);
		return path;
	}
	if (!SESSION_ID.test(input)) throw new Error("invalid_session_id");
	const matches: string[] = [];
	await findSessions(sessionsRoot, input, matches);
	if (matches.length === 0) throw new Error("session_not_found");
	if (matches.length > 1) throw new Error("ambiguous_session_id");
	await assertRegularFile(matches[0] as string);
	return matches[0] as string;
}

export function extractSessionMetrics(text: string, sourcePath = "session.jsonl", disposition?: unknown): SessionMetrics {
	const messages: Record<string, unknown>[] = [];
	let lineNumber = 0;
	for (const line of text.split("\n")) {
		lineNumber += 1;
		if (!line.trim()) continue;
		let event: unknown;
		try {
			event = JSON.parse(line) as unknown;
		} catch {
			throw new Error(`invalid_session_jsonl_line_${lineNumber}`);
		}
		const item = record(event);
		const message = record(item?.message);
		if (item?.type === "message" && message?.role === "toolResult" && message.toolName === TOOL_NAME) {
			messages.push(message);
		}
	}

	const observations = extractObservationMetrics(text, disposition);
	const totals = {
		toolCalls: messages.length,
		succeededRuns: 0,
		partialRuns: 0,
		failedRuns: 0,
		abortedRuns: 0,
		requestedTasks: 0,
		admittedTasks: 0,
		tasks: 0,
		launchedChildren: 0,
		singletonRuns: 0,
		zeroChangeWorkers: 0,
		hardDependencyEdges: { known: 0, unavailableRuns: 0 },
		explicitModelTasks: { known: 0, unavailableRuns: 0 },
		explicitThinkingTasks: { known: 0, unavailableRuns: 0 },
		mechanicalDispatchCorrectionCandidates: 0,
		semanticRepairs: null,
		semanticRepairEvidence: "unavailable" as const,
		durationMs: 0,
		changedPaths: 0,
		usage: emptyUsage(),
	};
	const roles = emptyRunRoles();
	const routes = new Map<string, RouteMetrics>();
	const errors = new Map<string, number>();
	const runs: RunMetrics[] = [];
	let authoritative = 0;
	let legacy = 0;
	let requestedPeak = 0;
	let observedPeak = 0;
	let hasObservedPeak = false;

	for (const [index, message] of messages.entries()) {
		const details = record(message.details) ?? {};
		const telemetry = record(details.telemetry);
		const tasks = Array.isArray(details.tasks) ? details.tasks.map(record).filter((task): task is Record<string, unknown> => task !== undefined) : [];
		const telemetryVersion = telemetry?.schemaVersion === 4 ? 4 : telemetry?.schemaVersion === 3 ? 3 : telemetry?.schemaVersion === 2 ? 2 : telemetry?.schemaVersion === 1 ? 1 : null;
		const isAuthoritative = telemetryVersion !== null;
		const isSchemaTwo = telemetryVersion === 2 || telemetryVersion === 3 || telemetryVersion === 4;
		if (isAuthoritative) authoritative += 1;
		else legacy += 1;
		const status = runStatus(details.status);
		if (status === "succeeded") totals.succeededRuns += 1;
		else if (status === "partial") totals.partialRuns += 1;
		else if (status === "aborted") totals.abortedRuns += 1;
		else totals.failedRuns += 1;

		const errorCodes = new Set<string>();
		const contentError = errorCodeFromContent(message.content);
		const runError = (isAuthoritative ? safeErrorCode(telemetry?.runErrorCode) : undefined) ?? contentError;
		const requestedTasks = isAuthoritative ? nonNegativeInteger(telemetry?.requestedTasks) : tasks.length > 0 ? tasks.length : null;
		const admittedTasks = isAuthoritative ? nonNegativeInteger(telemetry?.admittedTasks) : tasks.length > 0 ? tasks.length : null;
		let launchedChildren = isAuthoritative ? nonNegativeInteger(telemetry?.launchedChildren) : 0;
		let runDurationMs = telemetryVersion === 4 ? duration(telemetry?.runDurationMs) : isAuthoritative ? number(telemetry?.runDurationMs) : 0;
		const peakConcurrency = isAuthoritative ? nonNegativeInteger(telemetry?.peakConcurrency) : null;
		const requestedDependencyEdges = isSchemaTwo ? nonNegativeInteger(telemetry?.requestedDependencyEdges) : null;
		const admittedDependencyEdges = isSchemaTwo ? nonNegativeInteger(telemetry?.admittedDependencyEdges) : null;
		const explicitModelTasks = isSchemaTwo ? nonNegativeInteger(telemetry?.explicitModelTasks) : null;
		const explicitThinkingTasks = isSchemaTwo ? nonNegativeInteger(telemetry?.explicitThinkingTasks) : null;
		if (requestedTasks !== null) {
			totals.requestedTasks += requestedTasks;
			requestedPeak = Math.max(requestedPeak, requestedTasks);
			if (requestedTasks === 1) totals.singletonRuns += 1;
		}
		if (admittedTasks !== null) totals.admittedTasks += admittedTasks;
		if (isSchemaTwo) {
			totals.hardDependencyEdges.known += requestedDependencyEdges as number;
			totals.explicitModelTasks.known += explicitModelTasks as number;
			totals.explicitThinkingTasks.known += explicitThinkingTasks as number;
		} else {
			totals.hardDependencyEdges.unavailableRuns += 1;
			totals.explicitModelTasks.unavailableRuns += 1;
			totals.explicitThinkingTasks.unavailableRuns += 1;
		}
		if (peakConcurrency !== null) {
			hasObservedPeak = true;
			observedPeak = Math.max(observedPeak, peakConcurrency);
		}

		const runRoles = emptyRunRoles();
		for (const task of tasks) {
			const roleValue = string(task.role);
			if (!ROLES.includes(roleValue as Role)) continue;
			const role = roleValue as Role;
			const taskUsage = usage(task.usage);
			const taskTelemetry = record(task.telemetry);
			const launched = isAuthoritative
				? taskTelemetry?.childStarted === true
				: taskUsage.turns > 0;
			if (!isAuthoritative && launched) launchedChildren += 1;
			const durationMs = number(task.durationMs);
			if (!isAuthoritative) runDurationMs = Math.max(runDurationMs ?? 0, durationMs);
			const changedPathsValue = task.changedPaths;
			const hasChangedPaths = Array.isArray(changedPathsValue);
			const changedPaths = hasChangedPaths ? changedPathsValue.length : 0;
			const taskStatus = string(task.status);
			const taskError = safeErrorCode(record(task.error)?.code);
			if (taskError) {
				errorCodes.add(taskError);
				errors.set(taskError, (errors.get(taskError) ?? 0) + 1);
			}
			if (role === "worker" && taskStatus === "succeeded" && hasChangedPaths && changedPaths === 0) {
				totals.zeroChangeWorkers += 1;
			}

			totals.tasks += 1;
			totals.durationMs += durationMs;
			totals.changedPaths += changedPaths;
			addUsage(totals.usage, taskUsage);
			for (const roleMetric of [roles[role], runRoles[role]]) {
				roleMetric.tasks += 1;
				roleMetric.launchedChildren += launched ? 1 : 0;
				roleMetric.succeeded += taskStatus === "succeeded" ? 1 : 0;
				roleMetric.failed += taskStatus === "failed" ? 1 : 0;
				roleMetric.durationMs += durationMs;
				roleMetric.changedPaths += changedPaths;
				addUsage(roleMetric.usage, taskUsage);
			}

			const route = record(task.route);
			if (route) {
				const provider = string(route.provider);
				const model = string(route.model);
				const thinking = string(route.thinking);
				const source = routeSource(route.source);
				const routeSelectionSource = selectionSource(route.selectionSource);
				const key = `${provider}\u0000${model}\u0000${thinking}\u0000${source}\u0000${routeSelectionSource}`;
				const metric = routes.get(key) ?? { provider, model, thinking, source, selectionSource: routeSelectionSource, ...emptyRoleMetrics() };
				metric.tasks += 1;
				metric.launchedChildren += launched ? 1 : 0;
				metric.succeeded += taskStatus === "succeeded" ? 1 : 0;
				metric.failed += taskStatus === "failed" ? 1 : 0;
				metric.durationMs += durationMs;
				metric.changedPaths += changedPaths;
				addUsage(metric.usage, taskUsage);
				routes.set(key, metric);
			}
		}
		if (runError && !errorCodes.has(runError)) {
			errorCodes.add(runError);
			errors.set(runError, (errors.get(runError) ?? 0) + 1);
		}
		totals.launchedChildren += launchedChildren;
		if (launchedChildren === 0 && status === "failed") totals.mechanicalDispatchCorrectionCandidates += 1;
		if (runs.length < MAX_RUN_RECORDS) {
			runs.push({
				ordinal: index + 1,
				status,
				telemetryAuthority: isAuthoritative ? "authoritative" : "legacy-inferred",
				telemetrySchemaVersion: telemetryVersion,
				requestedTasks,
				admittedTasks,
				launchedChildren,
				requestedDependencyEdges,
				admittedDependencyEdges,
				explicitModelTasks,
				explicitThinkingTasks,
				runDurationMs,
				timing: telemetryVersion === 4 ? timingMetrics(telemetry?.timing, runDurationMs) : null,
				peakConcurrency,
				roles: runRoles,
				errorCodes: [...errorCodes].sort(),
			});
		}
	}

	return {
		schemaVersion: OUTPUT_SCHEMA_VERSION,
		observations,
		managedDispatch: extractManagedDispatch(text),
		source: {
			legacyCountersScope: "csheng_subagents-only",
			sessionId: sessionIdFromPath(sourcePath),
			telemetryMode: (authoritative > 0 || observations.available) && legacy > 0 ? "mixed" : authoritative > 0 || observations.available ? "authoritative" : "legacy",
			selectionMode: "exact-session",
			scannedSessions: 1,
			matchedSessions: messages.length > 0 || observations.available ? 1 : 0,
			selectedRuns: messages.length,
			excludedRuns: 0,
			unavailableProvenanceRuns: messages.length,
			planEligibility: "unavailable",
		},
		totals,
		roles,
		routes: [...routes.values()].sort((left, right) =>
			`${left.provider}/${left.model}:${left.thinking}:${left.source}:${left.selectionSource}`.localeCompare(`${right.provider}/${right.model}:${right.thinking}:${right.source}:${right.selectionSource}`)),
		errors: [...errors.entries()].map(([code, count]) => ({ code, count })).sort((left, right) => left.code.localeCompare(right.code)),
		concurrency: { requestedPeak, observedPeak: hasObservedPeak ? observedPeak : null },
		runs,
	};
}

function usageText(): string {
	return "Usage: extract-session-metrics.ts --session <path-or-id> [--sessions-root <dir>] [--output <new-file>] [--disposition <explicit-parent-json>]\n       extract-session-metrics.ts --epoch current --sessions-root <dir> --manifest <file> [--output <new-file>]";
}

interface CliOptions {
	disposition?: string;
	session?: string;
	epoch?: "current";
	sessionsRoot?: string;
	manifest?: string;
	output?: string;
}

const MAX_WALK_DEPTH = 8;
const MAX_WALK_ENTRIES = 20_000;
const MAX_SESSION_FILES = 4_096;
const MAX_SESSION_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_PARSED_RUNS = 100_000;
const MAX_REPORT_BYTES = 4 * 1024 * 1024;

function parseArgs(args: string[]): CliOptions | "help" {
	if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) return "help";
	const values = new Map<string, string>();
	for (let index = 0; index < args.length; index += 2) {
		const key = args[index];
		const value = args[index + 1];
		if (!key || !value || !["--session", "--sessions-root", "--output", "--epoch", "--manifest", "--disposition"].includes(key)) throw new Error("invalid_arguments");
		if (values.has(key)) throw new Error("duplicate_argument");
		values.set(key, value);
	}
	const session = values.get("--session");
	const epoch = values.get("--epoch");
	if (session && epoch) throw new Error("ambiguous_input_mode");
	if (epoch && epoch !== "current") throw new Error("invalid_epoch_mode");
	if (!session && epoch !== "current") throw new Error("session_required");
	if (epoch === "current" && (!values.get("--sessions-root") || !values.get("--manifest"))) throw new Error("epoch_inputs_required");
	const options: CliOptions = {};
	const disposition = values.get("--disposition");
	if (disposition !== undefined) { if (epoch) throw new Error("disposition_requires_exact_session"); options.disposition = disposition; }
	if (session !== undefined) options.session = session;
	if (epoch === "current") options.epoch = "current";
	const sessionsRoot = values.get("--sessions-root");
	const manifest = values.get("--manifest");
	const output = values.get("--output");
	if (sessionsRoot !== undefined) options.sessionsRoot = sessionsRoot;
	if (manifest !== undefined) options.manifest = manifest;
	if (output !== undefined) options.output = output;
	return options;
}

interface EpochManifest {
	extensionEpoch: string;
	configurationEpoch: string;
	extensionActivatedAtMs: number;
	configurationActivatedAtMs: number;
}

async function readEpochManifest(path: string): Promise<EpochManifest> {
	await assertRegularFile(path);
	const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
	if (
		parsed.version !== 1
		|| typeof parsed.extensionEpoch !== "string"
		|| typeof parsed.configurationEpoch !== "string"
		|| typeof parsed.extensionActivatedAtMs !== "number"
		|| typeof parsed.configurationActivatedAtMs !== "number"
	) throw new Error("invalid_manifest");
	return {
	extensionEpoch: parsed.extensionEpoch,
	configurationEpoch: parsed.configurationEpoch,
	extensionActivatedAtMs: parsed.extensionActivatedAtMs,
	configurationActivatedAtMs: parsed.configurationActivatedAtMs,
	};
}

function nonNegativeInt(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function runMatchesEpoch(details: Record<string, unknown>, manifest: EpochManifest): "select" | "exclude" | "unavailable" {
	const telemetry = record(details.telemetry);
	if (!telemetry || (telemetry.schemaVersion !== 3 && telemetry.schemaVersion !== 4)) return "unavailable";
	const provenance = record(telemetry.provenance);
	if (!provenance || typeof provenance.available !== "boolean") return "unavailable";
	if (!nonNegativeInt(telemetry.requestedTasks) || !nonNegativeInt(telemetry.admittedTasks) || !nonNegativeInt(telemetry.launchedChildren) || (telemetry.schemaVersion === 3 ? !nonNegativeInt(telemetry.runDurationMs) : telemetry.runDurationMs !== null && duration(telemetry.runDurationMs) === null)) {
		return "unavailable";
	}
	if (telemetry.admittedTasks > telemetry.requestedTasks || telemetry.launchedChildren > telemetry.admittedTasks) return "unavailable";
	if (typeof telemetry.startedAtMs !== "number" || !Number.isFinite(telemetry.startedAtMs) || telemetry.startedAtMs < 0) return "unavailable";
	if (provenance.available !== true) return "unavailable";
	if (typeof provenance.extensionEpoch !== "string" || typeof provenance.configurationEpoch !== "string") return "unavailable";
	if (provenance.extensionEpoch !== manifest.extensionEpoch || provenance.configurationEpoch !== manifest.configurationEpoch) {
		return "exclude";
	}
	const cutoff = Math.max(manifest.extensionActivatedAtMs, manifest.configurationActivatedAtMs);
	if (telemetry.startedAtMs < cutoff) return "exclude";
	return "select";
}

export function filterEpochSessionText(text: string, manifest: EpochManifest): { text: string; selected: number; excluded: number; unavailable: number } {
	const kept: string[] = [];
	let selected = 0;
	let excluded = 0;
	let unavailable = 0;
	let parsedRuns = 0;
	for (const line of text.split("\n")) {
		if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) throw new Error("line_too_large");
		if (!line.trim()) continue;
		const event = JSON.parse(line) as unknown;
		const item = record(event);
		const message = record(item?.message);
		if (item?.type !== "message" || message?.role !== "toolResult") continue;
		if (message.toolName === "csheng_subagent_sessions") {
			// The managed envelope has no effective revision pair. Never infer it from file time or the parent process.
			const action = record(message.details)?.action;
			if (action === "create" || action === "continue") { unavailable++; if (++parsedRuns > MAX_PARSED_RUNS) throw new Error("too_many_runs"); }
			continue;
		}
		if (message.toolName !== TOOL_NAME) continue;
		parsedRuns += 1;
		if (parsedRuns > MAX_PARSED_RUNS) throw new Error("too_many_runs");
		const details = record(message.details) ?? {};
		const decision = runMatchesEpoch(details, manifest);
		if (decision === "select") {
			kept.push(line);
			selected += 1;
		} else if (decision === "exclude") excluded += 1;
		else unavailable += 1;
	}
	return { text: kept.join("\n"), selected, excluded, unavailable };
}

async function walkSessionFiles(root: string, files: string[], depth: number, stats: { entries: number }): Promise<void> {
	if (depth > MAX_WALK_DEPTH) throw new Error("walk_too_deep");
	const directory = await opendir(root);
	for await (const entry of directory) {
		stats.entries += 1;
		if (stats.entries > MAX_WALK_ENTRIES) throw new Error("too_many_entries");
		const path = join(root, entry.name);
		const info = await lstat(path);
		if (info.isSymbolicLink()) throw new Error("symlink_rejected");
		if (info.isDirectory()) await walkSessionFiles(path, files, depth + 1, stats);
		else if (info.isFile() && entry.name.endsWith(".jsonl")) {
			if (info.size > MAX_SESSION_BYTES) throw new Error("session_too_large");
			files.push(path);
			if (files.length > MAX_SESSION_FILES) throw new Error("too_many_sessions");
		}
	}
}

export async function extractCurrentEpochMetrics(sessionsRoot: string, manifestPath: string): Promise<SessionMetrics> {
	const manifest = await readEpochManifest(manifestPath);
	const managed = new ManagedDispatchCollector(manifest);
	const files: string[] = [];
	await walkSessionFiles(resolve(sessionsRoot), files, 0, { entries: 0 });
	let totalBytes = 0;
	let selected = 0;
	let excluded = 0;
	let unavailable = 0;
	let matchedSessions = 0;
	const chunks: string[] = [];
	for (const path of files) {
		const info = await lstat(path);
		totalBytes += info.size;
		if (totalBytes > MAX_TOTAL_BYTES) throw new Error("input_too_large");
		const text = await readFile(path, "utf8");
		managed.add(text);
		const filtered = filterEpochSessionText(text, manifest);
		selected += filtered.selected;
		excluded += filtered.excluded;
		unavailable += filtered.unavailable;
		if (filtered.selected > 0) {
			matchedSessions += 1;
			chunks.push(filtered.text);
		}
	}
	const metrics = extractSessionMetrics(chunks.join("\n"), "current-epoch.jsonl");
	metrics.managedDispatch = managed.result();
	metrics.source.sessionId = "current-epoch";
	metrics.source.selectionMode = "current-epoch";
	metrics.source.scannedSessions = files.length;
	metrics.source.matchedSessions = matchedSessions;
	metrics.source.selectedRuns = selected;
	metrics.source.excludedRuns = excluded;
	metrics.source.unavailableProvenanceRuns = unavailable;
	return metrics;
}

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	if (options === "help") {
		process.stdout.write(`${usageText()}\n`);
		return;
	}
	const metrics = options.epoch === "current"
		? await extractCurrentEpochMetrics(options.sessionsRoot as string, options.manifest as string)
		: await (async () => {
			const path = await resolveSessionPath(options.session as string, options.sessionsRoot);
			let disposition: unknown;
			if (options.disposition) {
				try {
					await assertRegularFile(options.disposition);
					if ((await lstat(options.disposition)).size > 4096) throw new Error("too_large");
					const text = await readFile(options.disposition, "utf8");
					if (Buffer.byteLength(text) > 4096) throw new Error("too_large");
					disposition = JSON.parse(text);
				} catch { throw new Error("invalid_parent_disposition_file"); }
			}
			return extractSessionMetrics(await readFile(path, "utf8"), path, disposition);
		})();
	const output = `${JSON.stringify(metrics, null, 2)}\n`;
	if (Buffer.byteLength(output, "utf8") > MAX_REPORT_BYTES) throw new Error("report_too_large");
	if (options.output) {
		await writeFile(resolve(options.output), output, { encoding: "utf8", flag: "wx", mode: 0o600 });
		process.stdout.write(`${JSON.stringify({ result: "pass", output: basename(options.output) })}\n`);
		return;
	}
	process.stdout.write(output);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
	main().catch((error: unknown) => {
		const code = error instanceof Error ? safeErrorCode(error.message) ?? "evaluation_failed" : "evaluation_failed";
		process.stderr.write(`${JSON.stringify({ result: "fail", code })}\n`);
		process.exitCode = 1;
	});
}
