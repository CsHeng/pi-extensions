import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import agentBark from "../extensions/agent-bark.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown>;

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
	return {
		home, handlers, entries, ctx,
		async events(): Promise<Array<Record<string, string>>> {
			return (await readFile(join(home, "events.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
		},
	};
}

test("subagents register no Bark handlers and never start the notification hook", async t => {
	const state = await fixture(t, "1");
	assert.equal(state.handlers.size, 0);
	await assert.rejects(readFile(join(state.home, "events.jsonl")), { code: "ENOENT" });
});

for (const childMarker of [undefined, "0"]) {
	test(`main-agent start and settled events still reach the hook (marker ${childMarker ?? "unset"})`, async t => {
		const state = await fixture(t, childMarker);
		assert.deepEqual([...state.handlers.keys()], ["before_agent_start", "agent_settled"]);
		await state.handlers.get("before_agent_start")!({}, state.ctx);
		const message = "Complete\n" + "x".repeat(350);
		state.entries.push({ type: "message", message: {
			role: "assistant", stopReason: "stop", content: [{ type: "text", text: message }],
		} });
		await state.handlers.get("agent_settled")!({}, state.ctx);
		const events = await state.events();
		assert.deepEqual(events.map(event => event.hook_event_name), ["UserPromptSubmit", "Stop"]);
		const settled = events[1];
		assert.ok(settled);
		assert.equal(settled.last_assistant_message, message.replace(/\n/g, " ").slice(0, 300));
		assert.equal(settled.session_id, "main-session");
		assert.equal(settled.cwd, "/fixture/project");
	});
}

test("main-agent failure preserves the shared hook's StopFailure event", async t => {
	const state = await fixture(t);
	state.entries.push({ type: "message", message: {
		role: "assistant", stopReason: "error", content: [{ type: "text", text: "Failed" }],
	} });
	await state.handlers.get("agent_settled")!({}, state.ctx);
	const [failure] = await state.events();
	assert.ok(failure);
	assert.equal(failure.hook_event_name, "StopFailure");
});

test("an absent user-owned notification hook does not fail the main agent", async t => {
	const state = await fixture(t, undefined, false);
	await state.handlers.get("before_agent_start")!({}, state.ctx);
	await state.handlers.get("agent_settled")!({}, state.ctx);
});
