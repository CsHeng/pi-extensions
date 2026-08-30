import { lstat, opendir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OUTPUT_SCHEMA_VERSION = 2;
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
	telemetrySchemaVersion: 1 | 2 | null;
	requestedTasks: number | null;
	admittedTasks: number | null;
	launchedChildren: number;
	requestedDependencyEdges: number | null;
	admittedDependencyEdges: number | null;
	explicitModelTasks: number | null;
	explicitThinkingTasks: number | null;
	runDurationMs: number;
	peakConcurrency: number | null;
	roles: Record<Role, RoleMetrics>;
	errorCodes: string[];
}

export interface SessionMetrics {
	schemaVersion: typeof OUTPUT_SCHEMA_VERSION;
	source: {
		sessionId: string;
		telemetryMode: "authoritative" | "legacy" | "mixed";
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

export function extractSessionMetrics(text: string, sourcePath = "session.jsonl"): SessionMetrics {
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
		const telemetryVersion = telemetry?.schemaVersion === 2 ? 2 : telemetry?.schemaVersion === 1 ? 1 : null;
		const isAuthoritative = telemetryVersion !== null;
		const isSchemaTwo = telemetryVersion === 2;
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
		let runDurationMs = isAuthoritative ? number(telemetry?.runDurationMs) : 0;
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
			if (!isAuthoritative) runDurationMs = Math.max(runDurationMs, durationMs);
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
				peakConcurrency,
				roles: runRoles,
				errorCodes: [...errorCodes].sort(),
			});
		}
	}

	return {
		schemaVersion: OUTPUT_SCHEMA_VERSION,
		source: {
			sessionId: sessionIdFromPath(sourcePath),
			telemetryMode: authoritative > 0 && legacy > 0 ? "mixed" : authoritative > 0 ? "authoritative" : "legacy",
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
	return "Usage: extract-session-metrics.ts --session <path-or-id> [--sessions-root <dir>] [--output <new-file>]";
}

interface CliOptions {
	session: string;
	sessionsRoot?: string;
	output?: string;
}

function parseArgs(args: string[]): CliOptions | "help" {
	if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) return "help";
	const values = new Map<string, string>();
	for (let index = 0; index < args.length; index += 2) {
		const key = args[index];
		const value = args[index + 1];
		if (!key || !value || !["--session", "--sessions-root", "--output"].includes(key)) throw new Error("invalid_arguments");
		if (values.has(key)) throw new Error("duplicate_argument");
		values.set(key, value);
	}
	const session = values.get("--session");
	if (!session) throw new Error("session_required");
	const options: CliOptions = { session };
	const sessionsRoot = values.get("--sessions-root");
	const output = values.get("--output");
	if (sessionsRoot !== undefined) options.sessionsRoot = sessionsRoot;
	if (output !== undefined) options.output = output;
	return options;
}

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	if (options === "help") {
		process.stdout.write(`${usageText()}\n`);
		return;
	}
	const path = await resolveSessionPath(options.session, options.sessionsRoot);
	const metrics = extractSessionMetrics(await readFile(path, "utf8"), path);
	const output = `${JSON.stringify(metrics, null, 2)}\n`;
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
		const code = error instanceof Error ? error.message : "evaluation_failed";
		process.stderr.write(`${JSON.stringify({ result: "fail", code })}\n`);
		process.exitCode = 1;
	});
}
