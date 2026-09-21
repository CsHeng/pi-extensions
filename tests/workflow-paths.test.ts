import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test, { type TestContext } from "node:test";
import { pathIdentity } from "../extensions/workflow/paths.ts";
import { fingerprintScope } from "../extensions/workflow/fingerprints.ts";

async function fixture(t: TestContext): Promise<string> {
 const root = await realpath(await mkdtemp(join(tmpdir(), "workflow-paths-")));
 t.after(() => rm(root, { recursive: true, force: true }));
 await mkdir(join(root, "installation"));
 await mkdir(join(root, "skills", "sub"), { recursive: true });
 await writeFile(join(root, "installation", "same"), "unrelated");
 await writeFile(join(root, "skills", "same"), "physical target");
 await symlink(join(root, "skills", "sub"), join(root, "installation", "bridge"));
 return root;
}

test("path identity follows absolute and relative links before parent components", async t => {
 const root = await fixture(t);
 const bridge = join(root, "installation", "bridge");
 await symlink(`..${sep}skills${sep}sub`, join(root, "installation", "relative"));
 await symlink(`bridge${sep}..${sep}same`, join(root, "installation", "nested"));
 for (const entry of [`${bridge}/../same`, `${root}/installation/relative/../same`, `${root}/installation/nested`]) {
  assert.equal((await pathIdentity(entry)).physical, join(root, "skills", "same"));
  assert.equal(await readFile(entry, "utf8"), "physical target");
 }
 const identity = await pathIdentity(`${bridge}/../same`);
 assert.deepEqual(identity.links, [{ path: bridge, target: join(root, "skills", "sub") }]);
 assert.equal((await pathIdentity(`${bridge}/../same`, false)).physical, join(root, "skills", "same"));
 // An actual final link stays replaceable when the caller asks not to follow it.
 assert.equal((await pathIdentity(join(root, "installation", "nested"), false)).physical, join(root, "installation", "nested"));
});

test("non-directory components cannot be traversed via child, dot, parent or trailing separators", async t => {
 const root = await fixture(t);
 const file = join(root, "skills", "same");
 await symlink(file, join(root, "file-link"));
 await symlink(`${file}/`, join(root, "slash-target"));
 await symlink(`${file}/../sub`, join(root, "parent-target"));
 for (const entry of [file, join(root, "file-link")]) {
  for (const suffix of ["/child", "/.", "/..", "/"]) {
   for (const followLeaf of [true, false]) {
    await assert.rejects(pathIdentity(entry + suffix, followLeaf), { code: "ENOTDIR" });
   }
   assert.equal((await fingerprintScope([entry + suffix], root)).state, "unavailable");
  }
 }
 for (const link of ["slash-target", "parent-target"]) {
  await assert.rejects(pathIdentity(join(root, link)), { code: "ENOTDIR" });
 }
 // Directory separators remain valid, including inside a link target.
 await symlink(`${root}/skills/`, join(root, "directory-link"));
 assert.equal((await pathIdentity(`${root}/directory-link/`)).physical, join(root, "skills"));
});

test("missing tails retain their first missing component and cannot escape through parent traversal", async t => {
 const root = await fixture(t);
 const missing = join(root, "skills", "missing");
 for (const input of [`${missing}/../same`, `${root}/installation/bridge/../missing/../same`]) {
  const identity = await pathIdentity(input);
  assert.equal(identity.physical, missing);
  assert.equal(identity.missing, missing);
 }
 const tail = await pathIdentity(`${missing}/child`);
 assert.equal(tail.physical, join(missing, "child"));
 assert.equal(tail.missing, missing);
 await symlink("missing/../same", join(root, "skills", "dangling"));
 assert.equal((await pathIdentity(join(root, "skills", "dangling"))).missing, missing);
});

test("dot traversal and replaceable leaves cannot bypass directory search permission", async t => {
 if (process.platform === "win32" || process.getuid?.() === 0) {
  t.skip("requires a non-root POSIX process for mode-bit search permissions");
  return;
 }
 const root = await fixture(t);
 const locked = join(root, "locked");
 await mkdir(locked);
 await chmod(locked, 0o600);
 try {
  for (const suffix of ["/.", "/..", "/../skills/same", "/", "/child"]) {
   for (const followLeaf of [true, false]) {
    await assert.rejects(pathIdentity(locked + suffix, followLeaf), { code: "EACCES" });
   }
   assert.equal((await fingerprintScope([locked + suffix], root)).state, "unavailable");
  }
 } finally {
  await chmod(locked, 0o700);
 }
});

test("symlink cycles are bounded rather than producing a physical identity", async t => {
 const root = await fixture(t);
 await symlink("cycle-b", join(root, "cycle-a"));
 await symlink("cycle-a", join(root, "cycle-b"));
 await assert.rejects(pathIdentity(join(root, "cycle-a")), /symlink resolution limit/);
 assert.equal((await fingerprintScope([join(root, "cycle-a")], root)).state, "unavailable");
});
