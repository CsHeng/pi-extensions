import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { EventEmitter } from "node:events";
import { createShellDelivery } from "../extensions/retained-shell/delivery.ts";
import { createShellExecutionOwner, type ShellExecutionEvent, type ShellScope } from "../extensions/retained-shell/execution.ts";
import { bindRetainedShell } from "../extensions/retained-shell/index.ts";
import { shellClaim } from "../extensions/retained-shell/policy.ts";

const shell = { shell: "/bin/sh", args: ["-c"] };
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
		bindRetainedShell(pi as unknown as ExtensionAPI, createShellExecutionOwner({ spawnSpec: () => shell }));
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
	const owner = createShellExecutionOwner({ spawnSpec: () => shell, onEvent: (event) => { events.push(event); } });
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
	const owner = createShellExecutionOwner({ spawnSpec: () => shell });
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
	const owner = createShellExecutionOwner({ spawnSpec: () => shell });
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
	const owner = createShellExecutionOwner({ spawnSpec: () => shell });
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
	const owner = createShellExecutionOwner({ spawnSpec: () => shell, maxOutputBytes: 32 });
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

test("observer failure and late output do not settle before the process closes", async (t) => {
	const dir = await scratch();
	const child = new EventEmitter() as EventEmitter & { pid: number; stdout: EventEmitter; stderr: EventEmitter; stdin: null };
	child.pid = 4242;
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.stdin = null;
	const owner = createShellExecutionOwner({
		spawnSpec: () => shell,
		launch: () => child as never,
		stop: () => {
			child.stdout.emit("data", Buffer.from("late\n"));
			child.emit("close", null);
		},
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
});

test("controls stay in one session branch and a switch interrupts only the old owner", async (t) => {
	const dir = await scratch();
	const owner = createShellExecutionOwner({ spawnSpec: () => shell });
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

test("terminal retention is bounded and a dropped wake stays inspectable", () => {
	const delivery = createShellDelivery();
	const event = (id: string, status = "exited"): ShellExecutionEvent => ({
		version: 1, executionId: id, owner: "pi-bash", sessionId: "session", branchAnchor: "leaf", toolCallId: "call", phase: "exited", status: status as "exited", exitCode: 0, deadlineAt: null, truncated: false, outputTail: id, notification: "idle-wake-or-next-request",
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

test("terminal records stay bounded", async (t) => {
	const dir = await scratch();
	const owner = createShellExecutionOwner({ spawnSpec: () => shell, maxTerminalRecords: 2 });
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
	assert.equal(owner.inspect(ids[0]!, unscoped), undefined);
	assert.equal(owner.inspect(ids[2]!, unscoped)?.status, "exited");
});
