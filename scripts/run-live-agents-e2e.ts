import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const TIMEOUT_MS = 20 * 60 * 1000;
const KILL_GRACE_MS = 5_000;
const PEER_TOOLS = ["invoke_agent", "message_agent", "list_agents", "wait_agents", "stop_agent", "release_agent", "agent_candidate"] as const;
const SCHEMA_VERSION = 5;
// Commands owned by three package extensions; the observer requires each from this package root.
const REQUIRED_COMMANDS = ["skill-mentions", "fast-gpt", "agents"] as const;
const ROLES = ["explorer", "reviewer", "worker"] as const;
type Role = typeof ROLES[number];
const NAMES: Readonly<Record<Role, string>> = { explorer: "explore", reviewer: "review", worker: "worker" };

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
	label?: unknown;
	role?: unknown;
	episode?: unknown;
	state?: unknown;
	route?: { provider?: unknown; model?: unknown; thinking?: unknown; source?: unknown; executionProfileRequested?: unknown; thinkingProfileRequested?: unknown };
	result?: { status?: unknown; output?: unknown; usage?: unknown };
	candidate?: SessionCandidate;
}

/** Details of a peer tool result; engine requests add action, status, telemetry and full views. */
interface PeerDetails {
	schemaVersion?: unknown;
	op?: unknown;
	action?: unknown;
	status?: unknown;
	kind?: unknown;
	requestTelemetry?: RequestTelemetry;
	sessions?: SessionView[];
}

interface JsonEvent {
	type?: unknown;
	toolName?: unknown;
	args?: unknown;
	result?: { details?: PeerDetails };
}

export interface LiveE2eSummary {
	result: "pass";
	source: "temporary" | "installed";
	packageExtensions: 3;
	agents: 3;
	roles: ["explorer", "reviewer", "worker"];
	/** Route provenance per role; model selectors stay out of the redacted summary. */
	routeSources: Record<Role, string>;
	profileMode: "role-default";
	workerWorkspace: "isolated";
	workerConvergence: "applied";
	released: 3;
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

const isPeerTool = (name: unknown): boolean => typeof name === "string" && (PEER_TOOLS as readonly string[]).includes(name);

/** Engine requests made by peer tools, once per invocation. */
function collectRequests(events: readonly JsonEvent[]): Array<PeerDetails & { tool: string }> {
	if (events.some((event) => event.type === "tool_execution_start" && event.toolName === "agent")) fail("retired_agent_tool_called");
	if (!events.some((event) => event.type === "tool_execution_start" && isPeerTool(event.toolName))) fail("unexpected_agent_tool_call_count");
	for (const event of events) {
		if (event.type !== "tool_execution_start" || !isPeerTool(event.toolName)) continue;
		if (/expectedEpisode|candidateId|"handle"/.test(JSON.stringify(event.args ?? {}))) fail("tool_call_carries_internal_identity");
	}
	const seen = new Set<string>();
	const requests: Array<PeerDetails & { tool: string }> = [];
	for (const event of events) {
		if (event.type !== "tool_execution_end" || !isPeerTool(event.toolName)) continue;
		const details = event.result?.details;
		if (!details || details.schemaVersion !== SCHEMA_VERSION) fail("peer_details_not_current");
		if (details.action === undefined) continue;
		const invocationId = details.requestTelemetry?.invocationId;
		if (typeof invocationId !== "string" || !invocationId) fail("request_telemetry_missing");
		if (seen.has(invocationId)) continue;
		seen.add(invocationId);
		requests.push({ ...details, tool: event.toolName as string });
	}
	if (requests.length === 0) fail("agent_result_missing");
	return requests;
}

function single<T>(items: readonly T[], code: string): T {
	if (items.length !== 1) fail(code);
	return items[0]!;
}

export function validateLiveRun(
	stdout: string,
	expectedTokens: Readonly<Record<"explore" | "review" | "worker", string>>,
	workerContent: string,
	source: "temporary" | "installed",
): LiveE2eSummary {
	const requests = collectRequests(parseEvents(stdout));
	const creates = requests.filter((details) => details.tool === "invoke_agent" && details.action === "create");
	if (creates.length !== 3) fail("agent_invocations_not_succeeded");
	const routeSources = {} as Record<Role, string>;
	const views = {} as Record<Role, SessionView>;
	let launched = 0;
	for (const role of ROLES) {
		const created = single(creates.filter((details) => details.sessions?.[0]?.role === role && details.sessions[0].label === NAMES[role]), `role_${role}_not_succeeded`);
		const telemetry = created.requestTelemetry;
		if (created.status !== "succeeded" || created.kind !== "execution" || telemetry?.requestedTasks !== 1 || telemetry.admittedTasks !== 1 || telemetry.launchedChildren !== 1 || telemetry.replayedEpisodes !== 0) fail(`role_${role}_not_succeeded`);
		launched += telemetry.launchedChildren;
		const view = created.sessions![0]!;
		if (view.result?.status !== "succeeded") fail(`role_${role}_not_succeeded`);
		const token = role === "explorer" ? expectedTokens.explore : role === "reviewer" ? expectedTokens.review : expectedTokens.worker;
		if (typeof view.result.output !== "string" || !view.result.output.includes(token)) fail(`role_${role}_token_missing`);
		const route = view.route;
		if (typeof route?.source !== "string" || typeof route.provider !== "string" || typeof route.model !== "string" || typeof route.thinking !== "string") fail(`role_${role}_route_missing`);
		if (route.executionProfileRequested !== undefined || route.thinkingProfileRequested !== undefined) fail(`role_${role}_unexpected_profile`);
		routeSources[role] = route.source;
		views[role] = view;
	}
	const worker = views.worker;
	if (typeof worker.handle !== "string" || !worker.candidate || typeof worker.candidate.id !== "string" || worker.candidate.status === "applied") fail("worker_apply_missing");
	const apply = requests.find((details) => details.tool === "agent_candidate" && details.action === "apply" && details.status === "succeeded"
		&& details.sessions?.[0]?.handle === worker.handle && details.sessions?.[0]?.candidate?.id === worker.candidate?.id && details.sessions?.[0]?.candidate?.status === "applied");
	if (!apply || apply.requestTelemetry?.launchedChildren !== 0 || apply.requestTelemetry.replayedEpisodes !== 0) fail("worker_apply_missing");
	for (const role of ROLES) {
		const view = views[role];
		const released = requests.find((details) => details.tool === "release_agent" && details.action === "close" && details.status === "succeeded"
			&& details.sessions?.[0]?.handle === view.handle && details.sessions?.[0]?.state === "closed");
		if (!released || released.requestTelemetry?.launchedChildren !== 0 || released.requestTelemetry.replayedEpisodes !== 0) fail("session_not_released");
	}
	if (workerContent.trim() !== expectedTokens.worker) fail("worker_content_mismatch");
	const total = requests.reduce((sum, details) => sum + (typeof details.requestTelemetry?.launchedChildren === "number" ? details.requestTelemetry.launchedChildren : 0), 0);
	if (launched !== 3 || total !== 3) fail("replay_usage_counted_twice");
	return {
		result: "pass",
		source,
		packageExtensions: 3,
		agents: 3,
		roles: ["explorer", "reviewer", "worker"],
		routeSources,
		profileMode: "role-default",
		workerWorkspace: "isolated",
		workerConvergence: "applied",
		released: 3,
		launchedChildren: 3,
	};
}

async function writeObserver(observerPath: string, packageRoot: string): Promise<void> {
	const commands = JSON.stringify(REQUIRED_COMMANDS);
	const tools = JSON.stringify(PEER_TOOLS);
	const ownedRoot = JSON.stringify(packageRoot);
	await writeFile(observerPath, `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";\n\nconst requiredCommands = ${commands};\nconst peerTools: readonly string[] = ${tools};\nconst packageRoot = ${ownedRoot};\nconst isPackagePath = (value: unknown): boolean => typeof value === "string" && (value === packageRoot || value.startsWith(packageRoot + "/"));\n\nexport default function packageObserver(pi: ExtensionAPI): void {\n\tpi.on("tool_call", (event) => {\n\t\tif (!peerTools.includes(event.toolName)) return undefined;\n\t\tconst commands = pi.getCommands();\n\t\tconst missing = requiredCommands.filter((name) => !commands.some((command) =>\n\t\t\t(command.name === name || command.name.startsWith(name + ":")) && isPackagePath(command.sourceInfo.path),\n\t\t));\n\t\tfor (const name of peerTools) {\n\t\t\tconst tool = pi.getAllTools().find((candidate) => candidate.name === name);\n\t\t\tif (!tool || !isPackagePath(tool.sourceInfo.path) || !pi.getActiveTools().includes(name)) missing.push("tool:" + name);\n\t\t}\n\t\treturn missing.length === 0\n\t\t\t? undefined\n\t\t\t: { block: true, terminate: true, reason: \`package_e2e_missing:\${missing.join(",")}\` };\n\t});\n}\n`);
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
	if (process.env.PI_EXTENSIONS_AGENTS_LIVE_E2E !== "1") fail("live_e2e_requires_PI_EXTENSIONS_AGENTS_LIVE_E2E_1");
	const args = process.argv.slice(2);
	if (args.some((argument) => argument !== "--installed") || args.filter((argument) => argument === "--installed").length > 1) {
		fail("usage_run_live_agents_e2e_optional_installed");
	}
	const source = args.includes("--installed") ? "installed" as const : "temporary" as const;
	const scriptPath = fileURLToPath(import.meta.url);
	// The installed lane observes the package the local publisher installs; the temporary lane loads this checkout.
	const packageRoot = source === "installed"
		? await realpath(join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "packages", "csheng-pi-extensions")).catch(() => fail("installed_package_missing"))
		: resolve(dirname(scriptPath), "..");
	const tempParent = join(homedir(), "tmp");
	await mkdir(tempParent, { recursive: true });
	const harnessRoot = await mkdtemp(join(tempParent, "pi-extensions-agents-e2e-"));
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
		const invocations = [
			{ name: NAMES.explorer, role: "explorer", prompt: `Read seed.txt and summarize it in one line. End your report with this exact marker on its own line: ${tokens.explore}`, access: [{ permission: "read", scope: join(repositoryRoot, "seed.txt") }] },
			{ name: NAMES.reviewer, role: "reviewer", prompt: `Inspect seed.txt as the bounded review target. End your report with this exact marker on its own line: ${tokens.review}`, access: [{ permission: "read", scope: join(repositoryRoot, "seed.txt") }] },
			{ name: NAMES.worker, role: "worker", workspace: "isolated", prompt: `Create result.txt containing exactly ${tokens.worker} followed by one newline, then include the exact marker ${tokens.worker} in the result.`, access: [{ permission: "write", scope: repositoryRoot }] },
		];
		const prompt = [
			...invocations.map((args, index) => `${index + 1}. Call invoke_agent with exactly these arguments: ${JSON.stringify(args)}`),
			`4. After all three invocations returned their results, call agent_candidate with {"name":"${NAMES.worker}","action":"apply"} in a separate step. If it reports a result you have not been shown, repeat the same call once.`,
			`5. Then call release_agent with disposition "discard" once for each of ${NAMES.explorer}, ${NAMES.reviewer} and ${NAMES.worker}.`,
			"Call no other tools. After those calls, reply only E2E_PARENT_DONE.",
		].join("\n");
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
