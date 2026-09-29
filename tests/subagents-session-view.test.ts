import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ContinuationService, registerContinuationTool } from "../extensions/subagents/continuation.ts";
import { ManagedSessionStore } from "../extensions/subagents/managed-sessions.ts";
import { defaultConfig } from "../extensions/subagents/config.ts";
import { validateGraphStructure } from "../extensions/subagents/graph.ts";
import { emptyUsage, type TaskResult } from "../extensions/subagents/contracts.ts";
import type { NativeObservation, NativeUsageRow } from "../extensions/subagents/observability.ts";
import {
	SESSION_VIEW_EVENT,
	SESSION_VIEW_CHANGED_EVENT,
	SESSION_VIEW_LIMITS,
	SESSION_VIEW_REQUEST_EVENT,
	SessionViewBuilder,
	parseSessionViewReply,
	parseSessionViewRequest,
	type SessionViewReply,
	type SessionViewScope,
} from "../extensions/subagents/session-view.ts";

const exec = promisify(execFile);
const usageRow = (ownerSessionId: string, entryId: string, input: number, cost: number): NativeUsageRow =>
	({ ownerSessionId, entryId, kind: "assistant", modelKey: null, usage: { input, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: input + 1, cost } });
const observation = (ownerSessionId: string, entries: NativeUsageRow[]): NativeObservation =>
	({ available: true, ownerSessionId, entries, commands: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 }, contextWindow: null, toolNames: null, capabilityKey: null });
async function until(predicate: () => boolean, attempts = 300): Promise<void> {
	for (let attempt = 0; attempt < attempts; attempt++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.ok(false, "bounded condition not reached");
}

function countingStore(store: ManagedSessionStore) {
	const counts = { inventory: 0, recordedObservations: 0 };
	const counted = new Proxy(store, {
		get(target, property) {
			if (property === "inventory" || property === "recordedObservations") {
				counts[property]++;
				const method = (target as unknown as Record<string, (() => unknown) | undefined>)[property];
				return method!.bind(target);
			}
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
		},
	});
	return { store: counted as ManagedSessionStore, counts };
}

function contextFixture(cwd: string, mode: "tui" | "print" = "tui"): ExtensionContext {
	const model = { provider: "synthetic", id: "parent", reasoning: false };
	return { cwd, mode, model, thinkingLevel: "off", scopedModels: [], modelRegistry: { getAll: () => [model], getAvailable: () => [model] }, isProjectTrusted: () => true,
		sessionManager: { getSessionId: () => "parent-session", getLeafId: () => "anchor", getBranch: () => [{ id: "anchor" }] } } as unknown as ExtensionContext;
}

const ownerOf = (repo: string, parentSessionId = "parent-session") => ({ repo, parentSessionId, anchor: "anchor", branch: ["anchor"] });
const scope = (owner: SessionViewScope["owner"], live: SessionViewScope["live"] = [], extra: Partial<SessionViewScope> = {}): SessionViewScope =>
	({ ownerSessionId: "parent-session", anchor: "anchor", trusted: true, owner, live, generation: "generation-1", ...extra });

async function rootFixture(t: test.TestContext) {
	const base = await mkdtemp(join(tmpdir(), "session-view-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const repo = join(base, "repo");
	await mkdir(repo);
	await exec("git", ["init", "-q", repo]);
	return { base, repo };
}

async function allocateFixture(store: ManagedSessionStore, repo: string, requestId: string, tasks = 1) {
	const graph = validateGraphStructure({ tasks: Array.from({ length: tasks }, (_, index) => ({ id: `task-${index}`, role: "explorer", objective: "scan", scope: ["."] })) });
	if (!graph.ok) throw new Error("fixture");
	return store.allocate({ repo, parentSessionId: "parent-session", anchor: "anchor", branch: ["anchor"] }, requestId, graph.tasks);
}

test("session-view requests and replies validate strictly and reject foreign shapes", async (t) => {
	const { base, repo } = await rootFixture(t);
	const store = new ManagedSessionStore(base);
	const record = (await allocateFixture(store, repo, "a")).records[0]!;
	await store.withSession(record.handle, { repo, parentSessionId: "parent-session", anchor: "anchor", branch: ["anchor"] }, async current => { current.episode = 1; current.requests.push({ id: "r1", fingerprint: "a".repeat(64), episode: 1, state: "complete" }); await store.save(current); });
	const builder = new SessionViewBuilder({ store });
	assert.deepEqual(parseSessionViewRequest({ version: 1, requestId: "ui-1", page: 0 }), { version: 1, requestId: "ui-1", page: 0 });
	for (const bad of [undefined, null, "x", [], { version: 2, requestId: "ui-1", page: 0 }, { version: 1, requestId: "ui-1" }, { version: 1, requestId: "ui-1", page: 0, extra: true },
		{ version: 1, requestId: "bad id", page: 0 }, { version: 1, requestId: "ui-1", page: -1 }, { version: 1, requestId: "ui-1", page: 1.5 },
		{ version: 1, requestId: "ui-1", page: SESSION_VIEW_LIMITS.maxRequestPage + 1 }]) {
		assert.equal(parseSessionViewRequest(bad), undefined, JSON.stringify(bad));
	}
	const reply = await builder.build({ version: 1, requestId: "ui-1", page: 0 }, scope(ownerOf(repo)));
	assert.equal(parseSessionViewReply(reply).ok, true);
	assert.equal(reply.history.rows.length, 1);
	for (const [mutate, label] of [
		[(value: SessionViewReply) => { (value as unknown as Record<string, unknown>).extra = 1; }, "extra key"],
		[(value: SessionViewReply) => { value.summary = { agents: 1, acceptedEpisodes: null, states: { idle: 0, queued: 0, running: 0, interrupted: 0, closed: 0 }, liveAgents: 2 }; }, "live count mismatch"],
		[(value: SessionViewReply) => { value.history.totalPages = 5; }, "navigation mismatch"],
		[(value: SessionViewReply) => { value.history.state = "unavailable"; }, "unavailable with rows"],
		[(value: SessionViewReply) => { value.usage = null; }, "ready history without usage"],
		[(value: SessionViewReply) => { value.inventory = { state: "ready", complete: true, unreadableRecords: 0 }; value.summary = null; }, "complete inventory without summary"],
		[(value: SessionViewReply) => { value.history.rows.push(value.history.rows[0]!); }, "row duplication"],
	] as Array<[(value: SessionViewReply) => void, string]>) {
		const copy = structuredClone(reply);
		mutate(copy);
		assert.equal(parseSessionViewReply(copy).ok, false, label);
	}
	const truncated = structuredClone(reply);
	(truncated as unknown as { usage: unknown }).usage = { status: "unavailable" };
	assert.equal(parseSessionViewReply(truncated).ok, false, "truncated projection objects fail closed");
	const fabricated = structuredClone(reply);
	const usage = (fabricated as unknown as { usage: { status: string; assistantTurns: number | null; usage: { input: number } } }).usage!;
	usage.status = "unavailable"; usage.assistantTurns = null; usage.usage.input = 5;
	assert.equal(parseSessionViewReply(fabricated).ok, false, "unavailable projection never carries a known total");
});

test("live pages reject settled or duplicate identities and retain safe route detail", async (t) => {
	const { base, repo } = await rootFixture(t);
	const store = new ManagedSessionStore(base);
	const record = (await allocateFixture(store, repo, "routes")).records[0]!;
	await store.withSession(record.handle, ownerOf(repo), async current => {
		current.route = { provider: "fixture", model: "safe-model", thinking: "high" } as NonNullable<typeof current.route>;
		await store.save(current);
	});
	const reply = await new SessionViewBuilder({ store }).build({ version: 1, requestId: "ui-identity", page: 0 }, scope(ownerOf(repo)));
	assert.equal(reply.history.rows[0]!.route?.model, "safe-model");
	assert.equal(parseSessionViewReply(reply).ok, true);
	const live = { id: "session_live", ordinal: 1, role: "explorer" as const, episode: 1, status: "running" as const, executionPhase: "child-execution" as const, route: null, assistantTurns: 0, elapsedMs: null, replayed: false, headline: "", activeTools: [] };
	const withLive = { ...reply, live: [live], summary: { ...reply.summary!, liveAgents: 1 } };
	assert.equal(parseSessionViewReply(withLive).ok, true);
	assert.equal(parseSessionViewReply({ ...withLive, live: [{ ...live, status: "succeeded" }] }).ok, false);
	assert.equal(parseSessionViewReply({ ...withLive, live: [{ ...live, id: record.handle }] }).ok, false);
	const unsafe = structuredClone(reply);
	unsafe.history.rows[0]!.route!.model = "unsafe\u001b[2J";
	assert.equal(parseSessionViewReply(unsafe).ok, false);
});

test("builder pages every retained handle beyond admission limits with page-independent live rows and totals", async (t) => {
	const { base, repo } = await rootFixture(t);
	const store = new ManagedSessionStore(base);
	const handles: string[] = [];
	for (let round = 0; round < 5; round++) {
		const records = (await allocateFixture(store, repo, `batch-${round}`, 3)).records;
		handles.push(...records.map((record) => record.handle));
		for (const record of records) await store.withSession(record.handle, { repo, parentSessionId: "parent-session", anchor: "anchor", branch: ["anchor"] }, async current => { current.state = "closed"; current.retained = true; await store.save(current); });
	}
	assert.equal(handles.length, 15);
	const liveRow = { id: handles[0]!, ordinal: 1, role: "explorer" as const, episode: 1, status: "running" as const, executionPhase: "child-execution" as const, route: null, assistantTurns: 1, elapsedMs: 5, replayed: false, headline: "live", activeTools: [] };
	const builder = new SessionViewBuilder({ store, limits: { pageSize: 4 } });
	const replies: SessionViewReply[] = [];
	for (let page = 0; page < 4; page++) replies.push(await builder.build({ version: 1, requestId: `ui-${page}`, page }, scope(ownerOf(repo), [liveRow])));
	const paged = replies.flatMap((reply) => reply.history.rows.map((row) => row.handle));
	assert.equal(new Set(paged).size, paged.length, "no handle appears twice across pages");
	assert.deepEqual(new Set(paged), new Set(handles.filter((handle) => handle !== liveRow.id)), "paging reaches every non-live handle exactly once");
	const clamped = await builder.build({ version: 1, requestId: "ui-clamp", page: 99 }, scope(ownerOf(repo), [liveRow]));
	assert.deepEqual(clamped.history.rows.map((row) => row.handle), replies[3]!.history.rows.map((row) => row.handle), "out-of-range pages clamp to the last page");
	const [first, ...rest] = replies;
	assert.ok(first);
	for (const reply of rest) {
		assert.deepEqual(reply.summary, first.summary, "summary is page-independent");
		assert.deepEqual(reply.usage, first.usage, "totals are page-independent");
		assert.deepEqual(reply.live, first.live, "live rows are page-independent");
		assert.equal(reply.revision, first.revision, "paging does not invalidate");
	}
	assert.equal(first.summary!.agents, 15);
	assert.equal(first.summary!.liveAgents, 1);
	assert.deepEqual(first.summary!.states, { idle: 0, queued: 0, running: 0, interrupted: 0, closed: 15 }, "summary counts the complete inventory, not the page");
	assert.ok(first.history.rows.every((row) => row.state === "closed" && row.retained && row.latestOutcome === "unknown"));
	assert.equal(first.history.totalRows, 14);
	assert.equal(first.history.totalPages, 4);
});

test("builder gates untrusted or unresolved owners and keeps fresh live rows usable", async (t) => {
	const { base, repo } = await rootFixture(t);
	const store = new ManagedSessionStore(base);
	const builder = new SessionViewBuilder({ store });
	const liveRow = { id: "session_live0000000000000000000000001", ordinal: 1, role: "explorer" as const, episode: 1, status: "running" as const, executionPhase: "child-execution" as const, route: null, assistantTurns: 0, elapsedMs: null, replayed: false, headline: "", activeTools: [] };
	const untrusted = await builder.build({ version: 1, requestId: "ui-1", page: 0 }, { ...scope(ownerOf(repo), [liveRow]), trusted: false });
	assert.deepEqual(untrusted.history, { state: "unavailable", reason: "project_trust_required", pageSize: SESSION_VIEW_LIMITS.pageSize, page: 0, totalRows: 0, totalPages: 0, rows: [] });
	assert.equal(untrusted.summary, null);
	assert.equal(untrusted.inventory.state, "unavailable");
	assert.equal(untrusted.live.length, 0, "untrusted queries do not expose retained live observations");
	assert.equal(parseSessionViewReply(untrusted).ok, true);
	const unresolved = await builder.build({ version: 1, requestId: "ui-2", page: 0 }, scope(null, [liveRow], { reason: "repository_root_unavailable" }));
	assert.equal(unresolved.history.reason, "repository_root_unavailable");
	assert.equal(unresolved.live.length, 1);
	const linked = new ManagedSessionStore(join(base, "linked"));
	await mkdir(join(base, "linked"), { mode: 0o700 });
	await mkdir(join(base, "real"), { mode: 0o700 });
	await symlink(join(base, "real"), linked.root);
	const unavailable = await new SessionViewBuilder({ store: linked }).build({ version: 1, requestId: "ui-3", page: 0 }, scope(ownerOf(repo), [liveRow]));
	assert.equal(unavailable.history.state, "unavailable");
	assert.equal(unavailable.history.reason, "managed_storage_invalid");
	assert.equal(unavailable.live.length, 1);
	assert.equal(unavailable.usage, null);
	assert.equal(parseSessionViewReply(unavailable).ok, true);
});

test("retained projection is cached; paging and re-render never rescan history or observations", async (t) => {
	const { base, repo } = await rootFixture(t);
	const real = new ManagedSessionStore(base);
	await allocateFixture(real, repo, "a");
	const { store, counts } = countingStore(real);
	const builder = new SessionViewBuilder({ store });
	const view = scope(ownerOf(repo));
	await builder.build({ version: 1, requestId: "ui-0", page: 0 }, view);
	assert.equal(counts.inventory, 1);
	assert.equal(counts.recordedObservations, 1);
	await builder.build({ version: 1, requestId: "ui-1", page: 1 }, view);
	await builder.build({ version: 1, requestId: "ui-2", page: 0 }, view); // ordinary re-render/heartbeat
	assert.equal(counts.inventory, 1, "cached pages do not rescan registries");
	assert.equal(counts.recordedObservations, 1, "cached pages do not rescan observations");
	builder.invalidate(); // lifecycle transition only
	await builder.build({ version: 1, requestId: "ui-3", page: 0 }, view);
	assert.equal(counts.inventory, 2);
	builder.reset(); // session/tree change drops the retained projection
	await builder.build({ version: 1, requestId: "ui-4", page: 0 }, view);
	assert.equal(counts.inventory, 3);
});

test("recorded usage surfaces per-row and session totals with honest coverage", async (t) => {
	const { base, repo } = await rootFixture(t);
	const store = new ManagedSessionStore(base);
	const owner = { repo, parentSessionId: "parent-session", anchor: "anchor", branch: ["anchor"] };
	const first = (await allocateFixture(store, repo, "a")).records[0]!;
	const second = (await allocateFixture(store, repo, "b")).records[0]!;
	for (const handle of [first.handle, second.handle]) {
		await store.withSession(handle, owner, async record => {
			record.episode = 2;
			record.requests.push({ id: "r1", fingerprint: "a".repeat(64), episode: 1, state: "complete" }, { id: "r2", fingerprint: "b".repeat(64), episode: 2, state: "complete" });
			await store.save(record);
		});
	}
	await store.saveObservation(first.handle, 1, observation("child-1", [usageRow("child-1", "a1", 4, 0.5)]));
	await store.saveObservation(first.handle, 2, observation("child-1", [usageRow("child-1", "a2", 6, 0.25)]));
	await store.saveObservation(second.handle, 1, observation("child-2", [usageRow("child-2", "a1", 3, 0.125)]));
	const reply = await new SessionViewBuilder({ store }).build({ version: 1, requestId: "ui-1", page: 0 }, scope(ownerOf(repo)));
	assert.equal(reply.usage!.status, "incomplete");
	assert.deepEqual(reply.usage!.usage, { input: 13, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 16, cost: 0.875 });
	assert.equal(reply.usage!.assistantTurns, 3);
	assert.deepEqual(reply.usage!.episodes, { recorded: 3, missing: 1, orphaned: 0, unprovable: false });
	const rows = new Map(reply.history.rows.map((row) => [row.handle, row]));
	const firstRow = rows.get(first.handle)!;
	assert.equal(firstRow.acceptedEpisodes, 2);
	assert.equal(firstRow.recordedUsage.status, "complete");
	assert.equal(firstRow.recordedUsage.assistantTurns, 2);
	const secondRow = rows.get(second.handle)!;
	assert.equal(secondRow.recordedUsage.status, "incomplete");
	assert.deepEqual(secondRow.recordedUsage.episodes, { recorded: 1, missing: 1, orphaned: 0, unprovable: false });
	assert.equal(secondRow.recordedUsage.metrics.input, "incomplete");
	assert.equal(secondRow.recordedUsage.usage.input, 3, "known subtotal stays labeled, never zero");
});

test("payload bounds degrade visibly instead of faking an empty success", async (t) => {
	const { base, repo } = await rootFixture(t);
	const store = new ManagedSessionStore(base);
	const owner = { repo, parentSessionId: "parent-session", anchor: "anchor", branch: ["anchor"] };
	const record = (await allocateFixture(store, repo, "a")).records[0]!;
	await store.withSession(record.handle, owner, async current => { current.episode = 1; current.requests.push({ id: "r1", fingerprint: "a".repeat(64), episode: 1, state: "complete" }); await store.save(current); });
	await store.saveObservation(record.handle, 1, observation("child-1", [usageRow("child-1", "a1", 4, 0.5)]));
	const degraded = await new SessionViewBuilder({ store, limits: { maxPayloadBytes: 1400 } }).build({ version: 1, requestId: "ui-1", page: 0 }, scope(ownerOf(repo)));
	assert.equal(degraded.history.reason, "payload_limit");
	assert.equal(degraded.history.state, "unavailable", "an undeliverable page is not an empty ready page");
	assert.deepEqual(degraded.history.rows, []);
	assert.equal(degraded.summary!.agents, 1);
	assert.equal(parseSessionViewReply(degraded).ok, true);
	const minimal = await new SessionViewBuilder({ store, limits: { maxPayloadBytes: 64 } }).build({ version: 1, requestId: "ui-2", page: 0 }, scope(ownerOf(repo)));
	assert.equal(minimal.history.state, "unavailable");
	assert.equal(minimal.history.reason, "payload_limit");
	assert.equal(minimal.live.length, 0);
	assert.equal(parseSessionViewReply(minimal).ok, true);
});

async function serviceFixture(t: test.TestContext) {
	const { base, repo } = await rootFixture(t);
	const real = new ManagedSessionStore(base);
	const { store, counts } = countingStore(real);
	let children = 0;
	let release: (() => void) | undefined;
	let gate: Promise<void> | undefined;
	const service = new ContinuationService({ store, loadConfig: async () => ({ config: defaultConfig() }), onObserver: () => {}, runChild: async options => {
		options.onChildStarted?.();
		if (gate) await gate;
		options.onChildSettled?.();
		children++;
		return { id: options.task.id, role: options.task.role, status: "succeeded", output: "done", stderr: "", usage: { ...emptyUsage(), turns: 1 }, durationMs: 1, changedPaths: [], convergence: "not-applicable", reportComplete: true, observation: observation(`child-${children}`, [usageRow(`child-${children}`, "a1", 5, 0.5)]) };
	} });
	t.after(async () => { release?.(); await service.shutdown(); await rm(base, { recursive: true, force: true }); });
	return { base, repo, store: real, counts, service, holdChild: () => { gate = new Promise<void>(resolve => { release = resolve; }); }, releaseChild: () => { release?.(); } };
}

test("core lifecycle integrates inventory, invalidation, live/history transition and stale persisted running", async (t) => {
	const f = await serviceFixture(t);
	const ctx = contextFixture(f.repo);
	const query = (page = 0) => f.service.sessionView({ version: 1, requestId: `ui-${page}-${f.counts.inventory}`, page }, ctx);
	const created = await f.service.execute({ action: "create", requestId: "run-1", mode: "foreground", tasks: [{ id: "task", role: "explorer", objective: "scan", scope: ["."] }] }, ctx);
	assert.equal(created.status, "succeeded");
	const handle = created.sessions[0]!.handle;
	let reply = await query();
	assert.equal(reply.summary!.agents, 1);
	assert.equal(reply.summary!.acceptedEpisodes, 1);
	assert.equal(reply.summary!.states.idle, 1);
	assert.equal(reply.usage!.status, "complete");
	assert.equal(reply.usage!.assistantTurns, 1);
	assert.equal(reply.usage!.usage.input, 5);
	const row = reply.history.rows.find(entry => entry.handle === handle)!;
	assert.equal(row.episode, 1);
	assert.equal(row.latestOutcome, "succeeded");
	assert.equal(row.acceptedEpisodes, 1);
	assert.equal(row.recordedUsage.assistantTurns, 1);
	// A stale persisted running state without a fresh core-owned observation is history, never live.
	const stale = (await f.service.execute({ action: "create", requestId: "run-2", mode: "foreground", tasks: [{ id: "task", role: "explorer", objective: "scan", scope: ["."] }] }, ctx)).sessions[0]!.handle;
	await f.store.withSession(stale, { repo: f.repo, parentSessionId: "parent-session", anchor: "anchor", branch: ["anchor"] }, async record => { record.state = "running"; await f.store.save(record); });
	const reloaded = await new SessionViewBuilder({ store: f.store }).build({ version: 1, requestId: "ui-reload", page: 0 }, scope(ownerOf(f.repo)));
	assert.equal(reloaded.live.length, 0);
	assert.equal(reloaded.history.rows.find(entry => entry.handle === stale)!.state, "running");
	assert.equal(reloaded.summary!.states.running, 1);
	// Live work moves its handle out of history and settles back without double counting.
	f.holdChild();
	const asyncRun = await f.service.execute({ action: "create", requestId: "run-3", tasks: [{ id: "task", role: "explorer", objective: "scan", scope: ["."] }] }, ctx);
	assert.equal(asyncRun.status, "accepted");
	const liveHandle = asyncRun.sessions[0]!.handle;
	await until(() => f.service.liveObserverTasks().length === 1);
	reply = await query();
	assert.equal(reply.live.length, 1);
	assert.equal(reply.live[0]!.id, liveHandle);
	assert.equal(reply.summary!.liveAgents, 1);
	assert.ok(!reply.history.rows.some(entry => entry.handle === liveHandle), "a live handle never also occupies history");
	assert.equal(reply.summary!.agents, 3);
	f.releaseChild();
	await until(() => f.service.liveObserverTasks().length === 0);
	reply = await query();
	assert.ok(reply.history.rows.some(entry => entry.handle === liveHandle && entry.state === "idle"));
	assert.equal(reply.summary!.liveAgents, 0);
	// Continuation keeps one stable identity and accumulates recorded episodes exactly once.
	const continued = await f.service.execute({ action: "continue", mode: "foreground", episodes: [{ handle, requestId: "next", expectedEpisode: 1, message: "continue" }] }, ctx);
	assert.equal(continued.status, "succeeded");
	assert.equal(continued.sessions[0]!.handle, handle);
	reply = await query();
	const continuedRow = reply.history.rows.find(entry => entry.handle === handle)!;
	assert.equal(continuedRow.episode, 2);
	assert.equal(continuedRow.acceptedEpisodes, 2);
	assert.equal(reply.summary!.agents, 3);
	assert.equal(reply.usage!.assistantTurns, 4);
	assert.equal(reply.usage!.usage.input, 20);
	// Replay reuses committed evidence without rewriting or rescanning it.
	const scans = f.counts.inventory;
	const replay = await f.service.execute({ action: "create", requestId: "run-1", mode: "foreground", tasks: [{ id: "task", role: "explorer", objective: "scan", scope: ["."] }] }, ctx);
	assert.equal(replay.status, "succeeded");
	reply = await query();
	assert.equal(f.counts.inventory, scans, "replay is not an invalidation");
	assert.equal(reply.summary!.agents, 3);
	// Close and refresh invalidate the retained projection through the actual mutation paths.
	await f.service.execute({ action: "close", handle: liveHandle, expectedEpisode: 1, disposition: "retain" }, ctx);
	reply = await query();
	assert.equal(reply.summary!.states.closed, 1);
	const beforeRefresh = f.counts.inventory;
	const refreshed = await f.service.execute({ action: "refresh", handle, expectedEpisode: 2 }, ctx);
	assert.ok(["succeeded", "failed"].includes(refreshed.status));
	reply = await query();
	assert.ok(f.counts.inventory > beforeRefresh, "refresh invalidates the retained projection through its mutation path");
});

test("session-view event wiring answers only strict validated requests from active host modes", async (t) => {
	const { base, repo } = await rootFixture(t);
	const store = new ManagedSessionStore(base);
	const handlers = new Map<string, Array<(event: unknown, ctx?: unknown) => unknown>>();
	const eventHandlers = new Map<string, Array<(data: unknown) => void>>();
	const replies: unknown[] = [];
	let changes = 0;
	const pi = {
		registerCommand() {}, registerTool() {}, appendEntry() {}, sendMessage() {}, sendUserMessage() {},
		getActiveTools: () => ["csheng_subagent_sessions"],
		on(name: string, handler: (event: unknown, ctx?: unknown) => unknown) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		events: {
			on(name: string, handler: (data: unknown) => void) { eventHandlers.set(name, [...(eventHandlers.get(name) ?? []), handler]); },
			emit(name: string, data: unknown) { if (name === SESSION_VIEW_EVENT) replies.push(data); if (name === SESSION_VIEW_CHANGED_EVENT) changes++; },
		},
	} as unknown as ExtensionAPI;
	const service = registerContinuationTool(pi, { store, loadConfig: async () => ({ config: defaultConfig() }), runChild: async options => ({ id: options.task.id, role: options.task.role, status: "succeeded", output: "done", stderr: "", usage: emptyUsage(), durationMs: 1, changedPaths: [], convergence: "not-applicable", reportComplete: true }) });
	t.after(async () => { await service.shutdown(); await rm(base, { recursive: true, force: true }); });
	const request = (data: unknown) => { for (const handler of eventHandlers.get(SESSION_VIEW_REQUEST_EVENT) ?? []) handler(data); };
	request({ version: 1, requestId: "early", page: 0 });
	await new Promise(resolve => setTimeout(resolve, 20));
	assert.equal(replies.length, 0, "requests without a session context stay unanswered");
	for (const handler of handlers.get("session_start") ?? []) await handler({}, contextFixture(repo));
	request({ version: 2, requestId: "bad", page: 0 });
	request({ version: 1, requestId: "bad id", page: 0 });
	request("garbage");
	await new Promise(resolve => setTimeout(resolve, 20));
	assert.equal(replies.length, 0, "malformed requests stay unanswered");
	request({ version: 1, requestId: "ui-1", page: 9 });
	await until(() => replies.length === 1);
	const parsed = parseSessionViewReply(replies[0]);
	assert.equal(parsed.ok, true);
	if (!parsed.ok) throw new Error("fixture");
	assert.equal(parsed.value.requestId, "ui-1");
	assert.equal(parsed.value.ownerSessionId, "parent-session");
	assert.equal(parsed.value.history.page, 0, "out-of-range pages clamp");
	assert.equal(parsed.value.summary!.agents, 0);
	const allocated = (await allocateFixture(store, repo, "notification")).records[0]!;
	await service.execute({ action: "close", handle: allocated.handle, expectedEpisode: 0, disposition: "retain" }, contextFixture(repo));
	assert.ok(changes > 0, "closing emits an invalidation even without a live observer heartbeat");
	for (const handler of handlers.get("session_start") ?? []) await handler({}, contextFixture(repo, "print"));
	request({ version: 1, requestId: "ui-2", page: 0 });
	await new Promise(resolve => setTimeout(resolve, 20));
	assert.equal(replies.length, 1, "print mode never answers display queries");
});

test("late inventory reads cannot poison a newer revision and concurrent queries coalesce", async (t) => {
	const { base, repo } = await rootFixture(t);
	const original = new ManagedSessionStore(base);
	await allocateFixture(original, repo, "first");
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	let captured = false, scans = 0;
	const store = new Proxy(original, { get(target, property) {
		if (property === "inventory") return async (...args: Parameters<ManagedSessionStore["inventory"]>) => {
			scans++;
			const value = await target.inventory(...args);
			if (scans === 1) { captured = true; await gate; }
			return value;
		};
		const value = Reflect.get(target, property, target);
		return typeof value === "function" ? value.bind(target) : value;
	} });
	const builder = new SessionViewBuilder({ store });
	const first = builder.build({ version: 1, requestId: "first", page: 0 }, scope(ownerOf(repo)));
	await until(() => captured);
	const concurrent = builder.build({ version: 1, requestId: "same-revision", page: 0 }, scope(ownerOf(repo)));
	await allocateFixture(original, repo, "second");
	builder.invalidate();
	const second = await builder.build({ version: 1, requestId: "second", page: 0 }, scope(ownerOf(repo)));
	release();
	const stale = await first;
	await concurrent;
	const third = await builder.build({ version: 1, requestId: "third", page: 0 }, scope(ownerOf(repo)));
	assert.equal(stale.summary!.agents, 1);
	assert.ok(stale.revision < second.revision);
	assert.equal(third.summary!.agents, 2);
	assert.equal(scans, 2, "pending reads coalesce and the late result cannot replace the new cache");
});

test("same-session branch changes recompute the historical branch marker", async (t) => {
	const { base, repo } = await rootFixture(t);
	const store = new ManagedSessionStore(base);
	await allocateFixture(store, repo, "first");
	const builder = new SessionViewBuilder({ store });
	const first = await builder.build({ version: 1, requestId: "first", page: 0 }, scope(ownerOf(repo)));
	const otherOwner = { ...ownerOf(repo), anchor: "other", branch: ["other"] };
	const second = await builder.build({ version: 1, requestId: "second", page: 0 }, scope(otherOwner, [], { anchor: "other" }));
	assert.equal(first.history.rows[0]!.onCurrentBranch, true);
	assert.equal(second.history.rows[0]!.onCurrentBranch, false);
});

test("owner and session transitions keep retained projections scoped and stale replies distinguishable", async (t) => {
	const { base, repo } = await rootFixture(t);
	const store = new ManagedSessionStore(base);
	await allocateFixture(store, repo, "a");
	const builder = new SessionViewBuilder({ store });
	const first = await builder.build({ version: 1, requestId: "ui-1", page: 0 }, scope(ownerOf(repo)));
	builder.reset();
	const forked = await builder.build({ version: 1, requestId: "ui-1", page: 0 }, scope(ownerOf(repo, "forked-session"), [], { ownerSessionId: "forked-session", generation: "generation-2" }));
	assert.notEqual(forked.ownerSessionId, first.ownerSessionId);
	assert.notEqual(forked.generation, first.generation);
	assert.ok(forked.revision > first.revision);
	assert.equal(first.summary!.agents, 1);
	assert.equal(forked.summary!.agents, 0, "a forked parent session owns no records from the first session");
	assert.equal(parseSessionViewReply(first).ok && parseSessionViewReply(forked).ok, true);
});
