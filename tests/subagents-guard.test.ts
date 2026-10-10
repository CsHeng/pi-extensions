import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CHILD_CAPABILITY_MANIFEST_VERSION, type ChildCapabilityManifest } from "../extensions/subagents/contracts.ts";
import { authorizePath, parseCapability } from "../extensions/subagents/path-policy.ts";
import { getManagedRole, toolsForAccess } from "../extensions/subagents/roles.ts";
import { isNativePathTool, isNativeShellTool, readOnlyToolArgs } from "../extensions/subagents/native-context.ts";

async function fixture(t: test.TestContext) {
	const root = await mkdtemp(join(tmpdir(), "subagent-guard-"));
	const outside = await mkdtemp(join(tmpdir(), "subagent-outside-"));
	t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); });
	await mkdir(join(root, "src"));
	await writeFile(join(root, "src", "allowed.ts"), "old");
	await writeFile(join(outside, "secret"), "secret");
	const read: ChildCapabilityManifest = { version: CHILD_CAPABILITY_MANIFEST_VERSION, role: "reviewer", cwd: root, grants: [{ permission: "read", path: root }], roots: [] };
	const write: ChildCapabilityManifest = { version: CHILD_CAPABILITY_MANIFEST_VERSION, role: "explorer", cwd: root, grants: [{ permission: "write", path: root }], roots: [] };
	return { root, outside, read, write };
}

test("the same grant exposes the same tools regardless of purpose label", () => {
	assert.deepEqual(toolsForAccess(false), ["read", "grep", "find", "ls", "git_read", "bash"]);
	assert.ok(toolsForAccess(true).includes("edit"));
	assert.ok(toolsForAccess(true).includes("bash"));
});

test("native operation hints depend on access, not the role label", () => {
	for (const role of ["explorer", "reviewer", "worker"] as const) {
		assert.deepEqual(getManagedRole(role, false).tools, toolsForAccess(false));
		assert.deepEqual(getManagedRole(role, true).tools, toolsForAccess(true));
	}
});

test("native path/shell classification and read-only selection are shared", () => {
	for (const tool of ["read", "grep", "find", "ls", "edit", "write"]) assert.equal(isNativePathTool(tool), true, tool);
	assert.equal(isNativePathTool("bash"), false);
	assert.equal(isNativePathTool("fixture_custom"), false);
	for (const tool of ["bash", "powershell"]) assert.equal(isNativeShellTool(tool), true, tool);
	assert.equal(isNativeShellTool("read"), false);
	// Read-only intent removes only the mutating builtins; a write grant adds no ceiling.
	assert.deepEqual(readOnlyToolArgs(false), ["--exclude-tools", "edit,write"]);
	assert.deepEqual(readOnlyToolArgs(true), []);
});

test("read grants do not become write grants and write grants stay inside the path", async (t) => {
	const { root, outside, read, write } = await fixture(t);
	assert.equal((await authorizePath(read, "read", join(root, "src", "allowed.ts"))).allowed, true);
	assert.equal((await authorizePath(read, "edit", join(root, "src", "allowed.ts"))).allowed, false);
	assert.equal((await authorizePath(write, "edit", join(root, "src", "allowed.ts"))).allowed, true);
	assert.equal((await authorizePath(write, "write", join(outside, "secret"))).allowed, false);
	assert.equal((await authorizePath(write, "write", join(root, ".git", "config"))).allowed, false);
});

test("unsupported capability versions are rejected without normalization", () => {
	assert.throws(() => parseCapability({ version: 2, root: "/repo", role: "worker", readRoots: ["/repo"], writePaths: [], externalReadRoots: [] }), /unsupported version/);
	assert.throws(() => parseCapability({ version: 1, root: "/repo", role: "explorer", readRoots: ["/repo"], writePaths: [] }), /unsupported version/);
});

test("an authorized missing file or directory is created without granting its siblings", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "subagent-guard-missing-"));
	const outside = await mkdtemp(join(tmpdir(), "subagent-guard-missing-outside-"));
	t.after(async () => { await rm(base, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); });
	await mkdir(join(base, "src"));
	const src = await lstat(join(base, "src"));
	const baseInfo = await lstat(base);
	const manifest: ChildCapabilityManifest = { version: CHILD_CAPABILITY_MANIFEST_VERSION, role: "worker", cwd: base, grants: [
		{ permission: "write", path: join(base, "src", "new.ts"), anchor: { path: join(base, "src"), dev: src.dev, ino: src.ino } },
		{ permission: "write", path: join(base, "build"), anchor: { path: base, dev: baseInfo.dev, ino: baseInfo.ino } },
	], roots: [] };
	assert.equal((await authorizePath(manifest, "write", join(base, "src", "new.ts"))).allowed, true);
	assert.equal((await authorizePath(manifest, "write", "src/new.ts")).allowed, true);
	assert.equal((await authorizePath(manifest, "write", join(base, "build", "out.ts"))).allowed, true);
	assert.equal((await authorizePath(manifest, "write", join(base, "src", "other.ts"))).allowed, false);
	assert.equal((await authorizePath(manifest, "write", join(base, "src"))).allowed, false);
	assert.equal((await authorizePath(manifest, "write", join(outside, "secret"))).allowed, false);
	await writeFile(join(base, "src", "new.ts"), "created");
	assert.equal((await authorizePath(manifest, "read", join(base, "src", "new.ts"))).allowed, true);
	// A persisted existing-parent anchor rejects a replacement directory at the same pathname.
	await rename(join(base, "src"), join(base, "src-old"));
	await mkdir(join(base, "src"));
	const replaced = await authorizePath(manifest, "write", join(base, "src", "new.ts"));
	assert.equal(replaced.allowed, false);
	assert.equal(replaced.fatal, true);
});

test("a stable prepared parent allows an authorized writable leaf to be created, replaced or deleted", async (t) => {
	const parent = await mkdtemp(join(tmpdir(), "subagent-guard-parent-"));
	const outside = await mkdtemp(join(tmpdir(), "subagent-guard-parent-outside-"));
	t.after(async () => { await rm(parent, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); });
	await writeFile(join(outside, "secret"), "secret");
	const prepared = join(parent, "prepared"); await mkdir(prepared);
	const a = join(prepared, "a.ts"); await writeFile(a, "original");
	const anchorInfo = await lstat(prepared);
	const manifest: ChildCapabilityManifest = { version: CHILD_CAPABILITY_MANIFEST_VERSION, role: "worker", cwd: prepared, grants: [{ permission: "write", path: a, anchor: { path: prepared, dev: anchorInfo.dev, ino: anchorInfo.ino } }], roots: [] };
	assert.equal((await authorizePath(manifest, "write", a)).allowed, true);
	assert.equal((await authorizePath(manifest, "read", a)).allowed, true);
	await rm(a);
	assert.equal((await authorizePath(manifest, "write", a)).allowed, true, "an authorized new leaf is created under the stable parent");
	await writeFile(a, "recreated");
	assert.equal((await authorizePath(manifest, "write", a)).allowed, true);
	await rm(a); await writeFile(a, "replaced");
	assert.equal((await authorizePath(manifest, "write", a)).allowed, true, "an atomic same-path replacement is not an identity failure");
	// A symlink at the writable leaf still cannot escape the stable parent.
	await rm(a); await symlink(join(outside, "secret"), a);
	assert.equal((await authorizePath(manifest, "write", a)).allowed, false);
	assert.equal((await authorizePath(manifest, "read", a)).allowed, false);
	// Replacing the stable parent itself is a capability change.
	await rm(a);
	await rename(prepared, join(parent, "moved")); await mkdir(prepared);
	const replaced = await authorizePath(manifest, "write", a);
	assert.equal(replaced.allowed, false);
	assert.equal(replaced.fatal, true);
});

test("a writable selector anchor does not grant sibling reads through a replaced leaf", async t => {
	const base = await mkdtemp(join(tmpdir(), "subagent-read-anchor-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	await writeFile(join(base, "selected"), "allowed"); await writeFile(join(base, "private"), "not granted");
	const info = await lstat(base);
	const manifest: ChildCapabilityManifest = { version: CHILD_CAPABILITY_MANIFEST_VERSION, role: "worker", cwd: base, grants: [{ permission: "write", path: join(base, "selected"), anchor: { path: base, dev: info.dev, ino: info.ino } }], roots: [] };
	await rm(join(base, "selected"));
	assert.equal((await authorizePath(manifest, "read", "selected")).allowed, true, "a declared missing leaf is still in range; existence is not authority");
	await symlink("private", join(base, "selected"));
	assert.equal((await authorizePath(manifest, "read", "selected")).allowed, false);
	assert.equal((await authorizePath(manifest, "write", "selected")).allowed, false);
	await mkdir(join(base, "directory")); await writeFile(join(base, "directory", "owned"), "allowed");
	await symlink("owned", join(base, "directory", "internal"));
	manifest.grants[0]!.path = join(base, "directory");
	assert.equal((await authorizePath(manifest, "read", "directory/internal")).allowed, true, "an internal alias remains within the declared directory grant");
	await symlink("../private", join(base, "directory", "external"));
	assert.equal((await authorizePath(manifest, "read", "directory/external")).allowed, false);
});

test("a replaced ancestor above the child cwd is rejected for reads and writes", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "subagent-guard-ancestor-"));
	const outside = await mkdtemp(join(tmpdir(), "subagent-guard-ancestor-outside-"));
	t.after(async () => { await rm(base, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); });
	const real = join(base, "real");
	const cwd = join(real, "child");
	await mkdir(cwd, { recursive: true });
	await writeFile(join(cwd, "a.txt"), "original");
	await mkdir(join(outside, "child"), { recursive: true });
	await writeFile(join(outside, "child", "a.txt"), "external");
	await writeFile(join(outside, "child", "new.ts"), "external-new");
	const childInfo = await lstat(cwd);
	const manifest: ChildCapabilityManifest = { version: CHILD_CAPABILITY_MANIFEST_VERSION, role: "worker", cwd, grants: [
		{ permission: "write", path: join(cwd, "a.txt"), anchor: { path: cwd, dev: childInfo.dev, ino: childInfo.ino } },
		{ permission: "write", path: join(cwd, "new.ts"), anchor: { path: cwd, dev: childInfo.dev, ino: childInfo.ino } },
	], roots: [] };
	assert.equal((await authorizePath(manifest, "read", join(cwd, "a.txt"))).allowed, true);
	assert.equal((await authorizePath(manifest, "write", join(cwd, "new.ts"))).allowed, true);
	await rename(real, join(base, "moved"));
	await symlink(outside, real);
	for (const [tool, path] of [["read", join(cwd, "a.txt")], ["write", join(cwd, "a.txt")], ["write", join(cwd, "new.ts")]] as const) {
		const denied = await authorizePath(manifest, tool, path);
		assert.equal(denied.allowed, false, `${tool} ${path}`);
		assert.equal(denied.fatal, true, `${tool} ${path}`);
	}
});

test("a read-only evidence pin is not imposed on an overlapping writable leaf", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "subagent-guard-overlap-"));
	t.after(async () => { await rm(base, { recursive: true, force: true }); });
	const a = join(base, "a.ts"); await writeFile(a, "original");
	const aInfo = await lstat(a);
	const baseInfo = await lstat(base);
	const manifest: ChildCapabilityManifest = { version: CHILD_CAPABILITY_MANIFEST_VERSION, role: "worker", cwd: base, grants: [
		{ permission: "read", path: a, pin: { dev: aInfo.dev, ino: aInfo.ino } },
		{ permission: "write", path: a, anchor: { path: base, dev: baseInfo.dev, ino: baseInfo.ino } },
	], roots: [] };
	await writeFile(join(base, "a2.ts"), "replaced");
	await rename(join(base, "a2.ts"), a);
	assert.equal((await authorizePath(manifest, "read", a)).allowed, true, "the writable anchor owns the path and ignores a stale read pin");
	assert.equal((await authorizePath(manifest, "write", a)).allowed, true);
	const z = join(base, "z.ts"); await writeFile(z, "z");
	const zInfo = await lstat(z);
	const readOnly: ChildCapabilityManifest = { ...manifest, grants: [{ permission: "read", path: z, pin: { dev: zInfo.dev, ino: zInfo.ino } }] };
	assert.equal((await authorizePath(readOnly, "read", z)).allowed, true);
	await writeFile(join(base, "z2.ts"), "changed");
	await rename(join(base, "z2.ts"), z);
	const denied = await authorizePath(readOnly, "read", z);
	assert.equal(denied.allowed, false);
	assert.equal(denied.fatal, true);
});
