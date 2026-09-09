import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const TIMEOUT_MS = 20 * 60 * 1000;
const KILL_GRACE_MS = 5_000;
const SESSION_TOOL = "csheng_subagent_sessions";
const REQUIRED_COMMANDS = ["default", "plan", "skill-mentions", "subagents"] as const;
const EXPECTED_ROLE_ROUTES = {
	explorer: "openai-codex/gpt-5.6-luna:medium",
	reviewer: "openai-codex/gpt-5.6-sol:high",
	worker: "openai-codex/gpt-5.6-terra:high",
} as const;

interface RequestTelemetry {
	invocationId?: unknown;
	requestedTasks?: unknown;
	admittedTasks?: unknown;
	launchedChildren?: unknown;
	replayedEpisodes?: unknown;
}

interface SessionCandidate {
	id?: unknown;
	episode?: unknown;
	status?: unknown;
}

interface SessionView {
	handle?: unknown;
	role?: unknown;
	episode?: unknown;
	state?: unknown;
	route?: {
		provider?: unknown;
		model?: unknown;
		thinking?: unknown;
		source?: unknown;
		executionProfileRequested?: unknown;
		reasoningProfileRequested?: unknown;
	};
	result?: { status?: unknown; output?: unknown; usage?: unknown };
	candidate?: SessionCandidate;
}

interface SessionActionResult {
	schemaVersion?: unknown;
	action?: unknown;
	status?: unknown;
	requestTelemetry?: RequestTelemetry;
	sessions?: SessionView[];
}

interface JsonEvent {
	type?: unknown;
	toolName?: unknown;
	result?: { details?: SessionActionResult };
	message?: { role?: unknown; toolName?: unknown; details?: SessionActionResult };
}

export interface LiveE2eSummary {
	result: "pass";
	source: "temporary" | "installed";
	packageExtensions: 3;
	tasks: 3;
	roles: ["explorer", "reviewer", "worker"];
	routeSource: "package-default";
	roleRoutes: typeof EXPECTED_ROLE_ROUTES;
	profileMode: "role-default";
	workerConvergence: "applied";
	launchedChildren: 3;
}

function fail(code: string): never {
	throw Object.assign(new Error(code), { code });
}

function parseEvents(stdout: string): JsonEvent[] {
	const events: JsonEvent[] = [];
	for (const line of stdout.split("\n")) {
		if (!line.trim()) continue;
		try {
			events.push(JSON.parse(line) as JsonEvent);
		} catch {
			fail("invalid_json_stream");
		}
	}
	return events;
}

function eventToolName(event: JsonEvent): unknown {
	return event.toolName ?? event.message?.toolName;
}

function eventDetails(event: JsonEvent): SessionActionResult | undefined {
	if (event.type === "tool_execution_end" && event.toolName === SESSION_TOOL) return event.result?.details;
	if (event.type === "message_end" && event.message?.role === "toolResult" && event.message.toolName === SESSION_TOOL) {
		return event.message.details;
	}
	return undefined;
}

function collectResults(events: readonly JsonEvent[]): SessionActionResult[] {
	if (events.some((event) => eventToolName(event) === "csheng_subagents")) fail("retired_subagent_tool");
	const starts = events.filter((event) => event.type === "tool_execution_start" && event.toolName === SESSION_TOOL);
	if (starts.length < 1) fail("unexpected_subagent_tool_call_count");
	const seen = new Set<string>();
	const results: SessionActionResult[] = [];
	for (const event of events) {
		const details = eventDetails(event);
		if (!details) continue;
		const invocationId = details.requestTelemetry?.invocationId;
		if (typeof invocationId !== "string" || !invocationId) fail("request_telemetry_missing");
		if (seen.has(invocationId)) continue;
		seen.add(invocationId);
		results.push(details);
	}
	if (results.length === 0) fail("subagent_result_missing");
	return results;
}

function asSessions(value: SessionActionResult): SessionView[] {
	if (!Array.isArray(value.sessions)) fail("subagent_sessions_missing");
	return value.sessions;
}

function sessionByRole(sessions: readonly SessionView[], role: "explorer" | "reviewer" | "worker"): SessionView {
	const matches = sessions.filter((session) => session.role === role);
	if (matches.length !== 1) fail(`role_${role}_not_succeeded`);
	return matches[0]!;
}

function validateRoute(session: SessionView, role: "explorer" | "reviewer" | "worker"): void {
	const route = session.route ?? undefined;
	if (route?.source !== "package-default") fail(`role_${role}_route_not_package_default`);
	if (typeof route.provider !== "string" || typeof route.model !== "string" || typeof route.thinking !== "string") {
		fail(`role_${role}_route_missing`);
	}
	if (`${route.provider}/${route.model}:${route.thinking}` !== EXPECTED_ROLE_ROUTES[role]) fail(`role_${role}_route_mismatch`);
	if (route.executionProfileRequested !== undefined || route.reasoningProfileRequested !== undefined) {
		fail(`role_${role}_unexpected_profile`);
	}
}

function launchedChildren(results: readonly SessionActionResult[]): number {
	let total = 0;
	for (const details of results) {
		const telemetry = details.requestTelemetry;
		if (typeof telemetry?.launchedChildren !== "number") fail("request_telemetry_missing");
		total += telemetry.launchedChildren;
	}
	return total;
}

export function validateLiveRun(
	stdout: string,
	expectedTokens: Readonly<Record<"explore" | "review" | "worker", string>>,
	workerContent: string,
	source: "temporary" | "installed",
): LiveE2eSummary {
	const results = collectResults(parseEvents(stdout));
	const freshCreates = results.filter((details) => details.action === "create" && details.requestTelemetry?.replayedEpisodes === 0);
	if (freshCreates.length !== 1) fail("subagent_graph_not_succeeded");
	const created = freshCreates[0]!;
	if (created.schemaVersion !== 2 || created.status !== "succeeded") fail("subagent_graph_not_succeeded");
	const telemetry = created.requestTelemetry;
	if (telemetry?.requestedTasks !== 3 || telemetry.admittedTasks !== 3 || telemetry.launchedChildren !== 3) {
		fail("subagent_graph_not_succeeded");
	}
	const sessions = asSessions(created);
	if (sessions.length !== 3) fail("subagent_graph_not_succeeded");
	const expected = [
		{ role: "explorer" as const, outputToken: expectedTokens.explore },
		{ role: "reviewer" as const, outputToken: expectedTokens.review },
		{ role: "worker" as const },
	];
	for (const item of expected) {
		const session = sessionByRole(sessions, item.role);
		if (session.result?.status !== "succeeded") fail(`role_${item.role}_not_succeeded`);
		if ("outputToken" in item && (typeof session.result.output !== "string" || !session.result.output.includes(item.outputToken))) {
			fail(`role_${item.role}_token_missing`);
		}
		validateRoute(session, item.role);
	}
	const worker = sessionByRole(sessions, "worker");
	if (typeof worker.handle !== "string" || typeof worker.episode !== "number") fail("worker_apply_missing");
	if (!worker.candidate || typeof worker.candidate.id !== "string" || worker.candidate.status === "applied") {
		fail("worker_apply_missing");
	}
	const apply = results.find((details) => {
		if (details.action !== "apply" || details.status !== "succeeded") return false;
		const session = details.sessions?.[0];
		return !!session && session.handle === worker.handle
			&& session.episode === worker.episode
			&& session.candidate?.id === worker.candidate?.id
			&& session.candidate?.status === "applied";
	});
	if (!apply || apply.requestTelemetry?.launchedChildren !== 0 || apply.requestTelemetry.replayedEpisodes !== 0) {
		fail("worker_apply_missing");
	}
	for (const session of sessions) {
		if (typeof session.handle !== "string" || typeof session.episode !== "number") fail("session_not_closed");
		const closed = results.find((details) => details.action === "close"
			&& details.status === "succeeded"
			&& details.sessions?.[0]?.handle === session.handle
			&& details.sessions?.[0]?.episode === session.episode
			&& details.sessions?.[0]?.state === "closed");
		if (!closed || closed.requestTelemetry?.launchedChildren !== 0 || closed.requestTelemetry.replayedEpisodes !== 0) {
			fail("session_not_closed");
		}
	}
	if (workerContent.trim() !== expectedTokens.worker) fail("worker_content_mismatch");
	if (launchedChildren(results) !== 3) fail("replay_usage_counted_twice");
	return {
		result: "pass",
		source,
		packageExtensions: 3,
		tasks: 3,
		roles: ["explorer", "reviewer", "worker"],
		routeSource: "package-default",
		roleRoutes: EXPECTED_ROLE_ROUTES,
		profileMode: "role-default",
		workerConvergence: "applied",
		launchedChildren: 3,
	};
}

async function writeObserver(observerPath: string, packageRoot: string): Promise<void> {
	const commands = JSON.stringify(REQUIRED_COMMANDS);
	const ownedRoot = JSON.stringify(packageRoot);
	await writeFile(observerPath, `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";\n\nconst requiredCommands = ${commands};\nconst packageRoot = ${ownedRoot};\nconst isPackagePath = (value: unknown): boolean => typeof value === "string" && (value === packageRoot || value.startsWith(packageRoot + "/"));\n\nexport default function packageObserver(pi: ExtensionAPI): void {\n\tpi.on("tool_call", (event) => {\n\t\tif (event.toolName !== "${SESSION_TOOL}") return undefined;\n\t\tconst commands = pi.getCommands();\n\t\tconst missing = requiredCommands.filter((name) => !commands.some((command) =>\n\t\t\t(command.name === name || command.name.startsWith(name + ":")) && isPackagePath(command.sourceInfo.path),\n\t\t));\n\t\tconst tool = pi.getAllTools().find((candidate) => candidate.name === "${SESSION_TOOL}");\n\t\tconst retired = pi.getAllTools().some((candidate) => candidate.name === "csheng_subagents");\n\t\tif (!tool || !isPackagePath(tool.sourceInfo.path) || !pi.getActiveTools().includes("${SESSION_TOOL}") || retired) {\n\t\t\tmissing.push(retired ? "tool:csheng_subagents" : "tool:${SESSION_TOOL}");\n\t\t}\n\t\treturn missing.length === 0\n\t\t\t? undefined\n\t\t\t: { block: true, terminate: true, reason: \`package_e2e_missing:\${missing.join(",")}\` };\n\t});\n}\n`);
}

function terminateProcess(child: ReturnType<typeof spawn>): NodeJS.Timeout | undefined {
	const processId = child.pid;
	if (processId === undefined) return undefined;
	try {
		process.kill(-processId, "SIGTERM");
	} catch {
		child.kill("SIGTERM");
	}
	const escalation = setTimeout(() => {
		try {
			process.kill(-processId, "SIGKILL");
		} catch {
			child.kill("SIGKILL");
		}
	}, KILL_GRACE_MS);
	escalation.unref();
	return escalation;
}

async function runPi(arguments_: readonly string[], cwd: string): Promise<{ stdout: string; stderrBytes: number }> {
	return new Promise((resolvePromise, rejectPromise) => {
		const child = spawn("pi", arguments_, {
			cwd,
			detached: process.platform !== "win32",
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const stdoutChunks: Buffer[] = [];
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let stoppedForOutput = false;
		let timedOut = false;
		let escalation: NodeJS.Timeout | undefined;
		const timeout = setTimeout(() => {
			timedOut = true;
			escalation = terminateProcess(child);
		}, TIMEOUT_MS);
		child.stdout.on("data", (chunk: Buffer) => {
			stdoutBytes += chunk.length;
			if (stdoutBytes > MAX_STDOUT_BYTES) {
				stoppedForOutput = true;
				escalation ??= terminateProcess(child);
				return;
			}
			stdoutChunks.push(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderrBytes = Math.min(MAX_STDERR_BYTES, stderrBytes + chunk.length);
		});
		child.once("error", (error) => {
			clearTimeout(timeout);
			if (escalation) clearTimeout(escalation);
			rejectPromise(Object.assign(error, { code: "pi_spawn_failed" }));
		});
		child.once("close", (code) => {
			clearTimeout(timeout);
			if (escalation) clearTimeout(escalation);
			if (timedOut) {
				rejectPromise(Object.assign(new Error("live_e2e_timeout"), { code: "live_e2e_timeout" }));
				return;
			}
			if (stoppedForOutput) {
				rejectPromise(Object.assign(new Error("live_e2e_output_limit"), { code: "live_e2e_output_limit" }));
				return;
			}
			if (code !== 0) {
				rejectPromise(Object.assign(new Error("pi_exit_nonzero"), { code: "pi_exit_nonzero", stderrBytes }));
				return;
			}
			resolvePromise({ stdout: Buffer.concat(stdoutChunks).toString("utf8"), stderrBytes });
		});
	});
}

async function main(): Promise<void> {
	if (process.env.CSHENG_SUBAGENTS_LIVE_E2E !== "1") fail("live_e2e_requires_CSHENG_SUBAGENTS_LIVE_E2E_1");
	const args = process.argv.slice(2);
	if (args.some((argument) => argument !== "--installed") || args.filter((argument) => argument === "--installed").length > 1) {
		fail("usage_run_live_subagents_e2e_optional_installed");
	}
	const source = args.includes("--installed") ? "installed" as const : "temporary" as const;
	const scriptPath = fileURLToPath(import.meta.url);
	const packageRoot = resolve(dirname(scriptPath), "..");
	const tempParent = join(homedir(), "tmp");
	await mkdir(tempParent, { recursive: true });
	const harnessRoot = await mkdtemp(join(tempParent, "csheng-subagents-e2e-"));
	const repositoryRoot = join(harnessRoot, "repo");
	const observerPath = join(harnessRoot, "package-observer.ts");
	const resultPath = join(repositoryRoot, "result.txt");
	const nonce = randomBytes(8).toString("hex");
	const tokens = {
		explore: `EXPLORE_${nonce}`,
		review: `REVIEW_${nonce}`,
		worker: `WORKER_${nonce}`,
	};
	try {
		await mkdir(repositoryRoot);
		await writeFile(join(repositoryRoot, "seed.txt"), `seed-${nonce}\n`);
		await writeObserver(observerPath, packageRoot);
		await runPi(["--version"], repositoryRoot);
		const git = spawn("git", ["init", "-q"], { cwd: repositoryRoot, stdio: "ignore" });
		await new Promise<void>((resolvePromise, rejectPromise) => {
			git.once("error", rejectPromise);
			git.once("close", (code) => code === 0 ? resolvePromise() : rejectPromise(new Error("git_init_failed")));
		});
		const create = {
			action: "create",
			requestId: `e2e${nonce}`,
			tasks: [
				{
					id: "explore",
					role: "explorer",
					objective: `Read seed.txt and return the exact marker ${tokens.explore}.`,
					scope: ["seed.txt"],
				},
				{
					id: "review",
					role: "reviewer",
					objective: `Inspect seed.txt as the bounded review target and include the exact marker ${tokens.review} in the result.`,
					scope: ["seed.txt"],
				},
				{
					id: "worker",
					role: "worker",
					objective: `Create result.txt containing exactly ${tokens.worker} followed by one newline, then include the exact marker ${tokens.worker} in the result.`,
					scope: ["."],
					writePaths: ["result.txt"],
				},
			],
		};
		const prompt = `Call csheng_subagent_sessions with this exact create argument object: ${JSON.stringify(create)}\nAfter create returns succeeded sessions, call csheng_subagent_sessions apply exactly once for the successful worker session using that session's returned handle as handle, returned episode as expectedEpisode, and returned candidate.id as candidateId.\nThen call csheng_subagent_sessions close once for each of the three sessions using each session's returned handle and episode as expectedEpisode and disposition discard.\nDo not call continue or inspect. After those tool calls, call no more tools and reply only E2E_PARENT_DONE.`;
		const piArguments = [
			"--mode", "json",
			"--no-session",
			"--approve",
			"--no-skills",
			"--no-prompt-templates",
			...(source === "temporary" ? ["--no-extensions", "--extension", packageRoot] : []),
			"--extension", observerPath,
			"-p",
			prompt,
		];
		const run = await runPi(piArguments, repositoryRoot);
		const workerContent = await readFile(resultPath, "utf8");
		const summary = validateLiveRun(run.stdout, tokens, workerContent, source);
		process.stdout.write(`${JSON.stringify(summary)}\n`);
	} finally {
		await rm(harnessRoot, { recursive: true, force: true });
	}
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
	main().catch((error: unknown) => {
		const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "live_e2e_failed";
		process.stderr.write(`${JSON.stringify({ result: "fail", code })}\n`);
		process.exitCode = 1;
	});
}
