import { commandCorrelationKey } from "./command-correlation.ts";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, copyFile, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
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
import { GIT_READ_TOOL, registerGitRead } from "./git-read.ts";
import { workerGitEnvironment } from "./worker-inputs.ts";
import { recordCapabilityInvalidation, registerObservationHooks } from "./observation-hooks.ts";
import { getManagedRole, toolsForAccess } from "./roles.ts";
import { isNativePathTool, isNativeBashTool } from "./native-context.ts";
import { startPeerLink, PeerLinkError } from "./peer-link.ts";
import { peerToolDefinitions } from "./peer-tools.ts";
import { DEFAULT_CAPABILITIES } from "./peer-protocol.ts";
import { SharedWriteRecorder } from "./shared-writes.ts";

export const WORKER_SCRATCH_ENV = "PI_EXTENSIONS_AGENT_WORKER_SCRATCH";

export interface CommandObservation {
	startMs: number;
	endMs: number | null;
	exitCode: number | null;
	status: "running" | "exited" | "failed" | "aborted" | "timed-out" | "output-limit";
}

export interface WorkerToolsOptions {
	cwd: string;
	scratch: string;
	env?: NodeJS.ProcessEnv;
	onCommand?: (value: CommandObservation & { toolCallId: string | null }) => void;
}

const WORKER_COMMAND_TOKEN_ENV = "PI_EXTENSIONS_WORKER_CMD_ID";

async function killTaggedDescendants(token: string): Promise<void> {
	if (process.platform !== "linux" || typeof process.getuid !== "function") return;
	const needle = Buffer.from(`${WORKER_COMMAND_TOKEN_ENV}=${token}\0`, "utf8");
	const myUid = process.getuid();
	let entries: string[];
	try { entries = await readdir("/proc"); } catch { return; }
	for (const name of entries) {
		if (!/^\d+$/.test(name)) continue;
		const pid = Number(name);
		if (pid === process.pid) continue;
		try {
			const info = await stat(`/proc/${name}`);
			if (info.uid !== myUid) continue;
			const environ = await readFile(`/proc/${name}/environ`);
			if (environ.includes(needle)) process.kill(pid, "SIGKILL");
		} catch { /* Process exited or unreadable. */ }
	}
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
		const timeout = execution.timeout;
		if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0 || timeout * 1000 > 2_147_483_647)) return Promise.reject(new Error("Invalid timeout"));
		execution.signal?.throwIfAborted();
		return new Promise((resolve, reject) => {
			const commandToken = randomUUID();
			const child = spawn("bash", ["-c", command], { cwd: directory, env: { ...execution.env, [WORKER_COMMAND_TOKEN_ENV]: commandToken }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
			let error: Error | undefined;
			let timedOut = false;
			let closeTimer: NodeJS.Timeout | undefined;
			let sweepTimer: NodeJS.Timeout | undefined;
			const stop = () => {
				if (!child.pid) return;
				try { process.kill(-child.pid, "SIGKILL"); }
				catch (caught) { if ((caught as NodeJS.ErrnoException).code !== "ESRCH") { error = new Error("worker_command_stop_failed"); unsettled = true; } }
			};
			const timeoutTimer = timeout === undefined ? undefined : setTimeout(() => { timedOut = true; stop(); }, timeout * 1000);
			child.stdout.on("data", execution.onData);
			child.stderr.on("data", execution.onData);
			child.once("error", (caught) => { error = caught; });
			child.once("exit", () => {
				// Shell exit is not process-group settlement: stop ordinary background
				// descendants, then sweep detached same-command descendants holding pipes open.
				stop();
				sweepTimer = setTimeout(() => { void killTaggedDescendants(commandToken); }, Math.min(250, Math.floor(HARD_LIMITS.killGraceMs / 4)));
				closeTimer = setTimeout(() => {
					unsettled = true;
					child.stdout.destroy(); child.stderr.destroy();
					reject(new Error("worker_command_unsettled"));
				}, HARD_LIMITS.killGraceMs);
			});
			child.once("close", (code) => {
				if (timeoutTimer) clearTimeout(timeoutTimer);
				if (sweepTimer) clearTimeout(sweepTimer);
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
	const started = performance.now();
	let activeToolCallId: string | null = null;

	const definitions = [
		createReadToolDefinition(cwd), createGrepToolDefinition(cwd),
		createFindToolDefinition(cwd), createLsToolDefinition(cwd),
		createEditToolDefinition(cwd), createWriteToolDefinition(cwd),
		createBashToolDefinition(cwd, {
			exposeSessionEnvironment: false,
			spawnHook: (context) => ({ ...context, env: { ...workerGitEnvironment(options.env ?? context.env), TMPDIR: scratch } }),
			operations: { async exec(command, directory, execution) {
				// Observation storage is bounded; execution has no cumulative command budget.
				if (commands.length >= HARD_LIMITS.maxPendingToolCalls) commands.shift();
				const observation: CommandObservation = { startMs: performance.now() - started, endMs: null, exitCode: null, status: "running" };
				commands.push(observation);
				try {
					const result = await localBash.exec(command, directory, execution);
					observation.exitCode = result.exitCode;
					observation.status = "exited";
					return result;
				} catch (error) {
					observation.status = execution.signal?.aborted ? "aborted" : error instanceof Error && error.message.startsWith("timeout:") ? "timed-out" : "failed";
					throw error;
				} finally {
					observation.endMs = unsettled ? null : performance.now() - started;
					try { options.onCommand?.({ ...observation, toolCallId: activeToolCallId }); } catch {}
				}
			} },
		}),
	] as ToolDefinition[];

	const projectOutput = (result: { content: unknown[]; details?: unknown; structuredContent?: unknown }) => {
		const details = result.details as { fullOutputPath?: string } | undefined;
		const structured = result.structuredContent as { full_output_path?: string } | undefined;
		for (const path of [details?.fullOutputPath, structured?.full_output_path]) {
			if (path && !outputs.has(path)) outputs.set(path, join(scratch, `command-${randomUUID()}.log`));
		}
		const rewrite = (text: string) => {
			for (const [source, destination] of outputs) text = text.replaceAll(source, destination);
			return text;
		};
		return {
			...result,
			content: result.content.map((part: any) => part.type === "text" ? { ...part, text: rewrite(part.text) } : part),
			...(details?.fullOutputPath ? { details: { ...details, fullOutputPath: outputs.get(details.fullOutputPath) } } : {}),
			...(structured?.full_output_path ? { structuredContent: { ...structured, full_output_path: outputs.get(structured.full_output_path) } } : {}),
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
	try { await access(join(getAgentDir(), "bin", name), constants.X_OK); return; } catch {}
	for (const executable of name === "fd" ? ["fd", "fdfind"] : ["rg"]) {
		try { await promisify(execFile)(executable, ["--version"], { timeout: 5_000 }); return; } catch {}
	}
	throw new Error("worker_tool_unavailable");
}

export type WorkerTools = Awaited<ReturnType<typeof createWorkerTools>>;

/**
 * Native names the effective configured catalog already owns. Pi builds builtin tools
 * first and then lets extension/sdk tools replace them, so a non-builtin source means an
 * ordinary configured extension (or MCP/SDK caller) provides that name. The worker kit
 * must not claim those names: CLI extensions load before configured ones and first
 * registration wins, so claiming them would shadow the user's implementation.
 */
function configuredToolNames(pi: Pick<ExtensionAPI, "getAllTools">): ReadonlySet<string> {
	const names = new Set<string>();
	for (const tool of pi.getAllTools()) if (tool.sourceInfo?.source !== "builtin") names.add(tool.name);
	return names;
}

export default async function managedWorkerExtension(pi: ExtensionAPI): Promise<void> {
	if (process.env[CHILD_MARKER_ENV] !== "1") return;
	const loaded = await loadCapability();
	const link = startPeerLink(pi);
	const may = loaded.manifest?.may ?? DEFAULT_CAPABILITIES;
	const peerTools = link ? peerToolDefinitions(async (op, args, signal) => {
		try { return { text: (await link.request(op, args, signal)).text }; }
		catch (error) { return { isError: true, text: error instanceof PeerLinkError ? (error.detail ?? error.code) : "agent_link_failed" }; }
	}, op => op === "list" || op === "wait" || op === "message" || may.invoke) : [];
	// Registered at load so every request of every turn carries the same tool set.
	for (const tool of peerTools) pi.registerTool(tool);
	const recorder = loaded.manifest?.sharedWrites ? new SharedWriteRecorder(loaded.manifest.sharedWrites) : undefined;
	const recorded = new Map<string, string>();
	let worker: WorkerTools | undefined;
	let fatal = true;
	let initialized = false;
	// The lifecycle entry names the operations this toolkit actually owns. FIFO and command
	// evidence only ever describe these; an opaque configured implementation is not
	// certified as drained merely because the toolkit lifecycle settled.
	let ownedTools: string[] = [];
	let recoverySafe = true; // Only in-process, toolkit-owned file operations can attest crash recovery.
	const marker = (phase: "ready" | "stopped", ok: boolean) => pi.appendEntry("agents.worker-lifecycle", { phase, ok, owned: [...ownedTools], recoverySafe });
	// CLI extensions run session_start before configured extensions, so ownership cannot
	// be decided there. before_agent_start runs only after every session_start handler,
	// including configured same-name registrations. The kit then claims only builtin names.
	const initialize = async (): Promise<void> => {
		try {
			const scratch = process.env[WORKER_SCRATCH_ENV];
			if (!loaded.manifest || !scratch || await realpath(process.cwd()) !== loaded.manifest.cwd) throw new Error("managed_worker_state_invalid");
			const root = loaded.manifest.cwd;
			worker = await createWorkerTools({ cwd: root, scratch,
				onCommand: (value) => pi.appendEntry("agents.worker-command", { ...value, version: 2,
					status: value.endMs === null ? "unknown" : value.status === "exited" ? (value.exitCode === 0 ? "succeeded" : "failed") : value.status === "aborted" ? "aborted" : value.status === "timed-out" ? "timeout" : "failed",
				}),
			});
			const allowed = new Set(toolsForAccess(loaded.manifest.grants.some(grant => grant.permission === "write")));
			const configured = configuredToolNames(pi);
			const owned = worker.tools.filter(tool => allowed.has(tool.name) && !configured.has(tool.name));
			for (const tool of owned) pi.registerTool(tool);
			ownedTools = owned.map(tool => tool.name);
			if (allowed.has(GIT_READ_TOOL) && !configured.has(GIT_READ_TOOL)) { registerGitRead(pi, loaded.manifest); ownedTools.push(GIT_READ_TOOL); }
			// This registration is post-load, so Pi's refresh does not reactivate a name that
			// already existed as a builtin (grep/find/ls). Activate the owned tools explicitly.
			pi.setActiveTools([...new Set([...pi.getActiveTools(), ...ownedTools])]);
			fatal = false;
		} catch {}
	};
	pi.on("before_agent_start", async event => {
		if (!initialized) { initialized = true; await initialize(); }
		marker("ready", !fatal);
		if (!loaded.manifest) return;
		event.systemPromptOptions.appendSystemPrompt = [event.systemPromptOptions.appendSystemPrompt, getManagedRole(loaded.manifest.role, loaded.manifest.grants.some(grant => grant.permission === "write"), loaded.manifest.rolePrompt).systemPrompt].filter(Boolean).join("\n\n");
		if (loaded.manifest.guidance) event.systemPromptOptions.contextFiles = loaded.manifest.guidance.contextFiles;
	});
	pi.on("tool_call", async (event) => {
		const peerTool = peerTools.some(tool => tool.name === event.toolName);
		if (!peerTool && (!ownedTools.includes(event.toolName) || !["read", "write", "edit", "ls"].includes(event.toolName))) recoverySafe = false;
		if (fatal || !loaded.manifest) return { block: true, terminate: true, reason: "Managed worker state is unavailable." };
		if (peerTool) return;
		if (isNativeBashTool(event.toolName)) { recorder?.shellUsed(); return; }
		// The typed Git tool authorizes its repository selector and every requested path
		// itself. A native single-path check would authorize the child cwd (git_read has no
		// `path`) and reject valid scoped history queries, so only its grant membership is
		// checked here and the typed implementation remains authoritative.
		if (event.toolName === GIT_READ_TOOL) {
			if (!toolsForAccess(loaded.manifest.grants.some(grant => grant.permission === "write")).includes(event.toolName)) return { block: true, terminate: false, reason: `Tool ${event.toolName} is outside the granted capability.` };
			return;
		}
		// Configured extension, MCP and custom tools are eligible because the effective host
		// catalog exposes them; only the native path tools remain subject to the manifest.
		if (!isNativePathTool(event.toolName)) return;
		const input = event.input as Record<string, unknown>;
		const decision = await authorizePath(loaded.manifest, event.toolName, typeof input.path === "string" ? input.path : ".");
		if (decision.fatal) { fatal = true; recordCapabilityInvalidation(pi); }
		if (!decision.allowed) return { block: true, terminate: decision.fatal === true, reason: decision.reason ?? "Path denied." };
		if (decision.resolvedPath && typeof input.path === "string") input.path = decision.resolvedPath;
		if (recorder && (event.toolName === "write" || event.toolName === "edit")) {
			const target = decision.resolvedPath ?? (typeof input.path === "string" ? input.path : undefined);
			if (target) { recorder.beforeWrite(target); recorded.set(event.toolCallId, target); }
		}
	});
	pi.on("tool_execution_end", event => {
		const target = recorded.get(event.toolCallId);
		if (!target) return;
		recorded.delete(event.toolCallId);
		if (!event.isError) recorder?.afterWrite(target);
	});
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
