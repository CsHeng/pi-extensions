import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { JsonlProtocolParser } from "../extensions/subagents/protocol.ts";
import { installedHostEnvironment } from "../scripts/installed-host-env.ts";
const exec = promisify(execFile);
const hostEnv = installedHostEnvironment();

for (const mode of ["aggregate", "retry"]) test(`installed host ${mode} completes from final message and actual execution evidence`, async (t) => {
	try { await exec("pi", ["--version"], { env: hostEnv, timeout: 5000 }); } catch { t.skip("installed Pi unavailable; no installation performed"); return; }
	const base = await mkdtemp(join(tmpdir(), "stream-host-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const agent = join(base, "agent"); await mkdir(agent);
	await writeFile(join(agent, "settings.json"), JSON.stringify({ retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 }, compaction: { enabled: false } }));
	const launched = exec("pi", ["--mode", "json", "-p", "--session", join(base, "native.jsonl"), "--no-extensions", "-e", new URL("fixtures/subagents-stream-host.ts", import.meta.url).pathname, "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-approve", "--model", "stream-fixture/fixture", "--thinking", "off", "--", "offline fixture"], { cwd: base, timeout: 30_000, maxBuffer: 16 * 1024 * 1024, env: { PATH: hostEnv.PATH, HOME: base, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", STREAM_FIXTURE_MODE: mode } });
	launched.child.stdin?.end();
	const { stdout } = await launched;
	const lines = stdout.trim().split("\n");
	const events = lines.map(line => JSON.parse(line));
	if (mode === "aggregate") assert.ok(lines.some(line => Buffer.byteLength(line) > 1024 * 1024 && JSON.parse(line).type === "agent_end"));
	else {
		assert.ok(events.some(event => event.type === "message_end" && event.message?.stopReason === "error" && event.message.content.some((part: any) => part.type === "toolCall")));
		assert.equal(events.filter(event => event.type === "tool_execution_start").length, 0);
	}
	const parser = new JsonlProtocolParser();
	for (let offset = 0; offset < stdout.length; offset += 8192) parser.push(stdout.slice(offset, offset + 8192));
	const result = parser.finish();
	assert.equal(result.reportComplete, true, JSON.stringify(result));
	assert.equal(result.output, "complete synthetic report");
	assert.ok(result.usage.turns > 0);
	assert.ok((await readFile(join(base, "native.jsonl"), "utf8")).endsWith("\n"));
	const withoutSettlement = new JsonlProtocolParser();
	withoutSettlement.push(events.filter(event => event.type !== "agent_settled").map(event => JSON.stringify(event)).join("\n") + "\n");
	assert.equal(withoutSettlement.finish().reportComplete, false);
});
