import { spawn } from "node:child_process";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { StringDecoder } from "node:string_decoder";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
	CHILD_CAPABILITY_ENV,
	CHILD_MARKER_ENV,
	HARD_LIMITS,
	emptyTaskTelemetry,
	emptyUsage,
	truncateUtf8,
	type ChildActivity,
	type ChildCapabilityManifest,
	type EffectiveRoute,
	type TaskResult,
} from "./contracts.ts";
/** Native history evidence supplied by the managed store; not a one-shot allocator. */
export interface DiagnosticTaskSession {
	path: string;
	ref: string;
	removeUnused(): Promise<void>;
}
export interface DiagnosticLimitResult {
	ok: boolean;
	code?: "diagnostic_session_limit";
	scope?: "child" | "run";
}
import type { NormalizedTask } from "./graph.ts";
import { JsonlProtocolParser } from "./protocol.ts";
import type { RoleDefinition } from "./roles.ts";
import { workerGitEnvironment, type WorkerInputState } from "./worker-inputs.ts";
import { boundNativeObservation, collectNativeObservation, nativeLeaf, unavailableObservation } from "./observability.ts";
import { MANAGED_LIMITS } from "./session-contracts.ts";
import { prepareChildGuidance, type CapturedProjectSkill } from "./guidance-resources.ts";

async function readObservationNative(file: string): Promise<string | undefined> {
	try {
		const info = await lstat(file);
		if (!info.isFile() || info.size > MANAGED_LIMITS.maxNativeBytes || await realpath(file) !== resolve(file)) return undefined;
		const text = await readFile(file, "utf8");
		return Buffer.byteLength(text) <= MANAGED_LIMITS.maxNativeBytes ? text : undefined;
	} catch { return undefined; }
}

export interface PiInvocation {
	command: string;
	args: string[];
}

type StopCause = "aborted" | "timeout" | "diagnostic_session_limit" | "child_exit_stalled";

export interface ChildRunOptions {
	managedWorkerScratch?: string;
	managedWorkerInputs?: WorkerInputState;
	/** Original project root, distinct from the isolated child source cwd. */
	sourceRoot?: string;
	inheritSkills?: boolean;
	parentSkills?: readonly Skill[];
	projectSkills?: readonly CapturedProjectSkill[];
	managedProcessGroup?: boolean;
	task: NormalizedTask;
	role: RoleDefinition;
	route: EffectiveRoute;
	cwd: string;
	guardExtensionPath: string;
	capability: ChildCapabilityManifest;
	prompt: string;
	approveProject: boolean;
	diagnosticSession: DiagnosticTaskSession;
	checkDiagnosticLimits?(): Promise<DiagnosticLimitResult>;
	onRunDiagnosticLimit?(): void;
	abortCause?(): "aborted" | "diagnostic_session_limit";
	signal?: AbortSignal;
	timeoutMs?: number;
	killGraceMs?: number;
	settledExitGraceMs?: number;
	invocation?: PiInvocation;
	env?: NodeJS.ProcessEnv;
	now?: () => number;
	onActivity?(activity: Readonly<ChildActivity>): void;
	onChildStarted?(): void;
	onChildSettled?(): void;
}

const ENV_DENYLIST = new Set([CHILD_CAPABILITY_ENV, CHILD_MARKER_ENV, "CSHENG_SUBAGENT_TEST_MODE", "CSHENG_SUBAGENT_WORKER_SCRATCH", "CSHENG_SUBAGENT_WORKER_INPUTS"]);

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

function childEnvironment(source: NodeJS.ProcessEnv, capabilityPath: string, managedWorkerScratch?: string, managedWorkerInputs?: WorkerInputState): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(source)) {
		if (!ENV_DENYLIST.has(key) && value !== undefined) env[key] = value;
	}
	env[CHILD_MARKER_ENV] = "1";
	env[CHILD_CAPABILITY_ENV] = capabilityPath;
	if (managedWorkerScratch) {
		env.CSHENG_SUBAGENT_WORKER_SCRATCH = managedWorkerScratch;
		env.TMPDIR = managedWorkerScratch;
		if (managedWorkerInputs) env.CSHENG_SUBAGENT_WORKER_INPUTS = JSON.stringify(managedWorkerInputs);
		env.PI_OFFLINE = "1";
	}
	return managedWorkerScratch ? workerGitEnvironment(env) : env;
}

export function buildChildPrompt(task: NormalizedTask, prompt: string, advisoryWrites = false): string {
	const verification = task.verification.length > 0 ? `\nExpected parent evidence:\n- ${task.verification.join("\n- ")}` : "";
	const externalRoots = task.externalReadRoots ?? [];
	const external = externalRoots.length > 0 ? externalRoots.join("\n- ") : "none";
	return `Task ${task.id}\nRole: ${task.role}\nObjective: ${task.objective}\nRead scope:\n- ${task.scope.join("\n- ")}\nExternal read roots:\n- ${external}\n${advisoryWrites ? "Initial write regions (advisory)" : "Write paths"}:\n- ${task.writePaths.length > 0 ? task.writePaths.join("\n- ") : advisoryWrites ? "not predicted; stay within the task root and objective" : "none"}${verification}\n\nInputs:\n${prompt}`;
}

export async function runChild(options: ChildRunOptions): Promise<TaskResult> {
	const now = options.now ?? (() => performance.now());
	const started = now();
	const privateDir = await mkdtemp(join(tmpdir(), "csheng-subagent-"));
	await chmod(privateDir, 0o700);
	const systemPromptPath = join(privateDir, "role.md");
	const taskPromptPath = join(privateDir, "task.md");
	const capabilityPath = join(privateDir, "capability.json");
	let stderr = "";
	let spawnError: Error | undefined;
	let childDidStart = false;
	let childDurationMs = 0;
	let finalActivity: Readonly<ChildActivity> | undefined;
	let activitySink = (activity: Readonly<ChildActivity>) => {
		finalActivity = activity;
		options.onActivity?.(activity);
	};
	const parser = new JsonlProtocolParser({
		now,
		allowedTools: options.role.tools,
		onActivity(activity) { activitySink(activity); },
	});

	try {
		const observationBefore = await readObservationNative(options.diagnosticSession.path);
		const observationStart = observationBefore === undefined ? undefined : nativeLeaf(observationBefore);
		const nativeStartBytes = options.managedWorkerScratch ? (await lstat(options.diagnosticSession.path)).size : 0;
		const completePrompt = buildChildPrompt(options.task, options.prompt, "writeRoot" in options.capability && options.capability.writeRoot === true);
		if (Buffer.byteLength(completePrompt, "utf8") > HARD_LIMITS.maxPromptBytes) {
			return failure(options, started, now, "prompt_too_large", "Complete child prompt exceeds the byte limit.");
		}
		const guidance = options.sourceRoot ? await prepareChildGuidance(options.sourceRoot, options.cwd, options.inheritSkills ?? true, options.env?.PI_CODING_AGENT_DIR, options.env?.HOME ?? homedir(), options.parentSkills, options.projectSkills) : undefined;
		const capability = guidance && options.capability.version === 2
			? { ...options.capability, guidance: { contextFiles: guidance.contextFiles, readRoots: guidance.readRoots, physicalRoots: guidance.physicalRoots } }
			: options.capability;
		await Promise.all([
			writeFile(systemPromptPath, options.role.systemPrompt, { encoding: "utf8", mode: 0o600 }),
			writeFile(taskPromptPath, completePrompt, { encoding: "utf8", mode: 0o600 }),
			writeFile(capabilityPath, JSON.stringify(capability), { encoding: "utf8", mode: 0o600 }),
		]);

		const args = [
			"--mode", "json", "-p", "--session", options.diagnosticSession.path,
			"--no-extensions", "-e", options.guardExtensionPath,
			"--no-skills", ...(guidance?.skillPaths.flatMap(path => ["--skill", path]) ?? []), "--no-prompt-templates",
			"--tools", options.role.tools.join(","),
			"--model", `${options.route.provider}/${options.route.model}`,
			"--thinking", options.route.thinking,
			options.approveProject ? "--approve" : "--no-approve",
			"--append-system-prompt", systemPromptPath,
			"--", `@${taskPromptPath}`,
		];
		const invocation = options.invocation ?? resolvePiInvocation(args);
		const finalArgs = options.invocation ? [...options.invocation.args, ...args] : invocation.args;
		let stopCause: StopCause | undefined = options.signal?.aborted ? "aborted" : undefined;

		const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
			const managedGroup = (options.managedProcessGroup || options.managedWorkerScratch !== undefined) && process.platform !== "win32";
			const child = spawn(invocation.command, finalArgs, {
				detached: managedGroup,
				cwd: options.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: childEnvironment(options.env ?? process.env, capabilityPath, options.managedWorkerScratch, options.managedWorkerInputs),
			});
			let closed = false;
			let stopping = false;
			let childStartedAt: number | undefined;
			let killTimer: NodeJS.Timeout | undefined;
			let settledTimer: NodeJS.Timeout | undefined;
			let checkingLimit = false;

			const signalChild = (signal: NodeJS.Signals) => {
				try {
					if (managedGroup && child.pid) process.kill(-child.pid, signal);
					else child.kill(signal);
				} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") spawnError ??= new Error("child_process_group_stop_failed"); }
			};
			child.once("exit", () => { if (managedGroup) signalChild("SIGKILL"); });
			const requestStop = (cause: StopCause) => {
				if (closed) return;
				stopCause ??= cause;
				if (stopping) return;
				stopping = true;
				signalChild("SIGTERM");
				killTimer = setTimeout(() => {
					if (!closed) signalChild("SIGKILL");
				}, options.killGraceMs ?? HARD_LIMITS.killGraceMs);
				killTimer.unref();
			};
			const checkLimits = () => {
				if (!options.checkDiagnosticLimits || checkingLimit || closed) return;
				checkingLimit = true;
				void options.checkDiagnosticLimits()
					.then((limit) => {
						if (!limit.ok) {
							if (limit.scope === "run") options.onRunDiagnosticLimit?.();
							requestStop("diagnostic_session_limit");
						}
					})
					.catch(() => requestStop("diagnostic_session_limit"))
					.finally(() => { checkingLimit = false; });
			};
			const activity = (snapshot: Readonly<ChildActivity>) => {
				finalActivity = snapshot;
				options.onActivity?.(snapshot);
				checkLimits();
				if (snapshot.agentSettledObserved && !settledTimer && !closed) {
					settledTimer = setTimeout(() => requestStop("child_exit_stalled"), options.settledExitGraceMs ?? HARD_LIMITS.settledExitGraceMs);
					settledTimer.unref();
				}
			};
			activitySink = activity;

			const abort = () => requestStop(options.abortCause?.() ?? "aborted");
			if (options.signal?.aborted) abort();
			else options.signal?.addEventListener("abort", abort, { once: true });
			const timeout = setTimeout(() => requestStop("timeout"), options.timeoutMs ?? HARD_LIMITS.taskTimeoutMs);
			timeout.unref();

			child.once("spawn", () => {
				childDidStart = true;
				childStartedAt = now();
				options.onChildStarted?.();
				activitySink(parser.snapshot(childStartedAt));
				if (stopCause) requestStop(stopCause);
			});
			const decoder = new StringDecoder("utf8");
			child.stdout.on("data", (chunk: Buffer | string) => parser.push(typeof chunk === "string" ? chunk : decoder.write(chunk)));
			child.stdout.on("end", () => parser.push(decoder.end()));
			child.stderr.on("data", (chunk: Buffer | string) => {
				stderr = truncateUtf8(stderr + chunk.toString(), HARD_LIMITS.maxStderrBytes).text;
			});
			child.once("error", (error) => { spawnError = error; });
			child.once("close", (code, signal) => {
				closed = true;
				if (childStartedAt !== undefined) {
					childDurationMs = Math.max(0, now() - childStartedAt);
					options.onChildSettled?.();
				}
				clearTimeout(timeout);
				if (killTimer) clearTimeout(killTimer);
				if (settledTimer) clearTimeout(settledTimer);
				options.signal?.removeEventListener("abort", abort);
				resolveExit({ code, signal });
			});
		});

		const parsed = parser.finish();
		const managedToolState = options.managedWorkerScratch ? await workerToolsSettled(options.diagnosticSession.path, nativeStartBytes) : undefined;
		if (finalActivity) {
			finalActivity = Object.freeze({ ...finalActivity, phase: "closed", elapsedMs: Math.max(finalActivity.elapsedMs, now() - started) });
			options.onActivity?.(finalActivity);
		}
		const output = truncateUtf8(parsed.output, HARD_LIMITS.maxFinalOutputBytes);
		const suffix = output.truncatedBytes > 0 ? `\n\n[Output truncated: ${output.truncatedBytes} bytes omitted.]` : "";
		const durationMs = now() - started;
		const observationAfter = await readObservationNative(options.diagnosticSession.path);
		const observationEnd = observationAfter === undefined ? undefined : nativeLeaf(observationAfter);
		const observation = observationStart === undefined || observationEnd === undefined || observationAfter === undefined
			? unavailableObservation()
			: boundNativeObservation(collectNativeObservation(observationAfter, { startLeaf: observationStart, endLeaf: observationEnd, launched: childDidStart }));
		// Timing is optional evidence. A readable owned range can retain usage,
		// commands and capabilities without a terminal timing marker.
		const base: TaskResult = {
			observation, observationVersion: 1,
			id: options.task.id,
			role: options.task.role,
			status: "succeeded",
			output: `${output.text}${suffix}`,
			stderr,
			usage: parsed.usage,
			reportComplete: parsed.reportComplete,
			...(managedToolState === undefined ? {} : { workerToolsSettled: managedToolState }),
			durationMs,
			changedPaths: [],
			telemetry: { ...emptyTaskTelemetry(), childStarted: childDidStart, childMs: childDurationMs },
			convergence: "not-applicable",
			route: options.route,
			...(childDidStart ? { diagnosticSessionRef: options.diagnosticSession.ref } : {}),
			...(finalActivity === undefined ? {} : { activity: { ...finalActivity, activeTools: [...finalActivity.activeTools] } }),
			...(parsed.stopReason === undefined ? {} : { stopReason: parsed.stopReason }),
		};
		if (spawnError) return { ...base, status: "failed", error: { code: "spawn_failure", message: spawnError.message } };
		if (stopCause === "aborted") return { ...base, status: "aborted", error: { code: "aborted", message: "Child was cancelled." } };
		if (stopCause === "timeout") return { ...base, status: "failed", error: { code: "timeout", message: "Child exceeded its task timeout." } };
		if (stopCause === "diagnostic_session_limit") return { ...base, status: "failed", error: { code: "diagnostic_session_limit", message: "Child diagnostic session exceeded its storage limit." } };
		if (stopCause === "child_exit_stalled") return { ...base, status: "failed", error: { code: "child_exit_stalled", message: "Child settled but did not close within the exit grace period." } };
		if (exit.code !== 0) return { ...base, status: "failed", error: { code: "child_exit", message: `Child exited unsuccessfully (${exit.code ?? exit.signal ?? "unknown"}).` } };
		if (parsed.messageCount === 0 && parsed.malformedLines > 0) return { ...base, status: "failed", error: { code: "malformed_jsonl", message: "Child produced no valid assistant message." } };
		if (parsed.stopReason === "error" || parsed.stopReason === "aborted" || parsed.errorMessage) {
			return { ...base, status: parsed.stopReason === "aborted" ? "aborted" : "failed", error: { code: "child_model_error", message: parsed.errorMessage ?? `Child stopped with ${parsed.stopReason}.` } };
		}
		if (!parsed.reportComplete) return { ...base, status: "failed", error: { code: "incomplete_report", message: "Child did not settle with a complete final report and closed tool calls." } };
		if (options.managedWorkerScratch && managedToolState !== true) return { ...base, status: "failed", error: { code: "worker_tools_unsettled", message: "Managed worker tools did not record successful initialization and settlement for this episode." } };
		return base;
	} finally {
		if (!childDidStart) await options.diagnosticSession.removeUnused().catch(() => {});
		await rm(privateDir, { recursive: true, force: true });
	}
}

async function workerToolsSettled(path: string, start: number): Promise<boolean> {
	try {
		const info = await lstat(path);
		if (!info.isFile() || info.size > HARD_LIMITS.diagnosticChildBytes || info.size < start) return false;
		const data = await readFile(path);
		if (data.length !== info.size || data.at(-1) !== 10) return false;
		let ready = false;
		let stopped = false;
		for (const line of data.subarray(start).toString("utf8").trimEnd().split("\n")) {
			if (Buffer.byteLength(line) > HARD_LIMITS.maxProtocolLineBytes) return false;
			const entry = JSON.parse(line);
			if (entry.type !== "custom" || entry.customType !== "csheng-worker-lifecycle") continue;
			if (entry.data?.ok !== true) return false;
			if (entry.data.phase === "ready") ready = true;
			else if (entry.data.phase === "stopped" && ready) stopped = true;
			else return false;
		}
		return ready && stopped;
	} catch { return false; }
}

function failure(options: ChildRunOptions, started: number, now: () => number, code: string, message: string): TaskResult {
	return {
		id: options.task.id,
		role: options.task.role,
		status: "failed",
		output: "",
		stderr: "",
		usage: emptyUsage(),
		durationMs: now() - started,
		changedPaths: [],
		telemetry: emptyTaskTelemetry(),
		convergence: "not-applicable",
		route: options.route,
		error: { code, message },
	};
}
