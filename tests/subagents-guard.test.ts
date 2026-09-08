import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { CHILD_CAPABILITY_ENV, CHILD_MARKER_ENV, type ChildCapabilityManifest } from "../extensions/subagents/contracts.ts";
import childGuard from "../extensions/subagents/child-capability-guard.ts";
import { assertCanonicalExternalRoots, authorizePath, loadCapability, parseCapability } from "../extensions/subagents/path-policy.ts";

async function fixture(t: test.TestContext) {
	const root = await mkdtemp(join(tmpdir(), "subagent-guard-"));
	const outside = await mkdtemp(join(tmpdir(), "subagent-outside-"));
	t.after(async () => {
		await rm(root, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	});
	await mkdir(join(root, "src"));
	await writeFile(join(root, "src", "allowed.ts"), "old");
	await writeFile(join(outside, "secret"), "secret");
	const manifest: ChildCapabilityManifest = {
		version: 1,
		root,
		role: "worker",
		readRoots: [join(root, "src")],
		writePaths: [join(root, "src", "allowed.ts"), join(root, "src", "new.ts")],
	};
	return { root, outside, manifest };
}

test("path policy permits scoped reads and exact writes", async (t) => {
	const { manifest } = await fixture(t);
	assert.equal((await authorizePath(manifest, "read", "src/allowed.ts")).allowed, true);
	assert.equal((await authorizePath(manifest, "edit", "src/allowed.ts")).allowed, true);
	assert.equal((await authorizePath(manifest, "write", "src/new.ts")).allowed, true);
	assert.match((await authorizePath(manifest, "write", "src/other.ts")).reason ?? "", /exact declared/);
});

test("path policy rejects lexical and symlink escape", async (t) => {
	const { root, outside, manifest } = await fixture(t);
	assert.equal((await authorizePath(manifest, "read", "../escape")).allowed, false);
	assert.equal((await authorizePath(manifest, "read", join(outside, "secret"))).allowed, false);
	await symlink(outside, join(root, "src", "linked"));
	assert.equal((await authorizePath(manifest, "read", "src/linked/secret")).allowed, false);

	await symlink(join(root, "src", "allowed.ts"), join(root, "src", "write-link"));
	const linkedManifest = { ...manifest, writePaths: [...manifest.writePaths, join(root, "src", "write-link")] };
	assert.match((await authorizePath(linkedManifest, "write", "src/write-link")).reason ?? "", /symlinks/);
});

test("replacing a canonical root ancestor is fatal even when the replacement root is a directory", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "subagent-root-identity-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const parent = join(base, "parent");
	const root = join(parent, "repo");
	await mkdir(root, { recursive: true });
	const manifest: ChildCapabilityManifest = { version: 1, root, role: "worker", readRoots: [root], writePaths: [join(root, "file")] };
	await mkdir(join(base, "outside", "repo"), { recursive: true });
	await rename(parent, join(base, "preserved"));
	await symlink(join(base, "outside"), parent);
	for (const tool of ["read", "write"]) {
		const result = await authorizePath(manifest, tool, "file");
		assert.equal(result.allowed, false);
		assert.equal(result.fatal, true);
	}
});

test("read-only role cannot gain write capability", async (t) => {
	const { root } = await fixture(t);
	assert.throws(() => parseCapability({ version: 1, root, role: "reviewer", readRoots: [root], writePaths: [join(root, "x")] }), /read-only/);
	const reviewer: ChildCapabilityManifest = { version: 1, root, role: "reviewer", readRoots: [root], writePaths: [] };
	assert.match((await authorizePath(reviewer, "write", "x")).reason ?? "", /not allowed/);
});

test("capability loader requires a private regular manifest", async (t) => {
	const { root, manifest } = await fixture(t);
	const file = join(root, "capability.json");
	await writeFile(file, JSON.stringify(manifest), { mode: 0o644 });
	assert.match((await loadCapability({ [CHILD_CAPABILITY_ENV]: file })).error ?? "", /permissions/);
	await chmod(file, 0o600);
	assert.equal((await loadCapability({ [CHILD_CAPABILITY_ENV]: file })).manifest?.role, "worker");
});

test("exact v1 manifests normalize without external roots and reject widened v1 objects", async (t) => {
	const { root, manifest } = await fixture(t);
	const parsed = parseCapability(manifest);
	assert.equal(parsed.version, 2);
	assert.deepEqual(parsed.externalReadRoots, []);
	assert.throws(() => parseCapability({ ...manifest, externalReadRoots: [] }), /v1 cannot contain external/);
	assert.throws(() => parseCapability({ ...manifest, unexpected: true }), /unknown fields/);
	assert.throws(() => parseCapability({ ...manifest, version: 3 }), /invalid version/);
});

test("v2 manifests parse internal and external roots and reject relative or symlink aliases", async (t) => {
	const { root, outside } = await fixture(t);
	const externalFile = join(outside, "secret");
	const parsed = parseCapability({
		version: 2,
		root,
		role: "reviewer",
		readRoots: [join(root, "src")],
		writePaths: [],
		externalReadRoots: [externalFile],
	});
	assert.equal(parsed.version, 2);
	assert.deepEqual(parsed.externalReadRoots, [externalFile]);
	assert.throws(() => parseCapability({
		version: 2,
		root,
		role: "reviewer",
		readRoots: [join(root, "src")],
		writePaths: [],
		externalReadRoots: [externalFile],
		unexpected: true,
	}), /unknown fields/);
	assert.throws(() => parseCapability({
		version: 2,
		root,
		role: "reviewer",
		readRoots: [join(root, "src")],
		writePaths: [],
		externalReadRoots: ["../outside"],
	}), /absolute and canonical/);
	assert.throws(() => parseCapability({
		version: 2,
		root,
		role: "reviewer",
		readRoots: [join(root, "src")],
		writePaths: [],
		externalReadRoots: [`${outside}/nested/../secret`],
	}), /absolute and canonical/);

	const alias = join(outside, "alias-secret");
	await symlink(externalFile, alias);
	const aliased = parseCapability({
		version: 2,
		root,
		role: "reviewer",
		readRoots: [join(root, "src")],
		writePaths: [],
		externalReadRoots: [alias],
	});
	await assert.rejects(assertCanonicalExternalRoots(aliased), /absolute and canonical/);

	assert.throws(() => parseCapability({
		version: 2,
		root,
		role: "worker",
		readRoots: [join(root, "src")],
		writePaths: [join(root, "src", "allowed.ts")],
		externalReadRoots: [externalFile],
	}), /worker capability cannot contain external/);
	assert.throws(() => parseCapability({
		version: 2,
		root,
		role: "reviewer",
		readRoots: [root],
		writePaths: [join(root, "x")],
		externalReadRoots: [],
	}), /read-only/);
});

test("declared external file and directory reads work through each read-only tool", async (t) => {
	const { root, outside } = await fixture(t);
	const externalDir = join(outside, "lib");
	await mkdir(externalDir);
	const externalFile = join(externalDir, "note.ts");
	await writeFile(externalFile, "note");
	const manifest: ChildCapabilityManifest = {
		version: 2,
		root,
		role: "explorer",
		readRoots: [join(root, "src")],
		writePaths: [],
		externalReadRoots: [externalFile, externalDir],
	};
	for (const tool of ["read", "grep", "find", "ls"]) {
		assert.equal((await authorizePath(manifest, tool, externalFile)).allowed, true, tool);
		assert.equal((await authorizePath(manifest, tool, externalDir)).allowed, true, tool);
	}
	assert.equal((await authorizePath(manifest, "read", join(externalDir, "note.ts"))).allowed, true);
});

test("component names beginning with two dots remain contained", async (t) => {
	const { root, outside } = await fixture(t);
	const internalDir = join(root, "src", "..config");
	const externalDir = join(outside, "..config");
	await mkdir(internalDir);
	await mkdir(externalDir);
	const internalFile = join(internalDir, "local.ts");
	const externalFile = join(externalDir, "external.ts");
	await writeFile(internalFile, "local");
	await writeFile(externalFile, "external");
	const reviewer: ChildCapabilityManifest = {
		version: 2,
		root,
		role: "reviewer",
		readRoots: [join(root, "src")],
		writePaths: [],
		externalReadRoots: [outside],
	};
	assert.equal((await authorizePath(reviewer, "read", "src/..config/local.ts")).allowed, true);
	assert.equal((await authorizePath(reviewer, "read", externalFile)).allowed, true);
});

test("undeclared, sibling, and relative traversal cannot select an external root", async (t) => {
	const { root, outside, manifest } = await fixture(t);
	const externalFile = join(outside, "secret");
	const reviewer: ChildCapabilityManifest = {
		version: 2,
		root,
		role: "reviewer",
		readRoots: [join(root, "src")],
		writePaths: [],
		externalReadRoots: [externalFile],
	};
	assert.equal((await authorizePath(reviewer, "read", join(outside, "other"))).allowed, false);
	assert.equal((await authorizePath(reviewer, "read", outside)).allowed, false);
	assert.equal((await authorizePath(reviewer, "read", relative(root, externalFile))).allowed, false);
	assert.equal((await authorizePath(manifest, "read", externalFile)).allowed, false);
	assert.match((await authorizePath(reviewer, "write", externalFile)).reason ?? "", /not allowed/);
	assert.equal((await authorizePath({ ...manifest, version: 2, externalReadRoots: [] }, "edit", externalFile)).allowed, false);
});

test("recursive grep and find reject descendant symlink escape from internal and external roots", async (t) => {
	const { root, outside } = await fixture(t);
	const externalDir = join(outside, "ext");
	const hidden = await mkdtemp(join(tmpdir(), "subagent-hidden-"));
	t.after(async () => rm(hidden, { recursive: true, force: true }));
	await mkdir(externalDir);
	await writeFile(join(externalDir, "ok.ts"), "ok");
	await writeFile(join(hidden, "leak"), "leak");
	await symlink(join(hidden, "leak"), join(root, "src", "leak-link"));
	await symlink(join(hidden, "leak"), join(externalDir, "leak-link"));
	const explorer: ChildCapabilityManifest = {
		version: 2,
		root,
		role: "explorer",
		readRoots: [join(root, "src")],
		writePaths: [],
		externalReadRoots: [externalDir],
	};
	assert.equal((await authorizePath(explorer, "read", "src/allowed.ts")).allowed, true);
	assert.equal((await authorizePath(explorer, "read", "src/leak-link")).allowed, false);
	assert.equal((await authorizePath(explorer, "grep", "src")).allowed, false);
	assert.equal((await authorizePath(explorer, "find", "src")).allowed, false);
	assert.equal((await authorizePath(explorer, "ls", "src")).allowed, true);
	assert.equal((await authorizePath(explorer, "read", join(externalDir, "ok.ts"))).allowed, true);
	assert.equal((await authorizePath(explorer, "read", join(externalDir, "leak-link"))).allowed, false);
	assert.equal((await authorizePath(explorer, "grep", externalDir)).allowed, false);
	assert.equal((await authorizePath(explorer, "find", externalDir)).allowed, false);
	assert.equal((await authorizePath(explorer, "ls", externalDir)).allowed, true);
});

test("a safe rejection permits correction but lost root terminates subsequent calls", async (t) => {
	const { root, manifest } = await fixture(t);
	const file = join(root, "capability.json");
	await writeFile(file, JSON.stringify(manifest), { mode: 0o600 });
	const originalMarker = process.env[CHILD_MARKER_ENV];
	const originalCapability = process.env[CHILD_CAPABILITY_ENV];
	try {
		process.env[CHILD_MARKER_ENV] = "1";
		process.env[CHILD_CAPABILITY_ENV] = file;
		let handler: (event: any) => Promise<any> = async () => undefined;
		await childGuard({ on(_name: string, value: typeof handler) { handler = value; } } as never);
		const rejected = await handler({ toolName: "write", input: { path: "src/other.ts" } });
		assert.equal(rejected.block, true);
		assert.equal(rejected.terminate, false);
		assert.equal(await handler({ toolName: "write", input: { path: "src/allowed.ts" } }), undefined);
		await rm(root, { recursive: true });
		assert.equal((await handler({ toolName: "read", input: { path: "src/allowed.ts" } })).terminate, true);
	} finally {
		if (originalMarker === undefined) delete process.env[CHILD_MARKER_ENV];
		else process.env[CHILD_MARKER_ENV] = originalMarker;
		if (originalCapability === undefined) delete process.env[CHILD_CAPABILITY_ENV];
		else process.env[CHILD_CAPABILITY_ENV] = originalCapability;
	}
});

test("guard is inert outside a marked child and blocks invalid marked children", async () => {
	const originalMarker = process.env[CHILD_MARKER_ENV];
	const originalCapability = process.env[CHILD_CAPABILITY_ENV];
	try {
		delete process.env[CHILD_MARKER_ENV];
		const handlers = new Map<string, (event: any) => unknown>();
		const pi = { on(name: string, handler: (event: any) => unknown) { handlers.set(name, handler); } };
		await childGuard(pi as never);
		assert.equal(handlers.size, 0);

		process.env[CHILD_MARKER_ENV] = "1";
		delete process.env[CHILD_CAPABILITY_ENV];
		await childGuard(pi as never);
		assert.ok(handlers.has("tool_call"));
		assert.deepEqual(await handlers.get("tool_call")?.({ toolName: "read", input: { path: "." } }), {
			block: true,
			terminate: true,
			reason: "child capability manifest is missing",
		});
	} finally {
		if (originalMarker === undefined) delete process.env[CHILD_MARKER_ENV];
		else process.env[CHILD_MARKER_ENV] = originalMarker;
		if (originalCapability === undefined) delete process.env[CHILD_CAPABILITY_ENV];
		else process.env[CHILD_CAPABILITY_ENV] = originalCapability;
	}
});
