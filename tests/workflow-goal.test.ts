import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { mkdtemp, writeFile, rm, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGoalStore, canonicalScope, type GoalContext } from "../extensions/workflow/goal-store.ts";
import { accepted, judge, progressKey } from "../extensions/workflow/goal-state.ts";
import type { GoalOperation } from "../extensions/workflow/goal-contracts.ts";
import { goalReceipt, registerGoalTool } from "../extensions/workflow/goal-tool.ts";
import { goalRows } from "../extensions/workflow/goal-ui.ts";

const enroll: GoalOperation = { operation: "enroll", goal: "Implement goal", delivery: "source only", authority: "explicit user request", requirements: [{ key: "one", outcome: "first", verification: "check" }, { key: "two", outcome: "second", verification: "check" }], tasks: [{ key: "one", title: "First", covers: ["one"] }, { key: "two", title: "Second", covers: ["two"] }] };
async function fixture(t: test.TestContext) {
 const cwd = await mkdtemp(join(tmpdir(), "goal-test-")); t.after(() => rm(cwd, { recursive: true, force: true }));
 await writeFile(join(cwd, "one"), "one"); await writeFile(join(cwd, "two"), "two");
 const snapshots: { type: string; customType: string; data: unknown }[] = [];
 let failWrites = false;
 const store = createGoalStore((customType, data) => { if (failWrites) throw new Error("snapshot unavailable"); snapshots.push({ type: "custom", customType, data: structuredClone(data) }); });
 let serial = 0;
 const ctx: GoalContext = { cwd, now: "2026-09-18T00:00:00.000Z", sessionId: "fixture" };
 const run = async (op: GoalOperation) => { const result = await store.mutate(op, ctx, `call-${++serial}`); assert.equal(result.ok, true, result.message); return result; };
 const observe = async (id: string, error = false) => {
  const capture = await store.capture(cwd);
  store.observe({ ...capture, host: { toolCallId: id, toolName: "bash", sessionId: "fixture", at: ctx.now, isError: error, exitCode: error ? 1 : 0 } });
 };
 const report = (task: string, observationId?: string, complete = false): GoalOperation => ({ operation: "report", summary: "Executed check and evaluated result", facts: [{ key: "check", kind: observationId ? "host" : "agent", check: "unit test", result: "pass", ...(observationId ? { observationId } : {}) }], judgments: [`task:${task}`, `requirement:${task}`, ...(complete ? ["delivery"] : [])].map(subject => ({ subject, accepted: true, facts: ["check"], rationale: "Covers this subject" })), complete });
 return { store, ctx, run, observe, report, snapshots, cwd, failWrites: () => { failWrites = true; } };
}

test("strict enrollment is explicit; normal slice is start + compound report; all obligations gate close", async t => {
 const f = await fixture(t);
 assert.equal(f.store.current(), undefined);
 await f.run(enroll);
 await f.run({ operation: "start", task: "one", scope: ["one"] });
 const partial = await f.run(f.report("one", undefined, true));
 assert.equal(partial.view.state?.fulfillment, "pending"); assert.ok(partial.diagnostics.includes("requirement:two"));
 await f.run({ operation: "start", task: "two", scope: ["two"] });
 const final = await f.run(f.report("two", undefined, true));
 assert.equal(final.view.state?.fulfillment, "complete");
 assert.equal(f.snapshots.length, 5);
});

test("legitimate long contracts outlive cumulative record and snapshot ceilings", async t => {
 const f = await fixture(t); await f.run(enroll);
 const initial = structuredClone(f.snapshots[0]!);
 let appendedBytes = Buffer.byteLength(JSON.stringify(initial.data));
 const samples: { attempts: number; facts: number; snapshotBytes: number; appendedBytes: number; elapsedMs: number }[] = [];
 const started = performance.now();
 // Keep only the newest fixture entry in memory; account for every append, not just the live projection.
 const advance = async (op: GoalOperation) => {
  const result = await f.run(op);
  appendedBytes += Buffer.byteLength(JSON.stringify(f.snapshots.at(-1)!.data));
  f.snapshots.splice(0, f.snapshots.length - 1);
  return result;
 };
 for (let i = 0; i < 260; i++) {
  await advance({ operation: "start", task: "one", scope: ["one"] });
  await advance({ operation: "report", summary: "A useful independently recorded investigation", facts: Array.from({ length: 1 }, (_, n) => ({
   key: `check${n}`, kind: "agent" as const, check: `case ${i}/${n}`, result: "pass" as const, artifacts: ["x".repeat(500), "y".repeat(500), "z".repeat(500), "w".repeat(500)],
  })) });
  if (i === 31 || i === 259) samples.push({ attempts: i + 1, facts: f.store.current()!.facts.length,
   snapshotBytes: Buffer.byteLength(JSON.stringify(f.snapshots.at(-1)!.data)), appendedBytes, elapsedMs: Math.round(performance.now() - started) });
 }
 assert.equal(f.store.current()!.attempts.length, 260); assert.equal(f.store.current()!.facts.length, 260);
 assert.ok(samples.at(-1)!.snapshotBytes > 512 * 1024);
 await advance({ operation: "inspect" });
 await advance({ operation: "amend", reason: "same goal after investigation", authority: "existing" });
 await advance({ operation: "suspend", reason: "explicit test pause", condition: "explicit resume" });
 await advance({ operation: "resume", reason: "pause resolved", authority: "existing" });
 const replay = createGoalStore(() => {}); replay.replay([initial, ...f.snapshots]);
 assert.equal(replay.view().unavailable, undefined); assert.deepEqual(replay.current(), f.store.current());
 // Idempotency must not expire merely because another 128 operations occurred.
 const before = f.store.current(); await f.store.mutate(enroll, f.ctx, "call-1"); assert.deepEqual(f.store.current(), before);
 await advance({ operation: "start", task: "one", scope: ["one"] });
 await advance({ operation: "report", summary: "judge still-current early evidence", judgments: ["task:one", "requirement:one"].map(subject => ({ subject, facts: ["A1:check0"], accepted: true, rationale: "same source and supported obligation" })) });
 await advance({ operation: "start", task: "two", scope: ["two"] });
 await advance(f.report("two", undefined, true)); assert.equal(f.store.current()!.fulfillment, "complete");
 t.diagnostic(`synthetic growth (not a performance gate): ${JSON.stringify(samples)}`);
});

test("contract size and pending execution sets do not silently truncate real obligations", async t => {
 const f = await fixture(t);
 const keys = Array.from({ length: 70 }, (_, n) => `item${n}`);
 await f.run({ ...enroll, requirements: keys.map(key => ({ key, outcome: key, verification: "owned check" })),
  tasks: [...keys.map(key => ({ key, title: key, covers: [key] })), { key: "joined", title: "Real aggregate", covers: keys, dependsOn: keys }],
 });
 const runs = Array.from({ length: 270 }, (_, n) => `run-${n}`);
 f.store.pendingExecutions(runs); f.store.waitForExecutions(runs);
 assert.deepEqual(f.store.current()!.executionPending, runs); assert.deepEqual(f.store.current()!.continuation.waitingFor, runs);
 const replay = createGoalStore(() => {}); replay.replay(f.snapshots);
 assert.equal(replay.view().unavailable, undefined); assert.deepEqual(replay.current(), f.store.current());
});

test("append failure is a persistence diagnostic, not corrupt state or a reason to rerun checks", async t => {
 const f = await fixture(t); await f.run(enroll); const before = f.store.current(), writes = f.snapshots.length;
 f.failWrites();
 const result = await f.store.mutate({ operation: "start", task: "one", scope: ["one"] }, f.ctx, "failed-append");
 assert.equal(result.code, "persistence_failed"); assert.match(result.message!, /not installed/);
 assert.deepEqual(f.store.current(), before); assert.equal(f.snapshots.length, writes);
});

for (const field of ["scope", "writes"] as const) test(`overlong ${field} is a typed atomic path error, not a task description or unavailable contract`, async t => {
 const f = await fixture(t); await f.run(enroll);
 const before = structuredClone(f.store.current()), count = f.snapshots.length;
 const invalid = await f.store.mutate({ operation: "start", task: "one", scope: ["one"], [field]: ["x".repeat(300)] }, f.ctx, `overlong-${field}`);
 assert.equal(invalid.code, "invalid_scope"); assert.match(invalid.message!, /ENAMETOOLONG/);
 assert.ok(invalid.message!.includes("filesystem paths")); assert.ok(invalid.message!.length < 500);
 assert.equal(f.snapshots.length, count); assert.deepEqual(f.store.current(), before);
 assert.equal(f.store.view().unavailable, undefined);
 const path = "release notes 说明.md"; await writeFile(join(f.cwd, path), "valid path, not prose detection");
 await f.run({ operation: "start", task: "one", scope: [path, "planned 未来.ts"], writes: ["planned 未来.ts"] });
 assert.deepEqual(f.store.current()!.attempts.at(-1)!.scope, ["planned 未来.ts", path]);
});

test("dependency rejection names only missing predecessors and leaves independent work actionable", async t => {
 const f = await fixture(t); await f.run({ ...enroll, tasks: [...enroll.tasks!,
  { key: "joined", title: "Actual joined outcome", covers: ["one", "two"], dependsOn: ["one", "two"] },
  { key: "independent", title: "Independent local outcome", covers: ["one"] },
 ] });
 await f.run({ operation: "start", task: "one", scope: ["one"] }); await f.run(f.report("one"));
 const before = structuredClone(f.store.current()), count = f.snapshots.length;
 const rejected = await f.store.mutate({ operation: "start", task: "joined", scope: ["two"] }, f.ctx, "blocked-join");
 assert.equal(rejected.code, "dependency_pending");
 assert.ok(rejected.message?.includes("joined")); assert.match(rejected.message!, /predecessors: two\./);
 assert.equal(f.snapshots.length, count); assert.deepEqual(f.store.current(), before);
 assert.match(goalReceipt(rejected.view), /Ready: two, independent/);
 const state = structuredClone(before!); const diagnostics: string[] = [];
 judge(state, { subject: "task:joined", facts: ["A1:check"], accepted: true, rationale: "cannot bypass missing predecessor" }, diagnostics);
 assert.equal(accepted(state, "task:joined"), false); assert.match(diagnostics.join("\n"), /predecessors: two\./);
 await f.run({ operation: "start", task: "independent", scope: ["one"] });
 assert.equal(f.store.current()!.attempts.at(-1)!.task, "independent");
});

test("disk drift does not mechanically revoke explicit prerequisite judgment", async t => {
 const f = await fixture(t); await f.run({ ...enroll, tasks: [enroll.tasks![0]!, { ...enroll.tasks![1]!, dependsOn: ["one"] }] });
 await f.run({ operation: "start", task: "one", scope: ["one"] }); await f.run(f.report("one"));
 assert.match(goalReceipt(f.store.view()), /Ready: two/);
 await writeFile(join(f.cwd, "one"), "changed after acceptance");
 const before = structuredClone(f.store.current()), count = f.snapshots.length;
 let tool: any;
 registerGoalTool({ registerTool(value: unknown) { tool = value; }, on() {} } as never, f.store, () => false);
 const ctx = { cwd: f.cwd, sessionManager: { getSessionId: () => f.ctx.sessionId } };
 const rejected = await tool.execute("drift-start", { operation: "start", task: "two", scope: ["two"] }, undefined, undefined, ctx);
 assert.notEqual(rejected.isError, true);
 assert.equal(f.snapshots.length, count + 1);
 await tool.execute("drift-inspect", { operation: "inspect" }, undefined, undefined, ctx);
 assert.equal(accepted(f.store.current()!, "task:one"), true);
 assert.deepEqual(f.store.current()!.facts, before!.facts);
});

for (const broadFoundation of [false, true]) test(`foundation declarations ${broadFoundation ? "including consumers" : "owned independently"} do not automatically revoke judgment on disk drift`, async t => {
 const f = await fixture(t); await writeFile(join(f.cwd, "schema"), "shared interface");
 const keys = ["foundation", "one", "two"];
 await f.run({ ...enroll,
  requirements: keys.map(key => ({ key, outcome: key, verification: "owned source check" })),
  tasks: keys.map(key => ({ key, title: key, covers: [key], ...(key === "foundation" ? {} : { dependsOn: ["foundation"] }) })),
 });
 await f.run({ operation: "start", task: "foundation", scope: broadFoundation ? ["schema", "one", "two"] : ["schema"] });
 await f.observe("foundation-check"); await f.run(f.report("foundation", "foundation-check"));
 await f.run({ operation: "start", task: "two", scope: ["schema", "two"] });
 await f.observe("sibling-check"); await f.run(f.report("two", "sibling-check"));
 await f.run({ operation: "start", task: "one", scope: ["schema", "one"], writes: ["one"] });
 await writeFile(join(f.cwd, "one"), "consumer-only edit"); await f.run({ operation: "inspect" });
 assert.equal(accepted(f.store.current()!, "task:foundation"), true);
 assert.equal(accepted(f.store.current()!, "task:two"), true);
 assert.equal(f.store.current()!.attempts.at(-1)!.status, "running");
 await f.observe("consumer-check"); await f.run(f.report("one", "consumer-check"));
 assert.equal(accepted(f.store.current()!, "task:one"), true);
 await writeFile(join(f.cwd, "schema"), "changed shared interface"); await f.run({ operation: "inspect" });
 for (const key of keys) assert.equal(accepted(f.store.current()!, `task:${key}`), true);
 assert.ok(f.store.current()!.attempts.every(attempt => attempt.status === "reported"));
});

test("model-visible inspect exposes captured observation before a fact is reported", async t => {
 const f = await fixture(t); await f.run(enroll); await f.run({ operation: "start", task: "one", scope: ["one"] });
 await f.observe("captured-first"); await f.observe("captured-second");
 let tool: any;
 registerGoalTool({ registerTool(value: unknown) { tool = value; }, on() {} } as never, f.store, () => false);
 const result = await tool.execute("inspect-call", { operation: "inspect" }, undefined, undefined,
  { cwd: f.cwd, sessionManager: { getSessionId: () => f.ctx.sessionId } });
 const text = result.content[0].text as string;
 const receipt = JSON.parse(text.split("\n").find(line => line.startsWith('{"contractId"'))!);
 assert.deepEqual(receipt.observations.map((item: { id: string }) => item.id), ["captured-first", "captured-second"]);
 const report = await f.run(f.report("one", receipt.observations[0].id));
 assert.equal(accepted(report.view.state!, "task:one"), true);
});

test("terminal close is idempotent only for matching current outcome and proof", async t => {
 const f = await fixture(t); await f.run(enroll);
 for (const task of ["one", "two"]) { await f.run({ operation: "start", task, scope: [task] }); await f.run(f.report(task, undefined, task === "two")); }
 assert.equal(f.store.current()!.fulfillment, "complete");
 const before = f.snapshots.length;
 const repeat = await f.run({ operation: "close", outcome: "completed", reason: "repeat" });
 assert.equal(repeat.view.state!.fulfillment, "complete"); assert.equal(f.snapshots.length, before);
 const conflict = await f.store.mutate({ operation: "close", outcome: "cancelled", reason: "conflict" }, f.ctx, "conflict");
 assert.equal(conflict.code, "closed_contract");
 await writeFile(join(f.cwd, "one"), "changed");
 const drift = await f.run({ operation: "close", outcome: "completed", reason: "repeat" });
 assert.equal(drift.view.state!.fulfillment, "complete"); assert.equal(f.snapshots.length, before);
 for (const outcome of ["cancelled", "superseded"] as const) {
  const g = await fixture(t); await g.run(enroll); await g.run({ operation: "close", outcome, reason: "stop" });
  const count = g.snapshots.length; await g.run({ operation: "close", outcome, reason: "repeat" }); assert.equal(g.snapshots.length, count);
 }
});

test("terminal close is read-only and does not recertify filesystem contents", async t => {
 const f = await fixture(t); await f.run(enroll);
 for (const task of ["one", "two"]) { await f.run({ operation: "start", task, scope: [task] }); await f.run(f.report(task, undefined, task === "two")); }
 await writeFile(join(f.cwd, "one"), "changed"); f.failWrites();
 const result = await f.store.mutate({ operation: "close", outcome: "completed", reason: "repeat" }, f.ctx, "close-failed-proof");
 assert.equal(result.ok, true);
 assert.equal(result.view.state?.fulfillment, "complete"); assert.equal(result.view.unavailable, undefined);
});

test("honest check-time basis supports edits then verification; fake success/failure reports retain diagnostics", async t => {
 const f = await fixture(t); await f.run(enroll);
 await f.run({ operation: "start", task: "one", scope: ["one"], writes: ["one"] });
 await writeFile(join(f.cwd, "one"), "edited");
 await f.observe("check-fail", true);
 const failed = await f.run(f.report("one", "check-fail"));
 assert.equal(accepted(failed.view.state!, "task:one"), false); assert.ok(failed.diagnostics.length);
 const bad = await f.store.mutate({ ...f.report("one", "fabricated"), attempt: "A1" }, f.ctx, "bad");
 assert.equal(bad.code, "observation_required");
 // Correct a stable fact after a new real check; reported attempts need a new execution boundary.
 await f.run({ operation: "start", task: "one", scope: ["one"] }); await f.observe("check-pass");
 const success = await f.run(f.report("one", "check-pass"));
 assert.equal(accepted(success.view.state!, "task:one"), true);
 assert.equal(success.view.state!.facts.at(-1)!.kind, "host");
});

test("duplicate reports/corrections are bounded and do not create fake progress", async t => {
 const f = await fixture(t); await f.run(enroll); await f.run({ operation: "start", task: "one", scope: ["one"] });
 await f.run(f.report("one")); const progress = progressKey(f.store.current()!);
 const op = { ...f.report("one"), attempt: "A1" };
 await f.run(op); assert.equal(f.store.current()!.facts.length, 1); assert.equal(progressKey(f.store.current()!), progress);
 await f.run({ ...op, facts: [{ key: "check", kind: "agent", check: "corrected failure", result: "fail" }], judgments: [] });
 assert.equal(f.store.current()!.facts.length, 1); assert.equal(accepted(f.store.current()!, "task:one"), false);
});

test("same-file drift leaves evidence relevance to explicit judgment", async t => {
 const f = await fixture(t); await f.run(enroll);
 for (const task of ["one", "two"]) { await f.run({ operation: "start", task, scope: [task] }); await f.run(f.report(task)); }
 await writeFile(join(f.cwd, "one"), "compatible concurrent update");
 const result = await f.run({ operation: "close", outcome: "completed", reason: "evaluate current proof" });
 assert.equal(accepted(result.view.state!, "task:one"), true); assert.equal(accepted(result.view.state!, "task:two"), true);
 assert.equal(result.view.state!.goalRevision, 1);
 assert.equal(f.store.current()!.fulfillment, "pending", "delivery still requires its own judgment");
});

test("source aliases remain declarations rather than content certification", async t => {
 const f = await fixture(t); await symlink("one", join(f.cwd, "alias")); await f.run(enroll);
 await f.run({ operation: "start", task: "one", scope: ["alias"] }); await f.run(f.report("one"));
 assert.deepEqual(f.store.current()!.facts[0]!.scope, ["alias"]);
 await unlink(join(f.cwd, "alias")); await symlink("two", join(f.cwd, "alias"));
 await f.run({ operation: "close", outcome: "completed", reason: "evaluate proof" });
 assert.equal(accepted(f.store.current()!, "task:one"), true); assert.equal(f.store.current()!.facts[0]!.usable, true);
});

test("amended verification needs new judgment, not erased evidence or a relabeled old observation", async t => {
 const f = await fixture(t); await f.run(enroll);
 await f.run({ operation: "start", task: "one", scope: ["one"] }); await f.observe("original-check"); await f.run(f.report("one", "original-check"));
 const original = structuredClone(f.store.current()!.facts[0]!);
 await f.run({ operation: "amend", reason: "clarify the oracle meaning", authority: "same intent", requirements: [{ ...enroll.requirements![0]!, verification: "the same check proves the clarified boundary" }, enroll.requirements![1]!] });
 assert.equal(f.store.current()!.attempts[0]!.status, "interrupted");
 assert.deepEqual(f.store.current()!.facts[0], original);
 assert.equal(accepted(f.store.current()!, "task:one"), false); assert.equal(accepted(f.store.current()!, "requirement:one"), false);
 assert.equal((await f.store.mutate({ ...f.report("one"), attempt: "A1" }, f.ctx, "late-old-writer")).code, "unknown_attempt");
 await f.run({ operation: "start", task: "one", scope: ["one"] });
 const result = await f.run({ operation: "report", summary: "explicitly rejudge the original fact for the clarified requirement",
  facts: [{ key: "not-a-fresh-check", kind: "host", check: "must not relabel old execution", observationId: "original-check", result: "pass" }],
  judgments: ["task:one", "requirement:one"].map(subject => ({ subject, facts: ["A1:check"], accepted: true, rationale: "original actual check supports the clarified obligation; no new execution claimed" })),
 });
 assert.equal(result.view.state!.facts.find(fact => fact.id === "A2:not-a-fresh-check")!.usable, false);
 assert.equal(accepted(result.view.state!, "requirement:one"), true); assert.equal(accepted(result.view.state!, "task:one"), true);
 await writeFile(join(f.cwd, "one"), "real oracle input changed");
 await f.run({ operation: "inspect" });
 assert.equal(f.store.current()!.facts[0]!.usable, true); assert.equal(accepted(f.store.current()!, "task:one"), true);
 // The main agent may explicitly withdraw a judgment after observing a relevant change.
 await f.run({ operation: "report", attempt: "A2", summary: "relevant source changed", judgments: [{ subject: "task:one", facts: ["A1:check"], accepted: false, rationale: "affected verification required" }] });
 assert.equal(accepted(f.store.current()!, "task:one"), false);
});

test("task and dependency presentation order is not changed meaning", async t => {
 const f = await fixture(t);
 const tasks = [...enroll.tasks!, { key: "join", title: "Join", covers: ["one", "two"], dependsOn: ["one", "two"] }];
 await f.run({ ...enroll, tasks });
 for (const task of ["one", "two"]) { await f.run({ operation: "start", task, scope: [task] }); await f.run(f.report(task)); }
 await f.run({ operation: "start", task: "join", scope: ["one", "two"] });
 await f.run({ operation: "report", summary: "joined", judgments: [{ subject: "task:join", facts: ["A1:check", "A2:check"], accepted: true, rationale: "actual inputs" }] });
 const before = f.store.current()!;
 await f.run({ operation: "amend", reason: "presentation only", authority: "existing", tasks: [...tasks].reverse().map(task => ({ ...task, title: `Clearer ${task.title}`, covers: [...task.covers].reverse(), ...(task.dependsOn ? { dependsOn: [...task.dependsOn].reverse() } : {}) })) });
 assert.deepEqual(f.store.current()!.acceptance, before.acceptance); assert.deepEqual(f.store.current()!.facts, before.facts);
 assert.deepEqual(f.store.current()!.attempts, before.attempts);
});

for (const aggregateAccepted of [false, true]) test(`splitting an ${aggregateAccepted ? "accepted" : "unaccepted"} aggregate preserves unrelated proof without transferring acceptance`, async t => {
 const f = await fixture(t);
 const foundation = enroll.tasks![0]!;
 await f.run({ ...enroll, tasks: [foundation,
  { key: "owners", title: "Local and peer outcomes", covers: ["two"] },
  { key: "join", title: "Local consumer", covers: ["two"], dependsOn: ["owners"] },
 ] });
 await f.run({ operation: "start", task: "one", scope: ["one"] }); await f.run(f.report("one"));
 const proof = structuredClone(f.store.current()!.acceptance.find(j => j.subject === "task:one"));
 await f.run({ operation: "start", task: "owners", scope: ["two"] });
 await f.run({ operation: "report", summary: "aggregate slice", facts: [{ key: "f", kind: "agent", check: "aggregate evidence", result: "pass" }], judgments: [{ subject: "task:owners", facts: ["f"], accepted: aggregateAccepted, rationale: "fixture" }] });
 await f.run({ operation: "amend", reason: "Separate independent blocker and acceptance boundaries", authority: "same approved outcomes", tasks: [foundation,
  { key: "local", title: "Local source", covers: ["two"] },
  { key: "peer", title: "External peer verification", covers: ["two"] },
  { key: "join", title: "Local consumer", covers: ["two"], dependsOn: ["local"] },
 ] });
 const split = f.store.current()!;
 assert.deepEqual(split.acceptance.find(j => j.subject === "task:one"), proof);
 assert.equal(accepted(split, "task:one"), true); assert.equal(split.facts.find(f => f.id === "A1:check")!.usable, true);
 for (const key of ["owners", "local", "peer", "join"]) assert.equal(accepted(split, `task:${key}`), false);
 assert.equal(split.attempts.find(a => a.task === "owners")!.status, "interrupted");
 assert.equal(split.facts.find(f => f.id === "A2:f")!.usable, true, "a decomposition change is not source invalidation");
 const replay = createGoalStore(() => {}); replay.replay(f.snapshots);
 assert.equal(replay.view().unavailable, undefined); assert.deepEqual(replay.current(), split);
 await f.run({ operation: "start", task: "peer", scope: ["two"] });
 await f.run({ operation: "report", summary: "fixture absent", blocker: { kind: "capability", reason: "pinned peer missing", unblock: "peer provided" } });
 await f.run({ operation: "start", task: "local", scope: ["two"] });
 const judged = await f.run({ operation: "report", summary: "review original local-source evidence against the separated local obligation", judgments: [{ subject: "task:local", facts: ["A2:f"], accepted: true, rationale: "still-current source evidence suffices for this local result, not the blocked peer" }] });
 assert.equal(accepted(judged.view.state!, "task:local"), true);
 await f.run({ operation: "start", task: "join", scope: ["two"] });
 assert.equal(f.store.current()!.attempts.at(-1)!.task, "join");
 assert.equal(f.store.current()!.tasks.find(t => t.key === "peer")!.blocker?.kind, "capability");
 assert.equal(f.store.current()!.fulfillment, "pending");
});

test("active resume cannot renew anti-spin allowance but can unblock an independent task", async t => {
 const f = await fixture(t); await f.run(enroll); let dispatched = 0;
 await f.store.settle(f.ctx, () => dispatched++);
 for (let i = 0; i < 2; i++) {
  const result = await f.store.mutate({ operation: "resume", reason: "same wording", authority: "existing" }, f.ctx, `resume-${i}`);
  assert.equal(result.code, "already_active"); await f.store.settle(f.ctx, () => dispatched++);
 }
 assert.equal(dispatched, 2); assert.equal(f.store.current()!.continuation.state, "active");
 assert.equal(f.store.current()!.continuation.automaticPaused, true);
 await f.run({ operation: "start", task: "one", scope: ["one"] });
 await f.run({ operation: "report", summary: "blocked task", blocker: { kind: "prerequisite", reason: "missing", unblock: "restored" } });
 const history = structuredClone(f.store.current()!.continuation);
 await f.run({ operation: "resume", task: "one", reason: "restored", authority: "existing" });
 assert.deepEqual(f.store.current()!.continuation, history); assert.equal(f.store.current()!.tasks[0]!.blocker, undefined);
});

test("overlapping writer including canonical aliases prevents acceptance", async t => {
 const f = await fixture(t); await f.run(enroll);
 await f.run({ operation: "start", task: "one", scope: ["./one"] });
 await f.run({ operation: "start", task: "two", scope: ["two"], writes: [join(f.cwd, "one")] });
 const result = await f.run({ ...f.report("one"), attempt: "A1" });
 assert.ok(result.diagnostics.some(d => d.includes("overlapping writer"))); assert.equal(accepted(f.store.current()!, "task:one"), false);
 assert.deepEqual(await canonicalScope(["./one", join(f.cwd, "one")], f.cwd), [join(f.cwd, "one")]);
 await symlink(tmpdir(), join(f.cwd, "escape"));
 assert.deepEqual(await canonicalScope(["escape/outside"], f.cwd), [join(tmpdir(), "outside")]);
});

test("amended meaning invalidates dependent attempts, not independent work", async t => {
 const f = await fixture(t); await f.run(enroll);
 await f.run({ operation: "start", task: "one", scope: ["one"] });
 await f.run({ operation: "start", task: "two", scope: ["two"] });
 await f.run({ operation: "amend", authority: "same user clarifies", reason: "changed first requirement", requirements: [{ key: "one", outcome: "changed", verification: "new check" }, enroll.requirements![1]!] });
 assert.equal(f.store.current()!.attempts[0]!.status, "interrupted"); assert.equal(f.store.current()!.attempts[1]!.status, "running");
 assert.equal((await f.store.mutate({ ...f.report("one"), attempt: "A1" }, f.ctx, "stale")).code, "unknown_attempt");
});

test("waiting, input reconciliation, suspension and cancellation are not fulfillment", async t => {
 const f = await fixture(t); await f.run(enroll); await f.run({ operation: "start", task: "one", scope: ["one"] });
 await f.run({ operation: "report", summary: "prerequisite absent", blocker: { kind: "prerequisite", reason: "missing fixture", unblock: "fixture restored" } });
 assert.equal(f.store.current()!.fulfillment, "pending"); assert.equal(f.store.current()!.continuation.state, "active", "independent ready work remains actionable");
 await f.run({ operation: "start", task: "two", scope: ["two"] }); await f.run(f.report("two"));
 assert.equal(f.store.current()!.continuation.state, "waiting");
 f.store.delivered(true);
 assert.equal((await f.store.mutate({ operation: "resume", reason: "fixture exists", authority: "original request" }, f.ctx, "bad-resume")).code, "alignment_required");
 await f.run({ operation: "resume", reason: "fixture exists", authority: "original request", alignment: "same authorized goal" });
 assert.equal(f.store.current()!.continuation.state, "active");
 await f.run({ operation: "close", outcome: "cancelled", reason: "user cancelled" }); assert.equal(f.store.current()!.fulfillment, "cancelled");
});

test("productive continuation repeats; churn and changed wording cannot renew no-progress budget", async t => {
 const f = await fixture(t); await f.run(enroll); let count = 0;
 await f.store.settle(f.ctx, () => count++);
 await f.run({ operation: "start", task: "one", scope: ["one"] }); await f.run(f.report("one"));
 await f.store.settle(f.ctx, () => count++);
 await f.run({ operation: "start", task: "two", scope: ["two"] }); await f.run(f.report("two"));
 await f.store.settle(f.ctx, () => count++); assert.equal(count, 3);
 await f.run({ operation: "report", attempt: "A2", summary: "new prose without work" });
 await f.store.settle(f.ctx, () => count++); await f.store.settle(f.ctx, () => count++);
 assert.equal(count, 4); assert.equal(f.store.current()!.continuation.state, "active"); assert.equal(f.store.current()!.continuation.automaticPaused, true); assert.equal(f.store.current()!.fulfillment, "pending");
});

test("automatic anti-spin pause leaves authorized exploration executable without a resume ritual", async t => {
 const f = await fixture(t); await f.run(enroll); let dispatches = 0;
 const settle = () => f.store.settle(f.ctx, () => dispatches++);
 await settle(); await settle(); await settle();
 assert.equal(dispatches, 2); assert.equal(f.store.current()!.continuation.state, "active");
 assert.equal(f.store.current()!.continuation.automaticPaused, true);
 const paused = f.store.current(); await settle(); assert.deepEqual(f.store.current(), paused, "unchanged settlements do not churn snapshots");
 assert.match(goalReceipt(f.store.view()), /automatic dispatch paused/i);
 assert.equal((await f.store.mutate({ operation: "resume", reason: "new wording only", authority: "same" }, f.ctx, "no-refill")).code, "already_active");
 // Even a suspend/resume round trip cannot refresh the automatic dispatch budget.
 await f.run({ operation: "suspend", reason: "actual user pause", condition: "explicit user continuation" });
 assert.equal((await f.store.mutate({ operation: "start", task: "one", scope: ["one"] }, f.ctx, "paused-start")).code, "suspended");
 await f.run({ operation: "resume", reason: "explicit user continuation", authority: "same" }); await settle();
 assert.equal(dispatches, 2); assert.equal(f.store.current()!.continuation.automaticPaused, true);
 // A normal host run can investigate without another resume; failures and more necessary tasks can be useful progress.
 await f.run({ operation: "start", task: "one", scope: ["one"] }); await f.observe("diagnostic-failure", true);
 await f.run({ operation: "report", summary: "found a real missing prerequisite", facts: [{ key: "diagnostic", kind: "host", check: "real failed diagnostic", observationId: "diagnostic-failure", result: "fail" }] });
 await f.run({ operation: "amend", reason: "discovered necessary investigation", authority: "same outcome", tasks: [...enroll.tasks!, { key: "investigate", title: "Investigate", covers: ["one"] }] });
 await settle(); assert.equal(dispatches, 3); assert.equal(f.store.current()!.continuation.automaticPaused, undefined);
 assert.equal(f.store.current()!.acceptance.length, 0); assert.equal(f.store.current()!.tasks.length, 3);
 assert.equal(f.store.current()!.facts[0]!.result, "fail");
});

test("persistence is append-before-install, newest corruption fails closed, recovery is not autoresume", async t => {
 const f = await fixture(t); await f.run(enroll); await f.run({ operation: "start", task: "one", scope: ["one"] });
 const replay = createGoalStore(() => {}); replay.replay(f.snapshots); replay.recover("restart");
 assert.equal(replay.current()!.attempts[0]!.status, "interrupted"); assert.equal(replay.current()!.continuation.state, "suspended");
 const corrupt = structuredClone(f.snapshots.at(-1)!); (corrupt.data as any).state.serial = 0;
 replay.replay([...f.snapshots, corrupt]); assert.ok(replay.view().unavailable); assert.equal(replay.current(), undefined);
 const broken = createGoalStore(() => { throw new Error("disk failed"); });
 assert.equal((await broken.mutate(enroll, f.ctx, "enroll")).ok, false); assert.equal(broken.current(), undefined);
});

test("unsupported v1 snapshots fail closed without migration, fallback or history writes", async t => {
 const f = await fixture(t); await f.run(enroll);
 const before = structuredClone(f.snapshots);
 // Version rejection precedes payload parsing; neither readable nor corrupt v1 history is upgraded.
 for (const data of [{ schemaVersion: 1, state: { revision: 1, workset: { goal: "Old goal" } } }, { schemaVersion: 1 }]) {
  const old = { type: "custom", customType: "csheng-workflow-state", data };
  const history = [...before, old]; const unchanged = structuredClone(history);
  f.store.replay(history); f.store.recover("restart");
  assert.equal(f.store.current(), undefined);
  assert.match(f.store.view().unavailable!, /Unsupported latest workflow snapshot/);
  assert.match(goalReceipt(f.store.view()), /unavailable/);
  assert.doesNotMatch(goalReceipt(f.store.view()), /migrateLegacy/);
  assert.match(goalRows(f.store.view(), 120).join("\n"), /state unavailable/);
  assert.equal((await f.store.mutate({ operation: "inspect" }, f.ctx, "inspect")).ok, true);
  assert.equal((await f.store.mutate(enroll, f.ctx, "enroll")).code, "state_unavailable");
  assert.equal((await f.store.mutate({ operation: "resume", reason: "continue", authority: "existing" }, f.ctx, "resume")).code, "state_unavailable");
  assert.deepEqual(history, unchanged); assert.deepEqual(f.snapshots, before);
 }
 // Navigating to a v2 or empty branch is not an automatic history repair.
 f.store.replay(before); assert.equal(f.store.current()?.version, 3);
 f.store.replay([]); await f.run(enroll); assert.equal(f.store.current()?.version, 3);
});

test("v3 snapshots keep inert historical migration provenance without loading a v1 reader", async t => {
 const f = await fixture(t); await f.run(enroll);
 const state = f.store.current()!;
 state.legacy = { revision: 4, id: "old-workset", goal: "Previous goal" };
 f.store.replay([{ type: "custom", customType: "csheng-workflow-state", data: { schemaVersion: 3, state } }]);
 assert.equal(f.store.view().unavailable, undefined); assert.deepEqual(f.store.current()!.legacy, state.legacy);
 await f.run({ operation: "start", task: "one", scope: ["one"] });
 assert.deepEqual(f.store.current()!.legacy, state.legacy);
});

test("recovered pending executions remain visible across new dispatch and explicit reconciliation permits completion", async t => {
 const f = await fixture(t); await f.run(enroll);
 for (const task of ["one", "two"]) { await f.run({ operation: "start", task, scope: [task] }); await f.run(f.report(task)); }
 f.store.pendingExecutions(["old-run"]);
 const replay = createGoalStore(() => {}); replay.replay(f.snapshots); replay.recover("restart");
 assert.deepEqual(replay.current()!.recoveredExecutions, ["old-run"]);
 replay.pendingExecutions(["new-run"]);
 assert.deepEqual(replay.current()!.executionPending, ["old-run", "new-run"]);
 const invalid = await replay.mutate({ operation: "resume", reason: "cannot drop a live run", authority: "fixture", alignment: "same scope", reconciledExecutions: ["new-run"] }, f.ctx, "bad-resolution");
 assert.equal(invalid.code, "invalid_reconciliation");
 assert.deepEqual(replay.current()!.executionPending, ["old-run", "new-run"]);
 const resumed = await replay.mutate({ operation: "resume", reason: "owner inspected terminal retained work", authority: "same fixture", alignment: "old-run completed and remains retained; no business acceptance imported", reconciledExecutions: ["old-run"] }, f.ctx, "resolution");
 assert.equal(resumed.ok, true, resumed.message);
 assert.deepEqual(replay.current()!.executionPending, ["new-run"]);
 assert.deepEqual(replay.current()!.facts, f.store.current()!.facts, "reconciliation imports no execution facts");
 replay.pendingExecutions([]);
 const result = await replay.mutate({ operation: "report", attempt: "A2", summary: "explicit delivery judgment", judgments: [{ subject: "delivery", facts: ["A1:check", "A2:check"], accepted: true, rationale: "both outcomes verified; recovered execution disposition recorded" }], complete: true }, f.ctx, "complete");
 assert.equal(result.ok, true, result.message); assert.equal(replay.current()!.fulfillment, "complete");
 assert.deepEqual(replay.current()!.executionReconciliations?.[0]?.ids, ["old-run"]);
});

test("v2 history is read-only and explicitly replaced without importing acceptance or hiding executions", async t => {
 const f = await fixture(t); await f.run(enroll);
 await f.run({ operation: "start", task: "one", scope: ["one"] }); await f.run(f.report("one"));
 await f.run({ operation: "start", task: "two", scope: ["two"] });
 const old: any = structuredClone(f.store.current()!); old.version = 2; old.executionPending = ["run-old"];
 for (const entry of [...old.attempts, ...old.facts]) { entry.basis = { scope: entry.scope, fingerprint: "historic", state: "current" }; delete entry.scope; }
 const history = [{ type: "custom", customType: "csheng-workflow-state", data: { schemaVersion: 2, state: old } }];
 const before = structuredClone(history); const appended: any[] = [];
 const replay = createGoalStore((customType, data) => appended.push({ type: "custom", customType, data }));
 replay.replay(history); replay.recover("restart");
 assert.equal(replay.current(), undefined); assert.equal(replay.view().legacy?.requirements.length, 2);
 assert.deepEqual(replay.view().legacy?.executionPending, ["run-old"]);
 assert.match(goalReceipt(replay.view()), /run-old/);
 assert.deepEqual(history, before); assert.equal(appended.length, 0);
 let dispatched = false; await replay.settle(f.ctx, () => { dispatched = true; }); assert.equal(dispatched, false);
 assert.equal((await replay.mutate(enroll, f.ctx, "implicit")).code, "legacy_replacement_required");
 const replaced = await replay.mutate({ ...enroll, alignment: "Reconcile both old outcomes; run-old remains historical unresolved evidence and requires owner disposition outside this replacement." }, f.ctx, "replace");
 assert.equal(replaced.ok, true, replaced.message);
 assert.equal(replay.current()!.version, 3); assert.deepEqual(replay.current()!.facts, []); assert.deepEqual(replay.current()!.acceptance, []);
 assert.deepEqual(replay.current()!.replacement?.unresolvedExecutions, ["run-old", "A2"]);
 assert.equal(replay.current()!.replacement?.id, old.id);
 assert.deepEqual(history, before);
 const again = createGoalStore(() => {}); again.replay([...history, ...appended]); assert.equal(again.current()?.id, replay.current()!.id); assert.equal(again.view().legacy, undefined);
});

test("async cancellation/input fences and read-only optional UI preserve committed state", async t => {
 const f = await fixture(t); await f.run(enroll); const before = f.store.current();
 const controller = new AbortController(); controller.abort();
 assert.equal((await f.store.mutate({ operation: "start", task: "one" }, { ...f.ctx, signal: controller.signal }, "cancelled")).code, "preparation_changed");
 assert.deepEqual(f.store.current(), before);
 const pending = f.store.mutate({ operation: "start", task: "one" }, f.ctx, "overlap"); f.store.delivered(false);
 // Replay re-derives from the delivered input, so the accurate alignment gate surfaces instead of a bare conflict.
 assert.equal((await pending).code, "alignment_required");
 const stable = f.store.current(); goalRows(f.store.view(), 3); goalRows(f.store.view(), 120); assert.deepEqual(f.store.current(), stable);
 f.store.subscribe(() => { throw new Error("UI failed"); });
 await f.run({ operation: "amend", authority: "existing", reason: "retain", alignment: "same goal" }); assert.equal(f.store.current()!.input.aligned, true);
});

test("preparation-only conflicts replay against fresh state and commit exactly once", async t => {
 const f = await fixture(t); await f.run(enroll);
 await f.run({ operation: "start", task: "one", scope: ["one"] });
 const before = f.snapshots.length;
 const started = f.store.mutate({ operation: "start", task: "two", scope: ["two"] }, f.ctx, "conflict-start");
 f.store.pendingExecutions(["run-1"]); // commits while the start preparation awaits its scope checks
 const result = await started;
 assert.equal(result.ok, true, result.message);
 assert.equal(f.snapshots.length - before, 2); // one injected bookkeeping commit + exactly one committed start
 const state = f.store.current()!;
 assert.deepEqual(state.executionPending, ["run-1"]);
 assert.deepEqual(state.attempts.filter(a => a.task === "two").map(a => a.id), ["A2"]);
 // A replayed commit keeps duplicate call ids idempotent.
 const duplicate = await f.store.mutate({ operation: "start", task: "two", scope: ["two"] }, f.ctx, "conflict-start");
 assert.deepEqual(duplicate.diagnostics, ["Already recorded."]);
});

test("concurrent semantic changes surface their own accurate rejection after replay, not a conflict diagnostic", async t => {
 const f = await fixture(t); await f.run(enroll);
 await f.run({ operation: "start", task: "one", scope: ["one"] });
 const delivered = f.store.mutate({ operation: "start", task: "two", scope: ["two"] }, f.ctx, "delivered-start");
 f.store.delivered(false);
 const deliveredResult = await delivered;
 assert.equal(deliveredResult.code, "alignment_required");
 assert.match(deliveredResult.message!, /alignment/); assert.ok(!deliveredResult.message!.includes("Replayed"));
 assert.ok(f.store.current()!.attempts.every(a => a.task !== "two"));
 const recovered = f.store.mutate({ operation: "start", task: "two", scope: ["two"] }, f.ctx, "recovered-start");
 f.store.recover("test recovery interrupts attempts");
 const recoveredResult = await recovered;
 assert.equal(recoveredResult.code, "alignment_required");
 assert.ok(!recoveredResult.message!.includes("Replayed"));
 assert.ok(f.store.current()!.attempts.every(a => a.status === "interrupted"));
 assert.ok(f.store.current()!.attempts.every(a => a.task !== "two"));
});

test("parallel duplicate operations resolve without double commits; losers get the semantic rejection", async t => {
 const f = await fixture(t); await f.run(enroll);
 const starts = await Promise.all(["a", "b"].map(id => f.store.mutate({ operation: "start", task: "one", scope: ["one"] }, f.ctx, `dup-start-${id}`)));
 assert.equal(starts.filter(r => r.ok).length, 1);
 const loser = starts.find(r => !r.ok)!;
 assert.equal(loser.code, "running_attempt"); assert.ok(!loser.message!.includes("Replayed"));
 const before = f.snapshots.length;
 const reports = await Promise.all(["a", "b"].map(id => f.store.mutate(f.report("one"), f.ctx, `dup-report-${id}`)));
 assert.equal(reports.filter(r => r.ok).length, 1);
 const reportLoser = reports.find(r => !r.ok)!;
 assert.equal(reportLoser.code, "unknown_attempt"); assert.ok(!reportLoser.message!.includes("Replayed"));
 assert.equal(f.snapshots.length - before, 1);
});

test("a realistic parallel batch fully recovers through bounded replay", async t => {
 const f = await fixture(t);
 const keys = ["sib0", "sib1", "sib2"];
 for (const key of keys) await writeFile(join(f.cwd, key), key);
 await f.run({ ...enroll, requirements: keys.map(key => ({ key, outcome: key, verification: "check" })), tasks: keys.map(key => ({ key, title: key, covers: [key] })) });
 const before = f.snapshots.length;
 const results = await Promise.all(keys.map((key, n) => f.store.mutate({ operation: "start", task: key, scope: [key] }, f.ctx, `sib-${n}`)));
 assert.ok(results.every(r => r.ok), results.map(r => r.message).join(" | "));
 assert.equal(f.snapshots.length - before, keys.length);
 const ids = f.store.current()!.attempts.map(a => a.id);
 assert.equal(new Set(ids).size, ids.length);
});

test("a contention storm beyond the bound keeps today's rejection, now with a replay count", async t => {
 const f = await fixture(t);
 const keys = Array.from({ length: 8 }, (_, n) => `storm${n}`);
 for (const key of keys) await writeFile(join(f.cwd, key), key);
 await f.run({ ...enroll, requirements: keys.map(key => ({ key, outcome: key, verification: "check" })), tasks: keys.map(key => ({ key, title: key, covers: [key] })) });
 const before = f.snapshots.length;
 const results = await Promise.all(keys.map((key, n) => f.store.mutate({ operation: "start", task: key, scope: [key] }, f.ctx, `storm-${n}`)));
 const ok = results.filter(r => r.ok), rejected = results.filter(r => !r.ok);
 assert.equal(ok.length + rejected.length, keys.length);
 assert.ok(ok.length >= 2 && rejected.length >= 1, `expected partial recovery and residual conflicts, got ${ok.length}/${rejected.length}`);
 for (const r of rejected) { assert.equal(r.code, "preparation_changed"); assert.match(r.message!, /Replayed/); }
 assert.equal(f.snapshots.length - before, ok.length);
 const ids = f.store.current()!.attempts.map(a => a.id);
 assert.equal(new Set(ids).size, ids.length);
 // An exhausted start still starts cleanly once the storm drains.
 const remaining = keys.find(key => !f.store.current()!.attempts.some(a => a.task === key))!;
 const retry = await f.store.mutate({ operation: "start", task: remaining, scope: [remaining] }, f.ctx, "storm-retry");
 assert.equal(retry.ok, true, retry.message);
});

test("education surfaces: start names its attempt and window; rejections teach the remedy; description leads with the rules", async t => {
 const f = await fixture(t);
 let tool: ToolDefinition | undefined;
 registerGoalTool({ registerTool(value: ToolDefinition) { tool = value; }, on() {} } as unknown as ExtensionAPI, f.store, () => false);
 assert.ok(tool);
 assert.match(tool.description, /^High-frequency rules: report names the attempt id start returned, or omits attempt only while exactly one matching attempt runs \(optionally selected by task\)/);
 const ctx = { cwd: f.cwd, sessionManager: { getSessionId: () => "fixture" } } as unknown as ExtensionContext;
 let serial = 0;
 let lastDetails: { ok?: boolean; code?: string } | undefined;
 const runTool = async (args: Record<string, unknown>) => {
  const response = await tool!.execute(`tool-${++serial}`, args as never, undefined, undefined, ctx);
  lastDetails = response.details as { ok?: boolean; code?: string };
  return (response.content as Array<{ text?: string }>).map(part => part.text ?? "").join("\n");
 };
 await runTool(enroll);
 await runTool({ operation: "start", task: "one", scope: ["one"] });
 assert.equal(lastDetails?.ok, true);
 assert.equal(f.store.current()!.attempts.find(a => a.task === "one" && a.status === "running")?.id, "A1");
 const wrongAttempt = await runTool({ operation: "report", attempt: "A9", summary: "nothing" });
 assert.match(wrongAttempt, /Report the exact attempt id start returned, or inspect when several attempts run\./);
 await runTool({ operation: "report", summary: "claimed check", facts: [{ key: "check", kind: "host", check: "unit", result: "pass" }] });
 assert.equal(lastDetails?.ok, false);
 assert.equal(lastDetails?.code, "observation_required");
 const badJudgment = await runTool({ operation: "report", summary: "honest outcome", facts: [{ key: "k", kind: "agent", check: "c", result: "pass" }], judgments: [{ subject: "task:one", facts: ["A1:nope"], accepted: true, rationale: "r" }] });
 assert.match(badJudgment, /Reference current fact ids as attempt:key; the facts list shows what is usable\./);
 // An idempotent start replay must not attach another call's attempt guidance.
 const runToolWithId = async (id: string, args: Record<string, unknown>) => {
  const response = await tool!.execute(id, args as never, undefined, undefined, ctx);
  return (response.content as Array<{ text?: string }>).map(part => part.text ?? "").join("\n");
 };
 await runTool({ operation: "report", attempt: "A1", summary: "first slice reported without acceptance" });
 const created = await runToolWithId("dup-start", { operation: "start", task: "one", scope: ["one"] });
 assert.match(created, /Attempt A2 is running for task one/);
 await runTool({ operation: "report", attempt: "A2", summary: "second slice reported without acceptance" });
 await runTool({ operation: "start", task: "one", scope: ["one"] });
 const replayed = await runToolWithId("dup-start", { operation: "start", task: "one", scope: ["one"] });
 assert.match(replayed, /Already recorded\./);
 assert.ok(!/Attempt A\d is running/.test(replayed), "idempotent replay must not name another call's attempt");
});

test("cancellation and fencing never replay", async t => {
 const f = await fixture(t); await f.run(enroll);
 let fencedReads = 0;
 const fenced = await f.store.mutate({ operation: "start", task: "one", scope: ["one"] }, { ...f.ctx, fenced: () => { fencedReads++; return true; } }, "fenced-call");
 assert.equal(fenced.ok, false); assert.equal(fenced.code, "preparation_changed");
 assert.ok(!fenced.message!.includes("Replayed"));
 assert.equal(fencedReads, 2); // one preparation only: the lease check plus the wrapper's replay guard
 const controller = new AbortController(); controller.abort();
 const aborted = await f.store.mutate({ operation: "start", task: "two", scope: ["two"] }, { ...f.ctx, signal: controller.signal }, "aborted-call");
 assert.equal(aborted.ok, false); assert.equal(aborted.code, "preparation_changed");
 assert.ok(!aborted.message!.includes("Replayed"));
 assert.equal(f.store.current()!.attempts.length, 0);
});
