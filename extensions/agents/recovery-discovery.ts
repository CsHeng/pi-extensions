import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MANAGED_SESSION_VERSION, type SessionView } from "./session-contracts.ts";
import { PEER_TOOLS, PEER_TOOL_NAMES } from "./peer-protocol.ts";
import { AGENT_EXECUTION_EVENT } from "../shared/agent-execution.ts";
import type { ObserverTask } from "./observer-events.ts";

/** Resolve only the selected handles under the current owner and branch. */
export interface RecoveryDiscoverySource {
	resolveRecoveryHandles(ctx: ExtensionContext, handles: readonly string[]): Promise<SessionView[]>;
	liveObserverTasks(): ObserverTask[];
}

const MAX_HINTS = 20;
const MAX_BRANCH_ENTRIES = 2048;
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9]+$/.test(value) && value.length <= 128;

/** Treat native records as hints only; never copy their prose into the prompt. */
function hints(ctx: ExtensionContext, live: readonly ObserverTask[]): { handles: string[]; incomplete: boolean } {
	const handles = new Set<string>();
	let incomplete = false;
	const add = (handle: unknown, episode: unknown) => {
		if (!identifier(handle) || !Number.isSafeInteger(episode) || (episode as number) < 0) { incomplete = true; return; }
		if (!handles.has(handle) && handles.size >= MAX_HINTS) { incomplete = true; return; }
		handles.add(handle);
	};
	const calls = new Set<string>();
	const receipts = new Set<string>();
	const branch = ctx.sessionManager.getBranch();
	if (branch.length > MAX_BRANCH_ENTRIES) incomplete = true;
	for (const entry of branch.slice(-MAX_BRANCH_ENTRIES) as any[]) {
		const message = entry.type === "message" ? entry.message : undefined;
		if (message?.role === "assistant" && Array.isArray(message.content)) for (const part of message.content) {
			if (part?.type === "toolCall" && PEER_TOOLS.includes(part.name)) {
				if (typeof part.id === "string") calls.add(part.id); else incomplete = true;
			}
		}
		let payload: any;
		if (message?.role === "toolResult" && PEER_TOOLS.includes(message.toolName)) {
			if (typeof message.toolCallId === "string") receipts.add(message.toolCallId); else incomplete = true;
			payload = message.details;
			// A refused operation carries no agents.
			if (payload?.schemaVersion === MANAGED_SESSION_VERSION && payload.error) continue;
			if (payload?.schemaVersion !== MANAGED_SESSION_VERSION || !Array.isArray(payload.sessions)) { if (!message.isError) incomplete = true; continue; }
		} else if (entry.type === "custom" && entry.customType === AGENT_EXECUTION_EVENT) {
			payload = entry.data;
			if (payload?.version !== MANAGED_SESSION_VERSION || !Array.isArray(payload.sessions)) { incomplete = true; continue; }
		} else continue;
		for (const session of payload.sessions.slice(0, MAX_HINTS + 1)) add(session?.handle, session?.episode);
		if (payload.sessions.length > MAX_HINTS) incomplete = true;
	}
	for (const call of calls) if (!receipts.has(call)) incomplete = true;
	for (const row of live.slice(0, MAX_HINTS + 1)) add(row.id, row.episode);
	if (live.length > MAX_HINTS) incomplete = true;
	return { handles: [...handles], incomplete };
}

function describe(view: SessionView, live: readonly ObserverTask[]): string {
	const active = live.some(row => row.id === view.handle && row.episode === view.episode && (row.status === "running" || row.status === "pending"));
	let status: string;
	if (view.state === "running" || view.state === "queued") status = active ? `live ${view.state}` : `${view.state}, activity unconfirmed`;
	else if (view.state === "interrupted" || view.result?.status === "aborted") status = "interrupted or aborted; confirm it stopped with stop_agent";
	else status = view.result ? `result ${view.result.status}${view.reportComplete ? "" : ", report incomplete"}` : "idle, result unavailable";
	if (view.candidate && view.candidate.episode === view.episode) status += `; isolated candidate ${view.candidate.status}`;
	if (view.roots?.some(root => root.recovery === "required")) status += "; root recovery required";
	return `- ${view.label ?? "unnamed agent"} (${view.role}): ${status}`;
}

/** Register inside registerContinuationTool after constructing its service. No wake or mutation is performed. */
export function registerRecoveryDiscovery(pi: ExtensionAPI, service: RecoveryDiscoverySource): void {
	let pending = false;
	let source: "human" | "extension" | "mixed" | undefined;
	let generation = 0;
	const boundary = () => { pending = true; source = undefined; generation++; };
	pi.on("session_start", (event, ctx) => {
		boundary();
		if (event.reason === "new" || event.reason === "fork" || (event.reason === "startup" && !ctx.sessionManager.getLeafId())) pending = false;
	});
	pi.on("session_tree", boundary);
	pi.on("session_compact_failed", event => { if (event.aborted) boundary(); });
	pi.on("agent_end", event => {
		if (event.messages.some(message => message.role === "assistant" && ["aborted", "error"].includes(message.stopReason))) boundary();
	});
	pi.on("session_shutdown", () => { pending = false; source = undefined; generation++; });
	pi.on("input", event => {
		if (!pending || event.streamingBehavior) return;
		const next = event.source === "interactive" || event.source === "rpc" ? "human" : "extension";
		source = source === undefined || source === next ? next : "mixed";
	});
	pi.on("before_agent_start", async (event, ctx) => {
		const genuineInput = source === "human";
		source = undefined;
		if (!pending || !genuineInput || event.messageType !== "user" || !ctx.isProjectTrusted() || !pi.getActiveTools().includes(PEER_TOOL_NAMES.list)) return;
		const revision = generation;
		const session = ctx.sessionManager.getSessionId();
		const leaf = ctx.sessionManager.getLeafId();
		let views: SessionView[] = [];
		let selected: ReturnType<typeof hints>;
		let live: ObserverTask[];
		try {
			live = service.liveObserverTasks();
			selected = hints(ctx, live);
			if (selected.handles.length) views = await service.resolveRecoveryHandles(ctx, selected.handles);
		} catch { selected = { handles: [], incomplete: true }; live = []; }
		const allowed = new Set(selected.handles);
		if (views.some(view => !allowed.has(view.handle) || !identifier(view.handle) || !Number.isSafeInteger(view.episode))) selected.incomplete = true;
		views = views.filter(view => allowed.has(view.handle) && identifier(view.handle) && Number.isSafeInteger(view.episode));
		if (selected.handles.some(handle => !views.some(view => view.handle === handle))) selected.incomplete = true;
		if (!pending || generation !== revision || !ctx.isProjectTrusted() || !pi.getActiveTools().includes(PEER_TOOL_NAMES.list) || ctx.sessionManager.getSessionId() !== session || ctx.sessionManager.getLeafId() !== leaf) return;
		pending = false;
		const relevant = views.filter(view => view.state !== "closed");
		if (!relevant.length && !selected.incomplete) return;
		const rows = relevant.slice(0, 20).map(view => describe(view, live));
		if (relevant.length > rows.length || selected.incomplete) rows.push("- Discovery is incomplete; list_agents recovers all available agents.");
		return { message: { customType: "agents.recovery-discovery", display: false, content: `Agents from this session are available after interruption or session recovery:\n${rows.join("\n")}\nRead their results with list_agents and confirm interrupted agents stopped with stop_agent. Keep useful results and changes; when the current user instruction makes work obsolete, stop a running agent or release it after it has stopped. Do not implicitly discard work.` } };
	});
}
