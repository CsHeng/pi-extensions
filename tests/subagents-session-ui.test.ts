import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { defaultConfig } from "../extensions/subagents/config.ts";
import { emptyUsage } from "../extensions/subagents/contracts.ts";
import { validateGraphStructure } from "../extensions/subagents/graph.ts";
import { ManagedSessionStore } from "../extensions/subagents/managed-sessions.ts";
import { registerContinuationTool } from "../extensions/subagents/continuation.ts";
import { SESSION_VIEW_EVENT, type SessionViewReply } from "../extensions/subagents/session-view.ts";
import { createSubagentsUiExtension } from "../extensions/subagents-ui/index.ts";
import type { SubagentsOverlay } from "../extensions/subagents-ui/component.ts";

const exec = promisify(execFile);
async function until(predicate: () => boolean): Promise<void> {
	for (let index = 0; index < 500; index++) {
		if (predicate()) return;
		await new Promise(resolve => setTimeout(resolve, 10));
	}
	assert.fail("composed session view did not settle");
}
const observation = (ownerSessionId: string, entryId: string) => ({ available: true, ownerSessionId,
	entries: [{ ownerSessionId, entryId, kind: "assistant" as const, modelKey: null, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: 1 } }],
	commands: [], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: 1 }, contextWindow: null, toolNames: null, capabilityKey: null });
async function bytes(root: string): Promise<string[]> {
	const result: string[] = [];
	for (const entry of await readdir(root, { withFileTypes: true })) {
		const file = join(root, entry.name);
		if (entry.isDirectory()) result.push(...(await bytes(file)).map(value => `${entry.name}/${value}`));
		else result.push(`${entry.name}:${createHash("sha256").update(await readFile(file)).digest("hex")}`);
	}
	return result.sort();
}

test("37 retained handles and 49 episodes survive real core-to-overlay paging and reload", async t => {
	const base = await mkdtemp(join(tmpdir(), "session-ui-composed-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const repo = join(base, "repo");
	await mkdir(repo);
	await exec("git", ["init", "-q", repo]);
	await mkdir(join(base, "agent"), { mode: 0o700 });
	const store = new ManagedSessionStore(join(base, "agent"));
	const owner = { repo, parentSessionId: "composed-parent", anchor: "anchor", branch: ["anchor"] };
	const graph = validateGraphStructure({ tasks: [{ id: "seed", role: "explorer", scope: ["."], objective: "synthetic history" }] });
	assert.ok(graph.ok);
	const seeded: string[] = [];
	for (let index = 0; index < 27; index++) {
		const record = (await store.allocate(owner, `seed-${index}`, graph.tasks)).records[0]!;
		seeded.push(record.handle);
		record.episode = index < 12 ? 2 : 1;
		record.state = "closed";
		for (let episode = 1; episode <= record.episode; episode++) {
			record.requests.push({ id: `episode-${episode}`, fingerprint: "a".repeat(64), episode, state: "complete" });
			await store.saveObservation(record.handle, episode, observation(`seed-${index}`, `entry-${episode}`));
		}
		await store.save(record);
	}
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	let launches = 0;
	const mount = () => {
		const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
		const listeners = new Map<string, Array<(data: unknown) => void>>();
		const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<unknown> }>();
		let reply: SessionViewReply | undefined;
		let panel: SubagentsOverlay | undefined;
		const pi = { on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
			registerCommand(name: string, value: { handler: (args: string, ctx: ExtensionContext) => Promise<unknown> }) { commands.set(name, value); },
			registerShortcut() {}, registerTool() {}, appendEntry() {}, sendMessage() {}, sendUserMessage() {}, getActiveTools: () => [],
			events: { on(name: string, fn: (data: unknown) => void) { listeners.set(name, [...(listeners.get(name) ?? []), fn]); },
				emit(name: string, data: unknown) { if (name === SESSION_VIEW_EVENT) reply = data as SessionViewReply; for (const fn of listeners.get(name) ?? []) fn(data); } },
		} as unknown as ExtensionAPI;
		const model = { provider: "synthetic", id: "parent", reasoning: false };
		const ctx = { cwd: repo, mode: "tui", model, thinkingLevel: "off", scopedModels: [], modelRegistry: { getAll: () => [model], getAvailable: () => [model] }, isProjectTrusted: () => true,
			sessionManager: { getSessionId: () => owner.parentSessionId, getLeafId: () => owner.anchor, getBranch: () => owner.branch.map(id => ({ id })) },
			ui: { setWidget() {}, setStatus() {}, custom: (factory: (tui: TUI, theme: unknown, kb: unknown, done: (value: null) => void) => SubagentsOverlay) => new Promise(resolve => { panel = factory({ requestRender() {}, terminal: { rows: 24, columns: 80 } } as TUI, undefined, undefined, resolve); }) },
		} as unknown as ExtensionContext;
		const service = registerContinuationTool(pi, { store, loadConfig: async () => ({ config: defaultConfig() }), runChild: async options => {
			const child = ++launches;
			options.onChildStarted?.();
			await gate;
			options.onChildSettled?.();
			return { id: options.task.id, role: options.task.role, status: "succeeded", output: "done", stderr: "", usage: { ...emptyUsage(), turns: 1 }, durationMs: 1, changedPaths: [], convergence: "not-applicable", reportComplete: true, observation: observation(`child-${child}`, "entry") };
		} });
		createSubagentsUiExtension()(pi);
		const event = async (name: string) => { for (const fn of handlers.get(name) ?? []) await fn({}, ctx); };
		return { ctx, service, event, get reply() { return reply; }, get panel() { return panel!; }, open: async () => { void commands.get("subagents-ui")!.handler("", ctx); await until(() => !!panel && !!reply); } };
	};
	const mounted = mount();
	t.after(async () => { release(); await mounted.event("session_shutdown"); });
	await mounted.event("session_start");
	const created = await mounted.service.execute({ action: "create", requestId: "ten-live", tasks: Array.from({ length: 10 }, (_, index) => ({ id: `live-${index}`, role: "explorer", objective: "synthetic live", scope: ["."] })) }, mounted.ctx);
	assert.equal(created.status, "accepted");
	await until(() => mounted.service.liveObserverTasks().length === 10);
	await mounted.open();
	await until(() => mounted.reply?.summary?.agents === 37 && mounted.reply.live.length === 10);
	assert.equal(mounted.reply!.summary!.acceptedEpisodes, 49);
	const live = created.sessions.map(row => row.handle);
	const all = [...seeded, ...live];
	const scan = async (expected: string[], liveHandles: string[]) => {
		const seen = new Set<string>();
		mounted.panel.handleInput("enter");
		for (let page = 0; page < mounted.reply!.history.totalPages; page++) {
			if (mounted.reply!.history.page !== page) {
				mounted.panel.handleInput(page === 0 ? "pageUp" : "pageDown");
				await until(() => mounted.reply?.history.page === page);
			}
			for (let index = 0; index < 100; index++) {
				const frame = mounted.panel.render(80, 48);
				assert.ok(frame.length <= 48);
				const text = frame.join("\n");
				for (const handle of liveHandles) assert.ok(text.includes(handle.slice(8, 16)), "every live identity remains pinned");
				for (const handle of expected) if (text.includes(handle.slice(8, 16))) seen.add(handle);
				mounted.panel.handleInput("down");
			}
		}
		assert.deepEqual([...seen].sort(), [...expected].sort());
		mounted.panel.handleInput("enter");
	};
	await scan(seeded, live);
	release();
	await until(() => !mounted.service.busy && mounted.reply?.history.totalRows === 37 && mounted.reply.live.length === 0);
	assert.equal(mounted.reply!.usage!.assistantTurns, 49);
	assert.equal(mounted.reply!.usage!.usage.input, 49);
	assert.equal(mounted.reply!.usage!.status, "complete");
	await scan(all, []);
	await mounted.event("session_shutdown");
	const before = await bytes(join(base, "agent"));
	const calls = launches;
	const reloaded = mount();
	t.after(() => reloaded.event("session_shutdown"));
	await reloaded.event("session_start");
	await reloaded.open();
	assert.equal(reloaded.reply!.summary!.agents, 37);
	assert.equal(reloaded.reply!.summary!.acceptedEpisodes, 49);
	assert.equal(reloaded.reply!.usage!.assistantTurns, 49);
	assert.equal(reloaded.reply!.live.length, 0);
	assert.equal(launches, calls, "viewing retained history never launches a child");
	assert.deepEqual(await bytes(join(base, "agent")), before, "reload query does not mutate retained evidence");
});
