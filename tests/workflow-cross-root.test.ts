import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, writeFile, rm, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalScope, createGoalStore, overlaps, type GoalContext } from "../extensions/workflow/goal-store.ts";
import type { GoalOperation } from "../extensions/workflow/goal-contracts.ts";
import { accepted } from "../extensions/workflow/goal-state.ts";

async function fixture(t: test.TestContext) {
 const root = await realpath(await mkdtemp(join(tmpdir(), "workflow-cross-root-")));
 t.after(() => rm(root, { recursive: true, force: true }));
 const cwd = join(root, "architecture"), skills = join(root, "skills"), extensions = join(root, "extensions"), installed = join(root, "installation");
 for (const dir of [cwd, skills, extensions, installed]) { await mkdir(dir); await writeFile(join(dir, "same"), "same bytes"); }
 const store = createGoalStore(() => {});
 const ctx: GoalContext = { cwd, now: "2026-09-21T00:00:00.000Z", sessionId: "cross-root" };
 let serial = 0;
 const run = async (op: GoalOperation) => { const result = await store.mutate(op, ctx, `cross-${++serial}`); assert.equal(result.ok, true, result.message); return result; };
 await run({ operation: "enroll", goal: "Cross-repository change", delivery: "local installation", authority: "explicit fixture", requirements: [{ key: "a", outcome: "skills", verification: "check" }, { key: "b", outcome: "extensions", verification: "check" }], tasks: [{ key: "a", title: "Skills", covers: ["a"] }, { key: "b", title: "Extensions", covers: ["b"] }] });
 const report = (key: string): GoalOperation => ({ operation: "report", task: key, summary: "Observed fixture verification", facts: [{ id: "check", kind: "agent", check: "fixture", result: "pass" }], judgments: [{ target: { kind: "task", id: key }, facts: ["check"], accepted: true, rationale: "verified" }] });
 return { cwd, skills, extensions, installed, store, run, report };
}

test("cross-root declarations accept absolute, parent-relative and missing non-Git targets without content certification", async t => {
 const f = await fixture(t); const missing = join(f.installed, "new", "entry");
 assert.deepEqual(await canonicalScope(["../skills/same", join(f.skills, "same")], f.cwd), [join(f.skills, "same")]);
 assert.deepEqual(await canonicalScope([missing], f.cwd), [missing]);
 await f.run({ operation: "start", task: "a", scope: [join(f.skills, "same"), missing], writes: [missing] }); await f.run(f.report("a"));
 await mkdir(join(f.installed, "new")); await writeFile(missing, "installed"); await f.run({ operation: "inspect" });
 assert.equal(accepted(f.store.current()!, "task:a"), true);
});

test("physical root-qualified identities distinguish copies, siblings and default dot", async t => {
 const f = await fixture(t);
 const a = await canonicalScope(["."], f.cwd), b = await canonicalScope([f.skills], f.cwd);
 assert.equal(overlaps(a, b), false);
 assert.equal(overlaps(b, await canonicalScope([join(f.skills, "same")], f.cwd)), true);
 assert.equal(overlaps(b, await canonicalScope([`${f.skills}-other`], f.cwd)), false);
 assert.notDeepEqual(await canonicalScope(["same"], f.skills), await canonicalScope(["same"], f.extensions));
});

for (const alias of [false, true]) test(`active external writer ${alias ? "through alias" : "direct"} blocks overlapping acceptance`, async t => {
 const f = await fixture(t); const link = join(f.installed, "alias"); await symlink(f.skills, link);
 await f.run({ operation: "start", task: "b", scope: [join(f.extensions, "same")], writes: [alias ? link : f.skills] });
 await f.run({ operation: "start", task: "a", scope: [join(f.skills, "same")] });
 const result = await f.run(f.report("a"));
 assert.ok(result.diagnostics.some(message => message.includes("overlapping writer")));
 assert.equal(accepted(f.store.current()!, "task:a"), false);
});

test("a local dot writer does not block external declared evidence", async t => {
 const f = await fixture(t);
 await f.run({ operation: "start", task: "b", scope: ["same"], writes: ["."] });
 await f.run({ operation: "start", task: "a", scope: [join(f.skills, "same")] }); await f.run(f.report("a"));
 assert.equal(accepted(f.store.current()!, "task:a"), true);
});

test("link parent traversal follows physical order without a fictitious lexical endpoint", async t => {
 const f = await fixture(t); await mkdir(join(f.skills, "sub"));
 const bridge = join(f.installed, "bridge"); await symlink(join(f.skills, "sub"), bridge);
 const source = `${bridge}/../same`;
 assert.deepEqual(await canonicalScope([source], f.cwd), [join(f.skills, "same")]);
 await f.run({ operation: "start", task: "b", scope: [join(f.extensions, "same")], writes: [join(f.installed, "same")] });
 await f.run({ operation: "start", task: "a", scope: [source] }); await f.run(f.report("a"));
 assert.equal(accepted(f.store.current()!, "task:a"), true);
});

test("explicit source alias ancestor replacement remains an overlap, without scanning descendants", async t => {
 const f = await fixture(t); const bridge = join(f.installed, "bridge"); await symlink(f.skills, bridge);
 await f.run({ operation: "start", task: "b", scope: [join(f.extensions, "same")], writes: [bridge] });
 await f.run({ operation: "start", task: "a", scope: [join(bridge, "same")] });
 assert.ok((await f.run(f.report("a"))).diagnostics.some(message => message.includes("overlapping writer")));
});
