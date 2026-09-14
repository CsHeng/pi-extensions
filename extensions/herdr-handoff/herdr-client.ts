import { createHash } from "node:crypto";
import {
	HARD_LIMITS,
	handoffErrorMessage,
	type HandoffErrorCode,
	type HandoffMode,
	type LifecycleState,
} from "./contracts.ts";

export const MIN_HERDR_VERSION = [0, 8, 2] as const;
const MAX_CLI_BYTES = 256 * 1024;

export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}

export type HerdrExec = (
	command: string,
	args: string[],
	options?: { signal?: AbortSignal; timeout?: number },
) => Promise<ExecResult>;

export interface HerdrContract {
	herdrVersion: string;
	protocol: number;
	resultTypes: Record<string, string[]>;
	agentInfoRequired: string[];
	worktreeInfoRequired: string[];
	agentStatuses: string[];
	stableErrorCodes: string[];
	rawOutputs?: {
		agentRead: { stream: "stdout"; maxLines: number; maxBytes: number };
	};
}

export interface AgentSnapshot {
	paneId: string;
	workspaceId: string;
	tabId: string;
	status: LifecycleState;
	name?: string;
	kind?: string;
	cwd?: string;
	stateChangeSeq?: number;
	sessionFingerprint?: string;
	interactiveReady?: boolean;
}

export interface WorktreeSnapshot {
	workspaceId: string;
	tabId: string;
	paneId: string;
	checkoutPath: string;
	repoRoot?: string;
	isLinkedWorktree: boolean;
}

export type ClientResult<T> = { ok: true; value: T } | { ok: false; code: HandoffErrorCode; message: string };

function fail(code: HandoffErrorCode): ClientResult<never> {
	return { ok: false, code, message: handoffErrorMessage(code) };
}

function ok<T>(value: T): ClientResult<T> {
	return { ok: true, value };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return keys.every((key) => key in value);
}

export function parseHerdrVersion(text: string): [number, number, number] | undefined {
	const match = text.match(/herdr\s+(\d+)\.(\d+)\.(\d+)/);
	if (!match) return undefined;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function versionAtLeast(actual: readonly number[], minimum: readonly number[]): boolean {
	for (let index = 0; index < minimum.length; index += 1) {
		const left = actual[index] ?? 0;
		const right = minimum[index] ?? 0;
		if (left > right) return true;
		if (left < right) return false;
	}
	return true;
}

function fingerprint(session: Record<string, unknown>): string | undefined {
	if (typeof session.kind !== "string" || typeof session.value !== "string") return undefined;
	return createHash("sha256").update(`${session.kind}\n${session.value}`, "utf8").digest("hex");
}

function asLifecycle(value: unknown): LifecycleState | undefined {
	if (value === "idle" || value === "working" || value === "blocked" || value === "done" || value === "unknown") return value;
	return undefined;
}

export function decodeAgentInfo(value: unknown, required: readonly string[]): AgentSnapshot | undefined {
	if (!isRecord(value) || !hasKeys(value, required)) return undefined;
	const status = asLifecycle(value.agent_status);
	if (typeof value.pane_id !== "string" || typeof value.workspace_id !== "string" || typeof value.tab_id !== "string" || !status) {
		return undefined;
	}
	const snapshot: AgentSnapshot = {
		paneId: value.pane_id,
		workspaceId: value.workspace_id,
		tabId: value.tab_id,
		status,
	};
	if (typeof value.name === "string") snapshot.name = value.name;
	if (typeof value.agent === "string") snapshot.kind = value.agent;
	if (typeof value.cwd === "string") snapshot.cwd = value.cwd;
	if (typeof value.state_change_seq === "number") snapshot.stateChangeSeq = value.state_change_seq;
	if (typeof value.interactive_ready === "boolean") snapshot.interactiveReady = value.interactive_ready;
	if (isRecord(value.agent_session)) {
		const hashed = fingerprint(value.agent_session);
		if (hashed) snapshot.sessionFingerprint = hashed;
	}
	return snapshot;
}

function parseJsonValue(text: string): unknown | undefined {
	const trimmed = text.trim();
	if (!trimmed) return undefined;
	try {
		return JSON.parse(trimmed) as unknown;
	} catch {
		return undefined;
	}
}

function boundRecentOutput(text: string): string {
	const trailingNewline = text.endsWith("\n");
	const content = trailingNewline ? text.slice(0, -1) : text;
	const lines = content === "" ? [] : content.split("\n");
	let bounded = lines.length > HARD_LIMITS.maxReturnLines
		? lines.slice(-HARD_LIMITS.maxReturnLines).join("\n")
		: content;
	if (trailingNewline && bounded !== "") bounded += "\n";
	if (Buffer.byteLength(bounded, "utf8") <= HARD_LIMITS.maxReturnEnvelopeBytes) return bounded;
	let low = 0;
	let high = bounded.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (Buffer.byteLength(bounded.slice(-middle), "utf8") <= HARD_LIMITS.maxReturnEnvelopeBytes) low = middle;
		else high = middle - 1;
	}
	return bounded.slice(-low);
}

function mapHerdrCode(code: string): HandoffErrorCode {
	if (code === "agent_blocked") return "agent_blocked";
	if (code === "agent_prompt_stalled") return "agent_prompt_stalled";
	if (code === "timeout") return "handoff_timed_out";
	if (code === "agent_not_found") return "agent_not_found";
	if (code === "agent_not_ready") return "agent_not_ready";
	if (code === "agent_auth_blocked") return "agent_auth_blocked";
	if (code === "agent_start_failed") return "agent_start_failed";
	return "herdr_protocol_error";
}

export class HerdrClient {
	readonly exec: HerdrExec;
	readonly env: NodeJS.ProcessEnv;
	readonly contract: HerdrContract;

	constructor(options: { exec: HerdrExec; env?: NodeJS.ProcessEnv; contract: HerdrContract }) {
		this.exec = options.exec;
		this.env = options.env ?? process.env;
		this.contract = options.contract;
	}

	callerPaneId(): string | undefined {
		const value = this.env.HERDR_PANE_ID;
		return value ? value : undefined;
	}

	callerWorkspaceId(): string | undefined {
		const value = this.env.HERDR_WORKSPACE_ID;
		return value ? value : undefined;
	}

	async preflight(): Promise<ClientResult<{ version: string }>> {
		if (this.env.HERDR_ENV !== "1") return fail("herdr_environment_required");
		if (!this.callerPaneId() || !this.callerWorkspaceId()) return fail("herdr_environment_required");
		const ran = await this.run(["--version"], 5_000);
		if (!ran.ok) return ran;
		const version = parseHerdrVersion(ran.value.stdout);
		if (!version) return fail("herdr_cli_unavailable");
		if (!versionAtLeast(version, MIN_HERDR_VERSION)) return fail("herdr_cli_incompatible");
		return ok({ version: version.join(".") });
	}

	async getAgent(target: string): Promise<ClientResult<AgentSnapshot>> {
		const ran = await this.run(["agent", "get", target]);
		if (!ran.ok) return ran;
		return this.decodeTyped(ran.value, "agent_info", (result) => decodeAgentInfo(result.agent, this.contract.agentInfoRequired));
	}

	async startAgent(input: {
		name: string;
		kind: string;
		paneId: string;
		args: readonly string[];
		startupTimeoutMs?: number;
		signal?: AbortSignal;
	}): Promise<ClientResult<AgentSnapshot>> {
		const args = ["agent", "start", input.name, "--kind", input.kind, "--pane", input.paneId];
		if (input.startupTimeoutMs !== undefined) args.push("--timeout", String(input.startupTimeoutMs));
		if (input.args.length > 0) args.push("--", ...input.args);
		const ran = await this.run(args, input.startupTimeoutMs, input.signal);
		if (!ran.ok) return ran;
		return this.decodeTyped(ran.value, "agent_started", (result) => {
			if (!Array.isArray(result.argv) || result.argv.some((item) => typeof item !== "string")) return undefined;
			return decodeAgentInfo(result.agent, this.contract.agentInfoRequired);
		});
	}

	async promptAgent(input: {
		target: string;
		text: string;
		mode: HandoffMode;
		timeoutMs: number;
		signal?: AbortSignal;
	}): Promise<ClientResult<AgentSnapshot>> {
		const args = ["agent", "prompt", input.target, input.text, "--wait"];
		if (input.mode === "transfer") args.push("--until", "working");
		args.push("--timeout", String(input.timeoutMs));
		const ran = await this.run(args, input.timeoutMs + 1_000, input.signal);
		if (!ran.ok) return ran;
		return this.decodeTyped(ran.value, "agent_prompted", (result) => decodeAgentInfo(result.agent, this.contract.agentInfoRequired));
	}

	async waitAgent(input: {
		target: string;
		timeoutMs: number;
		until?: LifecycleState;
		signal?: AbortSignal;
	}): Promise<ClientResult<{ status: LifecycleState }>> {
		const args = ["agent", "wait", input.target];
		if (input.until) args.push("--until", input.until);
		args.push("--timeout", String(input.timeoutMs));
		const ran = await this.run(args, input.timeoutMs + 1_000, input.signal);
		if (!ran.ok) return ran;
		return this.decodeTyped(ran.value, "agent_info", (result) => {
			const agent = decodeAgentInfo(result.agent, this.contract.agentInfoRequired);
			return agent === undefined ? undefined : { status: agent.status };
		});
	}

	async readRecentUnwrapped(target: string, signal?: AbortSignal): Promise<ClientResult<{ text: string }>> {
		const ran = await this.run(["agent", "read", target, "--source", "recent-unwrapped", "--lines", String(HARD_LIMITS.maxReturnLines)], 15_000, signal);
		if (!ran.ok) return ran;
		return ok({ text: boundRecentOutput(ran.value.stdout) });
	}

	async sendInterrupt(target: string, signal?: AbortSignal): Promise<ClientResult<void>> {
		const ran = await this.run(["agent", "send-keys", target, "ctrl+c"], HARD_LIMITS.cancelWaitMs, signal);
		if (!ran.ok) return ran;
		const decoded = this.decodeTyped(ran.value, "ok", () => true);
		return decoded.ok ? ok(undefined) : decoded;
	}

	async createLinkedWorktree(input: {
		cwd: string;
		base?: string;
		signal?: AbortSignal;
	}): Promise<ClientResult<WorktreeSnapshot>> {
		const args = ["worktree", "create", "--cwd", input.cwd, "--no-focus"];
		if (input.base) args.push("--base", input.base);
		const ran = await this.run(args, 30_000, input.signal);
		if (!ran.ok) return ran;
		return this.decodeTyped(ran.value, "worktree_created", (result) => {
			if (!isRecord(result.workspace) || !isRecord(result.tab) || !isRecord(result.root_pane) || !isRecord(result.worktree)) return undefined;
			if (!hasKeys(result.worktree, this.contract.worktreeInfoRequired)) return undefined;
			if (typeof result.workspace.workspace_id !== "string" || typeof result.tab.tab_id !== "string" || typeof result.root_pane.pane_id !== "string") {
				return undefined;
			}
			if (
				typeof result.worktree.path !== "string"
				|| typeof result.worktree.is_bare !== "boolean"
				|| typeof result.worktree.is_detached !== "boolean"
				|| typeof result.worktree.is_prunable !== "boolean"
				|| typeof result.worktree.is_linked_worktree !== "boolean"
				|| typeof result.worktree.label !== "string"
			) return undefined;
			const nested = isRecord(result.workspace.worktree) ? result.workspace.worktree : undefined;
			const snapshot: WorktreeSnapshot = {
				workspaceId: result.workspace.workspace_id,
				tabId: result.tab.tab_id,
				paneId: result.root_pane.pane_id,
				checkoutPath: typeof nested?.checkout_path === "string" ? nested.checkout_path : result.worktree.path,
				isLinkedWorktree: result.worktree.is_linked_worktree,
			};
			if (typeof nested?.repo_root === "string") snapshot.repoRoot = nested.repo_root;
			return snapshot;
		});
	}

	private decodeTyped<T>(
		executed: ExecResult,
		type: string,
		decode: (result: Record<string, unknown>) => T | undefined,
	): ClientResult<T> {
		const parsed = parseJsonValue(executed.stdout);
		if (!isRecord(parsed) || !isRecord(parsed.result)) return fail("herdr_protocol_error");
		const required = this.contract.resultTypes[type];
		if (!required || parsed.result.type !== type || !hasKeys(parsed.result, required)) return fail("herdr_protocol_error");
		const value = decode(parsed.result);
		if (value === undefined) return fail("herdr_protocol_error");
		return ok(value);
	}

	private async run(args: string[], timeout?: number, signal?: AbortSignal): Promise<ClientResult<ExecResult>> {
		let executed: ExecResult;
		try {
			executed = await this.exec("herdr", args, {
				...(signal === undefined ? {} : { signal }),
				...(timeout === undefined ? {} : { timeout }),
			});
		} catch {
			return fail("herdr_cli_unavailable");
		}
		const size = Buffer.byteLength(executed.stdout, "utf8") + Buffer.byteLength(executed.stderr, "utf8");
		if (size > MAX_CLI_BYTES) return fail("herdr_protocol_error");
		if (executed.killed) return fail("handoff_timed_out");
		if (executed.code === 0) return ok(executed);
		const errorBody = parseJsonValue(executed.stderr) ?? parseJsonValue(executed.stdout);
		if (isRecord(errorBody) && isRecord(errorBody.error) && typeof errorBody.error.code === "string") {
			return fail(mapHerdrCode(errorBody.error.code));
		}
		return fail("herdr_protocol_error");
	}
}
