import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import agentBark from "../extensions/agent-bark.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown>;

const USER_START = { messageType: "user" } as const;
// Pi 1.2 fires before_agent_start for an idle `pi.sendMessage(..., { triggerTurn: true })`
// run too, and reports it as a custom message rather than a user prompt.
const CUSTOM_START = { messageType: "custom" } as const;
const SETTLED = { aborted: false } as const;

async function fixture(t: TestContext, childMarker?: string, installHook = true) {
	const home = await mkdtemp(join(tmpdir(), "pi-agent-bark-test-"));
	const previousHome = process.env.HOME;
	const previousMarker = process.env.CSHENG_SUBAGENT_CHILD;
	t.after(async () => {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousMarker === undefined) delete process.env.CSHENG_SUBAGENT_CHILD;
		else process.env.CSHENG_SUBAGENT_CHILD = previousMarker;
		await rm(home, { recursive: true, force: true });
	});
	process.env.HOME = home;
	if (childMarker === undefined) delete process.env.CSHENG_SUBAGENT_CHILD;
	else process.env.CSHENG_SUBAGENT_CHILD = childMarker;

	if (installHook) {
		const hookDirectory = join(home, ".local", "bin");
		await mkdir(hookDirectory, { recursive: true });
		await writeFile(join(hookDirectory, "agent-bark-hook"), `#!/bin/sh
set -eu
[ "$1" = pi ]
cat >> "$HOME/events.jsonl"
printf '\\n' >> "$HOME/events.jsonl"
`, { mode: 0o700 });
	}

	const handlers = new Map<string, Handler>();
	agentBark({ on(name: string, handler: Handler) { handlers.set(name, handler); } } as ExtensionAPI);
	const entries: unknown[] = [];
	const ctx = {
		mode: "json",
		cwd: "/fixture/project",
		sessionManager: {
			getSessionId: () => "main-session",
			getBranch: () => entries,
		},
	} as unknown as ExtensionContext;
	const start = (event: unknown = USER_START) => handlers.get("before_agent_start")!(event, ctx);
	const settle = (event: unknown = SETTLED) => handlers.get("agent_settled")!(event, ctx);
	return {
		home, handlers, entries, ctx, start, settle,
		async events(): Promise<Array<Record<string, string>>> {
			try {
				const content = (await readFile(join(home, "events.jsonl"), "utf8")).trim();
				return content === "" ? [] : content.split("\n").map(line => JSON.parse(line));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
				throw error;
			}
		},
	};
}

test("subagents register no Bark handlers and never start the notification hook", async t => {
	const state = await fixture(t, "1");
	assert.equal(state.handlers.size, 0);
	assert.deepEqual(await state.events(), []);
});

for (const childMarker of [undefined, "0"]) {
	test(`main-agent user start and settled events still reach the hook (marker ${childMarker ?? "unset"})`, async t => {
		const state = await fixture(t, childMarker);
		assert.deepEqual([...state.handlers.keys()], ["before_agent_start", "agent_settled", "session_start"]);
		await state.start();
		const message = "Complete\n" + "x".repeat(350);
		state.entries.push({ type: "message", message: {
			role: "assistant", stopReason: "stop", content: [{ type: "text", text: message }],
		} });
		await state.settle();
		const events = await state.events();
		assert.deepEqual(events.map(event => event.hook_event_name), ["UserPromptSubmit", "Stop"]);
		const settled = events[1];
		assert.ok(settled);
		assert.equal(settled.last_assistant_message, message.replace(/\n/g, " ").slice(0, 300));
		assert.equal(settled.session_id, "main-session");
		assert.equal(settled.cwd, "/fixture/project");
	});
}

test("Pi 1.2 custom-triggered runs stay silent at start and settlement", async t => {
	const state = await fixture(t);
	await state.start(CUSTOM_START);
	state.entries.push({ type: "message", message: {
		role: "assistant", stopReason: "stop", content: [{ type: "text", text: "internal wake reply" }],
	} });
	await state.settle();
	assert.deepEqual(await state.events(), []);
});

test("a custom run's failure does not leak a StopFailure", async t => {
	const state = await fixture(t);
	await state.start(CUSTOM_START);
	state.entries.push({ type: "message", message: {
		role: "assistant", stopReason: "error", content: [{ type: "text", text: "internal failure" }],
	} });
	await state.settle();
	assert.deepEqual(await state.events(), []);
});

test("a completed user run does not leak eligibility into the next custom run", async t => {
	const state = await fixture(t);
	await state.start();
	state.entries.push({ type: "message", message: {
		role: "assistant", stopReason: "stop", content: [{ type: "text", text: "user reply" }],
	} });
	await state.settle();
	assert.deepEqual((await state.events()).map(event => event.hook_event_name), ["UserPromptSubmit", "Stop"]);

	// The next run is internal. Its start must reclassify the run, so neither its start
	// nor its settlement may reuse the previous user run's eligibility.
	state.entries.push({ type: "message", message: {
		role: "assistant", stopReason: "stop", content: [{ type: "text", text: "subagent wake" }],
	} });
	await state.start(CUSTOM_START);
	await state.settle();
	assert.deepEqual((await state.events()).map(event => event.hook_event_name), ["UserPromptSubmit", "Stop"]);
});

test("an unsettled user run does not leak its eligibility into a later custom run", async t => {
	const state = await fixture(t);
	await state.start();
	assert.deepEqual((await state.events()).map(event => event.hook_event_name), ["UserPromptSubmit"]);

	// The user run never settles (for example the session was interrupted). The next run is
	// internal, and its start must reclassify before its settlement is considered.
	state.entries.push({ type: "message", message: {
		role: "assistant", stopReason: "stop", content: [{ type: "text", text: "subagent wake" }],
	} });
	await state.start(CUSTOM_START);
	await state.settle();
	assert.deepEqual((await state.events()).map(event => event.hook_event_name), ["UserPromptSubmit"]);
});

test("a silent custom run does not suppress the next user run", async t => {
	const state = await fixture(t);
	await state.start(CUSTOM_START);
	await state.settle();
	assert.deepEqual(await state.events(), []);

	state.entries.push({ type: "message", message: {
		role: "assistant", stopReason: "stop", content: [{ type: "text", text: "user reply" }],
	} });
	await state.start();
	await state.settle();
	assert.deepEqual((await state.events()).map(event => event.hook_event_name), ["UserPromptSubmit", "Stop"]);
});

test("main-agent failure preserves the shared hook's StopFailure event", async t => {
	const state = await fixture(t);
	await state.start();
	state.entries.push({ type: "message", message: {
		role: "assistant", stopReason: "error", content: [{ type: "text", text: "Failed" }],
	} });
	await state.settle();
	const [failure] = (await state.events()).slice(1);
	assert.ok(failure);
	assert.equal(failure.hook_event_name, "StopFailure");
});

test("a session change drops a pending user-run settlement", async t => {
	const state = await fixture(t);
	await state.start();
	assert.deepEqual((await state.events()).map(event => event.hook_event_name), ["UserPromptSubmit"]);
	state.handlers.get("session_start")!({}, state.ctx);
	await state.settle();
	assert.deepEqual((await state.events()).map(event => event.hook_event_name), ["UserPromptSubmit"]);
});

test("an absent user-owned notification hook does not fail the main agent", async t => {
	const state = await fixture(t, undefined, false);
	await state.start();
	await state.settle();
});
