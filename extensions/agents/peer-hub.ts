/**
 * Peer hub: executes the agent tools for the main model and for every managed child of this
 * session. Children reach it over a private Unix socket with a per-episode token; the hub resolves
 * the caller from that token, never from a tool argument. Agents are addressed by name; handles,
 * episodes and candidate identities stay inside.
 */
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { mkdtemp, rm, lstat } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { normalizeAccess, pathContains } from "./access.ts";
import type { ChildCapabilityManifest } from "./contracts.ts";
import { authorizePath } from "./path-policy.ts";
import { validateRepositoryTarget } from "./repository-policy.ts";
import type { AgentCapabilities, AgentTask, TaskResult } from "./contracts.ts";
import type { ContinuationService, PeerBridge } from "./continuation.ts";
import { managedWriteRoots, isolatedWriteRoots, type ManagedRecord } from "./managed-sessions.ts";
import { DEFAULT_CAPABILITIES, JsonLineReader, MAX_PEER_MESSAGE_BYTES, PEER_MESSAGE_ENTRY, PEER_STOP_ENTRY, PEER_TURN_ENTRY, formatAgentMessage, workspaceOf, type ChildFrame, type HubFrame, type Participant, type PeerOperation } from "./peer-protocol.ts";
import type { PeerToolOutcome } from "./peer-tools.ts";
import { ManagedError, MANAGED_SESSION_VERSION, type CurrentOwner, type SessionActionResult, type SessionView } from "./session-contracts.ts";
import { readSharedWrites, revertSharedWrites, sharedWritesDirectory, MAX_REPORTED_PATHS } from "./shared-writes.ts";
import type { AgentExecutionEvent } from "../shared/agent-execution.ts";
import type { MainLoopYield } from "../shared/main-loop-yield.ts";
import { DEFAULT_OBSERVATION_WAIT_SECONDS, observationWaitMilliseconds } from "../shared/observation-budget.ts";

const RECEIPT_REPORT_BYTES = 16 * 1024;
const SUMMARY_CHARS = 240;
const STOP_SETTLE_MS = 30_000;
/** Names that address the main agent or a capability selector rather than one agent. */
const RESERVED_NAMES = new Set(["main", "assigner", "peers"]);
/** The only user-role text a woken turn starts with; the messages themselves arrive as agent messages. */
export const WAKE_TRIGGER = "[Host: messages from other agents arrived for you. They appear in this conversation as agent messages; continue your assignment with them.]";

/** `shows` marks the turn result a receipt carries; it counts as shown to its recipient once consumed. */
interface Delivery { id: string; kind: "message" | "receipt"; from: Participant; text: string; shows?: { key: string; handle: string; episode: number } }
/** `stranded` holds why queued messages could not start a turn; the next message retries. */
interface LinkState { socket?: Socket | undefined; accepting: boolean; outbox: Delivery[]; sent: Set<string>; inflight: Map<string, Delivery>; stranded?: string | undefined }
/** `returned` collects results an agent's response carries; they count only once that response is written to its live link. */
interface Caller { participant: Participant; key: string; record?: ManagedRecord; capability?: ChildCapabilityManifest; returned?: Array<Pick<SessionView, "handle" | "episode">> }

export interface PeerHubDependencies {
	service: ContinuationService;
	context(): ExtensionContext | undefined;
	appendEntry(customType: string, data: unknown): void;
	/** Deliver an agent message to the main model as a distinct custom message, never user input. */
	sendToMain(text: string, details: Record<string, unknown>): void;
	mainLoopYield?: MainLoopYield;
	now?(): number;
}

export class PeerError extends Error {
	constructor(readonly code: string, readonly detail?: string) { super(code); this.name = "PeerError"; }
}

const active = (record: Pick<ManagedRecord, "state">) => record.state === "queued" || record.state === "running";
const keyOf = (participant: Participant) => participant.kind === "main" ? "main" : participant.name;
const truncate = (text: string, bytes: number) => {
	if (Buffer.byteLength(text) <= bytes) return text;
	let cut = text.slice(0, bytes);
	while (Buffer.byteLength(cut) > bytes) cut = cut.slice(0, -1);
	return `${cut}\n[report truncated; ${Buffer.byteLength(text) - Buffer.byteLength(cut)} bytes omitted]`;
};
const oneLine = (text: string) => { const flat = text.replace(/\s+/g, " ").trim(); return flat.length > SUMMARY_CHARS ? `${flat.slice(0, SUMMARY_CHARS)}…` : flat; };

export class PeerHub implements PeerBridge {
	private server: Server | undefined;
	private serverReady: Promise<string> | undefined;
	private directory: string | undefined;
	private readonly tokens = new Map<string, { handle: string; episode: number; capability: ChildCapabilityManifest; socket?: Socket }>();
	/** Names claimed by an invoke whose admission has not returned yet. */
	private readonly reserved = new Set<string>();
	/** Idle agents whose next turn is being admitted; later messages join that turn. */
	/** Per-handle wake in progress; only the wake that set its marker clears it. */
	private readonly waking = new Map<string, symbol>();
	/** Agents being stopped or reverted; no message starts a turn meanwhile. */
	private readonly stopping = new Set<string>();
	private readonly links = new Map<string, LinkState>();
	private readonly shown = new Map<string, Map<string, number>>();
	/** Results returned in a tool response; they count as shown at the caller's next model request. */
	private readonly returnedShown = new Map<string, Map<string, number>>();
	/** Messages a wake was started for; a turn that never accepted them reports failed delivery. */
	private readonly wakeIds = new Map<string, { episode: number; ids: Set<string> }>();
	/** Each shared writer's prepared write grants (with anchors) for its latest episode, for revert. */
	private readonly writeGrants = new Map<string, { episode: number; grants: ChildCapabilityManifest["grants"] }>();
	private readonly names = new Map<string, string>();
	/** Lowest episode an admitted turn will reach; admission can return before preparation marks the record queued. */
	private readonly expected = new Map<string, number>();
	private namesOwner: string | undefined;
	private readonly listeners = new Set<() => void>();
	private readonly mainWaiters = new Set<AbortController>();
	private readonly sockets = new Set<Socket>();
	private admissions: Promise<unknown> = Promise.resolve();
	private closed = false;
	private exitCleanup: (() => void) | undefined;
	constructor(private readonly deps: PeerHubDependencies) {}

	openLink(record: ManagedRecord, capability: ChildCapabilityManifest): { binding: { socket: string; token: string }; close(): void } | undefined {
		if (this.closed || !this.directory) return undefined;
		const token = randomUUID();
		this.tokens.set(token, { handle: record.handle, episode: record.episode, capability });
		this.writeGrants.set(record.handle, { episode: record.episode, grants: capability.grants.filter(grant => grant.permission === "write") });
		// Settlement revokes the token and the connection it authenticated.
		const wake = this.wakeIds.get(record.handle)?.episode === record.episode;
		return { binding: { socket: join(this.directory, "hub.sock"), token, ...(wake ? { wake: true } : {}) }, close: () => { const entry = this.tokens.get(token); this.tokens.delete(token); entry?.socket?.destroy(); } };
	}
	turnStarted(record: ManagedRecord, _runId: string, initiator: Participant): void {
		this.record(PEER_TURN_ENTRY, { phase: "started", name: record.task.id, handle: record.handle, role: record.task.role, episode: record.episode, workspace: workspaceOf(record.task), may: record.task.may ?? DEFAULT_CAPABILITIES, initiator });
		this.notify();
	}
	async turnTerminal(event: AgentExecutionEvent, initiator: Participant): Promise<void> {
		for (const view of event.sessions) {
			const ctx = this.deps.context(); if (!ctx) continue;
			let record: ManagedRecord | undefined;
			try { record = await this.deps.service.store.load(view.handle, await this.deps.service.ownerOf(ctx)); } catch { record = undefined; }
			const name = record?.task.id ?? view.label ?? view.handle;
			let written: { paths: string[]; shell: boolean } | undefined;
			if (record && managedWriteRoots(record).length > 0 && isolatedWriteRoots(record).length === 0) {
				try { written = await readSharedWrites(sharedWritesDirectory(this.deps.service.store, { handle: record.handle, episode: view.episode })); } catch { written = undefined; }
			}
			const status = view.result?.status;
			this.record(PEER_TURN_ENTRY, { phase: "finished", name, handle: view.handle, role: view.role, episode: view.episode, workspace: record ? workspaceOf(record.task) : "none", may: record?.task.may ?? DEFAULT_CAPABILITIES, initiator, ...(status ? { status } : {}),
				...(written ? { writtenPaths: written.paths.slice(0, MAX_REPORTED_PATHS).map(path => record ? this.relativeToRoots(record, path) : path), writtenPathsTruncated: written.paths.length > MAX_REPORTED_PATHS, shellUnattributed: written.shell,
					...(status && status !== "succeeded" ? { changedPathCount: written.shell ? null : written.paths.length } : {}) } : {}) });
			if (initiator.kind === "agent") {
				const recipient = this.names.get(initiator.name);
				// The full report goes only to an initiator that controls this agent; a peer gets the summary `list` would show.
				const full = record?.assigner === initiator.name;
				if (recipient) await this.deliverReceipt(recipient, { id: randomUUID(), kind: "receipt", from: { kind: "agent", name, role: view.role }, text: this.reportText(name, view, full), ...(full ? { shows: { key: initiator.name, handle: view.handle, episode: view.episode } } : {}) }).catch(() => {});
			}
			// Messages that arrived while the turn was settling start its next turn, unless this turn was
			// started for messages it never received: that delivery failed and is reported, not repeated.
			const link = this.links.get(view.handle);
			// Only this episode's wake state: a next turn admitted meanwhile keeps its own.
			const entry = this.wakeIds.get(view.handle);
			const woken = entry?.episode === view.episode ? entry.ids : undefined;
			if (woken) this.wakeIds.delete(view.handle);
			if (link && woken && link.outbox.some(item => woken.has(item.id))) { this.bounce(view.handle, new PeerError("delivery_failed")); continue; }
			if (link?.outbox.some(item => item.kind === "message") && !link.stranded && record && !active(record) && !this.stopping.has(view.handle)) {
				const first = link.outbox.find(item => item.kind === "message")!;
				void this.wake(view.handle, first.from).catch(error => this.bounce(view.handle, error));
			}
		}
		this.notify();
	}

	async execute(op: PeerOperation, args: Record<string, unknown>, caller: Caller, signal: AbortSignal | undefined, toolCallId: string): Promise<PeerToolOutcome> {
		try {
			const ctx = this.deps.context();
			if (!ctx) throw new PeerError("agents_unavailable", "The invoking session is not active.");
			if (!ctx.isProjectTrusted()) throw new PeerError("project_trust_required");
			const owner = await this.deps.service.ownerOf(ctx);
			await this.loadNames(owner);
			switch (op) {
				case "invoke": return await this.invoke(args, caller, owner, ctx, signal, toolCallId);
				case "message": return await this.message(args, caller, owner);
				case "list": return await this.list(args, caller, owner);
				case "wait": return await this.wait(args, caller, owner, signal);
				case "stop": return await this.stop(args, caller, owner, ctx);
				case "release": return await this.release(args, caller, owner, ctx);
				case "candidate": return await this.candidate(args, caller, owner, ctx);
			}
		} catch (error) {
			const code = error instanceof PeerError || error instanceof ManagedError ? error.code : (error as { code?: unknown })?.code;
			const detail = error instanceof PeerError || error instanceof ManagedError ? error.detail : undefined;
			return { isError: true, text: `${typeof code === "string" ? code : "agent_operation_failed"}${detail ? `: ${detail}` : ""}`, details: { schemaVersion: MANAGED_SESSION_VERSION, op, error: { code: typeof code === "string" ? code : "agent_operation_failed" } } };
		}
	}
	mainCaller(): Caller { return { participant: { kind: "main" }, key: "main" }; }

	private async invoke(args: Record<string, unknown>, caller: Caller, owner: CurrentOwner, ctx: ExtensionContext, signal: AbortSignal | undefined, toolCallId: string): Promise<PeerToolOutcome> {
		const name = String(args.name), role = String(args.role);
		if (caller.record && !(caller.record.task.may ?? DEFAULT_CAPABILITIES).invoke) throw new PeerError("not_permitted", "This agent may not invoke agents.");
		if (RESERVED_NAMES.has(name)) throw new PeerError("name_reserved", `"${name}" is reserved: "main" addresses the main agent and "assigner"/"peers" are message selectors.`);
		if (this.names.has(name) || this.reserved.has(name)) throw new PeerError("name_in_use", `An agent named ${name} already exists in this session; names are used once.`);
		this.reserved.add(name);
		try { return await this.admitInvoke(name, role, args, caller, owner, ctx, signal, toolCallId); }
		finally { this.reserved.delete(name); }
	}
	private async admitInvoke(name: string, role: string, args: Record<string, unknown>, caller: Caller, owner: CurrentOwner, ctx: ExtensionContext, signal: AbortSignal | undefined, toolCallId: string): Promise<PeerToolOutcome> {
		const definitions = await this.deps.service.roleDefinitions(owner, ctx);
		const definition = definitions.get(role);
		if (!definition) throw new PeerError("unknown_role", `No role definition named ${role}. Available: ${[...definitions.keys()].sort().join(", ")}.`);
		const access = args.access as AgentTask["access"];
		const may = (args.may as AgentCapabilities | undefined) ?? definition.may;
		const workspace = (args.workspace as AgentTask["workspace"]) ?? definition.workspace;
		const task = { id: name, role, objective: String(args.prompt), access, workspace, may,
			...(typeof args.executionProfile === "string" ? { executionProfile: args.executionProfile as AgentTask["executionProfile"] } : {}),
			...(typeof args.thinkingProfile === "string" ? { thinkingProfile: args.thinkingProfile as AgentTask["thinkingProfile"] } : {}),
			...(typeof args.model === "string" ? { model: args.model } : {}),
			...(typeof args.thinking === "string" ? { thinking: args.thinking as AgentTask["thinking"] } : {}) } as AgentTask;
		// A foreground host observes the first turn inside execute, so the name binds at admission.
		// An agent caller gets the admission receipt and collects the result through wait_agents or a receipt.
		const result = await this.admit(async release => {
			if (caller.record) await this.constrainAccess(caller, access);
			return this.deps.service.execute({ action: "create", tasks: [task] }, ctx, signal, undefined, toolCallId, { initiator: caller.participant, ...(caller.record ? { detach: true, authorize: records => this.confirmDescendantPins(caller, records) } : {}),
				admitted: handles => { if (handles[0]) { this.names.set(name, handles[0]); this.expected.set(handles[0], 1); } release(); } });
		});
		const view = result.sessions[0];
		if (!view || (result.status !== "accepted" && result.status !== "succeeded" && !view.result)) throw new ManagedError(result.error?.code ?? "invoke_failed", undefined, result.error?.detail);
		this.names.set(name, view.handle);
		const writes = access.some(rule => rule.permission === "write");
		const header = `Agent ${name} (role ${role}) ${result.kind === "execution" ? "finished its first turn" : "is running"}${writes ? `; workspace ${workspace}` : ""}; may message ${may.message.join(", ") || "nobody"}${may.roster ? ", sees the roster" : ""}${may.invoke ? ", may invoke agents" : ""}.`;
		if (result.kind === "execution") { this.markReturned(caller, view); return { text: `${header}\n${this.reportText(name, view, true)}`, details: this.details("invoke", [view], result) }; }
		return { text: `${header} Its turn result returns to you.`, details: this.details("invoke", [view], result) };
	}

	private async message(args: Record<string, unknown>, caller: Caller, owner: CurrentOwner): Promise<PeerToolOutcome> {
		const to = String(args.to), text = String(args.message);
		if (Buffer.byteLength(text) > MAX_PEER_MESSAGE_BYTES) throw new PeerError("message_too_large");
		if (to === caller.key) throw new PeerError("message_to_self");
		const may = caller.record?.task.may ?? DEFAULT_CAPABILITIES;
		if (to === "main") {
			if (caller.participant.kind === "main") throw new PeerError("message_to_self");
			if (!((may.message.includes("assigner") && caller.record?.assigner === "main") || may.message.includes("main"))) throw new PeerError("not_permitted", "This agent may not message the main agent.");
			this.deps.sendToMain(formatAgentMessage(caller.participant, "message", text), { from: caller.participant });
			for (const waiter of this.mainWaiters) waiter.abort();
			this.record(PEER_MESSAGE_ENTRY, { from: caller.participant, to: { kind: "main" }, bytes: Buffer.byteLength(text), kind: "message", delivery: "main", startedTurn: false });
			return { text: "Delivered to main.", details: this.details("message", []) };
		}
		const target = await this.recordByName(to, owner);
		if (caller.record && !this.mayMessage(caller.record, target)) throw new PeerError("not_permitted", `This agent may not message ${to}.`);
		const delivery: Delivery = { id: randomUUID(), kind: "message", from: caller.participant, text };
		const { outcome, request } = await this.deliverMessage(target, delivery);
		this.record(PEER_MESSAGE_ENTRY, { from: caller.participant, to: { kind: "agent", name: to, role: target.task.role }, bytes: Buffer.byteLength(text), kind: "message", delivery: outcome, startedTurn: outcome === "started-turn" });
		const text_ = outcome === "started-turn" ? `${to} was idle and starts a new turn with your message; that turn's result returns to you.`
			: outcome === "running" ? `${to} is running and reads your message at its next model call.`
			: `${to} is running; your message is queued and reaches it at its next model call or next turn.`;
		return { text: text_, details: this.details("message", [], request) };
	}

	private async list(args: Record<string, unknown>, caller: Caller, owner: CurrentOwner): Promise<PeerToolOutcome> {
		const store = this.deps.service.store;
		if (typeof args.name === "string") {
			const record = await this.recordByName(args.name, owner);
			this.requireVisible(caller, record);
			const view = store.view(record);
			const full = this.controls(caller, record);
			if (view.result && full && !this.pending(record)) { this.markReturned(caller, view); if (caller.key === "main") this.deps.service.acknowledge({ sessions: [view] }); }
			return { text: `${this.rosterLine(record, view)}\n${this.reportText(record.task.id, view, full)}`, details: this.details("list", [view]) };
		}
		const views = await store.list(owner);
		const rows: string[] = []; const shownViews: SessionView[] = [];
		for (const view of views) {
			let record: ManagedRecord;
			try { record = await store.load(view.handle, owner); } catch { continue; }
			if (!this.visible(caller, record)) continue;
			// A roster line is a summary, not the result: it neither counts as shown nor consumes a notice.
			rows.push(this.rosterLine(record, view)); shownViews.push(view);
		}
		return { text: rows.length ? rows.join("\n") : "No agents.", details: this.details("list", shownViews) };
	}

	private async wait(args: Record<string, unknown>, caller: Caller, owner: CurrentOwner, signal: AbortSignal | undefined): Promise<PeerToolOutcome> {
		const store = this.deps.service.store;
		let handles: string[];
		if (Array.isArray(args.names)) {
			handles = [];
			for (const name of args.names as string[]) { const record = await this.recordByName(name, owner); this.requireVisible(caller, record); handles.push(record.handle); }
		} else {
			handles = [];
			for (const view of await store.list(owner)) {
				const record = await store.load(view.handle, owner).catch(() => undefined);
				if (record && this.pending(record) && (caller.key === "main" ? record.assigner === "main" || record.assigner === undefined : record.assigner === caller.key)) handles.push(record.handle);
			}
			if (!handles.length) return { text: "None of the agents you invoked is running.", details: this.details("wait", []) };
		}
		const budget = observationWaitMilliseconds(typeof args.waitSeconds === "number" ? args.waitSeconds : DEFAULT_OBSERVATION_WAIT_SECONDS);
		// Results of the awaited agents arrive through this wait, so only other notices release it.
		const runs = new Set((await Promise.all(handles.map(handle => store.load(handle, owner).catch(() => undefined)))).flatMap(record => record?.dispatch?.runId ? [record.dispatch.runId] : []));
		const window = caller.key === "main" ? this.deps.mainLoopYield?.open({ ignore: ref => ref.producer === "agents" && (handles.some(handle => ref.id.endsWith(`:${handle}`)) || ref.id === ref.runId && ref.runId !== undefined && runs.has(ref.runId)) }) : undefined;
		const mainWaiter = caller.key === "main" ? new AbortController() : undefined;
		if (mainWaiter) this.mainWaiters.add(mainWaiter);
		const stop = AbortSignal.any([...(signal ? [signal] : []), ...(window ? [window.signal] : []), ...(mainWaiter ? [mainWaiter.signal] : [])]);
		let reason: string | undefined;
		try {
			const deadline = Date.now() + budget;
			for (;;) {
				const records = await Promise.all(handles.map(handle => store.load(handle, owner)));
				if (records.every(record => !this.pending(record))) break;
				if (stop.aborted) { reason = mainWaiter?.signal.aborted ? "message" : window?.reason ?? "aborted"; break; }
				const remaining = deadline - Date.now();
				if (remaining <= 0) { reason = "expired"; break; }
				await new Promise<void>(resolve => {
					const done = () => { clearTimeout(timer); this.listeners.delete(done); stop.removeEventListener("abort", done); resolve(); };
					const timer = setTimeout(done, Math.min(remaining, 1000));
					this.listeners.add(done); stop.addEventListener("abort", done, { once: true });
				});
			}
		} finally { window?.close(); if (mainWaiter) this.mainWaiters.delete(mainWaiter); }
		const sections: string[] = []; const views: SessionView[] = []; const returned: SessionView[] = [];
		for (const handle of handles) {
			const record = await store.load(handle, owner); const view = store.view(record); views.push(view);
			if (this.pending(record)) { sections.push(`${record.task.id}: still ${active(record) ? record.state : "starting"}.`); continue; }
			const full = this.controls(caller, record);
			if (view.result && full) this.markReturned(caller, view);
			returned.push(view);
			const stranded = this.links.get(handle)?.stranded;
			sections.push(this.reportText(record.task.id, view, full) + (stranded ? `\nMessages queued for it could not start a turn (${stranded}); they stay queued until another message or release.` : ""));
		}
		if (caller.key === "main") this.deps.service.acknowledge({ sessions: returned });
		const prefix = reason === "expired" ? "Wait budget expired; agents still running continue.\n" : reason === "message" ? "Returned early: a message for you arrived.\n" : reason === "steer" ? "Returned early for the user's steering message; agents continue.\n" : reason === "result" ? "Returned early: another result is ready; agents continue.\n" : reason ? "Wait ended early; agents continue.\n" : "";
		return { text: prefix + sections.join("\n\n"), details: this.details("wait", views) };
	}

	private async stop(args: Record<string, unknown>, caller: Caller, owner: CurrentOwner, ctx: ExtensionContext): Promise<PeerToolOutcome> {
		const store = this.deps.service.store;
		let record = await this.recordByName(String(args.name), owner);
		this.requireControl(caller, record);
		if (this.stopping.has(record.handle)) throw new PeerError("stop_pending", `${record.task.id} is already being stopped.`);
		this.stopping.add(record.handle);
		try {
			const lines: string[] = [];
			const link = this.links.get(record.handle);
			// Queued messages would start another turn; stopping drops them (receipts stay for a later turn).
			if (link) { link.outbox = link.outbox.filter(item => item.kind === "receipt"); link.stranded = undefined; }
			// A wake already entering admission finishes its transition first; then its turn is stopped like any other.
			for (let waited = 0; this.waking.has(record.handle) && waited < STOP_SETTLE_MS; waited += 50) await new Promise(resolve => setTimeout(resolve, 50));
			if (this.waking.has(record.handle)) throw new PeerError("stop_pending", `${record.task.id} is starting a turn; repeat stop_agent to confirm.`);
			record = await store.load(record.handle, owner);
			const live = () => active(record) || this.deps.service.agentLive(record.handle);
			if (live()) {
				const cancelled = this.deps.service.cancelAgent(record.handle);
				const deadline = Date.now() + STOP_SETTLE_MS;
				while (live() && Date.now() < deadline) {
					await new Promise<void>(resolve => { const done = () => { clearTimeout(timer); this.listeners.delete(done); resolve(); }; const timer = setTimeout(done, 250); this.listeners.add(done); });
					record = await store.load(record.handle, owner);
				}
				if (!cancelled && active(record) && !this.deps.service.agentLive(record.handle)) {
					// No live run in this process: confirm settlement of an episode a host restart interrupted.
					const result = await this.deps.service.execute({ action: "reconcile", handle: record.handle, expectedEpisode: record.episode }, ctx, undefined, undefined, `peer-${randomUUID()}`);
					if (result.status === "failed") throw new ManagedError(result.error?.code ?? "stop_unconfirmed", undefined, result.error?.detail);
					record = await store.load(record.handle, owner);
				}
				if (live()) throw new PeerError("stop_pending", `${record.task.id} has not stopped yet; repeat stop_agent to confirm.`);
				lines.push(`${record.task.id} stopped.`);
			} else lines.push(`${record.task.id} was not running.`);
			if (record.state === "interrupted" && record.reconciledEpisode !== record.episode) {
				// The engine confirms writer settlement or refuses; nothing is reverted on uncertain settlement.
				const result = await this.deps.service.execute({ action: "reconcile", handle: record.handle, expectedEpisode: record.episode }, ctx, undefined, undefined, `peer-${randomUUID()}`);
				if (result.status === "failed") throw new ManagedError(result.error?.code ?? "stop_unconfirmed", undefined, result.error?.detail);
				record = await store.load(record.handle, owner);
				lines.push(`${record.task.id} is confirmed stopped.`);
			}
			if (args.revert === true) {
				if (managedWriteRoots(record).length === 0 || isolatedWriteRoots(record).length > 0) throw new PeerError("revert_requires_shared_writer");
				const settled = record.state === "idle" || record.state === "interrupted" && record.reconciledEpisode === record.episode;
				if (!settled || active(record) || this.deps.service.agentLive(record.handle)) throw new PeerError("stop_unconfirmed", `${record.task.id}'s writer settlement is not confirmed; nothing was reverted.`);
				// Revert writes only into the checkout identity admitted for this agent.
				try { for (const root of managedWriteRoots(record)) await validateRepositoryTarget(root.target); }
				catch { throw new PeerError("checkout_changed", `${record.task.id}'s checkout changed identity; nothing was reverted.`); }
				// Each write grant must still be the directory prepared for that episode (its anchor identity).
				const prepared = this.writeGrants.get(record.handle);
				if (!prepared || prepared.episode !== record.episode || !prepared.grants.length) throw new PeerError("revert_unavailable", `${record.task.id}'s prepared grants for its last turn are not available in this session; nothing was reverted.`);
				for (const grant of prepared.grants) {
					const info = grant.anchor ? await lstat(grant.anchor.path).catch(() => undefined) : undefined;
					if (!grant.anchor || !info?.isDirectory() || info.dev !== grant.anchor.dev || info.ino !== grant.anchor.ino) throw new PeerError("checkout_changed", `${record.task.id}'s granted directory changed identity; nothing was reverted.`);
					// Below the anchor, every existing component up to the grant is a real directory (or the granted file), never a symlink.
					const below = grant.path.length > grant.anchor.path.length ? grant.path.slice(grant.anchor.path.length + 1).split("/").filter(Boolean) : [];
					let current = grant.anchor.path;
					for (const [index, part] of below.entries()) {
						current = join(current, part);
						const step = await lstat(current).catch(() => undefined);
						if (!step) break;
						// A single-file grant ends in a regular file.
						if (!step.isDirectory() && !(index === below.length - 1 && step.isFile())) throw new PeerError("checkout_changed", `${record.task.id}'s granted directory changed identity; nothing was reverted.`);
					}
				}
				const writable = prepared.grants.map(grant => grant.path);
				const outcome = await revertSharedWrites(sharedWritesDirectory(store, record), writable);
				this.record(PEER_STOP_ENTRY, { name: record.task.id, handle: record.handle, by: caller.participant, reverted: outcome.reverted.length, kept: outcome.kept.length, unknown: outcome.shell });
				lines.push(`Reverted ${outcome.reverted.length} file(s) its last turn wrote${outcome.reverted.length ? `: ${outcome.reverted.slice(0, 20).map(path => this.relativeToRoots(record, path)).join(", ")}` : ""}.`);
				if (outcome.kept.length) lines.push(`Left in place because someone else changed them, or they were not regular files inside its grant: ${outcome.kept.slice(0, 20).map(path => this.relativeToRoots(record, path)).join(", ")}.`);
				if (outcome.shell) lines.push("It also ran shell commands; changes made through the shell are not attributed and stay in place.");
			}
			return { text: lines.join("\n"), details: this.details("stop", [store.view(record)]) };
		} finally { this.stopping.delete(record.handle); this.notify(); }
	}

	private async release(args: Record<string, unknown>, caller: Caller, owner: CurrentOwner, ctx: ExtensionContext): Promise<PeerToolOutcome> {
		const record = await this.recordByName(String(args.name), owner);
		this.requireControl(caller, record);
		if (active(record) || this.pending(record)) throw new PeerError("agent_running", `${record.task.id} is running; stop it first.`);
		const disposition = args.disposition === "discard" ? "discard" : "retain";
		// Discarding an isolated agent deletes its unapplied candidate, so it follows the same shown rule as agent_candidate.
		if (disposition === "discard") { const unseen = this.unseenResult(caller, record); if (unseen) return unseen; }
		const result = await this.deps.service.execute({ action: "close", handle: record.handle, expectedEpisode: record.episode, disposition }, ctx, undefined, undefined, `peer-${randomUUID()}`);
		if (result.status !== "succeeded") throw new ManagedError(result.error?.code ?? "release_failed", undefined, result.error?.detail);
		this.links.delete(record.handle);
		if (caller.key === "main") this.deps.service.acknowledge(result);
		return { text: `${record.task.id} released (${disposition}); its name stays bound in this session.`, details: this.details("release", result.sessions, result) };
	}
	/** D7: a caller acts on an isolated candidate only after it has been shown that turn's result. */
	private unseenResult(caller: Caller, record: ManagedRecord): PeerToolOutcome | undefined {
		if (isolatedWriteRoots(record).length === 0 || !record.result) return undefined;
		if ((this.shown.get(caller.key)?.get(record.handle) ?? 0) >= record.episode) return undefined;
		const view = this.deps.service.store.view(record);
		this.markReturned(caller, view);
		if (caller.key === "main") this.deps.service.acknowledge({ sessions: [view] });
		return { isError: true, text: `${record.task.id} has a result you have not been shown; the checkout is untouched. Review it, then repeat the action.\n${this.reportText(record.task.id, view, true)}`, details: this.details("candidate", [view]) };
	}

	private async candidate(args: Record<string, unknown>, caller: Caller, owner: CurrentOwner, ctx: ExtensionContext): Promise<PeerToolOutcome> {
		const store = this.deps.service.store;
		const record = await this.recordByName(String(args.name), owner);
		this.requireControl(caller, record);
		if (isolatedWriteRoots(record).length === 0) throw new PeerError("not_isolated", `${record.task.id} works in a shared checkout; its changes are already in the working tree.`);
		if (active(record) || this.pending(record)) throw new PeerError("agent_running", `${record.task.id} is running; wait for its result first.`);
		const unseen = this.unseenResult(caller, record); if (unseen) return unseen;
		const action = String(args.action);
		if (action === "discard") {
			const result = await this.deps.service.execute({ action: "close", handle: record.handle, expectedEpisode: record.episode, disposition: "discard" }, ctx, undefined, undefined, `peer-${randomUUID()}`);
			if (result.status !== "succeeded") throw new ManagedError(result.error?.code ?? "discard_failed", undefined, result.error?.detail);
			this.links.delete(record.handle);
			return { text: `${record.task.id}'s candidate and private copy were discarded and the agent released.`, details: this.details("candidate", result.sessions, result) };
		}
		if (action === "apply" && !record.candidate) throw new PeerError("candidate_missing", `${record.task.id} has no candidate for its latest turn.`);
		const request = action === "apply" ? { action: "apply", handle: record.handle, expectedEpisode: record.episode, candidateId: record.candidate!.id } : { action: "refresh", handle: record.handle, expectedEpisode: record.episode };
		const result: SessionActionResult = await this.deps.service.execute(request, ctx, undefined, undefined, `peer-${randomUUID()}`);
		const after = result.sessions[0];
		if (result.status !== "succeeded") {
			const conflicts = result.error?.conflicts?.map(item => `${item.changedCount} changed path(s) in one root${item.changedPaths.length ? `, including ${item.changedPaths.join(", ")}` : ""}`).join("; ");
			return { isError: true, text: `${action} did not complete: ${result.error?.code ?? "failed"}${conflicts ? ` (${conflicts})` : ""}${result.error?.detail ? `. ${result.error.detail}` : ""}`, details: this.details("candidate", result.sessions, result) };
		}
		return { text: action === "apply" ? `${record.task.id}'s candidate was applied to the checkout (${after?.candidate?.appliedPaths.length ?? 0} paths). Applying is not acceptance; verify the result.` : `${record.task.id}'s private copy now includes the current checkout; its old candidate is no longer valid.`, details: this.details("candidate", result.sessions, result) };
	}

	// ---- Delivery ----
	/**
	 * Enqueue and decide in one step per recipient: a running or starting turn takes the message at
	 * its next model call; an idle agent starts exactly one turn, whose initiator is the sender that
	 * started it. The returned disposition is what happened, and telemetry records the same.
	 */
	private async deliverMessage(target: ManagedRecord, delivery: Delivery): Promise<{ outcome: "running" | "queued" | "started-turn"; request?: SessionActionResult }> {
		if (target.state === "closed") throw new PeerError("agent_released", `${target.task.id} was released.`);
		if (target.state === "interrupted") throw new PeerError("agent_interrupted", `${target.task.id} was interrupted; its assigner or the main agent can release it.`);
		if (this.stopping.has(target.handle)) throw new PeerError("agent_stopping", `${target.task.id} is being stopped.`);
		const link = this.link(target.handle);
		if (active(target) || this.waking.has(target.handle) || this.deps.service.agentLive(target.handle) || target.episode < (this.expected.get(target.handle) ?? 0)) {
			link.outbox.push(delivery); this.flush(link);
			return { outcome: link.socket && link.accepting ? "running" : "queued" };
		}
		link.outbox.push(delivery); link.stranded = undefined;
		try { const request = await this.wake(target.handle, delivery.from); return { outcome: "started-turn", ...(request ? { request } : {}) }; }
		catch (error) {
			if (error instanceof PeerError && error.code === "agent_busy") return { outcome: "queued" };
			link.outbox = link.outbox.filter(item => item.id !== delivery.id);
			// Messages other senders queued behind this failed wake are reported rather than left pending.
			if (link.outbox.some(item => item.kind === "message")) this.bounce(target.handle, error);
			throw error;
		}
	}
	/** Queued messages that could not start a turn stay visible instead of holding waits open. */
	private bounce(handle: string, error: unknown): void {
		const link = this.links.get(handle); if (!link) return;
		link.stranded = error instanceof PeerError || error instanceof ManagedError ? error.code : "wake_failed";
		this.notify();
	}
	private async deliverReceipt(handle: string, delivery: Delivery): Promise<void> {
		const ctx = this.deps.context(); if (!ctx) return;
		const record = await this.deps.service.store.load(handle, await this.deps.service.ownerOf(ctx));
		if (record.state === "closed") return;
		const link = this.link(handle);
		link.outbox.push(delivery);
		if (active(record)) this.flush(link);
		this.record(PEER_MESSAGE_ENTRY, { from: delivery.from, to: { kind: "agent", name: record.task.id, role: record.task.role }, bytes: Buffer.byteLength(delivery.text), kind: "receipt", delivery: active(record) ? "running" : "held", startedTurn: false });
	}
	/**
	 * Start an idle agent's next turn; the initiator receives that turn's result. The turn's user
	 * input is only the neutral host trigger: the waiting messages stay queued and reach the child
	 * as agent messages when its link attaches, before its first model call.
	 */
	private async wake(handle: string, initiator: Participant): Promise<SessionActionResult | undefined> {
		if (this.waking.has(handle)) throw new PeerError("agent_busy");
		const marker = Symbol(handle);
		this.waking.set(handle, marker);
		const clear = () => { if (this.waking.get(handle) === marker) this.waking.delete(handle); };
		try {
			return await this.admit(async release => {
				const ctx = this.deps.context(); if (!ctx) throw new PeerError("agents_unavailable");
				const owner = await this.deps.service.ownerOf(ctx);
				const record = await this.deps.service.store.load(handle, owner);
				const link = this.link(handle);
				if (!link.outbox.some(item => item.kind === "message")) { release(); return undefined; }
				if (active(record) || this.deps.service.agentLive(handle)) { this.flush(link); release(); throw new PeerError("agent_busy"); }
				if (record.state !== "idle") throw new PeerError(record.state === "closed" ? "agent_released" : "agent_interrupted");
				if (this.stopping.has(handle)) throw new PeerError("agent_stopping");
				this.wakeIds.set(handle, { episode: record.episode + 1, ids: new Set(link.outbox.filter(item => item.kind === "message").map(item => item.id)) });
				try {
					// An agent sender collects the woken turn's result through its receipt; the main agent follows its host mode.
					const result = await this.deps.service.execute({ action: "continue", episodes: [{ handle, expectedEpisode: record.episode, message: WAKE_TRIGGER }] }, ctx, undefined, undefined, `peer-wake-${randomUUID()}`, { initiator, ...(initiator.kind === "agent" ? { detach: true } : {}),
						admitted: handles => { if (handles.includes(handle)) this.expected.set(handle, record.episode + 1); clear(); release(); } });
					if (result.status === "failed" && result.kind !== "execution") throw new ManagedError(result.error?.code ?? "wake_failed", undefined, result.error?.detail);
					return result;
				} catch (error) { if (this.wakeIds.get(handle)?.episode === record.episode + 1) this.wakeIds.delete(handle); throw error; }
			});
		} finally { clear(); }
	}
	/** A turn is running, admitted but not yet prepared, or about to start for queued messages. */
	private pending(record: ManagedRecord): boolean {
		if (active(record) || this.waking.has(record.handle) || this.deps.service.agentLive(record.handle)) return true;
		if (record.state !== "idle") return false;
		const link = this.links.get(record.handle);
		return record.episode < (this.expected.get(record.handle) ?? 0) || (!link?.stranded && link?.outbox.some(item => item.kind === "message") === true);
	}
	private link(handle: string): LinkState {
		let link = this.links.get(handle);
		if (!link) { link = { accepting: false, outbox: [], sent: new Set(), inflight: new Map() }; this.links.set(handle, link); }
		return link;
	}
	private flush(link: LinkState): void {
		if (!link.socket || !link.accepting) return;
		for (const item of link.outbox) {
			if (link.sent.has(item.id)) continue;
			link.sent.add(item.id);
			this.send(link.socket, { type: "deliver", id: item.id, kind: item.kind, from: item.from, text: item.text });
		}
	}
	private send(socket: Socket, frame: HubFrame): void { if (!socket.destroyed) socket.write(`${JSON.stringify(frame)}\n`); }

	async start(): Promise<void> {
		if (this.serverReady) { await this.serverReady; return; }
		this.serverReady = (async () => {
			const directory = await mkdtemp(join(tmpdir(), "pi-agents-"));
			const path = join(directory, "hub.sock");
			const server = createServer(socket => this.accept(socket));
			await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, () => { server.off("error", reject); resolve(); }); });
			server.unref();
			this.server = server; this.directory = directory;
			// A host that exits without session shutdown still removes its private socket directory.
			const cleanup = () => { try { rmSync(directory, { recursive: true, force: true }); } catch { /* best effort */ } };
			process.once("exit", cleanup);
			this.exitCleanup = cleanup;
			return path;
		})();
		await this.serverReady;
	}
	private accept(socket: Socket): void {
		this.sockets.add(socket);
		socket.setEncoding("utf8");
		let binding: { handle: string; episode: number; capability: ChildCapabilityManifest; socket?: Socket } | undefined;
		let token: string | undefined;
		const requests = new Map<string, AbortController>();
		const reader = new JsonLineReader(raw => {
			const frame = raw as ChildFrame;
			if (!binding) {
				const entry = frame?.type === "hello" && typeof frame.token === "string" ? this.tokens.get(frame.token) : undefined;
				// One connection per episode token: a replayed hello never takes over a live link.
				if (!entry || entry.socket) { socket.destroy(); return; }
				entry.socket = socket; binding = entry; token = (frame as { token: string }).token;
				const link = this.link(binding.handle);
				link.socket?.destroy();
				link.socket = socket; link.accepting = true; link.sent.clear();
				this.flush(link);
				this.send(socket, { type: "ready" });
				return;
			}
			// Frames count only while this connection still holds its episode's live token.
			if (!token || this.tokens.get(token)?.socket !== socket) { socket.destroy(); return; }
			const link = this.link(binding.handle);
			if (link.socket !== socket) { socket.destroy(); return; }
			if (frame.type === "accepted") { const item = link.outbox.find(entry => entry.id === frame.id); if (item) { link.outbox = link.outbox.filter(entry => entry !== item); link.inflight.set(item.id, item); } }
			else if (frame.type === "rejected") { link.accepting = false; link.sent.delete(frame.id); }
			else if (frame.type === "consumed") {
				const item = link.inflight.get(frame.id); link.inflight.delete(frame.id);
				if (item?.shows) this.markShown(item.shows.key, item.shows);
			}
			else if (frame.type === "settled") this.returnInflight(link, frame.unconsumed);
			else if (frame.type === "turn") { const name = this.agentName(binding.handle); if (name) this.promoteShown(name); }
			else if (frame.type === "request" && typeof frame.id === "string") {
				const controller = new AbortController(); requests.set(frame.id, controller);
				const bound = binding;
				void (async () => {
					const caller = await this.agentCaller(bound.handle, bound.episode, bound.capability);
					if (caller) caller.returned = [];
					const outcome = caller ? await this.execute(frame.op, frame.args ?? {}, caller, controller.signal, `peer-${randomUUID()}`) : { isError: true, text: "agent_link_invalid" };
					requests.delete(frame.id);
					// Only a response written to this episode's live connection can reach the agent's next model request.
					const live = !socket.destroyed && !!token && this.tokens.get(token)?.socket === socket && this.links.get(bound.handle)?.socket === socket;
					if (!live) return;
					this.send(socket, outcome.isError ? { type: "response", id: frame.id, ok: false, error: { code: outcome.text.split(":")[0] ?? "failed", detail: outcome.text } } : { type: "response", id: frame.id, ok: true, result: { text: outcome.text } });
					for (const view of caller?.returned ?? []) this.markShown(caller!.key, view, this.returnedShown);
				})();
			}
		}, () => socket.destroy());
		socket.on("data", (chunk: string) => reader.push(chunk));
		socket.on("error", () => {});
		socket.on("close", () => {
			this.sockets.delete(socket);
			for (const controller of requests.values()) controller.abort();
			if (!binding) return;
			const link = this.links.get(binding.handle);
			if (link?.socket === socket) { link.socket = undefined; this.returnInflight(link, [...link.inflight.keys()]); }
			// Results returned to this agent but never carried into a model request of it do not count as shown.
			const name = this.agentName(binding.handle); if (name) this.returnedShown.delete(name);
		});
	}
	private returnInflight(link: LinkState, ids: readonly string[]): void {
		link.accepting = false;
		const back = ids.flatMap(id => link.inflight.get(id) ? [link.inflight.get(id)!] : []);
		for (const id of ids) link.inflight.delete(id);
		link.outbox.unshift(...back);
		link.sent.clear();
	}
	private async agentCaller(handle: string, episode: number, capability: ChildCapabilityManifest): Promise<Caller | undefined> {
		const ctx = this.deps.context(); if (!ctx) return undefined;
		try {
			const record = await this.deps.service.store.load(handle, await this.deps.service.ownerOf(ctx));
			if (record.episode !== episode || record.state === "closed") return undefined;
			return { participant: { kind: "agent", name: record.task.id, role: record.task.role }, key: record.task.id, record, capability };
		} catch { return undefined; }
	}
	async shutdown(): Promise<void> {
		this.closed = true;
		for (const socket of this.sockets) socket.destroy();
		this.sockets.clear();
		await new Promise<void>(resolve => this.server ? this.server.close(() => resolve()) : resolve());
		if (this.directory) await rm(this.directory, { recursive: true, force: true }).catch(() => {});
		if (this.exitCleanup) { process.off("exit", this.exitCleanup); this.exitCleanup = undefined; }
		this.server = undefined; this.serverReady = undefined; this.directory = undefined;
		this.tokens.clear(); this.links.clear(); this.notify();
	}
	reset(): void { this.returnedShown.clear(); this.wakeIds.clear(); this.writeGrants.clear(); this.expected.clear(); this.links.clear(); this.shown.clear(); this.names.clear(); this.namesOwner = undefined; this.tokens.clear(); }
	/** The main agent received a notice for these turns. */
	noticesShown(ids: readonly string[]): void {
		for (const id of ids) {
			const [runId, handle] = id.split(":"); if (!runId || !handle) continue;
			// Mark the episode this notice carried, never a later one that finished since.
			const episode = this.deps.service.episodeOf(runId, handle);
			if (episode !== undefined) this.markShown("main", { handle, episode });
		}
	}

	private mayMessage(sender: ManagedRecord, target: ManagedRecord): boolean {
		const may = sender.task.may ?? DEFAULT_CAPABILITIES;
		if (target.assigner === sender.task.id) return true;
		if (may.message.includes(target.task.id)) return true;
		if (may.message.includes("assigner") && sender.assigner === target.task.id) return true;
		return may.message.includes("peers") && target.assigner !== undefined && target.assigner === sender.assigner;
	}
	private controls(caller: Caller, record: ManagedRecord): boolean { return caller.key === "main" || record.assigner === caller.key; }
	private requireControl(caller: Caller, record: ManagedRecord): void {
		if (!this.controls(caller, record)) throw new PeerError("not_permitted", `Only ${record.task.id}'s assigner or the main agent can do that; seeing or messaging an agent confers no control over it.`);
	}
	private visible(caller: Caller, record: ManagedRecord): boolean {
		return this.controls(caller, record) || record.handle === caller.record?.handle || (caller.record?.task.may ?? DEFAULT_CAPABILITIES).roster;
	}
	private requireVisible(caller: Caller, record: ManagedRecord): void {
		if (!this.visible(caller, record)) throw new PeerError("not_visible", `${record.task.id} is not on this agent's roster.`);
	}
	/**
	 * A nested invocation stays inside the caller's prepared grants for this episode, with their
	 * identity pins and anchors. An isolated caller's writes stay in its private copy, so what it
	 * invokes may only read.
	 */
	private async constrainAccess(caller: Caller, access: AgentTask["access"]): Promise<void> {
		const capability = caller.capability;
		if (!caller.record || !capability) throw new PeerError("access_exceeds_grant", "This agent's grants are unavailable; it cannot invoke agents.");
		const isolated = isolatedWriteRoots(caller.record).length > 0;
		for (const requested of normalizeAccess(access)) {
			if (isolated && requested.permission === "write") throw new PeerError("access_exceeds_grant", "An agent working in an isolated copy may invoke agents with read access only.");
			const decision = await authorizePath(capability, requested.permission === "write" ? "write" : "read", requested.path);
			if (!decision.allowed) throw new PeerError("access_exceeds_grant", `An agent grants at most the access it holds${decision.reason ? ` (${decision.reason})` : ""}.`);
		}
	}

	/**
	 * Admission pins each read range afresh. Before the descendant is queued, its resolved pins must
	 * name the same objects as the caller's pinned grants, and its ranges must still authorize.
	 */
	private async confirmDescendantPins(caller: Caller, records: readonly ManagedRecord[]): Promise<void> {
		const grants = caller.capability?.grants ?? [];
		for (const record of records) {
			const mismatch = record.roots.flatMap(root => root.pins ?? []).some(pin => grants.some(grant => grant.pin && grant.path === pin.path && (grant.pin.dev !== pin.dev || grant.pin.ino !== pin.ino)));
			if (mismatch) throw new ManagedError("access_exceeds_grant", undefined, "A granted path changed identity while the agent was being admitted.");
			for (const requested of normalizeAccess(record.task.access)) {
				if (!(await authorizePath(caller.capability!, requested.permission === "write" ? "write" : "read", requested.path)).allowed) throw new ManagedError("access_exceeds_grant", undefined, "An agent grants at most the access it holds.");
			}
		}
	}

	private async loadNames(owner: CurrentOwner): Promise<void> {
		const key = `${owner.repo}\0${owner.parentSessionId}`;
		if (this.namesOwner === key) return;
		this.names.clear(); this.links.clear(); this.shown.clear(); this.returnedShown.clear();
		for (const entry of await this.deps.service.store.namedRecords(owner)) this.names.set(entry.name, entry.handle);
		this.namesOwner = key;
	}
	private async recordByName(name: string, owner: CurrentOwner): Promise<ManagedRecord> {
		const handle = this.names.get(name);
		if (!handle) throw new PeerError("unknown_agent", `No agent named ${name} in this session.`);
		try { return await this.deps.service.store.load(handle, owner); }
		catch (error) { if (error instanceof ManagedError && error.code === "managed_owner_mismatch") throw new PeerError("agent_on_other_branch", `${name} belongs to another branch of this session.`); throw error; }
	}
	/** Mark a result already in the caller's model context (a consumed receipt or a delivered notice). */
	private markShown(key: string, view: Pick<SessionView, "handle" | "episode">, into = this.shown): void {
		let map = into.get(key); if (!map) { map = new Map(); into.set(key, map); }
		map.set(view.handle, Math.max(view.episode, map.get(view.handle) ?? 0));
	}
	/** Mark a result returned in this tool response; another call in the same response cannot rely on it yet. */
	private markReturned(caller: Caller, view: Pick<SessionView, "handle" | "episode">): void {
		if (caller.returned) caller.returned.push({ handle: view.handle, episode: view.episode });
		else this.markShown(caller.key, view, this.returnedShown);
	}
	/** The caller's next model request carries everything returned to it so far. */
	promoteShown(key: string): void {
		const returned = this.returnedShown.get(key); if (!returned) return;
		this.returnedShown.delete(key);
		for (const [handle, episode] of returned) this.markShown(key, { handle, episode });
	}
	private agentName(handle: string): string | undefined {
		for (const [name, value] of this.names) if (value === handle) return name;
		return undefined;
	}
	private rosterLine(record: ManagedRecord, view: SessionView): string {
		const workspace = workspaceOf(record.task);
		const result = view.result;
		const latest = result ? `latest turn ${result.status}${result.output ? `: ${oneLine(result.output)}` : ""}` : "no result yet";
		return `- ${record.task.id} (${record.task.role}) ${view.state}${workspace === "none" ? "" : `, ${workspace} workspace`}, assigned by ${record.assigner ?? "main"}; ${latest}${view.candidate && view.candidate.status === "not-applied" ? "; isolated candidate ready" : ""}`;
	}
	private reportText(name: string, view: SessionView, full: boolean): string {
		const result = view.result as TaskResult | undefined;
		if (!result) return `${name}: no result yet.`;
		const changes = view.candidate ? `; isolated candidate ${view.candidate.status} (${view.candidate.changedPaths.length} changed paths)` : result.changedPaths.length ? `; wrote ${result.changedPaths.length} file(s) in the shared checkout` : "";
		const route = result.route ? `; ran on ${result.route.provider}/${result.route.model}:${result.route.thinking}` : "";
		const error = result.error ? `; ${result.error.code}` : "";
		const report = result.output ? (full ? truncate(result.output, RECEIPT_REPORT_BYTES) : oneLine(result.output)) : "(no report)";
		return `${name}: turn ${result.status}${error}${changes}${route}.\n${report}`;
	}
	private receiptText(name: string, view: SessionView): string { return this.reportText(name, view, true); }
	private relativeToRoots(record: ManagedRecord, path: string): string {
		for (const root of record.roots) if (pathContains(root.source, path)) return path.slice(root.source.length + 1) || ".";
		return path;
	}
	/**
	 * Tool-result details stay out of the model's context. An operation that made an engine request
	 * carries that request's action, status, telemetry and views for evaluators and UI; other
	 * operations carry only identities and states.
	 */
	private details(op: PeerOperation, sessions: SessionView[], request?: SessionActionResult): Record<string, unknown> {
		const base = { schemaVersion: MANAGED_SESSION_VERSION, op, sessions: sessions.map(view => ({ handle: view.handle, ...(view.label ? { label: view.label } : {}), role: view.role, episode: view.episode, state: view.state })) };
		if (!request) return base;
		return { ...base, action: request.action, status: request.status, ...(request.kind ? { kind: request.kind } : {}), ...(request.runId ? { runId: request.runId } : {}),
			...(request.error ? { error: { code: request.error.code } } : {}), ...(request.requestTelemetry ? { requestTelemetry: request.requestTelemetry } : {}), sessions: request.sessions };
	}
	private record(customType: string, data: Record<string, unknown>): void {
		try { this.deps.appendEntry(customType, { version: 1, atMs: Date.now(), ...data }); } catch { /* Telemetry never fails coordination. */ }
	}
	private notify(): void { for (const listener of [...this.listeners]) listener(); }
	/**
	 * Admissions run one at a time because the engine admits one request at a time. The lock is
	 * released as soon as admission returns (`release`), so a foreground host observing a turn
	 * never blocks a nested admission behind its own wait.
	 */
	private admit<T>(action: (release: () => void) => Promise<T>): Promise<T> {
		let release!: () => void;
		const gate = new Promise<void>(resolve => { release = resolve; });
		const prior = this.admissions;
		this.admissions = prior.then(() => gate);
		return prior.then(() => action(release)).finally(release);
	}
}

export async function socketReachable(path: string): Promise<boolean> {
	try { return (await lstat(path)).isSocket(); } catch { return false; }
}
