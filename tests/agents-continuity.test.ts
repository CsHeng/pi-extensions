import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerContinuationTool } from "../extensions/agents/continuation.ts";
test("registration adds no context projection and keeps recovery guidance", () => {
	const handlers = new Map<string, unknown[]>();
	const pi = {
		on(name: string, handler: unknown) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		registerTool() {}, registerCommand() {}, appendEntry() {},
		getActiveTools: () => ["list_agents"], events: { on() {}, emit() {} },
	} as unknown as ExtensionAPI;
	registerContinuationTool(pi, {});
	assert.equal(handlers.has("context"), false, "no automatic session index is projected into the model context");
	assert.equal(handlers.has("before_agent_start"), true, "bounded user-directed recovery is separate from a per-turn index");
});
