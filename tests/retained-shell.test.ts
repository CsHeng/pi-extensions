import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalBashOperations, type BashOperations, type ExtensionAPI, type ExtensionContext, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";

import { NATIVE_TIMER_MAX_MS } from "../extensions/shared/duration-timer.ts";
import { createShellDelivery } from "../extensions/async-bash/delivery.ts";
import { createShellExecutionOwner, type ShellExecutionEvent, type ShellExecutionOwner, type ShellExecutionView, type ShellScope, type StartShellInput } from "../extensions/async-bash/execution.ts";
import { bindRetainedShell } from "../extensions/async-bash/index.ts";
import loopNotifications from "../extensions/job-notifications/index.ts";
import { shellClaim, SHELL_EXECUTION_EVENT } from "../extensions/async-bash/policy.ts";
import { validateShellCall } from "../extensions/async-bash/validate.ts";
import { LOOP_FACTS_EVENT, LOOP_NOTICE_TYPE, LOOP_SNAPSHOT_REQUEST, type LoopFacts } from "../extensions/shared/loop-facts.ts";
import { fakeBashOperations } from "./helpers/fake-bash-operations.ts";

const scope: ShellScope = { sessionId: "session", branchAnchor: "leaf" };
const unscoped: ShellScope = { sessionId: null, branchAnchor: null };

async function scratch(): Promise<string> {
	const root = join(process.env.TMPDIR ?? tmpdir(), "extensions");
	await mkdir(root, { recursive: true });
	return mkdtemp(join(root, "retained-shell-"));
}

function quote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function waitForFile(path: string): Promise<void> {
	const started = Date.now();
	while (Date.now() - started < 2_000) {
		try {
			await readFile(path);
			return;
		} catch { /* not written yet */ }
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`file was not written: ${path}`);
}

test("shell claim keeps print on the native tool and does not seize another owner", () => {
	assert.equal(shellClaim("print", "builtin"), "leave-native");
	assert.equal(shellClaim("json", "builtin"), "leave-native");
	assert.equal(shellClaim("rpc", "extension"), "other-owner");
	assert.equal(shellClaim("tui", "builtin"), "claim");
	assert.equal(shellClaim("rpc", undefined), "leave-native");
});

test("registration claims builtin bash only in tui or rpc", () => {
	const cases = [
		{ mode: "print", source: "builtin", claimed: false, unavailable: false },
		{ mode: "json", source: "builtin", claimed: false, unavailable: false },
		{ mode: "rpc", source: "extension", claimed: false, unavailable: true },
		{ mode: "tui", source: "builtin", claimed: true, unavailable: false },
	] as const;
	for (const item of cases) {
		const tools: Array<{ name: string }> = [];
		const events: unknown[] = [];
		const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => void>>();
		const pi = {
			getAllTools: () => [{ name: "bash", sourceInfo: { source: item.source } }],
			getActiveTools: () => ["bash"],
			getSettings: () => ({}),
			events: { emit: (_channel: string, data: unknown) => { events.push(data); }, on: () => () => {} },
			registerTool: (tool: { name: string }) => { tools.push(tool); },
			registerCommand: () => {},
			sendUserMessage: () => {},
			sendMessage: async () => {},
			on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void) => {
				const list = handlers.get(event) ?? [];
				list.push(handler);
				handlers.set(event, list);
				return () => {};
			},
		};
		bindRetainedShell(pi as unknown as ExtensionAPI, createShellExecutionOwner({ operations: createLocalBashOperations() }));
		const ctx = { mode: item.mode, sessionManager: { getSessionId: () => "session", getLeafId: () => "leaf", getBranch: () => [{ id: "leaf" }] } } as ExtensionContext;
		for (const handler of handlers.get("session_start") ?? []) handler({}, ctx);
		assert.equal(tools.some((tool) => tool.name === "bash"), item.claimed, item.mode);
		assert.equal(events.some((event) => (event as { phase?: string }).phase === "unavailable"), item.unavailable, item.mode);
	}
});

test("retained execution keeps one process across inspect, renew, released wait, and cancel", async (t) => {
	const dir = await scratch();
	const marker = join(dir, "marker");
	const pidfile = join(dir, "pid");
	const events: ShellExecutionEvent[] = [];
	const owner = createShellExecutionOwner({ operations: createLocalBashOperations(), onEvent: (event) => { events.push(event); } });
	t.after(async () => {
		await owner.shutdown();
		await rm(dir, { recursive: true, force: true });
	});
	const started = await owner.start({
		command: `printf 'once\\n' >> ${quote(marker)}; echo $$ > ${quote(pidfile)}; sleep 30`,
		cwd: dir,
		env: process.env,
		sessionId: scope.sessionId,
		branchAnchor: scope.branchAnchor,
		toolCallId: "call-1",
		deadlineMs: 60_000,
		foregroundWindowMs: 0,
	});
	assert.equal(started.status, "running");
	assert.equal(owner.startCount, 1);
	await waitForFile(marker);
	await waitForFile(pidfile);
	assert.equal(owner.inspect(started.executionId, scope)?.executionId, started.executionId);
	const renewed = owner.renew(started.executionId, scope, 90_000);
	assert.equal(renewed.executionId, started.executionId);
	assert.ok(renewed.deadlineAt > started.deadlineAt);
	const controller = new AbortController();
	const waiting = owner.wait(started.executionId, scope, { signal: controller.signal, waitMs: 30_000 });
	controller.abort();
	const released = await waiting;
	assert.equal(released.status, "running");
	assert.equal(owner.startCount, 1);
	assert.equal(await readFile(marker, "utf8"), "once\n");
	const cancelled = await owner.cancel(started.executionId, scope);
	assert.equal(cancelled.status, "cancelled");
	assert.equal(cancelled.exitCode, null);
	assert.equal((await owner.cancel(started.executionId, scope)).status, "cancelled");
	assert.equal(events.filter((event) => event.phase === "started").length, 1);
	assert.equal(events.filter((event) => event.phase === "renewed").length, 1);
	assert.equal(events.filter((event) => event.phase === "cancelled").length, 1);
	assert.equal(events.filter((event) => event.phase === "exited").length, 0);
	const pid = Number(await readFile(pidfile, "utf8"));
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.throws(() => process.kill(pid, 0));
});

test("foreground window releases the wait and a short command returns its own terminal", async (t) => {
	const dir = await scratch();
	const owner = createShellExecutionOwner({ operations: createLocalBashOperations() });
	t.after(async () => {
		await owner.shutdown();
		await rm(dir, { recursive: true, force: true });
	});
	const running = await owner.start({
		command: "sleep 30",
		cwd: dir,
		env: process.env,
		sessionId: null,
		branchAnchor: null,
		toolCallId: null,
		deadlineMs: 60_000,
		foregroundWindowMs: 150,
	});
	assert.equal(running.status, "running");
	assert.equal(owner.startCount, 1);
	await owner.cancel(running.executionId, unscoped);
	const done = await owner.start({
		command: "printf 'hi\\n'",
		cwd: dir,
		env: process.env,
		sessionId: null,
		branchAnchor: null,
		toolCallId: "call-short",
		deadlineMs: 5_000,
		foregroundWindowMs: 2_000,
	});
	assert.equal(done.status, "exited");
	assert.equal(done.exitCode, 0);
	assert.equal(done.output, "hi\n");
	assert.equal(owner.startCount, 2);
});

test("deadline and shutdown do not report a successful exit", async (t) => {
	const dir = await scratch();
	const owner = createShellExecutionOwner({ operations: createLocalBashOperations() });
	t.after(async () => {
		await owner.shutdown();
		await rm(dir, { recursive: true, force: true });
	});
	const timed = await owner.start({
		command: "sleep 30",
		cwd: dir,
		env: process.env,
		sessionId: null,
		branchAnchor: null,
		toolCallId: null,
		deadlineMs: 200,
		foregroundWindowMs: 0,
	});
	const finished = await owner.wait(timed.executionId, unscoped, { waitMs: 2_000 });
	assert.equal(finished.status, "deadline");
	assert.equal(finished.exitCode, null);
	const replaced = await owner.start({
		command: "sleep 30",
		cwd: dir,
		env: process.env,
		sessionId: null,
		branchAnchor: null,
		toolCallId: null,
		deadlineMs: 60_000,
		foregroundWindowMs: 0,
	});
	await owner.shutdown();
	assert.equal(owner.inspect(replaced.executionId, unscoped)?.status, "interrupted");
	assert.equal(owner.inspect(replaced.executionId, unscoped)?.exitCode, null);
});

test("an already aborted start does not spawn", async (t) => {
	const dir = await scratch();
	const owner = createShellExecutionOwner({ operations: createLocalBashOperations() });
	t.after(async () => {
		await owner.shutdown();
		await rm(dir, { recursive: true, force: true });
	});
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(owner.start({
		command: "sleep 30",
		cwd: dir,
		env: process.env,
		sessionId: null,
		branchAnchor: null,
		toolCallId: null,
		deadlineMs: 60_000,
		foregroundWindowMs: 0,
		signal: controller.signal,
	}), /aborted before execution/);
	assert.equal(owner.startCount, 0);
});

test("output stays bounded and a missing command does not spawn", async (t) => {
	const dir = await scratch();
	const owner = createShellExecutionOwner({ operations: createLocalBashOperations(), maxOutputBytes: 32 });
	t.after(async () => {
		await owner.shutdown();
		await rm(dir, { recursive: true, force: true });
	});
	await assert.rejects(owner.start({
		command: "   ",
		cwd: dir,
		env: process.env,
		sessionId: null,
		branchAnchor: null,
		toolCallId: null,
		deadlineMs: 1_000,
		foregroundWindowMs: 0,
	}));
	assert.equal(owner.startCount, 0);
	const view = await owner.start({
		command: "i=0; while [ \"$i\" -lt 100 ]; do printf 'abcdefghij'; i=$((i+1)); done",
		cwd: dir,
		env: process.env,
		sessionId: null,
		branchAnchor: null,
		toolCallId: null,
		deadlineMs: 5_000,
		foregroundWindowMs: 2_000,
	});
	assert.equal(view.status, "exited");
	assert.equal(view.truncated, true);
	assert.ok(Buffer.byteLength(view.output) <= 32);
});

test("observer failure and late output do not settle before the native operation settles", async (t) => {
	const dir = await scratch();
	const { operations, executions } = fakeBashOperations({
		onAbort: (execution) => {
			execution.emit("late\n");
			execution.close(null);
		},
	});
	const owner = createShellExecutionOwner({
		operations,
		onEvent: () => { throw new Error("observer failed"); },
	});
	t.after(async () => {
		await owner.shutdown();
		await rm(dir, { recursive: true, force: true });
	});
	const started = await owner.start({
		command: "sleep 30",
		cwd: dir,
		env: process.env,
		sessionId: scope.sessionId,
		branchAnchor: scope.branchAnchor,
		toolCallId: "call-late",
		deadlineMs: 60_000,
		foregroundWindowMs: 0,
	});
	assert.equal(started.status, "running");
	const cancelled = await owner.cancel(started.executionId, scope);
	assert.equal(cancelled.status, "cancelled");
	assert.equal(cancelled.output, "late\n");
	assert.equal(cancelled.exitCode, null);
	assert.equal(executions.get("sleep 30")?.aborted, true);
});

test("controls stay in one session branch and a switch interrupts only the old owner", async (t) => {
	const dir = await scratch();
	const owner = createShellExecutionOwner({ operations: createLocalBashOperations() });
	t.after(async () => {
		await owner.shutdown();
		await rm(dir, { recursive: true, force: true });
	});
	const started = await owner.start({
		command: "sleep 30",
		cwd: dir,
		env: process.env,
		sessionId: "session",
		branchAnchor: "old",
		toolCallId: null,
		deadlineMs: 60_000,
		foregroundWindowMs: 0,
	});
	const oldScope = { sessionId: "session", branchAnchor: "old" };
	const other = { sessionId: "session", branchAnchor: "new" };
	assert.equal(owner.inspect(started.executionId, other), undefined);
	await assert.rejects(owner.cancel(started.executionId, other), /outside the current session branch/);
	await owner.interruptOthers(oldScope);
	assert.equal(owner.inspect(started.executionId, oldScope)?.status, "running");
	await owner.interruptOthers(other);
	const interrupted = owner.inspect(started.executionId, oldScope);
	assert.equal(interrupted?.status, "interrupted");
	assert.equal(interrupted?.exitCode, null);
});

test("branch switch keeps ancestor work and a late old terminal does not enter the new branch", async (t) => {
	const dir = await scratch();
	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => void>>();
	const listeners = new Map<string, Array<(data: unknown) => void>>();
	const published: LoopFacts[] = [];
	const pi = {
		getAllTools: () => [{ name: "bash", sourceInfo: { source: "builtin" } }],
		getActiveTools: () => ["bash"],
		getSettings: () => ({}),
		events: {
			on: (name: string, handler: (data: unknown) => void) => { listeners.set(name, [...(listeners.get(name) ?? []), handler]); return () => {}; },
			emit: (name: string, data: unknown) => { for (const handler of listeners.get(name) ?? []) handler(data); },
		},
		registerTool: () => {},
		registerCommand: () => {},
		sendUserMessage: () => {},
		sendMessage: async () => {},
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			return () => {};
		},
	};
	pi.events.on(LOOP_FACTS_EVENT, (data) => { const facts = data as LoopFacts; if (facts.producer === "retained-shell") published.push(facts); });
	const owner = createShellExecutionOwner({ operations: createLocalBashOperations(), onEvent: (event) => pi.events.emit(SHELL_EXECUTION_EVENT, event) });
	const startsBefore = owner.startCount;
	t.after(async () => { await owner.shutdown(); await rm(dir, { recursive: true, force: true }); });
	bindRetainedShell(pi as unknown as ExtensionAPI, owner);
	const ctxFor = (leaf: string, branch: string[]) => ({ mode: "tui", sessionManager: { getSessionId: () => "session", getLeafId: () => leaf, getBranch: () => branch.map((id) => ({ id })) } }) as ExtensionContext;
	const fire = (event: string, ctx: ExtensionContext) => { for (const handler of handlers.get(event) ?? []) handler({}, ctx); };
	fire("session_start", ctxFor("old", ["old"]));
	const started = await owner.start({ command: "sleep 30", cwd: dir, env: process.env, sessionId: "session", branchAnchor: "old", toolCallId: null, deadlineMs: 60_000, foregroundWindowMs: 0 });
	assert.equal(owner.startCount, startsBefore + 1);
	const ancestor = ctxFor("child", ["old", "child"]);
	fire("session_tree", ancestor);
	const kept = published.at(-1);
	assert.equal(kept?.availability, "ready");
	assert.equal(kept?.executions.some((execution) => execution.id === started.executionId && execution.phase === "running"), true, "ancestor-anchor work must stay visible");
	assert.equal(owner.startCount, startsBefore + 1);
	const away = ctxFor("other", ["other"]);
	fire("session_tree", away);
	await owner.interruptOthers({ sessionId: "session", branchAnchor: "other", branchIds: ["other"] });
	pi.events.emit(SHELL_EXECUTION_EVENT, { version: 1, executionId: started.executionId, owner: "pi-bash", sessionId: "session", branchAnchor: "old", toolCallId: null, phase: "interrupted", status: "interrupted", exitCode: null, deadlineAt: null, truncated: false, outputTail: "old", notification: "idle-wake-or-next-request", label: "Bash", terminalAt: null, lastOutputAt: null });
	const replies: LoopFacts[] = [];
	pi.events.emit(LOOP_SNAPSHOT_REQUEST, { version: 1, accept: (facts: LoopFacts) => replies.push(facts) });
	assert.equal(replies[0]?.executions.some((execution) => execution.id === started.executionId), false, "a late old-branch terminal must not be relabeled onto the current branch");
	assert.equal(owner.startCount, startsBefore + 1);
});

test("an empty execution id does not start a process", async () => {
	assert.equal(validateShellCall({ command: "echo effect", executionId: "" }).ok, false);
	assert.equal(validateShellCall({ action: "inspect", executionId: "" }).ok, false);
	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => void>>();
	const tools = new Map<string, { execute: (id: string, params: unknown, signal: undefined, update: undefined, ctx: ExtensionContext) => Promise<{ isError?: boolean }> }>();
	const owner = createShellExecutionOwner({ operations: createLocalBashOperations() });
	const before = owner.startCount;
	const pi = {
		getAllTools: () => [{ name: "bash", sourceInfo: { source: "builtin" } }],
		getActiveTools: () => ["bash"],
		getSettings: () => ({}),
		events: { on: () => () => {}, emit: () => {} },
		registerTool: (tool: { name: string; execute: (id: string, params: unknown, signal: undefined, update: undefined, ctx: ExtensionContext) => Promise<{ isError?: boolean }> }) => { tools.set(tool.name, tool); },
		registerCommand: () => {},
		sendUserMessage: () => {},
		sendMessage: async () => {},
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void) => { handlers.set(event, [...(handlers.get(event) ?? []), handler]); return () => {}; },
	};
	bindRetainedShell(pi as unknown as ExtensionAPI, owner);
	const ctx = { mode: "tui", cwd: "/tmp", sessionManager: { getSessionId: () => "session", getLeafId: () => "leaf", getBranch: () => [{ id: "leaf" }] } } as ExtensionContext;
	for (const handler of handlers.get("session_start") ?? []) handler({}, ctx);
	const rejected = await tools.get("bash")!.execute("call", { command: "echo effect", executionId: "" }, undefined, undefined, ctx);
	assert.equal(rejected.isError, true);
	assert.equal(owner.startCount, before);
	await owner.shutdown();
});

test("nine background terminals remain listed and project once", async (t) => {
	const dir = await scratch();
	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
	const listeners = new Map<string, Array<(data: unknown) => void>>();
	const pi = {
		getAllTools: () => [{ name: "bash", sourceInfo: { source: "builtin" } }],
		getActiveTools: () => ["bash"],
		getSettings: () => ({}),
		appendEntry: () => {},
		events: {
			on: (name: string, handler: (data: unknown) => void) => { listeners.set(name, [...(listeners.get(name) ?? []), handler]); return () => {}; },
			emit: (name: string, data: unknown) => { for (const handler of listeners.get(name) ?? []) handler(data); },
		},
		registerTool: () => {},
		registerCommand: () => {},
		sendUserMessage: () => {},
		sendMessage: async () => {},
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			return () => {};
		},
	};
	const owner = createShellExecutionOwner({ operations: createLocalBashOperations(), onEvent: (event) => pi.events.emit(SHELL_EXECUTION_EVENT, event) });
	t.after(async () => { await owner.shutdown(); await rm(dir, { recursive: true, force: true }); });
	bindRetainedShell(pi as unknown as ExtensionAPI, owner);
	loopNotifications(pi as unknown as ExtensionAPI);
	const exited = new Set<string>();
	pi.events.on(SHELL_EXECUTION_EVENT, (data) => {
		const event = data as ShellExecutionEvent;
		if (event.phase === "exited") exited.add(event.executionId);
	});
	const ctx = { mode: "tui", isIdle: () => false, hasPendingMessages: () => false, isProjectTrusted: () => true, signal: undefined, sessionManager: { getSessionId: () => "session", getLeafId: () => "leaf", getBranch: () => [{ id: "leaf" }] } } as ExtensionContext;
	for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
	const ids: string[] = [];
	for (let index = 0; index < 9; index++) {
		const started = await owner.start({ command: "echo ok", cwd: dir, env: process.env, sessionId: "session", branchAnchor: "leaf", toolCallId: null, deadlineMs: 60_000, foregroundWindowMs: 0 });
		ids.push(started.executionId);
	}
	const deadline = Date.now() + 3_000;
	while (exited.size < ids.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(exited.size, ids.length);
	assert.equal(owner.list(scope).filter((view) => view.status !== "running").length, ids.length);
	for (const id of ids) assert.equal(owner.inspect(id, scope)?.status, "exited");
	const project = async () => {
		let text = "";
		for (const handler of handlers.get("context_with_system") ?? []) {
			const result = await handler({ messages: [] }, ctx) as { messages?: Array<{ customType?: string; content?: string }> } | undefined;
			text += (result?.messages ?? []).filter((message) => message.customType === LOOP_NOTICE_TYPE).map((message) => message.content ?? "").join("\n");
		}
		return text;
	};
	const first = await project();
	for (const id of ids) assert.equal(first.split(id).length - 1, 1, id);
	const second = await project();
	for (const id of ids) assert.equal(second.includes(id), false, id);
	const replies: LoopFacts[] = [];
	pi.events.emit(LOOP_SNAPSHOT_REQUEST, { version: 1, accept: (facts: LoopFacts) => replies.push(facts) });
	assert.equal(replies.some((facts) => facts.producer === "retained-shell" && facts.executions.some((execution) => ids.includes(execution.id) && execution.disposition === "pending")), false);
});

test("terminal retention is bounded and a dropped wake stays inspectable", () => {
	const delivery = createShellDelivery();
	const event = (id: string, status = "exited"): ShellExecutionEvent => ({
		version: 1, executionId: id, owner: "pi-bash", sessionId: "session", branchAnchor: "leaf", toolCallId: "call", phase: "exited", status: status as "exited", exitCode: 0, deadlineAt: null, truncated: false, outputTail: id, notification: "idle-wake-or-next-request", label: "Bash", terminalAt: null, lastOutputAt: null,
	});
	delivery.noteReady(event("exec-a"));
	delivery.noteReturning(event("exec-b"));
	assert.equal(delivery.hasDeliverable(scope), true);
	delivery.notePull("exec-b");
	assert.equal(delivery.inspectable("exec-b")?.consumed, true);
	assert.equal(delivery.preview(scope)?.includes("exec-a"), true);
	delivery.fence();
	assert.equal(delivery.hasDeliverable(scope), false);
	assert.equal(delivery.inspectable("exec-a")?.consumed, false);
	delivery.noteReady(event("exec-c"));
	assert.equal(delivery.project(scope)?.includes("exec-c"), true);
	assert.equal(delivery.hasDeliverable(scope), false);
	assert.equal(delivery.inspectable("exec-c")?.outputTail, "");
	for (let index = 0; index < 12; index++) {
		const id = `old-${index}`;
		delivery.noteReturning({ ...event(id), outputTail: "x".repeat(50 * 1024) });
		delivery.notePull(id);
	}
	assert.equal(delivery.inspectable("old-0"), undefined);
	assert.equal(delivery.inspectable("old-11")?.outputTail, "");
	delivery.noteReady({ ...event("needed"), outputTail: "still needed" });
	assert.ok(delivery.preview(scope)?.includes("still needed"), "unconsumed required facts must survive obsolete trimming");
	delivery.fence();
	assert.equal(delivery.inspectable("needed")?.outputTail, "");
});

test("terminal records stay inspectable after later terminals finish", async (t) => {
	const dir = await scratch();
	const owner = createShellExecutionOwner({ operations: createLocalBashOperations() });
	t.after(async () => {
		await owner.shutdown();
		await rm(dir, { recursive: true, force: true });
	});
	const ids: string[] = [];
	for (const label of ["one", "two", "three"]) {
		const view = await owner.start({
			command: `printf '${label}\\n'`,
			cwd: dir,
			env: process.env,
			sessionId: null,
			branchAnchor: null,
			toolCallId: null,
			deadlineMs: 5_000,
			foregroundWindowMs: 2_000,
		});
		ids.push(view.executionId);
	}
	assert.equal(owner.inspect(ids[0]!, unscoped)?.status, "exited");
	assert.equal(owner.inspect(ids[2]!, unscoped)?.status, "exited");
	assert.equal(owner.list(unscoped).length, 3);
});

test("display notification sees every finished record", async (t) => {
	const dir = await scratch();
	const owner = createShellExecutionOwner({ operations: createLocalBashOperations() });
	t.after(async () => {
		await owner.shutdown();
		await rm(dir, { recursive: true, force: true });
	});
	const snapshots: string[][] = [];
	owner.subscribeDisplay(() => {
		snapshots.push(owner.list(unscoped).map((view) => view.executionId));
	});
	const ids: string[] = [];
	for (const command of ["exit 1", "printf 'two\n'", "printf 'three\n'"]) {
		const view = await owner.start({
			command,
			cwd: dir,
			env: process.env,
			sessionId: null,
			branchAnchor: null,
			toolCallId: null,
			deadlineMs: 5_000,
			foregroundWindowMs: 2_000,
		});
		ids.push(view.executionId);
	}
	const last = snapshots.at(-1) ?? [];
	assert.equal(last.length, 3);
	assert.equal(last.includes(ids[0]!), true);
	assert.deepEqual(owner.list(unscoped).map((view) => view.executionId), last);
});

test("omitted wait is 180 seconds and an explicit duration above the old caps is honored", async () => {
	const waits: number[] = [];
	const starts: StartShellInput[] = [];
	const renewals: number[] = [];
	const owner: ShellExecutionOwner = {
		startCount: 0,
		async start(input) { starts.push(input); return runningView(); },
		inspect() { return runningView(); },
		async wait(_executionId, _scope, options) { waits.push(options.waitMs); return runningView(); },
		renew(_executionId, _scope, deadlineMs) { renewals.push(deadlineMs); return runningView(); },
		async cancel() { return { ...runningView(), status: "cancelled" }; },
		async interruptOthers() {},
		async shutdown() {},
		list() { return []; },
		subscribeDisplay() { return () => {}; },
	};
	const tool = retainedTool(owner);
	const ctx = toolContext();
	const omitted = await tool.execute("wait-default", { action: "wait", executionId: "exec-fixed" }, undefined, undefined, ctx);
	assert.equal(waits[0], 180_000);
	assert.equal(omitted.details.exitCode, null);
	await tool.execute("wait-explicit", { action: "wait", executionId: "exec-fixed", waitSeconds: 1800 }, undefined, undefined, ctx);
	assert.equal(waits[1], 1_800_000);
	const rejected = await tool.execute("wait-invalid", { action: "wait", executionId: "exec-fixed", waitSeconds: Number.POSITIVE_INFINITY }, undefined, undefined, ctx);
	assert.equal(rejected.isError, true);
	assert.equal(waits.length, 2);
	await tool.execute("run-default", { command: "printf hi" }, undefined, undefined, ctx);
	assert.equal(starts[0]?.deadlineMs, 600_000);
	assert.equal(starts[0]?.foregroundWindowMs, 2_000);
	await tool.execute("run-explicit", { command: "printf hi", deadlineSeconds: 1800, foregroundSeconds: 1800, timeout: 2_147_484 }, undefined, undefined, ctx);
	assert.equal(starts[1]?.deadlineMs, 1_800_000);
	assert.equal(starts[1]?.foregroundWindowMs, 1_800_000);
	await tool.execute("run-old-ceiling", { command: "printf hi", deadlineSeconds: 2_147_484, background: true }, undefined, undefined, ctx);
	assert.equal(starts[2]?.deadlineMs, 2_147_484_000);
	assert.equal(starts[2]?.foregroundWindowMs, 0);
	const overflow = await tool.execute("run-overflow", { command: "printf hi", deadlineSeconds: 9_000_000_000_000 }, undefined, undefined, ctx);
	assert.equal(overflow.isError, true);
	assert.equal(starts.length, 3);
	await tool.execute("renew-explicit", { action: "renew", executionId: "exec-fixed", deadlineSeconds: 1800 }, undefined, undefined, ctx);
	assert.equal(renewals[0], 1_800_000);
	const inspected = await tool.execute("inspect-now", { action: "inspect", executionId: "exec-fixed" }, undefined, undefined, ctx);
	assert.equal(inspected.details.exitCode, null);
	assert.equal(inspected.details.status, "running");
});

test("inspect is immediate, wait expiry only releases the observer, and a terminal keeps its exit code", async (t) => {
	const dir = await scratch();
	const events: ShellExecutionEvent[] = [];
	const owner = createShellExecutionOwner({ operations: createLocalBashOperations(), onEvent: (event) => { events.push(event); } });
	t.after(async () => {
		await owner.shutdown();
		await rm(dir, { recursive: true, force: true });
	});
	const started = await owner.start({
		command: "sleep 30",
		cwd: dir,
		env: process.env,
		sessionId: null,
		branchAnchor: null,
		toolCallId: null,
		deadlineMs: 60_000,
		foregroundWindowMs: 0,
	});
	const before = started.deadlineAt;
	const snapshot = owner.inspect(started.executionId, unscoped);
	assert.equal(snapshot?.status, "running");
	assert.equal(snapshot?.exitCode, null);
	const released = await owner.wait(started.executionId, unscoped, { waitMs: 40 });
	assert.equal(released.status, "running");
	assert.equal(released.exitCode, null);
	assert.equal(owner.inspect(started.executionId, unscoped)?.deadlineAt, before);
	assert.equal(events.some((event) => event.phase === "renewed" || event.phase === "cancelled"), false);
	assert.equal(owner.startCount, 1);
	const controller = new AbortController();
	let waitReleased = false;
	const waiting = owner.wait(started.executionId, unscoped, { signal: controller.signal, waitMs: 30_000 }).then((view) => {
		waitReleased = true;
		return view;
	});
	const duringWait = owner.inspect(started.executionId, unscoped);
	assert.equal(duringWait?.status, "running");
	assert.equal(duringWait?.exitCode, null);
	assert.equal(waitReleased, false);
	controller.abort();
	assert.equal((await waiting).status, "running");
	await owner.cancel(started.executionId, unscoped);
	const finished = await owner.start({
		command: "exit 3",
		cwd: dir,
		env: process.env,
		sessionId: null,
		branchAnchor: null,
		toolCallId: null,
		deadlineMs: 80,
		foregroundWindowMs: 2_000,
	});
	assert.equal(finished.status, "exited");
	assert.equal(finished.exitCode, 3);
	assert.equal(owner.inspect(finished.executionId, unscoped)?.exitCode, 3);
	assert.equal((await owner.wait(finished.executionId, unscoped, { waitMs: 5_000 })).exitCode, 3);
	await new Promise((resolve) => setTimeout(resolve, 120));
	assert.equal(owner.inspect(finished.executionId, unscoped)?.status, "exited");
	assert.equal(owner.inspect(finished.executionId, unscoped)?.exitCode, 3);
});

test("a duration above the native timer ceiling does not expire immediately and start abort still cancels", async (t) => {
	const dir = await scratch();
	let startedId = "";
	const owner = createShellExecutionOwner({
		operations: createLocalBashOperations(),
		onEvent: (event) => { if (event.phase === "started") startedId = event.executionId; },
	});
	t.after(async () => {
		await owner.shutdown();
		await rm(dir, { recursive: true, force: true });
	});
	const deadline = await owner.start({
		command: "sleep 30",
		cwd: dir,
		env: process.env,
		sessionId: null,
		branchAnchor: null,
		toolCallId: null,
		deadlineMs: NATIVE_TIMER_MAX_MS + 5_000,
		foregroundWindowMs: 0,
	});
	await new Promise((resolve) => setTimeout(resolve, 40));
	assert.equal(owner.inspect(deadline.executionId, unscoped)?.status, "running");
	assert.equal(owner.inspect(deadline.executionId, unscoped)?.exitCode, null);
	let released = false;
	const controller = new AbortController();
	const waiting = owner.wait(deadline.executionId, unscoped, { signal: controller.signal, waitMs: NATIVE_TIMER_MAX_MS + 1_000 }).then((view) => {
		released = true;
		return view;
	});
	await new Promise((resolve) => setTimeout(resolve, 40));
	assert.equal(released, false);
	controller.abort();
	assert.equal((await waiting).status, "running");
	await owner.cancel(deadline.executionId, unscoped);
	startedId = "";
	const abortController = new AbortController();
	const pending = owner.start({
		command: "sleep 30",
		cwd: dir,
		env: process.env,
		sessionId: null,
		branchAnchor: null,
		toolCallId: null,
		deadlineMs: 60_000,
		foregroundWindowMs: NATIVE_TIMER_MAX_MS + 5_000,
		signal: abortController.signal,
	});
	const startedAt = Date.now();
	while (!startedId && Date.now() - startedAt < 2_000) await new Promise((resolve) => setTimeout(resolve, 10));
	assert.ok(startedId);
	await new Promise((resolve) => setTimeout(resolve, 40));
	assert.equal(owner.inspect(startedId, unscoped)?.status, "running");
	abortController.abort();
	const cancelled = await Promise.race([
		pending,
		new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("foreground abort did not release")), 1_000)),
	]);
	assert.equal(cancelled.status, "cancelled");
});

test("one native operation keeps a silent retained command alive until it writes its output", async (t) => {
	const dir = await scratch();
	const release = join(dir, "release");
	const native = createLocalBashOperations();
	let calls = 0;
	const counted: BashOperations = {
		exec: (command, cwd, options) => { calls += 1; return native.exec(command, cwd, options); },
	};
	const owner = createShellExecutionOwner({ operations: counted });
	t.after(async () => {
		await owner.shutdown();
		await rm(dir, { recursive: true, force: true });
	});
	const started = await owner.start({
		command: `while [ ! -f ${quote(release)} ]; do sleep 0.05; done; printf 'done\\n'`,
		cwd: dir,
		env: process.env,
		sessionId: scope.sessionId,
		branchAnchor: scope.branchAnchor,
		toolCallId: "call-native",
		deadlineMs: 20_000,
		foregroundWindowMs: 150,
	});
	assert.equal(started.status, "running");
	assert.equal(started.output, "");
	assert.equal(calls, 1);
	assert.equal(owner.startCount, 1);
	assert.equal(owner.inspect(started.executionId, scope)?.status, "running");
	await writeFile(release, "go\n");
	const finished = await owner.wait(started.executionId, scope, { waitMs: 10_000 });
	assert.equal(finished.status, "exited");
	assert.equal(finished.exitCode, 0);
	assert.equal(finished.output, "done\n");
	assert.equal(calls, 1);
	const writer = await owner.start({
		command: "printf 'early\\n'; sleep 0.3; printf 'late\\n'",
		cwd: dir,
		env: process.env,
		sessionId: scope.sessionId,
		branchAnchor: scope.branchAnchor,
		toolCallId: "call-output",
		deadlineMs: 20_000,
		foregroundWindowMs: 100,
	});
	assert.equal(writer.status, "running");
	assert.equal(writer.output, "early\n");
	assert.equal(owner.inspect(writer.executionId, scope)?.output, "early\n");
	const collected = await owner.wait(writer.executionId, scope, { waitMs: 10_000 });
	assert.equal(collected.status, "exited");
	assert.equal(collected.output, "early\nlate\n");
	assert.equal(calls, 2);
});

test("native operations apply cwd and environment once and the configured prefix once", async (t) => {
	const dir = await scratch();
	const resolved = await realpath(dir);
	const marker = join(dir, "prefix");
	const owner = createShellExecutionOwner({ operations: createLocalBashOperations() });
	t.after(async () => {
		await owner.shutdown();
		await rm(dir, { recursive: true, force: true });
	});
	const scopeInput = { cwd: dir, sessionId: scope.sessionId, branchAnchor: scope.branchAnchor, toolCallId: null, deadlineMs: 10_000, foregroundWindowMs: 5_000 } as const;
	const observed = await owner.start({
		command: "printf '%s|%s' \"$PWD\" \"$NATIVE_WRAPPER_ENV\"",
		...scopeInput,
		env: { ...process.env, NATIVE_WRAPPER_ENV: "wrapper-value" },
	});
	assert.equal(observed.status, "exited");
	assert.equal(observed.exitCode, 0);
	assert.equal(observed.output, `${resolved}|wrapper-value`);
	const prefixed = await owner.start({
		command: "true",
		commandPrefix: `printf 'prefix\\n' >> ${quote(marker)}`,
		...scopeInput,
		env: process.env,
	});
	assert.equal(prefixed.status, "exited");
	assert.equal(prefixed.exitCode, 0);
	assert.equal(prefixed.label, "true", "the label uses the command, not the prefix");
	assert.equal(prefixed.commandPreview, "true");
	assert.equal(await readFile(marker, "utf8"), "prefix\n", "the prefix runs once for one start");
});

test("a retained command has no terminal stdin and does not wait for input", async (t) => {
	const dir = await scratch();
	const owner = createShellExecutionOwner({ operations: createLocalBashOperations() });
	t.after(async () => {
		await owner.shutdown();
		await rm(dir, { recursive: true, force: true });
	});
	const view = await owner.start({
		command: "if [ -t 0 ]; then printf 'tty\\n'; else printf 'no-tty\\n'; fi; cat; printf 'after-stdin\\n'",
		cwd: dir,
		env: process.env,
		sessionId: null,
		branchAnchor: null,
		toolCallId: null,
		deadlineMs: 10_000,
		foregroundWindowMs: 5_000,
	});
	assert.equal(view.status, "exited");
	assert.equal(view.exitCode, 0);
	assert.equal(view.output, "no-tty\nafter-stdin\n");
});

test("cancel stops the shell and its children", async (t) => {
	const dir = await scratch();
	const shellPidFile = join(dir, "shell.pid");
	const childPidFile = join(dir, "child.pid");
	const owner = createShellExecutionOwner({ operations: createLocalBashOperations() });
	t.after(async () => {
		await owner.shutdown();
		await rm(dir, { recursive: true, force: true });
	});
	const started = await owner.start({
		command: `echo $$ > ${quote(shellPidFile)}; sleep 300 & echo $! > ${quote(childPidFile)}; wait`,
		cwd: dir,
		env: process.env,
		sessionId: scope.sessionId,
		branchAnchor: scope.branchAnchor,
		toolCallId: null,
		deadlineMs: 60_000,
		foregroundWindowMs: 0,
	});
	await waitForFile(shellPidFile);
	await waitForFile(childPidFile);
	const shellPid = Number(await readFile(shellPidFile, "utf8"));
	const childPid = Number(await readFile(childPidFile, "utf8"));
	assert.equal(shellPid > 1 && childPid > 1, true);
	assert.equal(processAlive(shellPid), true);
	assert.equal(processAlive(childPid), true);
	const cancelled = await owner.cancel(started.executionId, scope);
	assert.equal(cancelled.status, "cancelled");
	assert.equal(cancelled.exitCode, null);
	await waitForGone(shellPid);
	await waitForGone(childPid);
});

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
	} catch {
		return false;
	}
	try {
		// A killed orphan can stay a zombie until its new parent reaps it.
		return readFileSync(`/proc/${pid}/stat`, "utf8").split(" ")[2] !== "Z";
	} catch {
		return true;
	}
}

async function waitForGone(pid: number): Promise<void> {
	const started = Date.now();
	while (Date.now() - started < 5_000) {
		if (!processAlive(pid)) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`process ${pid} survived execution teardown`);
}

function runningView(): ShellExecutionView {
	return {
		executionId: "exec-fixed",
		owner: "pi-bash",
		status: "running",
		startedAt: 1,
		deadlineAt: 2,
		exitCode: null,
		output: "",
		truncated: false,
		toolCallId: "call",
		sessionId: "session",
		branchAnchor: "leaf",
		label: "Bash",
		commandPreview: "sleep 60",
		background: true,
		terminalAt: null,
		lastOutputAt: null,
	};
}

function toolContext(): ExtensionToolContext {
	return {
		mode: "tui",
		cwd: "/tmp",
		sessionManager: {
			getSessionId: () => "session",
			getLeafId: () => "leaf",
			getBranch: () => [{ id: "leaf" }],
			getSessionFile: () => undefined,
		},
	} as ExtensionToolContext;
}

function retainedTool(owner: ShellExecutionOwner): {
	description: string;
	promptGuidelines: string[];
	parameters: { properties: { waitSeconds: { description: string }; foregroundSeconds: { description: string } } };
	execute(toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: undefined, ctx: ExtensionToolContext): Promise<{
		content: Array<{ text: string }>;
		details: { exitCode?: number | null; status?: string };
		isError?: boolean;
	}>;
} {
	let tool: ReturnType<typeof retainedTool> | undefined;
	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => void>>();
	const pi = {
		getAllTools: () => [{ name: "bash", sourceInfo: { source: "builtin" } }],
		getActiveTools: () => ["bash"],
		getSettings: () => ({}),
		events: { emit: () => {}, on: () => () => {} },
		registerTool: (value: ReturnType<typeof retainedTool>) => { tool = value; },
		registerCommand: () => {},
		sendUserMessage: () => {},
		sendMessage: async () => {},
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
	};
	bindRetainedShell(pi as unknown as ExtensionAPI, owner);
	const ctx = { mode: "tui", sessionManager: { getSessionId: () => "session", getLeafId: () => "leaf", getBranch: () => [{ id: "leaf" }] } } as ExtensionContext;
	for (const handler of handlers.get("session_start") ?? []) handler({}, ctx);
	if (!tool) throw new Error("retained bash tool was not registered");
	return tool;
}
