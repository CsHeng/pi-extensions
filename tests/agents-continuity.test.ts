import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerContinuationTool } from "../extensions/agents/continuation.ts";
import { MANAGED_SESSION_VERSION } from "../extensions/agents/session-contracts.ts";

/** Structural guard for removed index projection: no module may reintroduce a per-turn index payload. */
test("no authored managed-index projection remains in the extension source", async () => {
	const { readdir, readFile } = await import("node:fs/promises");
	const directory = new URL("../extensions/agents/", import.meta.url);
	const offenders: string[] = [];
	for (const entry of await readdir(directory)) {
		if (!entry.endsWith(".ts")) continue;
		const source = await readFile(new URL(entry, directory), "utf8");
		if (/agents.managed-session-index|Stored local-task index|managedContextIndex|registerManagedContext/.test(source)) offenders.push(entry);
	}
	assert.deepEqual(offenders, []);
});

test("registration adds no context projection and keeps only operational event handlers", () => {
	const handlers = new Map<string, unknown[]>();
	const pi = {
		on(name: string, handler: unknown) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		registerTool() {}, registerCommand() {}, appendEntry() {},
		getActiveTools: () => ["list_agents"], events: { on() {}, emit() {} },
	} as unknown as ExtensionAPI;
	registerContinuationTool(pi, {});
	assert.equal(handlers.has("context"), false, "no automatic session index is projected into the model context");
	assert.equal(handlers.has("before_agent_start"), true, "bounded user-directed recovery is separate from a per-turn index");
	assert.deepEqual([...handlers.keys()].sort(), ["agent_end", "agent_start", "before_agent_start", "context_with_system", "input", "session_compact_failed", "session_shutdown", "session_start", "session_tree", "tool_execution_end", "turn_start"]);
});

test("the collaboration cutover uses storage contract version 5", () => {
	assert.equal(MANAGED_SESSION_VERSION, 5);
});
