import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider, type FauxProviderHandle } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type ExtensionError,
	type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

export type HostMode = "tui" | "rpc" | "json" | "print";

/** Bounded, redacted lifecycle trace shared by fixture extensions and the harness. */
export interface TraceEntry {
	at: number;
	event: string;
	detail?: Record<string, unknown>;
}

export interface Trace {
	readonly entries: TraceEntry[];
	record(event: string, detail?: Record<string, unknown>): void;
}

export function createTrace(): Trace {
	const started = performance.now();
	const entries: TraceEntry[] = [];
	return {
		entries,
		record(event, detail) {
			entries.push({ at: Math.round(performance.now() - started), event, ...(detail === undefined ? {} : { detail }) });
		},
	};
}

/** Wait until the trace contains a matching entry, or reject on timeout. */
export async function waitForTrace(trace: Trace, predicate: (entry: TraceEntry) => boolean, timeoutMs = 5000): Promise<TraceEntry> {
	const existing = trace.entries.find(predicate);
	if (existing) return existing;
	return await new Promise<TraceEntry>((resolve, reject) => {
		const started = performance.now();
		const poll = setInterval(() => {
			const match = trace.entries.find(predicate);
			if (match) {
				clearInterval(poll);
				resolve(match);
				return;
			}
			if (performance.now() - started > timeoutMs) {
				clearInterval(poll);
				reject(new Error(`trace timeout waiting for entry; saw ${trace.entries.map((entry) => entry.event).join(", ")}`));
			}
		}, 5);
	});
}

/**
 * Records the host lifecycle events the conformance suite asserts on. Place it in the
 * extension factory list wherever the test needs its handler order.
 */
export function createTraceObserver(trace: Trace): ExtensionFactory {
	return (pi) => {
		pi.on("input", (event) =>
			trace.record("input", {
				source: event.source,
				text: event.text,
				imageCount: event.images?.length ?? 0,
				...(event.streamingBehavior === undefined ? {} : { streamingBehavior: event.streamingBehavior }),
			}));
		pi.on("before_agent_start", (event) => trace.record("before_agent_start", { prompt: event.prompt }));
		pi.on("agent_start", () => trace.record("agent_start"));
		pi.on("agent_end", (event) => trace.record("agent_end", { stopReason: stopReasonOf(event.messages) }));
		pi.on("agent_settled", () => trace.record("agent_settled"));
		pi.on("message_start", (event) => trace.record("message_start", { role: event.message.role, preview: previewOf(event.message) }));
		pi.on("message_end", (event) => trace.record("message_end", { role: event.message.role, preview: previewOf(event.message) }));
		pi.on("context", (event) => trace.record("context", { roles: event.messages.map((message) => message.role).join(",") }));
		pi.on("tool_execution_start", (event) => trace.record("tool_start", { toolName: event.toolName }));
		pi.on("tool_execution_end", (event) => trace.record("tool_end", { toolName: event.toolName, isError: event.isError }));
		pi.on("session_shutdown", (event) => trace.record("session_shutdown", { reason: event.reason }));
	};
}

function stopReasonOf(messages: readonly unknown[]): string {
	const last = messages.at(-1) as { stopReason?: string } | undefined;
	return last?.stopReason ?? "none";
}

function previewOf(message: { role: string; content?: unknown }): string {
	const content = message.content;
	if (typeof content === "string") return content.slice(0, 60);
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			const typed = part as { type?: string; text?: string; name?: string };
			if (typed.type === "text") return typed.text ?? "";
			if (typed.type === "toolCall") return `toolCall:${typed.name ?? ""}`;
			return typed.type ?? "";
		})
		.join("|")
		.slice(0, 60);
}

export interface HostHarnessOptions {
	mode?: HostMode;
	/** Bind the real public command wait as Pi CLI modes do. False characterizes an unbound SDK host. */
	commandWait?: boolean;
	/** Shared trace; defaults to a fresh one. */
	trace?: Trace;
	/** Extension factories in load order; settlement handlers run in this order. */
	extensions?: ExtensionFactory[];
	/** Explicit package files, including a real installed snapshot, loaded by the public host loader. */
	extensionPaths?: string[];
	/** Prompt template name -> body, loaded as `/name`. */
	templates?: Record<string, string>;
	/** Use a real session file in a disposable directory instead of an in-memory session. */
	realSessionFile?: boolean;
	/** Reuse an existing session manager (for example a fork) instead of creating a new session. */
	sessionManager?: SessionManager;
	/** Explicit session_start reason for recovery scenarios (default "startup"). */
	sessionStartReason?: "startup" | "reload" | "new" | "resume" | "fork";
	/** Project trust as reported to extensions. Default true for fixture work. */
	trusted?: boolean;
	settings?: Record<string, unknown>;
	tokensPerSecond?: number;
}

export interface HostHarness {
	trace: Trace;
	session: AgentSession;
	faux: FauxProviderHandle;
	agentDir: string;
	workDir: string;
	sessionDir: string;
	errors: ExtensionError[];
	dispose(): Promise<void>;
}

const DEFAULT_SETTINGS = {
	retry: { maxRetries: 1, baseDelayMs: 5 },
	compaction: { enabled: false },
};

/**
 * Runs the actual installed dependency host (`@earendil-works/pi-coding-agent` 0.86.0) with the
 * official faux provider: real lifecycle, real tools, real session manager, no inference.
 */
export async function createHostHarness(options: HostHarnessOptions = {}): Promise<HostHarness> {
	const base = await mkdtemp(join(tmpdir(), "workflow-host-"));
	const agentDir = join(base, "agent");
	const workDir = join(base, "work");
	const sessionDir = join(base, "sessions");
	await mkdir(agentDir, { recursive: true });
	await mkdir(workDir, { recursive: true });
	await mkdir(sessionDir, { recursive: true });
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({ ...DEFAULT_SETTINGS, ...options.settings }));

	const templatePaths: string[] = [];
	if (options.templates) {
		const promptDir = join(base, "prompts");
		await mkdir(promptDir, { recursive: true });
		for (const [name, body] of Object.entries(options.templates)) {
			const file = join(promptDir, `${name}.md`);
			await writeFile(file, body);
			templatePaths.push(file);
		}
	}

	const settingsManager = SettingsManager.create(workDir, agentDir);
	settingsManager.setProjectTrusted(options.trusted ?? true);
	const loader = new DefaultResourceLoader({
		cwd: workDir,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noThemes: true,
		noContextFiles: true,
		additionalPromptTemplatePaths: templatePaths,
		extensionFactories: options.extensions ?? [],
		additionalExtensionPaths: options.extensionPaths ?? [],
	});
	await loader.reload();

	const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
	const faux = fauxProvider({ provider: "wf-fixture", ...(options.tokensPerSecond === undefined ? {} : { tokensPerSecond: options.tokensPerSecond }) });
	runtime.registerNativeProvider(faux.provider);
	const model = faux.getModel();

	const sessionManager = options.sessionManager
		?? (options.realSessionFile ? SessionManager.create(workDir, sessionDir) : SessionManager.inMemory(workDir));
	const { session } = await createAgentSession({
		cwd: workDir,
		agentDir,
		modelRuntime: runtime,
		model,
		resourceLoader: loader,
		sessionManager,
		settingsManager,
		...(options.sessionStartReason === undefined ? {} : { sessionStartEvent: { type: "session_start" as const, reason: options.sessionStartReason } }),
	});

	const trace = options.trace ?? createTrace();
	const errors: ExtensionError[] = [];
	session.subscribe((event) => {
		if (event.type === "agent_start" || event.type === "agent_end" || event.type === "agent_settled") {
			trace.record(`native:${event.type}`);
		}
	});
	const unsupportedCommand = async (): Promise<never> => { throw new Error("unrelated session-control command is outside the host fixture"); };
	await session.bindExtensions({
		mode: options.mode ?? "tui", onError: (error) => errors.push(error),
		...(options.commandWait === false ? {} : { commandContextActions: {
			waitForIdle: () => session.waitForIdle(),
			newSession: unsupportedCommand, fork: unsupportedCommand, navigateTree: unsupportedCommand,
			switchSession: unsupportedCommand, reload: unsupportedCommand,
		} }),
	});

	let disposed = false;
	return {
		trace,
		session,
		faux,
		agentDir,
		workDir,
		sessionDir,
		errors,
		async dispose() {
			if (disposed) return;
			disposed = true;
			session.dispose();
			await rm(base, { recursive: true, force: true });
		},
	};
}
