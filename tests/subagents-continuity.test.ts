import assert from "node:assert/strict";
import test from "node:test";
import { MANAGED_CONTEXT_TYPE, managedContextIndex, registerManagedContext } from "../extensions/subagents/context.ts";
import type { SessionView } from "../extensions/subagents/session-contracts.ts";

const view: SessionView = { handle: "session_example", role: "worker", episode: 2, state: "idle", reportComplete: true };

test("managed context contains bounded state, not reports, file paths or acceptance claims", () => {
	const text = managedContextIndex([{ ...view, result: { output: "private-prose /private/source" } as any }]);
	assert.match(text!, /session_example.*episode=2.*stored=idle/);
	assert.doesNotMatch(text!, /private-prose|\/private\/source/);
	assert.match(text!, /not proof of active execution or parent acceptance/);
	assert.equal(managedContextIndex([{ ...view, state: "closed" }]), undefined);
	assert.throws(() => managedContextIndex(Array.from({ length: 11 }, () => view)), /limit/);
});

test("per-request context restoration is idempotent, ephemeral and respects trust/tool disable", async () => {
	let handler: any;
	let active = true;
	let trusted = true;
	let reads = 0;
	const pi = { on(name: string, value: any) { assert.equal(name, "context"); handler = value; }, getActiveTools() { return active ? ["csheng_subagent_sessions"] : []; } };
	registerManagedContext(pi as any, async () => { reads++; return [view]; });
	const ctx = { isProjectTrusted: () => trusted };
	const original = [{ role: "user", content: "work", timestamp: 1 }];
	const first = await handler({ messages: original }, ctx);
	const second = await handler({ messages: first.messages }, ctx);
	assert.equal(original.length, 1);
	assert.equal(second.messages.filter((message: any) => message.customType === MANAGED_CONTEXT_TYPE).length, 1);
	assert.equal(second.messages.at(-1).content, first.messages.at(-1).content);
	assert.equal(second.messages.at(-1).display, false);
	assert.equal(reads, 2);
	active = false;
	assert.deepEqual((await handler({ messages: second.messages }, ctx)).messages, original);
	active = true; trusted = false;
	assert.deepEqual((await handler({ messages: second.messages }, ctx)).messages, original);
	assert.equal(reads, 2);
});

test("unavailable registry projection never invents an idle session or starts recovery", async () => {
	let handler: any;
	registerManagedContext({ on(_name: string, value: any) { handler = value; }, getActiveTools: () => ["csheng_subagent_sessions"] } as any, async () => { throw new Error("private failure path"); });
	const result = await handler({ messages: [] }, { isProjectTrusted: () => true });
	assert.match(result.messages[0].content, /index is unavailable/);
	assert.doesNotMatch(result.messages[0].content, /private failure path|stored=idle/);
});
