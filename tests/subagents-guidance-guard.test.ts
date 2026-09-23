import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { authorizePath, parseCapability } from "../extensions/subagents/path-policy.ts";
import type { ChildCapabilityManifest } from "../extensions/subagents/contracts.ts";

test("internal guidance grant is read-only and narrower than task external roots", async t => {
	const base = await mkdtemp(join(tmpdir(), "subagent-guidance-guard-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const root = join(base, "source"); const global = join(base, "global"); const unrelated = join(base, "unrelated");
	await Promise.all([root, global, unrelated].map(path => mkdir(path, { recursive: true })));
	await writeFile(join(global, "SKILL.md"), "guide");
	await writeFile(join(global, "reference.md"), "reference");
	await writeFile(join(unrelated, "secret"), "not guidance");
	await symlink(unrelated, join(global, "escape"));
	const manifest: ChildCapabilityManifest = { version: 2, role: "worker", root, readRoots: [root], writePaths: [], externalReadRoots: [], writeRoot: true,
		guidance: { contextFiles: [], readRoots: [global], physicalRoots: [global] } };
	assert.ok(parseCapability(manifest).guidance);
	assert.equal((await authorizePath(manifest, "read", join(global, "SKILL.md"))).allowed, true);
	assert.equal((await authorizePath(manifest, "read", join(global, "reference.md"))).allowed, true);
	assert.equal((await authorizePath(manifest, "read", join(unrelated, "secret"))).allowed, false);
	assert.equal((await authorizePath(manifest, "read", join(global, "escape", "secret"))).allowed, false);
	assert.equal((await authorizePath(manifest, "find", global)).allowed, false);
	assert.equal((await authorizePath(manifest, "write", join(global, "SKILL.md"))).allowed, false);
	assert.equal((await authorizePath(manifest, "bash", join(global, "SKILL.md"))).allowed, false);
	assert.throws(() => parseCapability({ ...manifest, guidance: { contextFiles: [], readRoots: ["../global"], physicalRoots: [global] } }), /invalid guidance paths/);
	const alias = join(base, "installed-guide");
	await symlink(global, alias);
	const pinned: ChildCapabilityManifest = { ...manifest, guidance: { contextFiles: [], readRoots: [alias], physicalRoots: [global] } };
	assert.equal((await authorizePath(pinned, "read", join(alias, "SKILL.md"))).allowed, true);
	await writeFile(join(unrelated, "SKILL.md"), "retargeted");
	await unlink(alias); await symlink(unrelated, alias);
	const retarget = await authorizePath(pinned, "read", join(alias, "SKILL.md"));
	assert.equal(retarget.allowed, false);
	assert.equal(retarget.fatal, true);
});
