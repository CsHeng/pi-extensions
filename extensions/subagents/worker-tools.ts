import { commandCorrelationKey } from "./command-correlation.ts";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, copyFile, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import {
	createBashToolDefinition, createEditToolDefinition, createFindToolDefinition,
	createGrepToolDefinition, createLsToolDefinition, getAgentDir,
	createReadToolDefinition, createWriteToolDefinition,
	type BashOperations, type ToolDefinition, type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { CHILD_MARKER_ENV, HARD_LIMITS } from "./contracts.ts";
import { authorizePath, loadCapability } from "./path-policy.ts";
import { inspectWorkerInputs, workerGitEnvironment, workerSourceFingerprint, type WorkerInputState } from "./worker-inputs.ts";
import { registerObservationHooks } from "./observation-hooks.ts";

export const WORKER_SCRATCH_ENV = "CSHENG_SUBAGENT_WORKER_SCRATCH";

export interface CommandObservation {
	startMs: number;
	endMs: number | null;
	exitCode: number | null;
	status: "running" | "exited" | "failed" | "aborted" | "timed-out" | "output-limit";
}

export interface WorkerToolsOptions {
	cwd: string;
	scratch: string;
	/** Task environment, not an OS security boundary. Pi authentication stays with Pi. */
	env?: NodeJS.ProcessEnv;
	observeState?: () => Promise<{ sourceKey: string; environmentKey: string }>;
	onCommand?: (value: CommandObservation & { toolCallId: string | null; sourceBeforeKey: string | null; sourceAfterKey: string | null; environmentBeforeKey: string | null; environmentAfterKey: string | null }) => void;
}

/** Trusted host tools. Queueing and candidate ownership do not sandbox bash. */
export async function createWorkerTools(options: WorkerToolsOptions) {
	const cwd = await realpath(options.cwd);
	const scratch = await realpath(options.scratch);
	const scratchRelation = relative(cwd, scratch);
	if (scratchRelation !== ".." && !scratchRelation.startsWith(`..${sep}`) && !isAbsolute(scratchRelation)) throw new Error("worker_scratch_inside_source");
	const shutdownController = new AbortController();
	let tail: Promise<void> = Promise.resolve();
	let closed = false;
	const commands: CommandObservation[] = [];
	const outputs = new Map<string, string>();
	if (process.platform === "win32") throw new Error("worker_host_platform_unsupported");
	let unsettled = false;
	const localBash: BashOperations = { exec(command, directory, execution) {
		const timeout = execution.timeout ?? HARD_LIMITS.taskTimeoutMs / 1000;
		if (!Number.isFinite(timeout) || timeout <= 0 || timeout * 1000 > 2_147_483_647) return Promise.reject(new Error("Invalid timeout"));
		execution.signal?.throwIfAborted();
		return new Promise((resolve, reject) => {
			const child = spawn("bash", ["-c", command], { cwd: directory, env: execution.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
			let error: Error | undefined;
			let timedOut = false;
			let closeTimer: NodeJS.Timeout | undefined;
			const stop = () => {
				if (!child.pid) return;
				try { process.kill(-child.pid, "SIGKILL"); }
				catch (caught) { if ((caught as NodeJS.ErrnoException).code !== "ESRCH") { error = new Error("worker_command_stop_failed"); unsettled = true; } }
			};
			const timeoutTimer = setTimeout(() => { timedOut = true; stop(); }, timeout * 1000);
			child.stdout.on("data", execution.onData);
			child.stderr.on("data", execution.onData);
			child.once("error", (caught) => { error = caught; });
			child.once("exit", () => {
				// Shell exit is not process-group settlement: stop ordinary background
				// descendants before permitting the next tool or candidate freeze.
				stop();
				closeTimer = setTimeout(() => {
					unsettled = true;
					child.stdout.destroy(); child.stderr.destroy();
					reject(new Error("worker_command_unsettled"));
				}, HARD_LIMITS.killGraceMs);
			});
			child.once("close", (code) => {
				clearTimeout(timeoutTimer);
				if (closeTimer) clearTimeout(closeTimer);
				execution.signal?.removeEventListener("abort", stop);
				if (error) reject(error);
				else if (execution.signal?.aborted) reject(new Error("aborted"));
				else if (timedOut) reject(new Error(`timeout:${timeout}`));
				else if (code === null) reject(new Error("worker_command_signalled"));
				else resolve({ exitCode: code });
			});
			if (execution.signal?.aborted) stop();
			else execution.signal?.addEventListener("abort", stop, { once: true });
		});
	} };
	const observeState = async () => { try { return await options.observeState?.(); } catch { return undefined; } };
	const started = performance.now();
	let outputBytes = 0;
	let activeToolCallId: string | null = null;

	const definitions = [
		createReadToolDefinition(cwd), createGrepToolDefinition(cwd),
		createFindToolDefinition(cwd), createLsToolDefinition(cwd),
		createEditToolDefinition(cwd), createWriteToolDefinition(cwd),
		createBashToolDefinition(cwd, {
			exposeSessionEnvironment: false,
			spawnHook: (context) => ({ ...context, env: { ...workerGitEnvironment(options.env ?? context.env), TMPDIR: scratch } }),
			operations: { async exec(command, directory, execution) {
				if (commands.length >= HARD_LIMITS.maxPendingToolCalls) throw new Error("worker_command_limit");
				const before = await observeState();
				const observation: CommandObservation = { startMs: performance.now() - started, endMs: null, exitCode: null, status: "running" };
				commands.push(observation);
				const outputController = new AbortController();
				const signal = AbortSignal.any([outputController.signal, ...(execution.signal ? [execution.signal] : [])]);
				try {
					const result = await localBash.exec(command, directory, { ...execution, signal,
						onData(chunk) {
							outputBytes += chunk.length;
							if (outputBytes > HARD_LIMITS.diagnosticChildBytes) outputController.abort();
							else execution.onData(chunk);
						},
					});
					observation.exitCode = result.exitCode;
					observation.status = "exited";
					return result;
				} catch (error) {
					observation.status = outputController.signal.aborted ? "output-limit" : execution.signal?.aborted ? "aborted" : error instanceof Error && error.message.startsWith("timeout:") ? "timed-out" : "failed";
					if (outputController.signal.aborted) throw new Error("worker_output_limit");
					throw error;
				} finally {
					observation.endMs = unsettled ? null : performance.now() - started;
					const after = unsettled ? undefined : await observeState();
					try { options.onCommand?.({ ...observation, toolCallId: activeToolCallId, sourceBeforeKey: before?.sourceKey ?? null, sourceAfterKey: after?.sourceKey ?? null,
						environmentBeforeKey: before?.environmentKey ?? null, environmentAfterKey: after?.environmentKey ?? null }); } catch { /* Optional metadata. */ }
				}
			} },
		}),
	] as ToolDefinition[];

	const projectOutput = (result: { content: unknown[]; details?: unknown }) => {
		const details = result.details as { fullOutputPath?: string } | undefined;
		if (details?.fullOutputPath && !outputs.has(details.fullOutputPath)) {
			outputs.set(details.fullOutputPath, join(scratch, `command-${randomUUID()}.log`));
		}
		const rewrite = (text: string) => {
			for (const [source, destination] of outputs) text = text.replaceAll(source, destination);
			return text;
		};
		return {
			...result,
			content: result.content.map((part: any) => part.type === "text" ? { ...part, text: rewrite(part.text) } : part),
			...(details?.fullOutputPath ? { details: { ...details, fullOutputPath: outputs.get(details.fullOutputPath) } } : {}),
		};
	};
	const moved = new Set<string>();
	async function collectOutputs(): Promise<void> {
		for (const [source, destination] of outputs) {
			if (moved.has(source)) continue;
			await copyFile(source, destination, constants.COPYFILE_EXCL);
			await chmod(destination, 0o600);
			await rm(source);
			moved.add(source);
		}
	}

	const tools = definitions.map((tool): ToolDefinition => ({
		...tool,
		execute(id, args, signal, onUpdate, context) {
			const run = tail.then(async () => {
				if (closed || unsettled) throw new Error("worker_tools_closed");
				const combined = AbortSignal.any([shutdownController.signal, ...(signal ? [signal] : [])]);
				combined.throwIfAborted();
				activeToolCallId = commandCorrelationKey(id);
				try {
					// Native search may download a missing executable. Require the existing
					// host tool first; this wrapper never provisions tools or changes PATH.
					if (tool.name === "grep" || tool.name === "find") await requireExistingSearchTool(tool.name === "grep" ? "rg" : "fd");
					combined.throwIfAborted();
					const update = (result: any) => {
						const projected = tool.name === "bash" ? projectOutput(result) : result;
						onUpdate?.(projected);
					};
					// Native read/search tools can reject on abort before underlying work
					// settles. Let read-only operations finish, then report cancellation;
					// shutdown and the FIFO retain ownership throughout preparation/I/O.
					const cancellable = ["bash", "write", "edit"].includes(tool.name);
					const result = await tool.execute(id, args, cancellable ? combined : undefined, update, context);
					combined.throwIfAborted();
					return tool.name === "bash" ? projectOutput(result) as typeof result : result;
				} catch (error) {
					if (tool.name === "bash" && error instanceof Error) {
						for (const [source, destination] of outputs) error.message = error.message.replaceAll(source, destination);
					}
					throw error;
				} finally {
					await collectOutputs();
				}
			});
			tail = run.then(() => undefined, () => undefined);
			return run;
		},
	}));
	return {
		tools,
		get commands(): readonly Readonly<CommandObservation>[] { return commands.map((span) => ({ ...span })); },
		async drain() { await tail; if (unsettled) throw new Error("worker_command_unsettled"); },
		async shutdown() {
			closed = true;
			shutdownController.abort();
			await tail;
			if (unsettled) throw new Error("worker_command_unsettled");
			for (const [source, destination] of outputs) {
				if (!moved.has(source)) await rm(source, { force: true });
				await rm(destination, { force: true });
			}
		},
	};
}

async function requireExistingSearchTool(name: "rg" | "fd"): Promise<void> {
	// Pi's documented managed-bin location takes priority over PATH, including
	// its supported Debian fdfind spelling. Never call ensureTool to provision.
	try { await access(join(getAgentDir(), "bin", name), constants.X_OK); return; } catch { /* try existing PATH binaries */ }
	for (const executable of name === "fd" ? ["fd", "fdfind"] : ["rg"]) {
		try { await promisify(execFile)(executable, ["--version"], { timeout: 5_000 }); return; } catch { /* try the next supported spelling */ }
	}
	throw new Error("worker_tool_unavailable");
}

export type WorkerTools = Awaited<ReturnType<typeof createWorkerTools>>;

/** Explicitly loaded only by a managed worker print process, never the parent. */
export default async function managedWorkerExtension(pi: ExtensionAPI): Promise<void> {
	if (process.env[CHILD_MARKER_ENV] !== "1") return;
	const loaded = await loadCapability();
	if (loaded.manifest?.guidance) pi.on("before_agent_start", event => {
		event.systemPromptOptions.contextFiles = loaded.manifest!.guidance!.contextFiles;
	});
	let worker: WorkerTools | undefined;
	let fatal = true;
	const marker = (phase: "ready" | "stopped", ok: boolean) => pi.appendEntry("csheng-worker-lifecycle", { phase, ok });
	pi.on("session_start", () => { marker("ready", !fatal); });
	pi.on("tool_call", async (event) => {
		if (fatal || !loaded.manifest) return { block: true, terminate: true, reason: "Managed worker state is unavailable." };
		if (event.toolName === "bash") return;
		const input = event.input as Record<string, unknown>;
		const decision = await authorizePath(loaded.manifest, event.toolName, typeof input.path === "string" ? input.path : ".");
		if (decision.fatal) fatal = true;
		if (!decision.allowed) return { block: true, terminate: decision.fatal === true, reason: decision.reason ?? "Path denied." };
	});
	try {
		const scratch = process.env[WORKER_SCRATCH_ENV];
		if (!loaded.manifest || loaded.manifest.role !== "worker" || !scratch || await realpath(process.cwd()) !== loaded.manifest.root) throw new Error("managed_worker_state_invalid");
		const root = loaded.manifest.root;
		worker = await createWorkerTools({ cwd: root, scratch,
			observeState: async () => {
				const state = JSON.parse(process.env.CSHENG_SUBAGENT_WORKER_INPUTS ?? "null") as WorkerInputState;
				const environment = await inspectWorkerInputs(root, state);
				return { sourceKey: await workerSourceFingerprint(root, state), environmentKey: environment.environmentKey };
			},
			onCommand: (value) => pi.appendEntry("csheng-worker-command", { ...value, version: 2,
				status: value.endMs === null ? "unknown" : value.status === "exited" ? (value.exitCode === 0 ? "succeeded" : "failed") : value.status === "aborted" ? "aborted" : value.status === "timed-out" ? "timeout" : "failed",
			}),
		});
		for (const tool of worker.tools) pi.registerTool(tool);
		fatal = false;
	} catch { /* The session-start entry records unavailable state without a fallback. */ }
	pi.on("agent_settled", async () => {
		try { if (!worker) throw new Error("unavailable"); await worker.shutdown(); marker("stopped", true); }
		catch { fatal = true; marker("stopped", false); }
	});
	let terminating = false;
	const terminate = () => {
		if (terminating) return;
		terminating = true;
		void (async () => {
			try { await worker?.shutdown(); marker("stopped", worker !== undefined); }
			finally { process.exit(143); }
		})();
	};
	process.on("SIGTERM", terminate);
	pi.on("session_shutdown", async () => { process.off("SIGTERM", terminate); await worker?.shutdown(); });
	registerObservationHooks(pi, { child: true, capabilityKey: loaded.manifest ? createHash("sha256").update(JSON.stringify(loaded.manifest)).digest("hex") : null });
}
