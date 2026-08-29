import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
	CHILD_CAPABILITY_ENV,
	CHILD_MARKER_ENV,
	HARD_LIMITS,
	emptyUsage,
	truncateUtf8,
	type ChildCapabilityManifest,
	type EffectiveRoute,
	type TaskResult,
} from "./contracts.ts";
import type { NormalizedTask } from "./graph.ts";
import { JsonlProtocolParser } from "./protocol.ts";
import type { RoleDefinition } from "./roles.ts";

export interface PiInvocation {
	command: string;
	args: string[];
}

export interface ChildRunOptions {
	task: NormalizedTask;
	role: RoleDefinition;
	route: EffectiveRoute;
	cwd: string;
	guardExtensionPath: string;
	capability: ChildCapabilityManifest;
	prompt: string;
	approveProject: boolean;
	signal?: AbortSignal;
	timeoutMs?: number;
	killGraceMs?: number;
	invocation?: PiInvocation;
	env?: NodeJS.ProcessEnv;
}

const ENV_DENYLIST = new Set([CHILD_CAPABILITY_ENV, CHILD_MARKER_ENV, "CSHENG_SUBAGENT_TEST_MODE"]);

export function resolvePiInvocation(extraArgs: string[]): PiInvocation {
	const currentScript = process.argv[1];
	const bunVirtual = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !bunVirtual && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...extraArgs] };
	}
	const executable = basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(executable)) return { command: process.execPath, args: extraArgs };
	return { command: "pi", args: extraArgs };
}

function childEnvironment(source: NodeJS.ProcessEnv, capabilityPath: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(source)) {
		if (!ENV_DENYLIST.has(key) && value !== undefined) env[key] = value;
	}
	env[CHILD_MARKER_ENV] = "1";
	env[CHILD_CAPABILITY_ENV] = capabilityPath;
	return env;
}

function buildPrompt(task: NormalizedTask, prompt: string): string {
	const verification = task.verification.length > 0 ? `\nExpected parent evidence:\n- ${task.verification.join("\n- ")}` : "";
	return `Task ${task.id}\nRole: ${task.role}\nObjective: ${task.objective}\nRead scope:\n- ${task.scope.join("\n- ")}\nWrite paths:\n- ${task.writePaths.length > 0 ? task.writePaths.join("\n- ") : "none"}${verification}\n\nInputs:\n${prompt}`;
}

export async function runChild(options: ChildRunOptions): Promise<TaskResult> {
	const started = Date.now();
	const privateDir = await mkdtemp(join(tmpdir(), "csheng-subagent-"));
	await chmod(privateDir, 0o700);
	const systemPromptPath = join(privateDir, "role.md");
	const taskPromptPath = join(privateDir, "task.md");
	const capabilityPath = join(privateDir, "capability.json");
	const parser = new JsonlProtocolParser();
	let stderr = "";
	let timedOut = false;
	let aborted = options.signal?.aborted ?? false;
	let spawnError: Error | undefined;

	try {
		const completePrompt = buildPrompt(options.task, options.prompt);
		if (Buffer.byteLength(completePrompt, "utf8") > HARD_LIMITS.maxPromptBytes) {
			return failure(options, started, "prompt_too_large", "Complete child prompt exceeds the byte limit.");
		}
		await Promise.all([
			writeFile(systemPromptPath, options.role.systemPrompt, { encoding: "utf8", mode: 0o600 }),
			writeFile(taskPromptPath, completePrompt, { encoding: "utf8", mode: 0o600 }),
			writeFile(capabilityPath, JSON.stringify(options.capability), { encoding: "utf8", mode: 0o600 }),
		]);

		const args = [
			"--mode", "json", "-p", "--no-session",
			"--no-extensions", "-e", options.guardExtensionPath,
			"--no-skills", "--no-prompt-templates",
			"--tools", options.role.tools.join(","),
			"--model", `${options.route.provider}/${options.route.model}`,
			"--thinking", options.route.thinking,
			options.approveProject ? "--approve" : "--no-approve",
			"--append-system-prompt", systemPromptPath,
			"--", `@${taskPromptPath}`,
		];
		const invocation = options.invocation ?? resolvePiInvocation(args);
		const finalArgs = options.invocation ? [...options.invocation.args, ...args] : invocation.args;

		const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
			const child = spawn(invocation.command, finalArgs, {
				cwd: options.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: childEnvironment(options.env ?? process.env, capabilityPath),
			});
			let closed = false;
			let killTimer: NodeJS.Timeout | undefined;
			const stop = () => {
				if (closed) return;
				child.kill("SIGTERM");
				killTimer = setTimeout(() => {
					if (!closed) child.kill("SIGKILL");
				}, options.killGraceMs ?? HARD_LIMITS.killGraceMs);
				killTimer.unref();
			};
			const abort = () => {
				aborted = true;
				stop();
			};
			if (options.signal?.aborted) abort();
			else options.signal?.addEventListener("abort", abort, { once: true });
			const timeout = setTimeout(() => {
				timedOut = true;
				stop();
			}, options.timeoutMs ?? HARD_LIMITS.taskTimeoutMs);
			timeout.unref();

			child.stdout.on("data", (chunk: Buffer | string) => parser.push(chunk.toString()));
			child.stderr.on("data", (chunk: Buffer | string) => {
				stderr = truncateUtf8(stderr + chunk.toString(), HARD_LIMITS.maxStderrBytes).text;
			});
			child.once("error", (error) => {
				spawnError = error;
			});
			child.once("close", (code, signal) => {
				closed = true;
				clearTimeout(timeout);
				if (killTimer) clearTimeout(killTimer);
				options.signal?.removeEventListener("abort", abort);
				resolve({ code, signal });
			});
		});

		const parsed = parser.finish();
		const output = truncateUtf8(parsed.output, HARD_LIMITS.maxFinalOutputBytes);
		const suffix = output.truncatedBytes > 0 ? `\n\n[Output truncated: ${output.truncatedBytes} bytes omitted.]` : "";
		const base: TaskResult = {
			id: options.task.id,
			role: options.task.role,
			status: "succeeded",
			output: `${output.text}${suffix}`,
			stderr,
			usage: parsed.usage,
			durationMs: Date.now() - started,
			changedPaths: [],
			convergence: "not-applicable",
			route: options.route,
			...(parsed.stopReason === undefined ? {} : { stopReason: parsed.stopReason }),
		};
		if (spawnError) return { ...base, status: "failed", error: { code: "spawn_failure", message: spawnError.message } };
		if (aborted) return { ...base, status: "aborted", error: { code: "aborted", message: "Child was cancelled." } };
		if (timedOut) return { ...base, status: "failed", error: { code: "timeout", message: "Child exceeded its task timeout." } };
		if (exit.code !== 0) return { ...base, status: "failed", error: { code: "child_exit", message: `Child exited unsuccessfully (${exit.code ?? exit.signal ?? "unknown"}).` } };
		if (parsed.messageCount === 0 && parsed.malformedLines > 0) return { ...base, status: "failed", error: { code: "malformed_jsonl", message: "Child produced no valid assistant message." } };
		if (parsed.stopReason === "error" || parsed.stopReason === "aborted" || parsed.errorMessage) {
			return { ...base, status: parsed.stopReason === "aborted" ? "aborted" : "failed", error: { code: "child_model_error", message: parsed.errorMessage ?? `Child stopped with ${parsed.stopReason}.` } };
		}
		return base;
	} finally {
		await rm(privateDir, { recursive: true, force: true });
	}
}

function failure(options: ChildRunOptions, started: number, code: string, message: string): TaskResult {
	return {
		id: options.task.id,
		role: options.task.role,
		status: "failed",
		output: "",
		stderr: "",
		usage: emptyUsage(),
		durationMs: Date.now() - started,
		changedPaths: [],
		convergence: "not-applicable",
		route: options.route,
		error: { code, message },
	};
}
