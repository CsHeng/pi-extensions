import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { queryGitRead, registerGitRead } from "../extensions/subagents/git-read.ts";
import { runReadGit } from "../extensions/subagents/git-workspace.ts";
import { authorizePath } from "../extensions/subagents/path-policy.ts";
import { getManagedRole } from "../extensions/subagents/roles.ts";
import type { NormalizedChildCapability } from "../extensions/subagents/contracts.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
const exec = promisify(execFile);
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
async function fixture(t: test.TestContext) {
 const base = await mkdtemp(join(tmpdir(), "git-read-")); const root = join(base, "repo"); await mkdir(join(root, "src"), { recursive: true });
 t.after(() => rm(base, { recursive: true, force: true }));
 const git = async (...args: string[]) => (await exec("git", ["-C", root, ...args], { env })).stdout.trim();
 await git("init", "-q"); await writeFile(join(root, "src/a"), "old\n"); await writeFile(join(root, "outside"), "outside secret\n");
 await git("add", "."); await git("commit", "-qm", "first"); const first = await git("rev-parse", "HEAD");
 await writeFile(join(root, "src/a"), "new\n"); await git("add", "."); await git("commit", "-qm", "second"); const second = await git("rev-parse", "HEAD");
 const cap: NormalizedChildCapability = { version: 2, role: "reviewer", root, readRoots: [join(root, "src")], writePaths: [], externalReadRoots: [] };
 const query = (input: Record<string, unknown>, signal?: AbortSignal) => queryGitRead(cap, { repository: "src", paths: ["src/a"], ...input }, signal);
 const unchanged = async () => ({ index: await readFile(join(root, ".git/index")), config: await readFile(join(root, ".git/config")), refs: await git("for-each-ref", "--format=%(refname) %(objectname)"), source: await readFile(join(root, "src/a")) });
 return { base, root, git, first, second, cap, query, unchanged };
}

test("typed historical queries bind commit/blob identity without source writes", async t => {
 const f = await fixture(t); const before = await f.unchanged();
 const show = await f.query({ operation: "show", head: f.first });
 assert.equal(show.ok, true, JSON.stringify(show)); assert.equal(show.head, f.first); assert.match(show.blob!, /^[a-f0-9]{40}$/); assert.equal(show.text, "old\n");
 const diff = await f.query({ operation: "diff", base: f.first, head: f.second });
 assert.equal(diff.ok, true, JSON.stringify(diff)); assert.match(diff.text!, /-old\n\+new/); assert.equal(diff.base, f.first); assert.equal(diff.head, f.second);
 const log = await f.query({ operation: "log", limit: 1 }); assert.equal(log.ok, true); assert.equal(log.complete, false); assert.match(log.text!, /second/);
 assert.deepEqual(await f.unchanged(), before);
 await rm(join(f.root, "src/a"));
 const deleted = await f.query({ operation: "show", head: f.first }); assert.equal(deleted.ok, true); assert.equal(deleted.text, "old\n");
});

test("index/worktree/status have distinct layers and bounded identities", async t => {
 const f = await fixture(t);
 await writeFile(join(f.root, "src/a"), "staged\n"); await f.git("add", "src/a"); await writeFile(join(f.root, "src/a"), "working\n");
 await writeFile(join(f.root, "src/untracked"), "untracked");
 const before = await f.unchanged();
 const staged = await f.query({ operation: "diff", layer: "index" }); assert.equal(staged.ok, true, JSON.stringify(staged)); assert.match(staged.text!, /\+staged/); assert.doesNotMatch(staged.text!, /working/);
 const working = await f.query({ operation: "diff", layer: "worktree" }); assert.equal(working.ok, true); assert.match(working.text!, /\+working/); assert.equal(working.before, working.after);
 const status = await f.query({ operation: "status", paths: ["src"] }); assert.equal(status.ok, true, JSON.stringify(status)); assert.match(status.text!, /MM src\/a/); assert.match(status.text!, /\?\? src\/untracked/);
 assert.deepEqual(await f.unchanged(), before);
});

test("scope and grammar cannot expose sibling content or a shell", async t => {
 const f = await fixture(t);
 for (const input of [
  { operation: "show", head: f.first, paths: ["outside"] }, { operation: "show", head: f.first, paths: ["../outside"] },
  { operation: "show", head: f.first, paths: [".git/config"] }, { operation: "show", head: f.first, paths: [":(top)**"] },
  { operation: "show", head: "HEAD:outside" }, { operation: "show", head: "--help" },
  { operation: "status", repository: ".." }, { operation: "status", argv: ["reset", "--hard"] },
 ]) { const result = await f.query(input); assert.equal(result.ok, false, JSON.stringify(input)); assert.equal(result.text, undefined); }
 assert.equal((await queryGitRead({ ...f.cap, role: "worker" }, { operation: "status", repository: "src", paths: ["src"] })).code, "role_denied");
 assert.ok(getManagedRole("reviewer").tools.includes("git_read")); assert.equal(getManagedRole("reviewer").tools.includes("bash"), false);
 assert.equal((await authorizePath(f.cap, "write", "src/a")).allowed, false);
 const worker = { ...f.cap, role: "worker" as const, readRoots: [f.root], writeRoot: true };
 assert.equal((await authorizePath(worker, "write", "../escape")).allowed, false);
 assert.equal((await authorizePath(worker, "write", "src/new")).allowed, true);
 await symlink(f.base, join(f.root, "src/link"));
 assert.equal((await f.query({ operation: "status", paths: ["src/link/secret"] })).ok, false);
});

test("external read subdirectories and historical symlink blobs do not widen grants", async t => {
 const f = await fixture(t); const child = join(f.base, "child"); await mkdir(child);
 const cap = { ...f.cap, root: child, readRoots: [child], externalReadRoots: [join(f.root, "src")] };
 const allowed = await queryGitRead(cap, { operation: "show", repository: join(f.root, "src"), paths: ["src/a"], head: f.first }); assert.equal(allowed.ok, true, JSON.stringify(allowed));
 assert.equal((await queryGitRead(cap, { operation: "show", repository: join(f.root, "src"), paths: ["outside"], head: f.first })).ok, false);
 await symlink("../../outside-file", join(f.root, "src/link")); await f.git("add", "src/link"); await f.git("commit", "-qm", "symlink");
 const link = await f.query({ operation: "show", paths: ["src/link"], head: "HEAD" }); assert.equal(link.ok, true, JSON.stringify(link)); assert.equal(link.text, "../../outside-file");
 await f.git("mv", "outside", "src/moved"); await f.git("commit", "-qm", "move across grant");
 const diff = await f.query({ operation: "diff", base: f.second, head: "HEAD", paths: ["src"] }); assert.equal(diff.ok, true); assert.doesNotMatch(diff.text!, /rename from outside|diff --git a\/outside/);
});

test("hostile diff/textconv/filter programs do not execute; replacement objects do not lie", async t => {
 const f = await fixture(t); const canary = join(f.base, "EXECUTED");
 const program = join(f.base, "helper.sh"); await writeFile(program, `#!/bin/sh\ntouch '${canary}'\ncat\n`); await chmod(program, 0o700);
 await f.git("config", "diff.hostile.command", program); await f.git("config", "diff.hostile.textconv", program);
 await writeFile(join(f.root, ".gitattributes"), "src/a diff=hostile\n");
 assert.equal((await f.query({ operation: "diff", base: f.first, head: f.second })).ok, true);
 await f.git("replace", f.first, f.second);
 const show = await f.query({ operation: "show", head: f.first }); assert.equal(show.ok, true); assert.equal(show.text, "old\n");
 for (const kind of ["clean", "process"]) {
  await f.git("config", `filter.hostile.${kind}`, program); await writeFile(join(f.root, ".gitattributes"), "src/a filter=hostile\n");
  const rejected = await f.query({ operation: "diff", layer: "worktree" }); assert.equal(rejected.ok, false); assert.match(rejected.code!, /unsupported_git_config|unsupported_content_filter/);
  assert.equal((await f.query({ operation: "status" })).ok, false);
  await f.git("config", "--unset", `filter.hostile.${kind}`);
 }
 await writeFile(join(f.root, ".gitattributes"), "src/a working-tree-encoding=UTF-16\n"); assert.equal((await f.query({ operation: "status" })).code, "unsupported_content_filter");
 await assert.rejects(readFile(canary), { code: "ENOENT" });
});

test("worktree configuration and sentinel-named filter drivers fail closed", async t => {
 const f = await fixture(t); const canary = join(f.base, "EXECUTED"); const helper = join(f.base, "filter.sh");
 await writeFile(helper, `#!/bin/sh\ntouch '${canary}'\ncat\n`); await chmod(helper, 0o700);
 await f.git("config", "extensions.worktreeConfig", "true");
 for (const driver of ["unset", "unspecified"]) for (const kind of ["clean", "process"]) {
  await f.git("config", "--worktree", `filter.${driver}.${kind}`, helper);
  await writeFile(join(f.root, ".gitattributes"), `src/a filter=${driver}\n`);
  for (const input of [{ operation: "status" }, { operation: "diff", layer: "worktree" }]) assert.equal((await f.query(input)).code, "unsupported_git_config");
  await f.git("config", "--worktree", "--unset", `filter.${driver}.${kind}`);
 }
 await f.git("config", "--unset", "extensions.worktreeConfig"); await rm(join(f.root, ".git/config.worktree"));
 await writeFile(join(f.root, ".gitattributes"), "src/a filter=unset\n");
 assert.equal((await f.query({ operation: "status" })).code, "unsupported_content_filter");
 await assert.rejects(readFile(canary), { code: "ENOENT" });
});

test("tracked parent symlink to a grant's ancestor cannot expose sibling bytes", async t => {
 const f = await fixture(t); const allowed = join(f.root, "src/allowed"); const link = join(allowed, "link");
 await mkdir(link, { recursive: true }); await writeFile(join(link, "secret"), "tracked\n"); await writeFile(join(f.root, "src/secret"), "OUTSIDE_GRANT\n");
 await f.git("add", "src"); await f.git("commit", "-qm", "tracked descendant");
 await rm(link, { recursive: true }); await symlink("..", link);
 const cap = { ...f.cap, readRoots: [allowed] };
 for (const paths of [["src/allowed"], ["src/allowed/link/secret"]]) {
  const result = await queryGitRead(cap, { operation: "status", repository: "src/allowed", paths });
  assert.equal(result.code, "read_scope_denied"); assert.equal(result.text, undefined); assert.equal(result.before, undefined);
 }
});

test("historical gitlink identities are visible; mutable gitlink inspection is explicitly unsupported", async t => {
 const f = await fixture(t);
 await f.git("update-index", "--add", "--cacheinfo", `160000,${f.first},src/module`); await f.git("commit", "-qm", "first gitlink"); const base = await f.git("rev-parse", "HEAD");
 await f.git("update-index", "--cacheinfo", `160000,${f.second},src/module`); await f.git("commit", "-qm", "second gitlink");
 const diff = await f.query({ operation: "diff", base, head: "HEAD", paths: ["src/module"] });
 assert.equal(diff.ok, true, JSON.stringify(diff)); assert.equal(diff.complete, true);
 assert.ok(diff.text!.includes(`-Subproject commit ${f.first}`)); assert.ok(diff.text!.includes(`+Subproject commit ${f.second}`));
 assert.equal((await f.query({ operation: "status", paths: ["src"] })).code, "unsupported_mutable_gitlink");
 await f.git("update-index", "--force-remove", "src/module");
 assert.equal((await f.query({ operation: "diff", layer: "index", paths: ["src"] })).code, "unsupported_mutable_gitlink", "deleted gitlink still belongs to the HEAD/index comparison");
});

test("binary and attribute-suppressed patches never become complete review evidence", async t => {
 const f = await fixture(t);
 await writeFile(join(f.root, ".gitattributes"), "src/a -diff\n");
 assert.equal((await f.query({ operation: "diff", base: f.first, head: f.second })).code, "unsupported_binary_content");
 await writeFile(join(f.root, "src/a"), "working\n");
 assert.equal((await f.query({ operation: "diff", layer: "worktree" })).complete, false);
 await rm(join(f.root, ".gitattributes")); await writeFile(join(f.root, "src/a"), "binary\0bytes"); await f.git("add", "src/a"); await f.git("commit", "-qm", "binary");
 assert.equal((await f.query({ operation: "diff", base: f.second, head: "HEAD" })).code, "unsupported_binary_content");
 assert.equal((await f.query({ operation: "show", head: "HEAD" })).code, "unsupported_binary_content");
});

test("object-source escapes, cancellation, and output limits fail explicitly", async t => {
 const f = await fixture(t);
 const aborted = AbortSignal.abort(); assert.equal((await f.query({ operation: "show", head: f.first }, aborted)).code, "git_aborted");
 await writeFile(join(f.root, ".git/objects/info/alternates"), "/outside/objects\n"); assert.equal((await f.query({ operation: "show", head: f.first })).code, "unsupported_object_source");
 await rm(join(f.root, ".git/objects/info/alternates"));
 await writeFile(join(f.root, ".git/info/grafts"), `${f.second} ${f.first}\n`); assert.equal((await f.query({ operation: "show", head: f.first })).code, "unsupported_object_source");
 await rm(join(f.root, ".git/info/grafts"));
 await writeFile(join(f.root, "src/a"), "界".repeat(27_000)); await f.git("add", "src/a"); await f.git("commit", "-qm", "large");
 const large = await f.query({ operation: "show", head: "HEAD" }); assert.equal(large.ok, true); assert.equal(large.complete, false); assert.ok(Buffer.byteLength(large.text!) <= 65536); assert.equal(large.text!.includes("�"), false);
 await writeFile(join(f.root, "src/a"), "x".repeat(1100_000)); await f.git("add", "src/a"); await f.git("commit", "-qm", "oversize");
 assert.equal((await f.query({ operation: "show", head: "HEAD" })).code, "git_output_limit");
});

test("registered linked worktree metadata is allowed without granting sibling source", async t => {
 const f = await fixture(t); const worktree = join(f.base, "linked");
 await f.git("worktree", "add", "--detach", worktree, f.first);
 const cap = { ...f.cap, root: worktree, readRoots: [join(worktree, "src")] };
 const result = await queryGitRead(cap, { operation: "show", repository: "src", paths: ["src/a"], head: "HEAD" });
 assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.head, f.first); assert.equal(result.text, "old\n");
 assert.equal((await queryGitRead(cap, { operation: "status", repository: f.root, paths: ["src"] })).ok, false);
});

test("bounded Git process timeout and in-flight cancellation reap the owned process", async t => {
 const f = await fixture(t); const bin = join(f.base, "bin"); await mkdir(bin);
 const pidfile = join(f.base, "pid");
 await writeFile(join(bin, "git"), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(pidfile)}, String(process.pid)); setInterval(() => {}, 1000);\n`);
 await chmod(join(bin, "git"), 0o700);
 const prior = process.env.PATH; process.env.PATH = `${bin}:${prior}`;
 try {
  await assert.rejects(runReadGit(f.root, ["status"], { timeoutMs: 300 }), (e: unknown) => (e as { code: string }).code === "git_timeout");
  const timedOutPid = Number(await readFile(pidfile, "utf8"));
  assert.throws(() => process.kill(timedOutPid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH");
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 300);
  try { await assert.rejects(runReadGit(f.root, ["status"], { signal: controller.signal }), (e: unknown) => (e as { code: string }).code === "git_aborted"); }
  finally { clearTimeout(timer); }
  const abortedPid = Number(await readFile(pidfile, "utf8"));
  assert.throws(() => process.kill(abortedPid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH");
 } finally { if (prior === undefined) delete process.env.PATH; else process.env.PATH = prior; }
});

test("registered readonly tool enforces its own typed boundary", async t => {
 const f = await fixture(t); let tool: any;
 registerGitRead({ registerTool(value) { tool = value; } } as ExtensionAPI, f.cap);
 const result = await tool.execute("call", { operation: "show", repository: "src", paths: ["src/a"], head: f.first });
 assert.equal(result.details.ok, true); assert.equal(result.details.text, "old\n");
 const denied = await tool.execute("call", { operation: "show", repository: "src", paths: ["outside"], head: f.first }); assert.equal(denied.isError, true);
});
