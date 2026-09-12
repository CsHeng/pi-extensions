import assert from "node:assert/strict";
import test from "node:test";
import {
	MAX_HEADLINE_BYTES,
	OBSERVER_EVENT,
	OBSERVER_LEGACY_VERSION,
	OBSERVER_VERSION,
	observerHeadline,
	observerTools,
	parseObserverSnapshot,
	type ObserverSnapshot,
} from "../extensions/subagents/observer-events.ts";

function task(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "scan",
		ordinal: 1,
		role: "explorer",
		episode: 0,
		status: "running",
		executionPhase: "child-execution",
		route: { provider: "openai", model: "gpt-4.1", thinking: "off" },
		assistantTurns: 3,
		elapsedMs: 1400,
		replayed: false,
		headline: "scan the bounded facts",
		activeTools: ["read"],
		...overrides,
	};
}

function snapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		version: OBSERVER_VERSION,
		parentSessionId: "parent_session-1",
		anchor: "leaf_entry-1",
		generation: "gen-1",
		runId: "run-1",
		revision: 0,
		phase: "running",
		requestedTasks: 2,
		admittedTasks: 2,
		launchedChildren: 1,
		activeChildren: 1,
		settledTasks: 0,
		aggregateAssistantTurns: 3,
		elapsedMs: 1500,
		tasks: [task()],
		...overrides,
	};
}

test("observer event name and version are exact", () => {
	assert.equal(OBSERVER_EVENT, "csheng.subagents.observer.v2");
	assert.equal(OBSERVER_VERSION, 3);
	assert.equal(OBSERVER_LEGACY_VERSION, 2);
});

test("snapshots accept the frozen v3 allowlist including native parent punctuation and null route", () => {
	const parsed = parseObserverSnapshot(snapshot());
	assert.equal(parsed.ok, true);
	if (!parsed.ok) return;
	const value: ObserverSnapshot = parsed.value;
	assert.equal(value.version, 3);
	assert.equal(value.parentSessionId, "parent_session-1");
	assert.equal(value.anchor, "leaf_entry-1");
	assert.equal(value.tasks[0]?.route?.model, "gpt-4.1");
	assert.equal(value.tasks[0]?.replayed, false);
	assert.equal(value.tasks[0]?.headline, "scan the bounded facts");
	assert.deepEqual(value.tasks[0]?.activeTools, ["read"]);
	const withoutRoute = parseObserverSnapshot(snapshot({
		tasks: [task({ route: null, episode: null, elapsedMs: null, assistantTurns: 0, status: "pending", executionPhase: "queued" })],
		elapsedMs: null,
		launchedChildren: 0,
		activeChildren: 0,
		aggregateAssistantTurns: 0,
	}));
	assert.equal(withoutRoute.ok, true);
	if (!withoutRoute.ok) return;
	assert.equal(withoutRoute.value.tasks[0]?.route, null);
	assert.equal(withoutRoute.value.tasks[0]?.episode, null);
	assert.equal(withoutRoute.value.elapsedMs, null);
	assert.equal(parseObserverSnapshot(snapshot({ anchor: null })).ok, true);
});

test("parser still accepts frozen v2 rows without headline or tools", () => {
	const { headline, activeTools, ...legacyTask } = task();
	void headline; void activeTools;
	const parsed = parseObserverSnapshot(snapshot({
		version: OBSERVER_LEGACY_VERSION,
		tasks: [legacyTask],
	}));
	assert.equal(parsed.ok, true);
	if (!parsed.ok) return;
	assert.equal(parsed.value.version, 2);
	assert.equal(parsed.value.tasks[0]?.headline, "");
	assert.deepEqual(parsed.value.tasks[0]?.activeTools, []);
	assert.equal(parseObserverSnapshot(snapshot({ version: OBSERVER_LEGACY_VERSION })).ok, false);
});

test("headline projection is single-line, bounded, and drops controls", () => {
	assert.equal(observerHeadline("search confirm the entry\nand extra"), "search confirm the entry and extra");
	assert.equal(observerHeadline(" \n\t "), "");
	assert.equal(observerHeadline("keep\u0007this"), "keep this");
	const long = "汉".repeat(MAX_HEADLINE_BYTES);
	const projected = observerHeadline(long);
	assert.ok(projected.endsWith("…"));
	assert.ok(Buffer.byteLength(projected, "utf8") <= MAX_HEADLINE_BYTES);
	assert.deepEqual(observerTools(["read", "grep", "read", "../escape", "tool execution"]), ["read", "grep"]);
});

test("parser rejects legacy, sensitive, and non-allowlisted keys", () => {
	assert.equal(parseObserverSnapshot(snapshot({ version: 1 })).ok, false);
	assert.equal(parseObserverSnapshot(snapshot({ prompt: "SECRET" })).ok, false);
	assert.equal(parseObserverSnapshot(snapshot({ objective: "SECRET" })).ok, false);
	assert.equal(parseObserverSnapshot(snapshot({ output: "SECRET" })).ok, false);
	assert.equal(parseObserverSnapshot(snapshot({ path: "/secret" })).ok, false);
	assert.equal(parseObserverSnapshot(snapshot({ credential: "SECRET" })).ok, false);
	assert.equal(parseObserverSnapshot(snapshot({ token: "SECRET" })).ok, false);
	assert.equal(parseObserverSnapshot(snapshot({ model: "gpt" })).ok, false);
	assert.equal(parseObserverSnapshot(snapshot({ peakConcurrency: 1 })).ok, false);
	assert.equal(parseObserverSnapshot(snapshot({ cancellationRequested: false })).ok, false);
	assert.equal(parseObserverSnapshot(snapshot({
		tasks: [task({ output: "SECRET" })],
	})).ok, false);
	assert.equal(parseObserverSnapshot(snapshot({
		tasks: [task({ inactiveForMs: 0 })],
	})).ok, false);
	assert.equal(parseObserverSnapshot(snapshot({
		tasks: [task({ objective: "SECRET" })],
	})).ok, false);
	const { headline, ...missingHeadline } = task();
	void headline;
	assert.equal(parseObserverSnapshot(snapshot({ tasks: [missingHeadline] })).ok, false);
	assert.equal(parseObserverSnapshot(snapshot({
		tasks: [task({ headline: "line\nfeed" })],
	})).ok, false);
	assert.equal(parseObserverSnapshot(snapshot({
		tasks: [task({ activeTools: ["read", "read"] })],
	})).ok, false);
	assert.equal(parseObserverSnapshot(snapshot({
		tasks: [task({ activeTools: ["../secret"] })],
	})).ok, false);
});

test("count inequalities and row uniqueness stay closed", () => {
	assert.equal(parseObserverSnapshot(snapshot({ admittedTasks: 3 })).ok, false);
	assert.equal(parseObserverSnapshot(snapshot({ launchedChildren: 3 })).ok, false);
	assert.equal(parseObserverSnapshot(snapshot({ activeChildren: 2 })).ok, false);
	assert.equal(parseObserverSnapshot(snapshot({ settledTasks: 3 })).ok, false);
	assert.equal(parseObserverSnapshot(snapshot({ requestedTasks: 11, admittedTasks: 11, tasks: [] })).ok, false);
	const overflow = Array.from({ length: 11 }, (_, index) => task({
		id: `t${index}`,
		ordinal: index + 1,
		route: null,
		status: "pending",
		executionPhase: "queued",
		assistantTurns: 0,
		elapsedMs: null,
	}));
	assert.equal(parseObserverSnapshot(snapshot({
		requestedTasks: 11,
		admittedTasks: 11,
		launchedChildren: 0,
		activeChildren: 0,
		tasks: overflow,
	})).ok, false);
	const ten = Array.from({ length: 10 }, (_, index) => task({
		id: `t${index}`,
		ordinal: index + 1,
		route: null,
		status: "pending",
		executionPhase: "queued",
		assistantTurns: 0,
		elapsedMs: null,
		replayed: true,
	}));
	assert.equal(parseObserverSnapshot(snapshot({
		requestedTasks: 10,
		admittedTasks: 10,
		launchedChildren: 0,
		activeChildren: 0,
		aggregateAssistantTurns: 0,
		elapsedMs: null,
		phase: "accepted",
		tasks: ten,
	})).ok, true);
	assert.equal(parseObserverSnapshot(snapshot({
		admittedTasks: 1,
		requestedTasks: 1,
		launchedChildren: 0,
		activeChildren: 0,
		tasks: [task(), task({ id: "other", ordinal: 2 })],
	})).ok, false);
	assert.equal(parseObserverSnapshot(snapshot({
		tasks: [task(), task({ id: "scan", ordinal: 2 })],
	})).ok, false);
	assert.equal(parseObserverSnapshot(snapshot({
		tasks: [task(), task({ id: "other", ordinal: 1 })],
	})).ok, false);
	assert.equal(parseObserverSnapshot(snapshot({
		tasks: [task({ ordinal: 0 })],
	})).ok, false);
	assert.equal(parseObserverSnapshot(snapshot({
		tasks: [task({ ordinal: 11 })],
	})).ok, false);
});

test("ids reject controls and path punctuation while keeping native parent/anchor marks", () => {
	assert.equal(parseObserverSnapshot(snapshot({ parentSessionId: "parent\n" })).ok, false);
	assert.equal(parseObserverSnapshot(snapshot({ parentSessionId: "parent\u001b" })).ok, false);
	assert.equal(parseObserverSnapshot(snapshot({ anchor: "leaf\u0007" })).ok, false);
	assert.equal(parseObserverSnapshot(snapshot({ generation: "gen id" })).ok, false);
	assert.equal(parseObserverSnapshot(snapshot({ runId: "../run" })).ok, false);
	assert.equal(parseObserverSnapshot(snapshot({
		tasks: [task({ id: "../escape" })],
	})).ok, false);
	assert.equal(parseObserverSnapshot(snapshot({
		tasks: [task({ id: "scan/path" })],
	})).ok, false);
});

test("routes stay bounded, enum-closed, and free of terminal controls", () => {
	assert.equal(parseObserverSnapshot(snapshot({
		tasks: [task({ route: { provider: "openai", model: "gpt-4.1", thinking: "max" } })],
	})).ok, true);
	assert.equal(parseObserverSnapshot(snapshot({
		tasks: [task({ route: { provider: "openai", model: "gpt-4.1", thinking: "unknown" } })],
	})).ok, false);
	assert.equal(parseObserverSnapshot(snapshot({
		tasks: [task({ route: { provider: "openai", model: "gpt-4.1", thinking: "off", selector: "secret" } })],
	})).ok, false);
	assert.equal(parseObserverSnapshot(snapshot({
		tasks: [task({ route: { provider: "open\u001bai", model: "gpt-4.1", thinking: "off" } })],
	})).ok, false);
	assert.equal(parseObserverSnapshot(snapshot({
		tasks: [task({ route: { provider: "openai", model: "gpt\n4", thinking: "off" } })],
	})).ok, false);
	assert.equal(parseObserverSnapshot(snapshot({
		tasks: [task({ route: { provider: "openai", model: "x".repeat(513), thinking: "off" } })],
	})).ok, false);
	assert.equal(parseObserverSnapshot(snapshot({
		tasks: [task({ route: { provider: "openai", model: "x".repeat(512), thinking: "off" } })],
	})).ok, true);
	assert.equal(parseObserverSnapshot(snapshot({
		tasks: [task({ route: { provider: "openai", model: "你".repeat(171), thinking: "off" } })],
	})).ok, false);
	assert.equal(parseObserverSnapshot(snapshot({
		tasks: [task({ route: { provider: "", model: "gpt-4.1", thinking: "off" } })],
	})).ok, false);
});

test("timing and scalar honesty reject NaN, negatives, and non-integers", () => {
	assert.equal(parseObserverSnapshot(snapshot({ elapsedMs: Number.NaN })).ok, false);
	assert.equal(parseObserverSnapshot(snapshot({ elapsedMs: Number.POSITIVE_INFINITY })).ok, false);
	assert.equal(parseObserverSnapshot(snapshot({ elapsedMs: -1 })).ok, false);
	assert.equal(parseObserverSnapshot(snapshot({ revision: -1 })).ok, false);
	assert.equal(parseObserverSnapshot(snapshot({ revision: 1.5 })).ok, false);
	assert.equal(parseObserverSnapshot(snapshot({
		tasks: [task({ elapsedMs: Number.NaN })],
	})).ok, false);
	assert.equal(parseObserverSnapshot(snapshot({
		tasks: [task({ assistantTurns: -1 })],
	})).ok, false);
	assert.equal(parseObserverSnapshot(snapshot({
		tasks: [task({ episode: -1 })],
	})).ok, false);
	assert.equal(parseObserverSnapshot(snapshot({
		tasks: [task({ episode: 1.5 })],
	})).ok, false);
	assert.equal(parseObserverSnapshot(snapshot({
		tasks: [task({ role: "agent" })],
	})).ok, false);
	assert.equal(parseObserverSnapshot(snapshot({
		tasks: [task({ status: "cancelled" })],
	})).ok, false);
	assert.equal(parseObserverSnapshot(snapshot({
		tasks: [task({ executionPhase: "running" })],
	})).ok, false);
	assert.equal(parseObserverSnapshot(snapshot({
		tasks: [task({ replayed: "true" })],
	})).ok, false);
	assert.equal(parseObserverSnapshot(null).ok, false);
	assert.equal(parseObserverSnapshot([]).ok, false);
});
