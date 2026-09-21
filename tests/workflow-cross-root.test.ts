import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, writeFile, rm, symlink, unlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalScope, createGoalStore, overlaps, type GoalContext, type SessionEntryLike } from "../extensions/workflow/goal-store.ts";
import { fingerprintScope } from "../extensions/workflow/fingerprints.ts";
import type { GoalOperation } from "../extensions/workflow/goal-contracts.ts";
import { accepted } from "../extensions/workflow/goal-state.ts";

async function fixture(t: test.TestContext) {
 const root = await mkdtemp(join(tmpdir(), "workflow-cross-root-"));
 t.after(() => rm(root, { recursive: true, force: true }));
 const cwd = join(root, "architecture"), skills = join(root, "skills"), extensions = join(root, "extensions"), installed = join(root, "installation");
 for (const dir of [cwd, skills, extensions, installed]) { await mkdir(dir); await writeFile(join(dir, "same"), "same bytes"); }
 const snapshots: SessionEntryLike[] = [];
 const store = createGoalStore((customType, data) => snapshots.push({ type: "custom", customType, data: structuredClone(data) }));
 const ctx: GoalContext = { cwd, now: "2026-09-21T00:00:00.000Z", sessionId: "cross-root" };
 let serial = 0;
 const run = async (op: GoalOperation) => { const result = await store.mutate(op, ctx, `cross-${++serial}`); assert.equal(result.ok, true, result.message); return result; };
 await run({ operation: "enroll", goal: "Cross-repository change", delivery: "local installation", authority: "explicit fixture", requirements: [{ key: "a", outcome: "skills", verification: "check" }, { key: "b", outcome: "extensions", verification: "check" }], tasks: [{ key: "a", title: "Skills", covers: ["a"] }, { key: "b", title: "Extensions", covers: ["b"] }] });
 const report = (key: string): GoalOperation => ({ operation: "report", task: key, summary: "Observed fixture verification", facts: [{ key: "check", kind: "agent", check: "fixture", result: "pass" }], judgments: [{ subject: `task:${key}`, facts: ["check"], accepted: true, rationale: "verified" }, { subject: `requirement:${key}`, facts: ["check"], accepted: true, rationale: "verified" }] });
 return { root, cwd, skills, extensions, installed, store, ctx, run, report, snapshots };
}

test("cross-root scope accepts absolute, parent-relative and missing non-Git targets", async t => {
 const f = await fixture(t);
 const missing = join(f.installed, "new", "entry");
 assert.deepEqual(await canonicalScope(["../skills/same", join(f.skills, "same")], f.cwd), [join(f.skills, "same")]);
 assert.deepEqual(await canonicalScope([missing], f.cwd), [missing]);
 await f.run({ operation: "start", task: "a", scope: [join(f.skills, "same"), missing], writes: [missing] });
 await f.run(f.report("a"));
 assert.equal(accepted(f.store.current()!, "task:a"), true);
 await mkdir(join(f.installed, "new")); await writeFile(missing, "installed");
 await f.run({ operation: "close", outcome: "completed", reason: "evaluate current proof" });
 assert.equal(accepted(f.store.current()!, "task:a"), false, "creation invalidates the affected source proof");
});

test("root-qualified identities distinguish copies, siblings and the local default dot", async t => {
 const f = await fixture(t);
 const a = await canonicalScope(["."], f.cwd), b = await canonicalScope([f.skills], f.cwd);
 assert.equal(overlaps(a, b), false);
 assert.equal(overlaps(b, await canonicalScope([join(f.skills, "same")], f.cwd)), true);
 assert.equal(overlaps(b, await canonicalScope([`${f.skills}-other`], f.cwd)), false);
 const first = await fingerprintScope(["same"], f.skills), copy = await fingerprintScope(["same"], f.extensions);
 assert.notEqual(first.fingerprint, copy.fingerprint, "same contents in another root are not old evidence");
 assert.deepEqual((await fingerprintScope([], f.cwd)).scope, ["."]);
 await f.run({ operation: "start", task: "a", scope: [join(f.skills, "same")] });
 await f.run(f.report("a"));
 await f.run({ operation: "start", task: "b", scope: [join(f.extensions, "same")], writes: [join(f.extensions, "same")] });
 await f.run(f.report("b"));
 await writeFile(join(f.skills, "same"), "changed"); await f.run({ operation: "close", outcome: "completed", reason: "evaluate current proof" });
 assert.equal(accepted(f.store.current()!, "task:a"), false);
 assert.equal(accepted(f.store.current()!, "task:b"), true);
});

test("a local dot writer does not block an external proof", async t => {
 const f = await fixture(t);
 await f.run({ operation: "start", task: "b", scope: ["same"], writes: ["."] });
 await f.run({ operation: "start", task: "a", scope: [join(f.skills, "same")] });
 await f.run(f.report("a"));
 assert.equal(accepted(f.store.current()!, "task:a"), true);
});

test("an aliased external writer blocks evidence for the same physical target", async t => {
 const f = await fixture(t);
 const alias = join(f.installed, "alias"); await symlink(f.skills, alias);
 await f.run({ operation: "start", task: "b", scope: [join(f.extensions, "same")], writes: [alias] });
 await f.run({ operation: "start", task: "a", scope: [join(f.skills, "same")] });
 const result = await f.run(f.report("a"));
 assert.ok(result.diagnostics.some(message => message.includes("overlapping writer")));
 assert.equal(accepted(f.store.current()!, "task:a"), false);
});

test("installation links bind retargeting without recursively reading undeclared targets", async t => {
 const f = await fixture(t);
 const link = join(f.installed, "skill"); await symlink(f.skills, link);
 const first = await fingerprintScope([link], f.cwd);
 assert.equal(first.state, "current");
 await f.run({ operation: "start", task: "a", scope: [link, join(f.skills, "same")], writes: [link] });
 await f.run(f.report("a"));
 await unlink(link); await symlink(f.extensions, link);
 assert.notEqual((await fingerprintScope([link], f.cwd)).fingerprint, first.fingerprint);
 await f.run({ operation: "close", outcome: "completed", reason: "evaluate current proof" });
 assert.equal(accepted(f.store.current()!, "task:a"), false);
 assert.equal((await fingerprintScope([f.installed], f.cwd)).state, "unavailable");
 const loop = join(f.installed, "loop"); await symlink("loop", loop);
 assert.equal((await fingerprintScope([loop], f.cwd)).state, "unavailable");
});

test("local subdirectory file links retain content tracking while external leaf siblings are not implicitly read", async t => {
 const f = await fixture(t);
 await mkdir(join(f.cwd, "src")); await symlink("../same", join(f.cwd, "src/link"));
 const local = await fingerprintScope(["src/link"], f.cwd);
 await writeFile(join(f.cwd, "same"), "updated local target");
 assert.notEqual((await fingerprintScope(["src/link"], f.cwd)).fingerprint, local.fingerprint);
 const link = join(f.installed, "link"); await symlink("same", link);
 const external = await fingerprintScope([link], f.cwd);
 const explicitTarget = await fingerprintScope([link, join(f.installed, "same")], f.cwd);
 await writeFile(join(f.installed, "same"), "updated undeclared sibling");
 assert.equal((await fingerprintScope([link], f.cwd)).fingerprint, external.fingerprint);
 assert.notEqual((await fingerprintScope([link, join(f.installed, "same")], f.cwd)).fingerprint, explicitTarget.fingerprint);
});

test("installation parent writer overlaps a link leaf even when its target is another root", async t => {
 const f = await fixture(t); const link = join(f.installed, "skill"); await symlink(f.skills, link);
 await f.run({ operation: "start", task: "b", scope: [join(f.extensions, "same")], writes: [f.installed] });
 await f.run({ operation: "start", task: "a", scope: [link] });
 const result = await f.run(f.report("a"));
 assert.ok(result.diagnostics.some(message => message.includes("overlapping writer")));
 assert.equal(accepted(f.store.current()!, "task:a"), false);
});

test("dangling ancestor retargeting invalidates missing proof and preserves destination write conflicts", async t => {
 const f = await fixture(t); const link = join(f.installed, "alias");
 const destination = join(f.skills, "not-created"); await symlink(destination, link);
 const declared = join(link, "result");
 const canonical = await canonicalScope([declared], f.cwd);
 assert.ok(canonical.includes(join(destination, "result")));
 assert.equal(overlaps(canonical, await canonicalScope([destination], f.cwd)), true);
 const first = await fingerprintScope([declared], f.cwd); assert.equal(first.state, "current");
 await f.run({ operation: "start", task: "a", scope: [declared] }); await f.run(f.report("a"));
 await unlink(link); await symlink(join(f.extensions, "not-created"), link);
 assert.notEqual((await fingerprintScope([declared], f.cwd)).fingerprint, first.fingerprint);
 await f.run({ operation: "inspect" }); assert.equal(accepted(f.store.current()!, "task:a"), false);
});

test("completed replay is revalidated before it can certify another invocation root", async t => {
 const f = await fixture(t);
 await f.run({ operation: "start", task: "a", scope: ["same"] }); await f.run(f.report("a"));
 await f.run({ operation: "start", task: "b", scope: ["same"] });
 const report = f.report("b"); report.complete = true;
 report.judgments!.push({ subject: "delivery", facts: ["check"], accepted: true, rationale: "fixture complete" });
 await f.run(report); assert.equal(f.store.current()!.fulfillment, "complete");
 const unchanged = createGoalStore(() => {}); unchanged.replay(f.snapshots); await unchanged.revalidate(f.cwd);
 assert.equal(unchanged.current()!.fulfillment, "complete");
 const moved = createGoalStore(() => {}); moved.replay(f.snapshots);
 const result = await moved.mutate({ operation: "inspect" }, { ...f.ctx, cwd: f.skills }, "recheck");
 assert.equal(result.view.state!.fulfillment, "pending"); assert.equal(result.view.state!.continuation.state, "suspended");
 assert.equal(result.view.state!.facts.some(fact => fact.usable), false);
});

test("intermediate link replacement conflicts, but sibling writes through the same alias do not", async t => {
 const f = await fixture(t); const switchRoot = join(f.root, "switch"); await mkdir(switchRoot);
 const middle = join(switchRoot, "current"), entry = join(f.installed, "entry");
 await symlink(join(f.skills, "same"), middle); await symlink(middle, entry);
 await f.run({ operation: "start", task: "b", scope: [join(f.extensions, "same")], writes: [switchRoot] });
 await f.run({ operation: "start", task: "a", scope: [entry] });
 const blocked = await f.run(f.report("a"));
 assert.ok(blocked.diagnostics.some(message => message.includes("overlapping writer")));
 const g = await fixture(t); const alias = join(g.installed, "alias"); await symlink(g.skills, alias);
 await g.run({ operation: "start", task: "b", scope: [join(g.extensions, "same")], writes: [join(alias, "other")] });
 await g.run({ operation: "start", task: "a", scope: [join(alias, "same")] });
 await g.run(g.report("a")); assert.equal(accepted(g.store.current()!, "task:a"), true);
});

test("link target parent traversal follows filesystem order, not lexical normalization", async t => {
 const f = await fixture(t); await mkdir(join(f.skills, "sub")); await mkdir(join(f.extensions, "sub"));
 const bridge = join(f.installed, "bridge"), entry = join(f.installed, "entry");
 await symlink(join(f.skills, "sub"), bridge); await symlink("bridge/../same", entry);
 assert.equal(await realpath(entry), join(f.skills, "same"));
 assert.ok((await canonicalScope([entry], f.cwd)).includes(await realpath(entry)));
 const direct = `${bridge}/../same`;
 assert.ok((await canonicalScope([direct], f.cwd)).includes(await realpath(direct)));
 const first = await fingerprintScope([entry], f.cwd), directFirst = await fingerprintScope([direct], f.cwd);
 await f.run({ operation: "start", task: "a", scope: [entry, direct] }); await f.run(f.report("a"));
 await unlink(bridge); await symlink(join(f.extensions, "sub"), bridge);
 assert.equal(await realpath(entry), join(f.extensions, "same"));
 assert.notEqual((await fingerprintScope([entry], f.cwd)).fingerprint, first.fingerprint);
 assert.notEqual((await fingerprintScope([direct], f.cwd)).fingerprint, directFirst.fingerprint);
 await f.run({ operation: "inspect" }); assert.equal(accepted(f.store.current()!, "task:a"), false);
});

test("missing traversal cannot be bypassed by parent components in a symlink target", async t => {
 const f = await fixture(t); const link = join(f.cwd, "missing-link"); await symlink("missing/../same", link);
 await assert.rejects(realpath(link), { code: "ENOENT" });
 const missing = await fingerprintScope([link], f.cwd); assert.equal(missing.state, "current");
 await f.run({ operation: "start", task: "a", scope: [link] }); await f.run(f.report("a"));
 await mkdir(join(f.cwd, "missing")); assert.equal(await realpath(link), join(f.cwd, "same"));
 assert.notEqual((await fingerprintScope([link], f.cwd)).fingerprint, missing.fingerprint);
 await f.run({ operation: "inspect" }); assert.equal(accepted(f.store.current()!, "task:a"), false);
});

test("directory scans carry intermediate link dependencies into acceptance conflicts", async t => {
 const f = await fixture(t); const src = join(f.cwd, "src"), switches = join(f.root, "switch");
 await mkdir(src); await mkdir(switches); await writeFile(join(src, "file"), "source");
 await symlink(join(src, "file"), join(switches, "current")); await symlink(join(switches, "current"), join(src, "link"));
 assert.equal((await fingerprintScope([src], f.cwd)).state, "current");
 await f.run({ operation: "start", task: "b", scope: [join(f.extensions, "same")], writes: [switches] });
 await f.run({ operation: "start", task: "a", scope: [src] });
 const blocked = await f.run(f.report("a"));
 assert.ok(blocked.diagnostics.some(message => message.includes("overlapping writer")));
 assert.equal(accepted(f.store.current()!, "task:a"), false);
});

test("parent traversal has no fictitious lexical endpoint that blocks an unrelated writer", async t => {
 const f = await fixture(t); await mkdir(join(f.skills, "sub"));
 const bridge = join(f.installed, "bridge"); await symlink(join(f.skills, "sub"), bridge);
 const source = `${bridge}/../same`;
 assert.deepEqual(await canonicalScope([source], f.cwd), [await realpath(source)]);
 await f.run({ operation: "start", task: "b", scope: [join(f.extensions, "same")], writes: [join(f.installed, "same")] });
 await f.run({ operation: "start", task: "a", scope: [source] }); await f.run(f.report("a"));
 assert.equal(accepted(f.store.current()!, "task:a"), true);
});

test("external declared directory includes its own files and missing/deleted state", async t => {
 const f = await fixture(t);
 const initial = await fingerprintScope([f.skills], f.cwd);
 assert.equal(initial.state, "current");
 await writeFile(join(f.skills, "extra"), "new");
 assert.notEqual((await fingerprintScope([f.skills], f.cwd)).fingerprint, initial.fingerprint);
 await rm(f.skills, { recursive: true });
 const removed = await fingerprintScope([f.skills], f.cwd);
 assert.equal(removed.state, "current"); assert.notEqual(removed.fingerprint, initial.fingerprint);
});
