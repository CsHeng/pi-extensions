import assert from "node:assert/strict";
import test from "node:test";
import { ManagedObserver, OBSERVER_HEARTBEAT_MS } from "../extensions/subagents/managed-observer.ts";
import type { ObserverSnapshot } from "../extensions/subagents/observer-events.ts";
import { emptyUsage, type EffectiveRoute, type TaskResult } from "../extensions/subagents/contracts.ts";

const owner = { repo: "/not-published", parentSessionId: "parent", anchor: "anchor", branch: ["anchor"] };
const route = { provider: "provider", model: "model", thinking: "high" } as EffectiveRoute;
const result = (status: TaskResult["status"]): TaskResult => ({ id: "task", role: "explorer", status, output: "never-published", stderr: "", usage: { ...emptyUsage(), turns: 3 }, durationMs: 40, changedPaths: [], convergence: "not-applicable" });

test("observer publishes actual starts, route, turns and frozen terminal values with bounded heartbeat", (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	let now = 0;
	const seen: ObserverSnapshot[] = [];
	const observer = new ManagedObserver("run", owner, "generation", [{ id: "task", role: "explorer", episode: 1, route, replayed: false }], () => now, value => seen.push(value));
	observer.begin();
	assert.equal(seen.at(-1)?.launchedChildren, 0);
	assert.equal(seen.at(-1)?.tasks[0]?.elapsedMs, null);
	observer.childStarted("task"); observer.childStarted("task");
	assert.equal(seen.at(-1)?.launchedChildren, 1);
	assert.equal(seen.at(-1)?.activeChildren, 1);
	now = 40; observer.update([result("running")]);
	assert.equal(seen.at(-1)?.tasks[0]?.assistantTurns, 3);
	assert.equal(seen.at(-1)?.tasks[0]?.route?.thinking, "high");
	const revision = seen.at(-1)!.revision;
	t.mock.timers.tick(OBSERVER_HEARTBEAT_MS);
	assert.ok(seen.at(-1)!.revision > revision);
	observer.childStopped("task"); observer.update([result("succeeded")]);
	now = 90; observer.update([result("succeeded")]);
	assert.equal(seen.at(-1)?.tasks[0]?.elapsedMs, 40);
	observer.finish(false, false);
	assert.equal(seen.at(-1)?.phase, "settled");
	assert.equal(seen.at(-1)?.activeChildren, 0);
	assert.equal(seen.at(-1)?.settledTasks, 1);
	const count = seen.length; t.mock.timers.tick(20_000); observer.childStarted("task");
	assert.equal(seen.length, count);
	assert.doesNotMatch(JSON.stringify(seen), /not-published|never-published/);
});

test("cached rows do not launch and unknown clocks stay null; abort closes remaining work", () => {
	const seen: ObserverSnapshot[] = [];
	const observer = new ManagedObserver("run", owner, "generation", [{ id: "task", role: "explorer", episode: 1, replayed: true }], () => null, value => seen.push(value));
	observer.begin(); observer.update([result("running")]);
	assert.equal(seen.at(-1)?.tasks[0]?.status, "pending");
	observer.update([result("succeeded")]); observer.finish(false, false);
	assert.equal(seen.at(-1)?.launchedChildren, 0);
	assert.equal(seen.at(-1)?.elapsedMs, null);
	assert.equal(seen.at(-1)?.tasks[0]?.route, null);
	const aborted = new ManagedObserver("abort", owner, "generation", [{ id: "task", role: "explorer", episode: 1, replayed: false }], () => 0, value => seen.push(value));
	aborted.begin(); aborted.finish(true, true);
	assert.equal(seen.at(-1)?.tasks[0]?.status, "aborted");
});

test("failed observers cannot fail the execution publisher or leak intervals", (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const observer = new ManagedObserver("run", owner, "generation", [], () => 0, () => { throw new Error("display only"); });
	assert.doesNotThrow(() => { observer.begin(); t.mock.timers.tick(OBSERVER_HEARTBEAT_MS); observer.finish(true, false); });
});
