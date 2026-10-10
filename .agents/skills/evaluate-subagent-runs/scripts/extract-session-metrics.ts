import { lstat, opendir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractObservationMetrics, type ObservationMetrics } from "./observation-metrics.ts";
import { extractManagedDispatch, ManagedDispatchCollector, type ManagedDispatchMetrics } from "./managed-dispatch.ts";

/** Metric-artifact schema. Independent of the collaboration/managed envelope version (currently 4). */
const OUTPUT_SCHEMA_VERSION = 5;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,127}$/;
/** Retired one-shot dispatch tool: every historical envelope is excluded before any payload interpretation. */
const TOOL_NAME = "csheng_subagents";
/** Registered managed tool: only its current schema is interpreted by the current-only reducers. */
const MANAGED_TOOL_NAME = "csheng_subagent_sessions";
const MANAGED_SCHEMA_VERSION = 4;
const MAX_WALK_DEPTH = 8;
const MAX_WALK_ENTRIES = 20_000;
const MAX_SESSION_FILES = 4_096;
const MAX_SESSION_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const MAX_REPORT_BYTES = 4 * 1024 * 1024;

/**
 * Current-version-only metric document. The retired one-shot `csheng_subagents` payload is never
 * interpreted; unsupported envelopes are counted as exclusions. Current evidence lives exclusively in
 * the native/managed `observations` and in `managedDispatch`.
 */
export interface SessionMetrics {
	schemaVersion: typeof OUTPUT_SCHEMA_VERSION;
	observations: ObservationMetrics;
	managedDispatch: ManagedDispatchMetrics;
	source: {
		sessionId: string;
		selectionMode: "exact-session" | "current-epoch";
		scannedSessions: number;
		matchedSessions: number;
		/** Supported current managed tool-result envelopes, counted once each. */
		selectedRuns: number;
		/** Unsupported one-shot or non-current managed tool-result envelopes, excluded before interpretation. */
		excludedRuns: number;
		/** Current managed evidence whose explicit epoch provenance could not be assigned. */
		unavailableProvenanceRuns: number;
		planEligibility: "unavailable";
	};
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
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

/**
 * Shallow tool-result classification. Only the tool name and the envelope's own version are read;
 * no task, route, usage, timing or prose field is ever interpreted here.
 */
function scanEnvelopes(text: string): { selected: number; excluded: number } {
	let selected = 0;
	let excluded = 0;
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
		if (item?.type !== "message" || message?.role !== "toolResult") continue;
		if (message.toolName === MANAGED_TOOL_NAME) {
			const version = record(message.details)?.schemaVersion;
			if (version === MANAGED_SCHEMA_VERSION) selected += 1;
			else excluded += 1;
		} else if (message.toolName === TOOL_NAME) {
			excluded += 1;
		}
	}
	return { selected, excluded };
}

export function extractSessionMetrics(text: string, sourcePath = "session.jsonl", disposition?: unknown): SessionMetrics {
	const observations = extractObservationMetrics(text, disposition);
	const envelopes = scanEnvelopes(text);
	return {
		schemaVersion: OUTPUT_SCHEMA_VERSION,
		observations,
		managedDispatch: extractManagedDispatch(text),
		source: {
			sessionId: sessionIdFromPath(sourcePath),
			selectionMode: "exact-session",
			scannedSessions: 1,
			matchedSessions: envelopes.selected > 0 || observations.available ? 1 : 0,
			selectedRuns: envelopes.selected,
			excludedRuns: envelopes.excluded,
			unavailableProvenanceRuns: 0,
			planEligibility: "unavailable",
		},
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
	let matchedSessions = 0;
	let excludedEnvelopes = 0;
	for (const path of files) {
		const info = await lstat(path);
		totalBytes += info.size;
		if (totalBytes > MAX_TOTAL_BYTES) throw new Error("input_too_large");
		const text = await readFile(path, "utf8");
		managed.add(text);
		const envelopes = scanEnvelopes(text);
		if (envelopes.selected > 0) matchedSessions += 1;
		excludedEnvelopes += envelopes.excluded;
	}
	const dispatch = managed.result();
	return {
		schemaVersion: OUTPUT_SCHEMA_VERSION,
		// Native observations require an exact-session input; the epoch projection stays dispatch-only.
		observations: extractObservationMetrics(""),
		managedDispatch: dispatch,
		source: {
			sessionId: "current-epoch",
			selectionMode: "current-epoch",
			scannedSessions: files.length,
			matchedSessions,
			selectedRuns: dispatch.selectedRequests,
			excludedRuns: dispatch.excludedRequests + excludedEnvelopes,
			unavailableProvenanceRuns: dispatch.unassignedRequests,
			planEligibility: "unavailable",
		},
	};
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

function safeErrorCode(value: unknown): string | undefined {
	return typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : undefined;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
	main().catch((error: unknown) => {
		const code = error instanceof Error ? safeErrorCode(error.message) ?? "evaluation_failed" : "evaluation_failed";
		process.stderr.write(`${JSON.stringify({ result: "fail", code })}\n`);
		process.exitCode = 1;
	});
}
