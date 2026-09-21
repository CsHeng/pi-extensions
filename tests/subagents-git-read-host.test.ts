import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { CHILD_CAPABILITY_ENV, CHILD_MARKER_ENV } from "../extensions/subagents/contracts.ts";
const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));

test("installed native readonly child discovers git_read, reads history and refuses sibling paths", { timeout: 30_000 }, async t => {
 try { await exec("pi", ["--version"], { timeout: 5000 }); } catch { t.skip("installed Pi unavailable; no installation performed"); return; }
 const base = await mkdtemp(join(tmpdir(), "git-read-native-")); t.after(() => rm(base, { recursive: true, force: true }));
 const repo = join(base, "repo"); const agent = join(base, "agent"); await mkdir(join(repo, "src"), { recursive: true }); await mkdir(agent);
 const env = { PATH: process.env.PATH, HOME: base, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_TELEMETRY: "0", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
 const git = async (...args: string[]) => (await exec("git", ["-C", repo, ...args], { env })).stdout.trim();
 await git("init", "-q"); await writeFile(join(repo, "src/a"), "historical fixture\n"); await writeFile(join(repo, "private"), "outside grant\n");
 await git("add", "."); await git("commit", "-qm", "fixture"); const head = await git("rev-parse", "HEAD");
 await writeFile(join(repo, "src/a"), "current fixture\n");
 const before = { index: await readFile(join(repo, ".git/index")), source: await readFile(join(repo, "src/a")) };
 const manifest = join(base, "capability.json"); await writeFile(manifest, JSON.stringify({ version: 2, role: "reviewer", root: repo, readRoots: [join(repo, "src")], writePaths: [], externalReadRoots: [] }), { mode: 0o600 });
 const inputs = join(base, "queries.json"); await writeFile(inputs, JSON.stringify([
  { operation: "show", repository: "src", paths: ["src/a"], head },
  { operation: "show", repository: "src", paths: ["private"], head },
 ]));
 await writeFile(join(agent, "settings.json"), JSON.stringify({ packages: [], compaction: { enabled: false } }));
 const implementation = process.env.CSHENG_GIT_READ_PROBE_ROOT ?? root;
 const execution = exec("pi", ["--mode", "json", "--no-session", "--no-extensions", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-approve",
  "--tools", "read,grep,find,ls,git_read", "-e", join(implementation, "extensions/subagents/child-capability-guard.ts"),
  "-e", join(root, "tests/fixtures/subagents-git-read-host.ts"), "--model", "git-read-fixture/fixture", "--thinking", "off", "--", "read fixture history"],
  { cwd: repo, env: { ...env, [CHILD_MARKER_ENV]: "1", [CHILD_CAPABILITY_ENV]: manifest, GIT_READ_FIXTURE_INPUTS: inputs }, timeout: 20_000, killSignal: "SIGKILL", maxBuffer: 2 * 1024 * 1024 });
 execution.child.stdin?.end();
 const result = await execution;
 const events = result.stdout.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line));
 const ends = events.filter(event => event.type === "tool_execution_end");
 assert.equal(ends.length, 2, result.stdout.slice(-4000));
 assert.equal(ends[0].result.details.ok, true); assert.equal(ends[0].result.details.head, head); assert.equal(ends[0].result.details.text, "historical fixture\n");
 assert.equal(ends[1].result.details.code, "read_scope_denied");
 const messages = events.filter(event => event.type === "message_end" && event.message.role === "assistant");
 const final = JSON.parse(messages.at(-1).message.content[0].text);
 assert.deepEqual(final.tools.sort(), ["read", "grep", "find", "ls", "git_read"].sort());
 assert.deepEqual(await readFile(join(repo, ".git/index")), before.index); assert.deepEqual(await readFile(join(repo, "src/a")), before.source);
 assert.equal(await git("rev-parse", "HEAD"), head);
});
