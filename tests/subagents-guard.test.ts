import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CHILD_CAPABILITY_ENV, CHILD_MARKER_ENV, type ChildCapabilityManifest } from "../extensions/subagents/contracts.ts";
import childGuard from "../extensions/subagents/child-capability-guard.ts";
import { authorizePath, loadCapability, parseCapability } from "../extensions/subagents/path-policy.ts";

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

test("guard is inert outside a marked child and blocks invalid marked children", async () => {
	const originalMarker = process.env[CHILD_MARKER_ENV];
	const originalCapability = process.env[CHILD_CAPABILITY_ENV];
	try {
		delete process.env[CHILD_MARKER_ENV];
		const handlers: Array<(event: any) => unknown> = [];
		await childGuard({ on(_name: string, handler: (event: any) => unknown) { handlers.push(handler); } } as never);
		assert.equal(handlers.length, 0);

		process.env[CHILD_MARKER_ENV] = "1";
		delete process.env[CHILD_CAPABILITY_ENV];
		await childGuard({ on(_name: string, handler: (event: any) => unknown) { handlers.push(handler); } } as never);
		assert.equal(handlers.length, 1);
		assert.deepEqual(await handlers[0]?.({ toolName: "read", input: { path: "." } }), {
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
