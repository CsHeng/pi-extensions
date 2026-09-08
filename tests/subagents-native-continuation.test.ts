import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { JsonlProtocolParser } from "../extensions/subagents/protocol.ts";

const exec = promisify(execFile);
const provider = new URL("fixtures/subagents-native-session.ts", import.meta.url).pathname;
const extension = new URL("fixtures/subagents-native-context.ts", import.meta.url).pathname;
const development = new URL("../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url).pathname;
const rows = (text: string) => text.trim().split("\n").map((line) => JSON.parse(line));
const eventFacts = (stdout: string) => JSON.stringify(rows(stdout).map((event) => ({ type: event.type, reason: event.reason, aborted: event.aborted, willRetry: event.willRetry, error: Boolean(event.errorMessage), stop: event.message?.stopReason, tokens: event.message?.usage?.totalTokens })));

async function fixture(t: test.TestContext, installed: boolean, automatic: boolean) {
	const base = await mkdtemp(join(tmpdir(), "native-managed-context-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const cwd = join(base, "repo"); const agent = join(base, "agent");
	await mkdir(cwd); await mkdir(agent); await exec("git", ["init", "-q", cwd]);
	await writeFile(join(agent, "settings.json"), JSON.stringify({ compaction: { enabled: automatic, reserveTokens: 512, keepRecentTokens: automatic ? 8 : 32 } }));
	const native = join(base, "parent.jsonl");
	return { base, native, async run(mode: string, prompt: string | readonly string[] = "next", extra: NodeJS.ProcessEnv = {}, path = native) {
		const args = ["--mode", "json", "-p", "--session", path, "--no-extensions", "-e", provider, "-e", extension, "--no-skills", "--no-context-files", "--no-prompt-templates", "--approve", "--model", "subagent-fixture/fixture", "--thinking", "off", ...(typeof prompt === "string" ? [prompt] : prompt)];
		const execution = exec(installed ? "pi" : process.execPath, installed ? args : [development, ...args], { cwd, timeout: 15_000, maxBuffer: 4 * 1024 * 1024,
			env: { PATH: process.env.PATH, HOME: base, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", CSHENG_NATIVE_CONTEXT_MODE: mode, ...extra },
		});
		execution.child.stdin?.end();
		const result = await execution;
		const parser = new JsonlProtocolParser(); parser.push(result.stdout);
		return { ...result, parsed: parser.finish(), events: rows(result.stdout), entries: rows(await readFile(path, "utf8")) };
	} };
}

for (const installed of [false, true]) test(`native ${installed ? "installed" : "development"} context survives reopen, manual compaction, reload and tree/fork; final payload honors later handlers`, async (t) => {
	const f = await fixture(t, installed, false);
	let sessionId: string | undefined;
	let visible = false;
	for (const mode of ["seed", "index", "disabled", "late-remove", "manual", "index", "reload", "index"]) {
		const result = await f.run(mode, mode === "reload" ? ["/fixture-managed-reload", "post-reload"] : mode === "seed" ? "seed ".repeat(400) : "next");
		sessionId ??= result.entries[0].id;
		assert.equal(result.entries[0].id, sessionId);
		assert.equal(result.entries.some((entry) => entry.customType === "csheng-managed-session-index"), false);
		if (mode === "reload") assert.equal(result.events.filter((event) => event.type === "agent_start").length, 1);
		assert.equal(result.parsed.reportComplete, true, `${mode}: ${eventFacts(result.stdout)}`);
		const index: number = ["seed", "disabled", "late-remove"].includes(mode) || !visible ? 0 : 1;
		const tool = ["disabled", "late-remove"].includes(mode) ? 0 : 1;
		assert.equal(result.parsed.output, `index=${index};managedTool=${tool};private=0`, result.stderr);
		if (mode === "seed") visible = true;
		if (mode === "manual") {
			assert.equal(result.entries.filter((entry) => entry.type === "compaction").length, 1);
			const compacted = result.entries.find((entry) => entry.type === "compaction");
			assert.match(compacted.summary, /^SYNTHETIC_SUMMARY/);
			assert.ok(result.entries.some((entry) => entry.id === compacted.firstKeptEntryId));
		}
	}
	assert.equal(rows(await readFile(f.native, "utf8")).filter((entry) => entry.message?.role === "user").length, 8);
	const output = join(f.base, "fork.json");
	await f.run("fork", "/fixture-managed-fork", { CSHENG_NATIVE_FORK_RESULT: output });
	const fork = JSON.parse(await readFile(output, "utf8"));
	assert.notEqual(fork.id, sessionId);
	assert.equal(relative(f.base, fork.native).startsWith(".."), false);
	const forked = await f.run("index", "next", {}, fork.native);
	assert.equal(forked.parsed.reportComplete, true);
	assert.equal(forked.parsed.output, "index=0;managedTool=1;private=0");
	const tree = await f.run("tree", "/fixture-managed-tree");
	assert.equal(tree.events.some((event) => event.type === "agent_start"), false);
	const moved = await f.run("index");
	assert.equal(moved.entries[0].id, sessionId);
	assert.equal(moved.parsed.reportComplete, true);
	assert.equal(moved.parsed.output, "index=0;managedTool=1;private=0");
});

for (const installed of [false, true]) for (const compaction of ["threshold", "overflow"]) test(`native ${installed ? "installed" : "development"} ${compaction} compaction retains managed context through recovery and reopen`, async (t) => {
	const f = await fixture(t, installed, true);
	for (const phase of ["seed", "trigger", "reopen"]) {
		const result = await f.run(phase === "seed" ? "seed" : "index", phase === "seed" ? "seed ".repeat(400) : "next", phase === "trigger" ? { CSHENG_NATIVE_COMPACTION_MODE: compaction } : {});
		assert.equal(result.parsed.reportComplete, true, eventFacts(result.stdout));
		assert.equal(result.parsed.output, `index=${phase === "seed" ? 0 : 1};managedTool=1;private=0`);
		if (phase === "trigger") {
			assert.ok(result.events.some((event) => event.type === "compaction_end" && event.reason === compaction), eventFacts(result.stdout));
			if (compaction === "overflow") assert.ok(result.parsed.usage.turns >= 2);
		}
	}
	const entries = rows(await readFile(f.native, "utf8"));
	assert.equal(entries.filter((entry) => entry.type === "compaction").length, 1);
	assert.equal(entries.filter((entry) => entry.message?.role === "user").length, 3);
	assert.equal(entries.some((entry) => entry.customType === "csheng-managed-session-index"), false);
});
