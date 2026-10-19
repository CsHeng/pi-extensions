import assert from "node:assert/strict";
import { captureListOverlay } from "./helpers/list-overlay.ts";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAboveEditor } from "../extensions/shared/above-editor.ts";
import { createJobsUi, JOBS_LIST_PAGE_SIZE } from "../extensions/jobs-ui/index.ts";
import { formatJobDuration, jobRows, jobsRenderBudget } from "../extensions/jobs-ui/render.ts";
import { commandLabel, commandPreview, createShellExecutionOwner, type ShellExecutionView, type ShellScope } from "../extensions/retained-shell/execution.ts";
import { bindRetainedShell } from "../extensions/retained-shell/index.ts";
import {
	JOBS_VIEW_CHANGED_EVENT,
	JOBS_VIEW_EVENT,
	JOBS_VIEW_REQUEST_EVENT,
	JOBS_VIEW_VERSION,
	parseJobsViewReply,
	JOBS_MIN_VISIBLE_SUCCESS_MS,
	isVisibleBackgroundJob,
	registerJobsView,
	type JobsViewRecord,
	type JobsViewReply,
} from "../extensions/retained-shell/jobs-view.ts";

const shell = { shell: "/bin/sh", args: ["-c"] };
const scope: ShellScope = { sessionId: "session-a", branchAnchor: "leaf-a", branchIds: ["leaf-a"] };

async function scratch(): Promise<string> {
	const root = join(process.env.TMPDIR ?? tmpdir(), "extensions");
	await mkdir(root, { recursive: true });
	return mkdtemp(join(root, "jobs-ui-"));
}

function fakeChild() {
	const child = new EventEmitter() as EventEmitter & { pid: number; stdout: EventEmitter; stderr: EventEmitter; stdin: { on: () => void; end: (chunk: string) => void } | null };
	child.pid = 7;
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.stdin = null;
	return child;
}

function harness(mode = "tui", trusted = true) {
	const listeners = new Map<string, Array<(data: unknown) => void>>();
	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => void>>();
	const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
	const tools: string[] = ["bash"];
	const wakes: string[] = [];
	const timers: Array<{ ms: number; cb: () => void }> = [];
	let widget: unknown;
	let selects: string[][] = [];
	const events = {
		on(name: string, fn: (data: unknown) => void) {
			listeners.set(name, [...(listeners.get(name) ?? []), fn]);
			return () => listeners.set(name, (listeners.get(name) ?? []).filter((item) => item !== fn));
		},
		emit(name: string, data: unknown) { for (const fn of [...(listeners.get(name) ?? [])]) fn(data); },
	};
	const pi = {
		registerCommand(name: string, value: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) { commands.set(name, value.handler); },
		registerTool(tool: { name: string }) { tools.push(tool.name); },
		getActiveTools: () => tools,
		getAllTools: () => [{ name: "bash", sourceInfo: { source: "builtin" } }],
		getSettings: () => ({}),
		appendEntry() { throw new Error("model context"); },
		sendUserMessage() { wakes.push("user"); throw new Error("wake"); },
		sendMessage() { wakes.push("message"); throw new Error("wake"); },
		on(name: string, fn: (event: unknown, ctx: ExtensionContext) => void) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); },
		events,
	} as unknown as ExtensionAPI;
	const ctx = {
		mode,
		hasUI: true,
		isProjectTrusted: () => trusted,
		isIdle: () => true,
		hasPendingMessages: () => false,
		signal: undefined,
		cwd: "/tmp",
		sessionManager: {
			getSessionId: () => "session-a",
			getLeafId: () => "leaf-a",
			getBranch: () => [{ id: "leaf-a" }],
			getSessionFile: () => undefined,
		},
		ui: {
			setWidget(_key: string, value: unknown) { widget = value; },
			notify() {},
			custom: captureListOverlay(rows => { selects.push(rows); }),
			theme: undefined,
		},
	} as unknown as ExtensionContext;
	return {
		pi, ctx, commands, tools, events, wakes, timers, get widget() { return widget; }, get selects() { return selects; },
		setTimer(cb: () => void, ms: number) { const handle = { ms, cb }; timers.push(handle); return handle; },
		clearTimer(handle: unknown) { const index = timers.indexOf(handle as { ms: number; cb: () => void }); if (index >= 0) timers.splice(index, 1); },
		fire(name: string, next = ctx) { for (const fn of handlers.get(name) ?? []) fn({}, next); },
	};
}

function lines(widget: unknown, rows = 36, width = 80): string[] {
	return (widget as (tui: unknown) => { render(width: number): string[] })({ terminal: { rows } }).render(width);
}

function record(patch: Partial<JobsViewRecord> & Pick<JobsViewRecord, "executionId" | "status">): JobsViewRecord {
	return {
		label: "sleep",
		exitCode: patch.status === "running" ? null : 0,
		startedAt: 1_000,
		terminalAt: patch.status === "running" ? null : 6_000,
		lastOutputAt: null,
		...patch,
	};
}

test("owner metadata is a bounded executable label plus actual close and output times", async (t) => {
	assert.equal(commandLabel("sleep 30 --secret-arg"), "sleep");
	assert.equal(commandLabel("/usr/bin/curl https://example.test/secret-token"), "curl");
	assert.equal(commandLabel("SECRET=token sleep 1"), "Bash");
	assert.equal(commandLabel("echo hi && rm secret-file"), "Bash");
	assert.equal(commandLabel("printf '%s' secret-stdin"), "Bash");
	const dir = await scratch();
	const child = fakeChild();
	let clock = 1_000;
	let stops = 0;
	const events: unknown[] = [];
	const owner = createShellExecutionOwner({
		spawnSpec: () => shell,
		now: () => clock,
		launch: () => child as never,
		stop: () => { stops += 1; child.emit("close", null); },
		onEvent: event => events.push(event),
	});
	t.after(async () => { await owner.shutdown(); await rm(dir, { recursive: true, force: true }); });
	const started = await owner.start({
		command: "sleep 30 --secret-arg",
		cwd: dir,
		env: { ...process.env, SECRET_ENV: "env-secret-value" },
		sessionId: scope.sessionId,
		branchAnchor: scope.branchAnchor,
		toolCallId: "call-1",
		deadlineMs: 60_000,
		foregroundWindowMs: 0,
	});
	assert.equal(started.label, "sleep");
	assert.equal(started.terminalAt, null);
	assert.equal(started.lastOutputAt, null);
	assert.equal(started.exitCode, null);
	assert.equal(started.commandPreview, "sleep 30 --secret-arg", "human preview now includes bounded command arguments");
	assert.equal(started.background, true);
	assert.equal(JSON.stringify(events).includes("secret-arg"), false, "human preview must not enter persisted execution events");
	assert.equal(JSON.stringify(started).includes("env-secret-value"), false);
	assert.equal(owner.startCount, 1);
	clock = 2_000;
	child.stdout.emit("data", Buffer.from("hi"));
	assert.equal(owner.inspect(started.executionId, scope)?.lastOutputAt, 2_000);
	const before = owner.startCount;
	assert.equal(owner.list(scope).length, 1);
	assert.equal(owner.startCount, before);
	assert.equal(stops, 0);
	clock = 5_000;
	child.emit("close", 0);
	const closed = owner.inspect(started.executionId, scope);
	assert.equal(closed?.status, "exited");
	assert.equal(closed?.exitCode, 0);
	assert.equal(closed?.terminalAt, 5_000);
	assert.equal(closed?.lastOutputAt, 2_000);
	assert.notEqual(closed?.terminalAt, closed?.deadlineAt);
	const silent = fakeChild();
	const silentOwner = createShellExecutionOwner({ spawnSpec: () => shell, now: () => 8_000, launch: () => silent as never });
	t.after(async () => { await silentOwner.shutdown(); });
	const quiet = await silentOwner.start({
		command: "SECRET=token sleep 1",
		cwd: dir,
		env: process.env,
		sessionId: scope.sessionId,
		branchAnchor: scope.branchAnchor,
		toolCallId: null,
		deadlineMs: 60_000,
		foregroundWindowMs: 0,
	});
	assert.equal(quiet.label, "Bash");
	silent.emit("close", 2);
	const quietClosed = silentOwner.inspect(quiet.executionId, scope);
	assert.equal(quietClosed?.lastOutputAt, null);
	assert.equal(quietClosed?.exitCode, 2);
	assert.equal(JSON.stringify(quietClosed).includes("token"), false);
});

test("Jobs excludes foreground completions and keeps background work while the duration threshold is zero", async (t) => {
	const dir = await scratch();
	const child = fakeChild();
	const owner = createShellExecutionOwner({ spawnSpec: () => shell, launch: () => {
		queueMicrotask(() => child.emit("close", 0)); return child as never;
	}, stop: () => child.emit("close", null) });
	t.after(async () => { await owner.shutdown(); await rm(dir, { recursive: true, force: true }); });
	const completed = await owner.start({ command: "true", cwd: dir, env: process.env, ...scope, toolCallId: null, deadlineMs: 60_000, foregroundWindowMs: 5_000 });
	assert.equal(completed.status, "exited");
	assert.equal(completed.background, false);
	assert.equal(JOBS_MIN_VISIBLE_SUCCESS_MS, 0);
	assert.equal(isVisibleBackgroundJob(completed), false);
	const detached = { ...completed, background: true, startedAt: 0 };
	assert.equal(isVisibleBackgroundJob({ ...detached, status: "running", terminalAt: null, exitCode: null }), true);
	assert.equal(isVisibleBackgroundJob({ ...detached, terminalAt: 100 }), true);
	assert.equal(isVisibleBackgroundJob({ ...detached, terminalAt: 29_999 }, 30_000), false);
	assert.equal(isVisibleBackgroundJob({ ...detached, terminalAt: 30_000 }, 30_000), true);
	assert.equal(isVisibleBackgroundJob({ ...detached, terminalAt: 100, exitCode: 1 }), true);
	assert.equal(formatJobDuration(230), "230ms");
	assert.equal(commandPreview("mise exec -- python3 - <<'PY'\nprint('private body')"), "mise exec -- python3 - <<'PY'");
	assert.equal(commandPreview("TOKEN=private curl --password hidden https://example.test"), "TOKEN=… curl --password … https://example.test");
	const rendered = jobRows({ records: [record({ executionId: "exec_hidden-id", status: "exited", commandPreview: "mise exec -- " + "command ".repeat(30) })] }, 80, 4, 10_000).join("\n");
	assert.match(rendered, /Bash "mise exec/);
	assert.match(rendered.replace(/\u001b\[[0-9;]*m/g, ""), /…".*exited/);
	assert.doesNotMatch(rendered, /hidden-id/);
});

test("jobs query returns the current branch snapshot and does not control or wake execution", async (t) => {
	const dir = await scratch();
	const child = fakeChild();
	const calls = { start: 0, cancel: 0, renew: 0, wait: 0 };
	const owner = createShellExecutionOwner({ spawnSpec: () => shell, launch: () => child as never, now: () => 1_000, stop: () => { child.emit("close", null); } });
	const wrapped = {
		...owner,
		async start(...args: Parameters<typeof owner.start>) { calls.start += 1; return owner.start(...args); },
		async cancel(...args: Parameters<typeof owner.cancel>) { calls.cancel += 1; return owner.cancel(...args); },
		renew(...args: Parameters<typeof owner.renew>) { calls.renew += 1; return owner.renew(...args); },
		wait(...args: Parameters<typeof owner.wait>) { calls.wait += 1; return owner.wait(...args); },
	};
	const h = harness();
	const jobs = registerJobsView(h.pi, wrapped, () => "ready");
	jobs.bind(h.ctx);
	t.after(async () => { await owner.shutdown(); await rm(dir, { recursive: true, force: true }); });
	const started = await owner.start({
		command: "sleep 5",
		cwd: dir,
		env: process.env,
		sessionId: "session-a",
		branchAnchor: "leaf-a",
		toolCallId: null,
		deadlineMs: 60_000,
		foregroundWindowMs: 0,
	});
	await owner.start({
		command: "sleep 9",
		cwd: dir,
		env: process.env,
		sessionId: "session-a",
		branchAnchor: "other-leaf",
		toolCallId: null,
		deadlineMs: 60_000,
		foregroundWindowMs: 0,
	});
	const seen: JobsViewReply[] = [];
	h.events.on(JOBS_VIEW_EVENT, (data) => { const parsed = parseJobsViewReply(data); if (parsed.ok) seen.push(parsed.value); });
	h.events.emit(JOBS_VIEW_REQUEST_EVENT, { version: JOBS_VIEW_VERSION, requestId: "req-1" });
	assert.equal(seen.length, 1);
	assert.equal(seen[0]?.availability, "ready");
	assert.equal(seen[0]?.records?.length, 1);
	assert.equal(seen[0]?.records?.[0]?.executionId, started.executionId);
	assert.equal(seen[0]?.records?.[0]?.label, "sleep");
	assert.equal(JSON.stringify(seen[0]).includes("output"), false);
	assert.equal(calls.start, 0);
	assert.equal(calls.cancel, 0);
	assert.equal(calls.renew, 0);
	assert.equal(calls.wait, 0);
	assert.deepEqual(h.wakes, []);
	child.stdout.emit("data", Buffer.from("later"));
	const changed: unknown[] = [];
	h.events.on(JOBS_VIEW_CHANGED_EVENT, (data) => changed.push(data));
	child.stderr.emit("data", Buffer.from("more"));
	assert.equal(changed.length >= 1, true);
	assert.equal(JSON.stringify(changed).includes("later"), false);
});

test("jobs view sorts running jobs before stopped jobs and keeps start time ascending", () => {
	const h = harness();
	const view = (executionId: string, status: ShellExecutionView["status"], startedAt: number, background = true): ShellExecutionView => ({
		...record({ executionId, status, startedAt, terminalAt: status === "running" ? null : startedAt + 10, exitCode: status === "exited" ? 0 : null }),
		owner: "pi-bash", sessionId: "session-a", branchAnchor: "leaf-a", toolCallId: null,
		commandPreview: executionId, deadlineAt: 60_000, output: "", truncated: false, background,
	});
	const jobs = registerJobsView(h.pi, {
		list: () => [
			view("exec_stopped_late", "exited", 40),
			view("exec_running_late", "running", 30),
			view("exec_running_early", "running", 5),
			view("exec_stopped_early", "cancelled", 10),
			view("exec_foreground", "exited", 1, false),
		],
		subscribeDisplay: () => () => {},
	}, () => "ready");
	jobs.bind(h.ctx);
	const replies: JobsViewReply[] = [];
	h.events.on(JOBS_VIEW_EVENT, (data) => { const parsed = parseJobsViewReply(data); if (parsed.ok) replies.push(parsed.value); });
	h.events.emit(JOBS_VIEW_REQUEST_EVENT, { version: JOBS_VIEW_VERSION, requestId: "sort" });
	assert.deepEqual(replies[0]?.records?.map((item) => item.executionId), ["exec_running_early", "exec_running_late", "exec_stopped_early", "exec_stopped_late"]);
	jobs.dispose();
});

test("jobs list projection keeps same-scope background jobs and drops foreground work", async (t) => {
	const dir = await scratch();
	const children = new Map<string, ReturnType<typeof fakeChild>>();
	const owner = createShellExecutionOwner({
		spawnSpec: () => shell,
		now: () => 1_000,
		launch: (_spec, command) => {
			const child = fakeChild();
			children.set(command, child);
			if (command === "true-foreground") queueMicrotask(() => child.emit("close", 0));
			return child as never;
		},
		stop: () => { for (const child of children.values()) child.emit("close", null); },
	});
	const h = harness();
	const jobs = registerJobsView(h.pi, owner, () => "ready");
	jobs.bind(h.ctx);
	t.after(async () => { await owner.shutdown(); await rm(dir, { recursive: true, force: true }); });
	const running = await owner.start({ command: "sleep-visible", cwd: dir, env: process.env, ...scope, toolCallId: null, deadlineMs: 60_000, foregroundWindowMs: 0 });
	const foreground = await owner.start({ command: "true-foreground", cwd: dir, env: process.env, ...scope, toolCallId: null, deadlineMs: 60_000, foregroundWindowMs: 5_000 });
	const brief = await owner.start({ command: "true-brief", cwd: dir, env: process.env, ...scope, toolCallId: null, deadlineMs: 60_000, foregroundWindowMs: 0 });
	assert.equal(brief.background, true);
	children.get("true-brief")?.emit("close", 0);
	await owner.start({ command: "sleep-other", cwd: dir, env: process.env, sessionId: scope.sessionId, branchAnchor: "other-leaf", toolCallId: null, deadlineMs: 60_000, foregroundWindowMs: 0 });
	assert.equal(foreground.background, false);
	assert.equal(foreground.status, "exited");
	const seen: JobsViewReply[] = [];
	h.events.on(JOBS_VIEW_EVENT, (data) => { const parsed = parseJobsViewReply(data); if (parsed.ok) seen.push(parsed.value); });
	h.events.emit(JOBS_VIEW_REQUEST_EVENT, { version: JOBS_VIEW_VERSION, requestId: "req-all" });
	assert.equal(seen.length, 1);
	assert.deepEqual(seen[0]?.records?.map((item) => item.executionId), [running.executionId, brief.executionId]);
	assert.equal(seen[0]?.records?.some((item) => item.executionId === foreground.executionId), false);
	assert.equal(seen[0]?.records?.some((item) => item.commandPreview === "sleep-other"), false);
	assert.equal("retained" in (seen[0] ?? {}), false);
	assert.equal(parseJobsViewReply({ ...seen[0], retained: [brief] }).ok, false);
	assert.equal(h.wakes.length, 0);
});

test("background snapshots remain complete across display-size boundaries", () => {
	for (const count of [256, 257, 1001]) {
		const h = harness();
		const views: ShellExecutionView[] = Array.from({ length: count }, (_, index) => {
			const background = index < count - 8;
			return {
				...record({ executionId: `exec_${String(index).padStart(4, "0")}`, status: background ? "running" : "exited", exitCode: background ? null : 0, terminalAt: background ? null : 2_000, startedAt: index }),
				owner: "pi-bash", sessionId: "session-a", branchAnchor: "leaf-a", toolCallId: null,
				commandPreview: `command-${index}`, deadlineAt: 60_000, output: "", truncated: false, background,
			};
		});
		let queries = 0;
		const jobs = registerJobsView(h.pi, { list: () => { queries++; return views; }, subscribeDisplay: () => () => {} }, () => "ready");
		jobs.bind(h.ctx);
		const replies: JobsViewReply[] = [];
		h.events.on(JOBS_VIEW_EVENT, raw => {
			const parsed = parseJobsViewReply(raw);
			if (parsed.ok) replies.push(parsed.value);
		});
		h.events.emit(JOBS_VIEW_REQUEST_EVENT, { version: JOBS_VIEW_VERSION, requestId: `count-${count}` });
		assert.equal(queries, 1);
		const reply = replies.at(-1)!;
		assert.equal(reply.availability, "ready");
		assert.equal(reply.records?.length, count - 8);
		assert.equal(reply.records?.at(-1)?.executionId, `exec_${String(count - 9).padStart(4, "0")}`);
		assert.equal(parseJobsViewReply({ ...reply, records: [...reply.records!, { ...reply.records![0], status: "invalid" }] }).ok, false, "all records still require validation");
		jobs.dispose();
	}
});

test("unavailable sources are not rendered as zero running jobs", async () => {
	const absent = harness();
	const composer = createAboveEditor();
	createJobsUi({ composer, setTimer: absent.setTimer, clearTimer: absent.clearTimer, now: () => 10_000 })(absent.pi);
	absent.fire("session_start");
	assert.equal(absent.widget, undefined);
	absent.timers.find((timer) => timer.ms === 4_000)?.cb();
	assert.equal(absent.widget, undefined);

	const other = harness();
	const otherJobs = registerJobsView(other.pi, { list: () => [], subscribeDisplay: () => () => {} }, () => "other-owner");
	otherJobs.bind(other.ctx);
	const replies: JobsViewReply[] = [];
	other.events.on(JOBS_VIEW_EVENT, (data) => { const parsed = parseJobsViewReply(data); if (parsed.ok) replies.push(parsed.value); });
	other.events.emit(JOBS_VIEW_REQUEST_EVENT, { version: JOBS_VIEW_VERSION, requestId: "other" });
	assert.equal(replies[0]?.availability, "unavailable");
	assert.equal(replies[0]?.reason, "other-owner");
	assert.equal("records" in (replies[0] ?? {}), false);
	const otherUi = harness();
	const otherComposer = createAboveEditor();
	createJobsUi({ composer: otherComposer, setTimer: otherUi.setTimer, clearTimer: otherUi.clearTimer })(otherUi.pi);
	let requestId = "";
	otherUi.events.on(JOBS_VIEW_REQUEST_EVENT, (data) => { requestId = (data as { requestId: string }).requestId; });
	otherUi.fire("session_start");
	otherUi.events.emit(JOBS_VIEW_EVENT, { version: 1, requestId, ownerSessionId: "session-a", anchor: "leaf-a", generation: "1", availability: "unavailable", reason: "other-owner" });
	assert.equal(otherUi.widget, undefined);

	const untrusted = harness("tui", false);
	const untrustedJobs = registerJobsView(untrusted.pi, { list() { throw new Error("private store"); }, subscribeDisplay: () => () => {} }, () => "ready");
	untrustedJobs.bind(untrusted.ctx);
	const denied: JobsViewReply[] = [];
	untrusted.events.on(JOBS_VIEW_EVENT, (data) => { const parsed = parseJobsViewReply(data); if (parsed.ok) denied.push(parsed.value); });
	untrusted.events.emit(JOBS_VIEW_REQUEST_EVENT, { version: JOBS_VIEW_VERSION, requestId: "trust" });
	assert.equal(denied[0]?.reason, "untrusted");
	assert.equal(denied[0]?.availability, "unavailable");
});

test("foreign and stale replies are not an empty local jobs list", () => {
	const h = harness();
	const composer = createAboveEditor();
	createJobsUi({ composer, setTimer: h.setTimer, clearTimer: h.clearTimer, now: () => 20_000 })(h.pi);
	const requestIds: string[] = [];
	h.events.on(JOBS_VIEW_REQUEST_EVENT, (data) => requestIds.push((data as { requestId: string }).requestId));
	h.fire("session_start");
	const current = requestIds.at(-1)!;
	h.events.emit(JOBS_VIEW_EVENT, { version: 1, requestId: current, ownerSessionId: "session-a", anchor: "leaf-a", generation: "9", availability: "ready", records: [record({ executionId: "exec_ready1111", status: "running", startedAt: 1_000, terminalAt: null })] });
	assert.match(lines(h.widget).join("\n"), /1 running \/ 1 total/);
	h.events.emit(JOBS_VIEW_CHANGED_EVENT, { version: 1, generation: "9" });
	const next = requestIds.at(-1)!;
	h.events.emit(JOBS_VIEW_EVENT, { version: 1, requestId: next, ownerSessionId: "other-session", anchor: "leaf-a", generation: "9", availability: "ready", records: [] });
	assert.equal(h.widget, undefined);
	h.events.emit(JOBS_VIEW_EVENT, { version: 1, requestId: current, ownerSessionId: "session-a", anchor: "leaf-a", generation: "4", availability: "ready", records: [record({ executionId: "exec_ready2222", status: "running", startedAt: 1_000, terminalAt: null })] });
	h.fire("session_start");
	const again = requestIds.at(-1)!;
	h.events.emit(JOBS_VIEW_EVENT, { version: 1, requestId: again, ownerSessionId: "session-a", anchor: "leaf-a", generation: "4", availability: "ready", records: [record({ executionId: "exec_ready2222", status: "running", startedAt: 1_000, terminalAt: null })] });
	h.events.emit(JOBS_VIEW_CHANGED_EVENT, { version: 1, generation: "4" });
	const staleId = requestIds.at(-1)!;
	h.events.emit(JOBS_VIEW_EVENT, { version: 1, requestId: staleId, ownerSessionId: "session-a", anchor: "leaf-a", generation: "5", availability: "ready", records: [] });
	assert.equal(h.widget, undefined);
	h.events.emit(JOBS_VIEW_CHANGED_EVENT, { version: 1, generation: "4" });
	const leafId = requestIds.at(-1)!;
	h.events.emit(JOBS_VIEW_EVENT, { version: 1, requestId: leafId, ownerSessionId: "session-a", anchor: "other-leaf", generation: "4", availability: "ready", records: [] });
	assert.equal(h.widget, undefined);
});

test("collapsed and expanded rows keep exact facts and freeze terminal duration", () => {
	assert.equal(formatJobDuration(723_000), "12m03s");
	assert.equal(formatJobDuration(null), "unknown");
	const now = 10_000_000;
	const records = [
		record({ executionId: "exec_aaaa1111", status: "running", startedAt: now - 723_000, terminalAt: null, lastOutputAt: now - 4_000 }),
		record({ executionId: "exec_bbbb1111", status: "exited", exitCode: 0, startedAt: 0, terminalAt: 5_000, lastOutputAt: null }),
		record({ executionId: "exec_cccc2222", status: "exited", exitCode: 2, startedAt: 0, terminalAt: 5_000, lastOutputAt: 1_000 }),
		record({ executionId: "exec_dddd3333", status: "interrupted", exitCode: null, startedAt: 0, terminalAt: 2_000, lastOutputAt: null }),
	];
	const folded = jobRows({ records }, 80, 4, now, undefined, { folded: true });
	assert.equal(folded.length, 1);
	assert.match(folded[0]!, /1 running \/ 4 total/);
	assert.match(folded[0]!, /longest 12m03s/);
	assert.match(folded[0]!, /failed/);
	assert.match(folded[0]!, /interrupted/);
	assert.match(folded[0]!, /!/);
	const expanded = jobRows({ records }, 100, 8, now).join("\n");
	assert.match(expanded, /Bash "sleep"  running  12m03s  output 4s/);
	assert.doesNotMatch(expanded, /a1111[^\n]*exit/);
	assert.match(expanded, /Bash "sleep"  exited  5s  no output  exit 0/);
	assert.doesNotMatch(expanded, /accepted|stalled|success/);
	assert.match(expanded, /Bash "sleep"  exited  5s  output 4s  exit 2/);
	assert.match(expanded, /Bash "sleep"  interrupted  2s  no output  exit unknown/);
	assert.doesNotMatch(expanded, /2h/);
	const knownEmpty = jobRows({ records: [] }, 80, 2, now, undefined, { folded: true });
	assert.match(knownEmpty[0]!, /0 running \/ 0 total/);
	assert.doesNotMatch(knownEmpty[0]!, /unavailable|!/);
	const missing = jobRows({ unavailable: "other-owner" }, 80, 4, now);
	assert.match(missing[0]!, /unavailable · other-owner/);
	assert.doesNotMatch(missing[0]!, /0 running/);
});

test("hide survives fact updates and list reaches rows that do not fit", async () => {
	const h = harness();
	const composer = createAboveEditor();
	createJobsUi({ composer, setTimer: h.setTimer, clearTimer: h.clearTimer, now: () => 50_000 })(h.pi);
	h.fire("session_start");
	const ids: string[] = [];
	h.events.on(JOBS_VIEW_REQUEST_EVENT, (data) => ids.push((data as { requestId: string }).requestId));
	h.fire("session_start");
	const records = [1, 2, 3, 4].map((item) => record({ executionId: `exec_job${item}aaaa`, label: `tool${item}`, status: "exited", exitCode: 0, startedAt: item, terminalAt: item + 1 }));
	h.events.emit(JOBS_VIEW_EVENT, { version: 1, requestId: ids.at(-1), ownerSessionId: "session-a", anchor: "leaf-a", generation: "3", availability: "ready", records });
	const beforeExpand = h.selects.length;
	await h.commands.get("jobs-ui")!("expand", h.ctx);
	assert.equal(h.selects.length, beforeExpand);
	assert.match(lines(h.widget, 36, 80).join("\n"), /tool1/);
	assert.match(lines(h.widget, 36, 80)[0]!, /▾/);
	const shown = lines(h.widget, 10, 20);
	assert.match(shown.join("\n"), /Jobs/);
	assert.equal(shown.filter(Boolean).length, 1);
	assert.equal(h.wakes.length, 0);
	await h.commands.get("jobs-ui")!("hide", h.ctx);
	assert.equal(h.widget, undefined);
	h.events.emit(JOBS_VIEW_CHANGED_EVENT, { version: 1, generation: "3" });
	h.events.emit(JOBS_VIEW_EVENT, { version: 1, requestId: ids.at(-1), ownerSessionId: "session-a", anchor: "leaf-a", generation: "3", availability: "ready", records: [...records, record({ executionId: "exec_extra9999", label: "extra", status: "running", startedAt: 1, terminalAt: null })] });
	assert.equal(h.widget, undefined);
	await h.commands.get("jobs-ui")!("show", h.ctx);
	assert.match(lines(h.widget, 36, 80).join("\n"), /1 running \/ 5 total/);
	assert.match(lines(h.widget, 36, 80)[0]!, /▾/);
	assert.match(lines(h.widget, 36, 80).join("\n"), /tool1/);
	await h.commands.get("jobs-ui")!("list", h.ctx);
	assert.match(h.selects.at(-1)!.join("\n"), /extra/);
	assert.match(lines(h.widget, 36, 80)[0]!, /▾/);
	assert.match(lines(h.widget, 36, 80).join("\n"), /tool1/);
	await h.commands.get("jobs-ui")!("collapse", h.ctx);
	await h.commands.get("jobs-ui")!("hide", h.ctx);
	await h.commands.get("jobs-ui")!("show", h.ctx);
	assert.equal(lines(h.widget, 36, 80).filter(Boolean).length, 1);
	assert.match(lines(h.widget, 36, 80)[0]!, /▸/);
	assert.equal(jobsRenderBudget(10), 1);
	assert.ok(jobsRenderBudget(36) < 12);
});

test("jobs list shows the same background jobs as the bottom section without changing it", async () => {
	const h = harness();
	createJobsUi({ composer: createAboveEditor(), setTimer: h.setTimer, clearTimer: h.clearTimer, now: () => 50_000 })(h.pi);
	const ids: string[] = [];
	h.events.on(JOBS_VIEW_REQUEST_EVENT, (data) => ids.push((data as { requestId: string }).requestId));
	h.fire("session_start");
	const visible = record({ executionId: "exec_visible11", status: "running", label: "visible", startedAt: 1_000, terminalAt: null, commandPreview: "sleep-visible" });
	const brief = record({ executionId: "exec_brief0001", status: "exited", label: "brief", commandPreview: "true-brief", startedAt: 1_000, terminalAt: 1_100 });
	h.events.emit(JOBS_VIEW_EVENT, {
		version: 1, requestId: ids.at(-1), ownerSessionId: "session-a", anchor: "leaf-a", generation: "1", availability: "ready",
		records: [visible, brief],
	});
	const collapsed = lines(h.widget, 36, 80).join("\n");
	assert.match(collapsed, /1 running \/ 2 total/);
	assert.doesNotMatch(collapsed, /true-brief|sleep-visible/);
	assert.match(lines(h.widget, 36, 80)[0]!, /▸/);
	const requests = ids.length;
	await h.commands.get("jobs-ui")!("list", h.ctx);
	const overlay = h.selects.at(-1)!.join("\n");
	assert.match(overlay, /true-brief/);
	assert.match(overlay, /sleep-visible/);
	assert.equal(ids.length, requests);
	assert.match(lines(h.widget, 36, 80)[0]!, /▸/);
	assert.doesNotMatch(lines(h.widget, 36, 80).join("\n"), /true-brief/);
	await h.commands.get("jobs-ui")!("expand", h.ctx);
	assert.match(lines(h.widget, 36, 80).join("\n"), /sleep-visible/);
	assert.match(lines(h.widget, 36, 80).join("\n"), /true-brief/);
	await h.commands.get("jobs-ui")!("list", h.ctx);
	assert.match(lines(h.widget, 36, 80)[0]!, /▾/);
	assert.match(lines(h.widget, 36, 80).join("\n"), /sleep-visible/);
	await h.commands.get("jobs-ui")!("hide", h.ctx);
	assert.equal(h.widget, undefined);
	await h.commands.get("jobs-ui")!("list", h.ctx);
	assert.equal(h.widget, undefined);
	assert.match(h.selects.at(-1)!.join("\n"), /true-brief/);
	assert.equal(h.wakes.length, 0);
});

function clickHeader(widget: unknown, y = 0, mode: "fullscreen" | "regular" = "fullscreen") {
	const view = (widget as (tui: unknown) => { render(width: number): string[]; handleMouse?(event: unknown): { focus?: boolean } | undefined })({ mode, terminal: { rows: 36 } });
	view.render(80);
	view.handleMouse?.({ type: "press", button: "left", x: 1, y, width: 80, height: 8 });
	return view.handleMouse?.({ type: "click", button: "left", x: 1, y, width: 80, height: 8 });
}

test("jobs list pages through every background job without dropping later rows", async () => {
	const h = harness();
	const records = Array.from({ length: 1001 }, (_, index) => record({ executionId: `exec_${index}`, status: "running", commandPreview: index === 1000 ? "last-background-job" : `command-${index}` }));
	let firstPage = "";
	let overlayRows: string[] = [];
	h.ctx.ui.custom = async factory => {
		const component = await factory({ terminal: { rows: 120, columns: 160 }, requestRender() {} } as never, { fg: (_color: string, text: string) => text } as never, {} as never, () => {});
		firstPage = component.render(160).join("\n");
		const pages = Math.ceil(records.length / JOBS_LIST_PAGE_SIZE);
		for (let index = 1; index < pages; index++) component.handleInput?.("pageDown");
		overlayRows = component.render(160);
		return undefined as never;
	};
	createJobsUi({ composer: createAboveEditor(), setTimer: h.setTimer, clearTimer: h.clearTimer })(h.pi);
	const ids: string[] = [];
	h.events.on(JOBS_VIEW_REQUEST_EVENT, data => ids.push((data as { requestId: string }).requestId));
	h.fire("session_start");
	h.events.emit(JOBS_VIEW_EVENT, {
		version: 1, requestId: ids.at(-1), ownerSessionId: "session-a", anchor: "leaf-a", generation: "1", availability: "ready",
		records,
	});
	await h.commands.get("jobs-ui")!("list", h.ctx);
	assert.doesNotMatch(firstPage, /last-background-job/);
	assert.match(overlayRows.join("\n"), /last-background-job/);
	assert.match(overlayRows.join("\n"), /1001–1001 of 1001/);
	h.fire("session_shutdown");
});

test("fullscreen Jobs header click toggles inline and does not open a dialog", async () => {
	const h = harness();
	createJobsUi({ composer: createAboveEditor(), setTimer: h.setTimer, clearTimer: h.clearTimer, now: () => 50_000 })(h.pi);
	const ids: string[] = [];
	h.events.on(JOBS_VIEW_REQUEST_EVENT, (data) => ids.push((data as { requestId: string }).requestId));
	h.fire("session_start");
	h.events.emit(JOBS_VIEW_EVENT, { version: 1, requestId: ids.at(-1), ownerSessionId: "session-a", anchor: "leaf-a", generation: "1", availability: "ready", records: [record({ executionId: "exec_click1111", status: "running", startedAt: 1_000, terminalAt: null, lastOutputAt: 2_000 })] });
	assert.equal(lines(h.widget, 36, 80).filter(Boolean).length, 1);
	assert.match(lines(h.widget, 36, 80)[0]!, /▸/);
	const pressed = clickHeader(h.widget);
	assert.equal(pressed?.focus, undefined);
	assert.equal(h.selects.length, 0);
	assert.match(lines(h.widget, 36, 80).join("\n"), /Bash "sleep"/);
	assert.match(lines(h.widget, 36, 80)[0]!, /▾/);
	clickHeader(h.widget, 1);
	assert.match(lines(h.widget, 36, 80).join("\n"), /Bash "sleep"/);
	clickHeader(h.widget);
	assert.equal(h.selects.length, 0);
	assert.equal(lines(h.widget, 36, 80).filter(Boolean).length, 1);
	assert.match(lines(h.widget, 36, 80)[0]!, /▸/);
	clickHeader(h.widget, 0, "regular");
	assert.equal(h.selects.length, 0);
	assert.equal(lines(h.widget, 36, 80).filter(Boolean).length, 1);
	assert.equal(h.wakes.length, 0);
});

test("running timer redraw keeps folded and hidden choices", async () => {
	let now = 20_000;
	const h = harness();
	createJobsUi({ composer: createAboveEditor(), now: () => now, setTimer: h.setTimer, clearTimer: h.clearTimer })(h.pi);
	const ids: string[] = [];
	h.events.on(JOBS_VIEW_REQUEST_EVENT, (data) => ids.push((data as { requestId: string }).requestId));
	h.fire("session_start");
	h.events.emit(JOBS_VIEW_EVENT, { version: 1, requestId: ids.at(-1), ownerSessionId: "session-a", anchor: "leaf-a", generation: "1", availability: "ready", records: [record({ executionId: "exec_tick1111", status: "running", startedAt: 1_000, terminalAt: null })] });
	assert.match(lines(h.widget, 36, 80)[0]!, /▸/);
	assert.match(lines(h.widget, 36, 80)[0]!, /longest 19s/);
	now = 25_000;
	h.timers.find((timer) => timer.ms === 1_000)?.cb();
	assert.equal(lines(h.widget, 36, 80).filter(Boolean).length, 1);
	assert.match(lines(h.widget, 36, 80)[0]!, /▸/);
	assert.match(lines(h.widget, 36, 80)[0]!, /longest 24s/);
	assert.equal(h.selects.length, 0);
	await h.commands.get("jobs-ui")!("expand", h.ctx);
	assert.match(lines(h.widget, 36, 80)[0]!, /▾/);
	assert.match(lines(h.widget, 36, 80).join("\n"), /24s/);
	now = 30_000;
	h.timers.find((timer) => timer.ms === 1_000)?.cb();
	assert.match(lines(h.widget, 36, 80)[0]!, /▾/);
	assert.match(lines(h.widget, 36, 80).join("\n"), /29s/);
	assert.equal(h.selects.length, 0);
	await h.commands.get("jobs-ui")!("hide", h.ctx);
	now = 40_000;
	assert.equal(h.widget, undefined);
	for (const timer of h.timers.filter((item) => item.ms === 1_000)) timer.cb();
	assert.equal(h.widget, undefined);
	await h.commands.get("jobs-ui")!("show", h.ctx);
	assert.match(lines(h.widget, 36, 80)[0]!, /▾/);
	assert.match(lines(h.widget, 36, 80).join("\n"), /39s/);
});

test("elapsed redraw stops when nothing visible is running, and headless mounts nothing", async () => {
	const h = harness();
	const composer = createAboveEditor();
	createJobsUi({ composer, setTimer: h.setTimer, clearTimer: h.clearTimer, now: () => 9_000 })(h.pi);
	const ids: string[] = [];
	h.events.on(JOBS_VIEW_REQUEST_EVENT, (data) => ids.push((data as { requestId: string }).requestId));
	h.fire("session_start");
	h.events.emit(JOBS_VIEW_EVENT, { version: 1, requestId: ids.at(-1), ownerSessionId: "session-a", anchor: "leaf-a", generation: "1", availability: "ready", records: [record({ executionId: "exec_run1111", status: "running", startedAt: 1_000, terminalAt: null })] });
	assert.equal(h.timers.some((timer) => timer.ms === 1_000), true);
	await h.commands.get("jobs-ui")!("hide", h.ctx);
	assert.equal(h.timers.some((timer) => timer.ms === 1_000), false);
	await h.commands.get("jobs-ui")!("show", h.ctx);
	assert.equal(h.timers.some((timer) => timer.ms === 1_000), true);
	h.events.emit(JOBS_VIEW_CHANGED_EVENT, { version: 1, generation: "1" });
	h.events.emit(JOBS_VIEW_EVENT, { version: 1, requestId: ids.at(-1), ownerSessionId: "session-a", anchor: "leaf-a", generation: "1", availability: "ready", records: [record({ executionId: "exec_run1111", status: "exited", exitCode: 0, startedAt: 1_000, terminalAt: 4_000 })] });
	assert.equal(h.timers.some((timer) => timer.ms === 1_000), false);
	h.fire("session_shutdown");
	assert.equal(h.widget, undefined);
	h.events.emit(JOBS_VIEW_EVENT, { version: 1, requestId: "after-shutdown", ownerSessionId: "session-a", anchor: "leaf-a", generation: "1", availability: "ready", records: [record({ executionId: "exec_run1111", status: "running", startedAt: 1_000, terminalAt: null })] });
	assert.equal(h.widget, undefined);
	assert.equal(h.timers.length, 0);

	for (const mode of ["print", "json", "rpc"]) {
		const headless = harness(mode);
		const headlessComposer = createAboveEditor();
		createJobsUi({ composer: headlessComposer, setTimer: headless.setTimer, clearTimer: headless.clearTimer })(headless.pi);
		headless.fire("session_start");
		assert.equal(headless.widget, undefined);
		assert.deepEqual(headlessComposer.slots(), []);
		assert.deepEqual(headless.tools, ["bash"]);
		await headless.commands.get("jobs-ui")!("expand", headless.ctx);
		assert.equal(headless.selects.length, 0);
		assert.equal(headless.widget, undefined);
	}
});

test("print and another bash owner do not become an empty retained jobs list", () => {
	for (const item of [
		{ mode: "print", source: "builtin", reason: "unreachable" },
		{ mode: "tui", source: "extension", reason: "other-owner" },
	]) {
		const tools: string[] = [];
		const listeners = new Map<string, Array<(data: unknown) => void>>();
		const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => void>>();
		const pi = {
			getAllTools: () => [{ name: "bash", sourceInfo: { source: item.source } }],
			getActiveTools: () => ["bash"],
			getSettings: () => ({}),
			events: {
				on(name: string, fn: (data: unknown) => void) { listeners.set(name, [...(listeners.get(name) ?? []), fn]); return () => {}; },
				emit(name: string, data: unknown) { for (const fn of listeners.get(name) ?? []) fn(data); },
			},
			registerTool(tool: { name: string }) { tools.push(tool.name); },
			registerCommand() {},
			sendUserMessage() { throw new Error("wake"); },
			sendMessage() { throw new Error("wake"); },
			on(name: string, fn: (event: unknown, ctx: ExtensionContext) => void) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); },
		};
		const owner = createShellExecutionOwner({ spawnSpec: () => shell, launch: () => { throw new Error("spawned"); } });
		bindRetainedShell(pi as unknown as ExtensionAPI, owner);
		const ctx = { mode: item.mode, hasUI: true, isProjectTrusted: () => true, sessionManager: { getSessionId: () => "session-a", getLeafId: () => "leaf-a", getBranch: () => [{ id: "leaf-a" }] } } as ExtensionContext;
		for (const handler of handlers.get("session_start") ?? []) handler({}, ctx);
		const replies: JobsViewReply[] = [];
		pi.events.emit(JOBS_VIEW_REQUEST_EVENT, { version: JOBS_VIEW_VERSION, requestId: "late" });
		pi.events.on(JOBS_VIEW_EVENT, (data) => { const parsed = parseJobsViewReply(data); if (parsed.ok) replies.push(parsed.value); });
		pi.events.emit(JOBS_VIEW_REQUEST_EVENT, { version: JOBS_VIEW_VERSION, requestId: "late" });
		assert.equal(replies.at(-1)?.availability, "unavailable");
		assert.equal(replies.at(-1)?.reason, item.reason);
		assert.equal(tools.includes("bash"), item.mode === "tui" && item.source === "builtin");
		assert.equal(owner.startCount, 0);
	}
});
