import assert from "node:assert/strict";
import { appendFile, chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SharedWriteRecorder, readSharedWrites, revertSharedWrites } from "../extensions/agents/shared-writes.ts";

async function workspace(t: test.TestContext) {
	const base = await mkdtemp(join(tmpdir(), "agents-shared-writes-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const root = join(base, "checkout"), scratch = join(base, "scratch");
	await mkdir(root, { recursive: true });
	return { root, scratch, recorder: new SharedWriteRecorder(scratch) };
}
async function agentWrite(recorder: SharedWriteRecorder, path: string, content: string) {
	recorder.beforeWrite(path); await writeFile(path, content); recorder.afterWrite(path);
}

test("revert restores files still as the agent left them and keeps files someone changed afterwards", async t => {
	const { root, scratch, recorder } = await workspace(t);
	const edited = join(root, "edited.txt"), created = join(root, "created.txt"), later = join(root, "later.txt");
	await writeFile(edited, "original"); await writeFile(later, "original");
	await agentWrite(recorder, edited, "agent");
	await agentWrite(recorder, created, "agent");
	await agentWrite(recorder, later, "agent");
	await writeFile(later, "user after the agent");
	assert.deepEqual((await readSharedWrites(scratch)).paths, [edited, created, later]);
	const outcome = await revertSharedWrites(scratch, [root]);
	assert.deepEqual(outcome.reverted, [edited, created]); assert.deepEqual(outcome.kept, [later]); assert.equal(outcome.shell, false);
	assert.equal(await readFile(edited, "utf8"), "original");
	await assert.rejects(readFile(created));
	assert.equal(await readFile(later, "utf8"), "user after the agent");
});

test("a change by someone else between two of the agent's writes keeps the file even when the agent's last write preserved it", async t => {
	const { root, scratch, recorder } = await workspace(t);
	const file = join(root, "shared.txt");
	await writeFile(file, "original\n");
	await agentWrite(recorder, file, "original\nagent-1\n");
	await appendFile(file, "user line\n");
	await agentWrite(recorder, file, "original\nagent-1\nuser line\nagent-2\n");
	const outcome = await revertSharedWrites(scratch, [root]);
	assert.deepEqual(outcome.kept, [file]); assert.deepEqual(outcome.reverted, []);
	assert.match(await readFile(file, "utf8"), /user line/);
});

test("a failed file-tool write records no after-image, and manifest destinations outside the agent's grant are never touched", async t => {
	const { root, scratch, recorder } = await workspace(t);
	const outside = join(root, "..", "outside.txt"), inside = join(root, "inside.txt");
	await writeFile(outside, "outside original"); await writeFile(inside, "inside original");
	// An attribution entry naming a path outside the writer's grant (the manifest lives in the agent's own scratch).
	await agentWrite(recorder, outside, "rewritten");
	recorder.beforeWrite(inside); // the tool then failed: no afterWrite
	const outcome = await revertSharedWrites(scratch, [root]);
	assert.deepEqual(outcome.reverted, []); assert.deepEqual(outcome.kept.sort(), [inside, outside].sort());
	assert.equal(await readFile(outside, "utf8"), "rewritten");
	assert.equal(await readFile(inside, "utf8"), "inside original");
});

test("shell use is reported as unattributed", async t => {
	const { root, scratch, recorder } = await workspace(t);
	recorder.shellUsed(); recorder.shellUsed();
	await agentWrite(recorder, join(root, "x.txt"), "x");
	assert.equal((await readSharedWrites(scratch)).shell, true);
	assert.equal((await revertSharedWrites(scratch, [root])).shell, true);
});

test("a later permission change, a parent replaced by a symlink, and a failed attempt are kept or unreported", async t => {
	const { root, scratch, recorder } = await workspace(t);
	const moded = join(root, "moded.sh"), nested = join(root, "dir", "inner.txt"), failed = join(root, "failed.txt");
	await writeFile(moded, "original"); await mkdir(join(root, "dir")); await writeFile(nested, "original"); await writeFile(failed, "original");
	await agentWrite(recorder, moded, "agent");
	await agentWrite(recorder, nested, "agent");
	recorder.beforeWrite(failed);
	await chmod(moded, 0o755);
	const elsewhere = join(root, "..", "elsewhere"); await mkdir(elsewhere); await writeFile(join(elsewhere, "inner.txt"), "agent");
	await rename(join(root, "dir"), join(root, "..", "dir-moved")); await symlink(elsewhere, join(root, "dir"));
	assert.deepEqual((await readSharedWrites(scratch)).paths, [moded, nested], "only completed writes count as written");
	const outcome = await revertSharedWrites(scratch, [root]);
	assert.deepEqual(outcome.reverted, []);
	assert.deepEqual(outcome.kept.sort(), [failed, moded, nested].sort());
	assert.equal(await readFile(join(elsewhere, "inner.txt"), "utf8"), "agent", "a destination outside the grant stays untouched");
});
