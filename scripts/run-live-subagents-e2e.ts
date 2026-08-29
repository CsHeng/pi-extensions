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
const REQUIRED_COMMANDS = ["default", "plan", "skill-mentions", "subagents"] as const;

interface ToolTaskResult {
	id?: unknown;
	role?: unknown;
	status?: unknown;
	output?: unknown;
	route?: {
		provider?: unknown;
		model?: unknown;
		source?: unknown;
	};
}

interface ToolRunDetails {
	status?: unknown;
	tasks?: unknown;
}

interface JsonEvent {
	type?: unknown;
	toolName?: unknown;
	result?: { details?: ToolRunDetails };
	message?: { role?: unknown; toolName?: unknown; details?: ToolRunDetails };
}

export interface LiveE2eSummary {
	result: "pass";
	source: "temporary" | "installed";
	packageExtensions: 3;
	tasks: 3;
	roles: ["explorer", "reviewer", "worker"];
	routeSource: "parent";
	sharedParentRoute: true;
	workerConvergence: "applied";
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

function findRunDetails(events: readonly JsonEvent[]): ToolRunDetails {
	const starts = events.filter((event) => event.type === "tool_execution_start" && event.toolName === "csheng_subagents");
	if (starts.length !== 1) fail("unexpected_subagent_tool_call_count");
	for (const event of events) {
		if (event.type === "tool_execution_end" && event.toolName === "csheng_subagents" && event.result?.details) {
			return event.result.details;
		}
		if (
			event.type === "message_end" &&
			event.message?.role === "toolResult" &&
			event.message.toolName === "csheng_subagents" &&
			event.message.details
		) {
			return event.message.details;
		}
	}
	return fail("subagent_result_missing");
}

export function validateLiveRun(
	stdout: string,
	expectedTokens: Readonly<Record<"explore" | "review" | "worker", string>>,
	workerContent: string,
	source: "temporary" | "installed",
): LiveE2eSummary {
	const details = findRunDetails(parseEvents(stdout));
	if (details.status !== "succeeded" || !Array.isArray(details.tasks) || details.tasks.length !== 3) {
		fail("subagent_graph_not_succeeded");
	}
	const tasks = details.tasks as ToolTaskResult[];
	const expected = [
		{ id: "explore", role: "explorer", outputToken: expectedTokens.explore },
		{ id: "review", role: "reviewer", outputToken: expectedTokens.review },
		{ id: "worker", role: "worker" },
	] as const;
	for (const item of expected) {
		const task = tasks.find((candidate) => candidate.id === item.id);
		if (!task || task.role !== item.role || task.status !== "succeeded") fail(`role_${item.role}_not_succeeded`);
		if ("outputToken" in item && (typeof task.output !== "string" || !task.output.includes(item.outputToken))) {
			fail(`role_${item.role}_token_missing`);
		}
		if (task.route?.source !== "parent") fail(`role_${item.role}_route_not_parent`);
		if (typeof task.route.provider !== "string" || typeof task.route.model !== "string") fail(`role_${item.role}_route_missing`);
	}
	const routes = tasks.map((task) => `${task.route?.provider}/${task.route?.model}`);
	if (new Set(routes).size !== 1) fail("roles_did_not_share_parent_route");
	if (workerContent.trim() !== expectedTokens.worker) fail("worker_content_mismatch");
	const worker = tasks.find((task) => task.id === "worker") as ToolTaskResult & { convergence?: unknown };
	if (worker.convergence !== "applied") fail("worker_convergence_not_applied");
	return {
		result: "pass",
		source,
		packageExtensions: 3,
		tasks: 3,
		roles: ["explorer", "reviewer", "worker"],
		routeSource: "parent",
		sharedParentRoute: true,
		workerConvergence: "applied",
	};
}

async function writeObserver(observerPath: string, packageRoot: string): Promise<void> {
	const commands = JSON.stringify(REQUIRED_COMMANDS);
	const ownedRoot = JSON.stringify(packageRoot);
	await writeFile(observerPath, `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";\n\nconst requiredCommands = ${commands};\nconst packageRoot = ${ownedRoot};\nconst isPackagePath = (value: unknown): boolean => typeof value === "string" && (value === packageRoot || value.startsWith(packageRoot + "/"));\n\nexport default function packageObserver(pi: ExtensionAPI): void {\n\tpi.on("tool_call", (event) => {\n\t\tif (event.toolName !== "csheng_subagents") return undefined;\n\t\tconst commands = pi.getCommands();\n\t\tconst missing = requiredCommands.filter((name) => !commands.some((command) =>\n\t\t\t(command.name === name || command.name.startsWith(name + ":")) && isPackagePath(command.sourceInfo.path),\n\t\t));\n\t\tconst tool = pi.getAllTools().find((candidate) => candidate.name === "csheng_subagents");\n\t\tif (!tool || !isPackagePath(tool.sourceInfo.path) || !pi.getActiveTools().includes("csheng_subagents")) {\n\t\t\tmissing.push("tool:csheng_subagents");\n\t\t}\n\t\treturn missing.length === 0\n\t\t\t? undefined\n\t\t\t: { block: true, terminate: true, reason: \`package_e2e_missing:\${missing.join(",")}\` };\n\t});\n}\n`);
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
		const graph = {
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
					scope: ["seed.txt", "result.txt"],
					writePaths: ["result.txt"],
				},
			],
		};
		const prompt = `Call csheng_subagents exactly once using this exact argument object: ${JSON.stringify(graph)}\nAfter the tool returns, call no more tools and reply only E2E_PARENT_DONE.`;
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
