import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const cc = join(homedir(), ".pi/agent/npm/node_modules/pi-cc-extensions/extensions/index.ts");
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("installed Pi and CC: one working writer preserves fast tokens and slow durations", { timeout: 40_000 }, async t => {
	try { await access(cc); await access("/usr/bin/script"); } catch {
		t.skip("requires installed CC and util-linux script; no installation performed"); return;
	}
	if (spawnSync("pi", ["--version"], { encoding: "utf8", timeout: 5_000 }).status !== 0) {
		t.skip("requires installed Pi"); return;
	}
	const base = await mkdtemp(join(tmpdir(), "work-timing-tui-"));
	const agent = join(base, "agent"); await mkdir(agent);
	await writeFile(join(agent, "settings.json"), JSON.stringify({ packages: [], compaction: { enabled: false } }));
	// CC's optional working-message writer must not co-own this row.
	await writeFile(join(agent, "claude-code-style.json"), JSON.stringify({ enableWorkingMessage: false, showStartupHeader: false,
		enableSessionReference: false, enableAgentAutocomplete: false, enableAgentSummary: false }));
	const args = ["pi", "--no-extensions", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-session", "--no-approve",
		"-e", join(root, "extensions/work-timing/index.ts"), "-e", cc, "-e", join(root, "tests/fixtures/work-timing-tui.ts"),
		"--model", "working-fixture/fixture", "--thinking", "off", "--tui-mode", "fullscreen", "--", "working fixture"];
	const child = spawn("script", ["-q", "-e", "-f", "-c", `stty cols 160 rows 40; exec ${args.map(quote).join(" ")}`, "/dev/null"], {
		cwd: base, detached: true,
		env: { PATH: process.env.PATH, HOME: base, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_TELEMETRY: "0", TERM: "xterm-256color" },
	});
	let output = "";
	const capture = (data: Buffer) => {
		output += data.toString();
		if (output.length > 1024 * 1024) { child.kill("SIGTERM"); return; }
		if (data.toString().includes("\u001b[6n")) child.stdin.write("\u001b[1;1R");
	};
	child.stdout.on("data", capture); child.stderr.on("data", capture);
	const exited = new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
	t.after(async () => {
		if (child.exitCode === null && child.signalCode === null && child.pid) {
			try { process.kill(-child.pid, "SIGTERM"); } catch { /* already exited */ }
			await Promise.race([exited.catch(() => {}), delay(500)]);
			if (child.exitCode === null && child.signalCode === null) {
				try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ }
			}
		}
		await rm(base, { recursive: true, force: true });
	});
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const exitCode = await Promise.race([exited, new Promise<"timeout">(resolve => { timeout = setTimeout(() => resolve("timeout"), 25_000); })]);
	clearTimeout(timeout);
	assert.equal(exitCode, 0, "offline installed-host fixture must finish");
	assert.ok(output.includes("Working..."), "custom working line must reach the real terminal");
	const writes = JSON.parse(await readFile(join(agent, "working-writes.json"), "utf8")) as Array<{ at: number; text?: string }>;
	assert.equal(writes.at(-1)?.text, undefined, "settlement restores the host default");
	const lines = writes.filter((item): item is { at: number; text: string } => typeof item.text === "string");
	assert.ok(lines.length > 10, "stream refreshes must not be limited to 1 Hz");
	const durations = (text: string) => [/^Working\.\.\. (\S+)/.exec(text)?.[1], /✻ ([^•]+?)(?: •|$)/.exec(text)?.[1]].join("|");
	for (const line of lines) assert.match(line.text, /^Working\.\.\. \S+( • .+)?$/, "every writer uses the one formatter");
	assert.ok(lines.some((line, index) => {
		const previous = lines[index - 1];
		if (!previous || line.at - previous.at >= 900) return false;
		return durations(previous.text) === durations(line.text) && previous.text !== line.text;
	}), "fast output estimates refresh between slow clock samples without replacing the template");
	assert.ok(lines.some(line => /✻ [12]s/.test(line.text)), "slow thinking clock must also advance");
	assert.ok(lines.some(line => / • ↑100 ↓48 CH0\.0% • ✻ [23]s • \d+ tok\/s$/.test(line.text)), "the settled request lane replaces the estimates; this fixture's immediate first output leaves no positive TTFT");
	// The real bash tool runs `sleep 7`, so the live tool field must appear past its threshold and then vanish.
	const toolLines = lines.filter(line => line.text.includes("⚙ "));
	assert.ok(toolLines.length > 0, "the live tool timer must reach the real terminal while bash runs");
	assert.ok(toolLines.some(line => line.text.includes("⚙ 2s ")), "the tool field appears on its two-second threshold");
	assert.ok(!toolLines.some(line => line.text.includes("⚙ 1s ")), "the tool field never appears below the threshold");
	const lastToolLine = lines.findLastIndex(line => line.text.includes("⚙ "));
	assert.ok(lines.slice(lastToolLine + 1).some(line => !line.text.includes("⚙ ")), "the tool field disappears when the tool ends");
});

for (const mode of ["timing-first", "notifications-first", "no-notifications"] as const) test(`installed Pi ${mode}: one interaction spans real Bash and Agent lifetimes and idle result handoffs`, { timeout: 40_000 }, async t => {
	try { await access("/usr/bin/script"); } catch { t.skip("requires util-linux script"); return; }
	const installedPath = (process.env.PATH ?? "").split(":").filter(entry => !entry.includes("node_modules/.bin")).join(":");
	if (spawnSync("pi", ["--version"], { env: { PATH: installedPath }, timeout: 5000 }).status !== 0) { t.skip("requires installed Pi"); return; }
	const base = await mkdtemp(join(tmpdir(), "work-timing-async-"));
	const agent = join(base, "agent"); await mkdir(agent);
	await writeFile(join(agent, "settings.json"), JSON.stringify({ packages: [], compaction: { enabled: false } }));
	const git = spawnSync("git", ["init", "-q", base], { env: { PATH: installedPath, HOME: base, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
	assert.equal(git.status, 0);
	const timing = join(root, "extensions/work-timing/index.ts");
	const notifications = join(root, "extensions/notices/index.ts");
	const observers = mode === "notifications-first" ? [notifications, timing] : mode === "timing-first" ? [timing, notifications] : [timing];
	// Bark evaluates the same interaction boundary independently; a stub hook records its events.
	await mkdir(join(base, ".local", "bin"), { recursive: true });
	await writeFile(join(base, ".local", "bin", "agent-bark-hook"), "#!/bin/sh\nset -eu\ncat >> \"$HOME/bark-events.jsonl\"\nprintf '\\n' >> \"$HOME/bark-events.jsonl\"\n", { mode: 0o700 });
	const args = ["pi", "--no-extensions", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-session", "--approve",
		"-e", join(root, "extensions/async-bash/index.ts"), "-e", join(root, "extensions/tasklist/index.ts"),
		...observers.flatMap(path => ["-e", path]), "-e", join(root, "extensions/agent-bark.ts"), "-e", join(root, "tests/fixtures/work-timing-async.ts"),
		"--model", "timing-async-fixture/fixture", "--thinking", "off", "--tui-mode", "fullscreen", "--", "timing fixture"];
	const child = spawn("script", ["-q", "-e", "-f", "-c", `stty cols 160 rows 40; exec ${args.map(quote).join(" ")}`, "/dev/null"], {
		cwd: base, detached: true, env: { PATH: installedPath, HOME: base, TMPDIR: base, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_TELEMETRY: "0", TERM: "xterm-256color", TIMING_NOTIFICATIONS: mode === "no-notifications" ? "0" : "1" },
	});
	let bytes = 0;
	let tail = "";
	const capture = (data: Buffer) => {
		bytes += data.length;
		tail = (tail + data.toString()).slice(-5000);
		if (bytes > 1024 * 1024) child.kill("SIGTERM");
		if (data.toString().includes("\u001b[6n")) child.stdin.write("\u001b[1;1R");
	};
	child.stdout.on("data", capture); child.stderr.on("data", capture);
	const exited = new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
	let timedOut = false;
	const timeout = setTimeout(() => { timedOut = true; if (child.pid) { try { process.kill(-child.pid, "SIGTERM"); } catch { /* stopped */ } } }, 30_000);
	t.after(async () => {
		clearTimeout(timeout);
		if (child.exitCode === null && child.signalCode === null && child.pid) {
			try { process.kill(-child.pid, "SIGTERM"); } catch { /* stopped */ }
			await Promise.race([exited.catch(() => {}), delay(500)]);
			if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* stopped */ } }
		}
		await exited.catch(() => {});
		await rm(base, { recursive: true, force: true });
		assert.ok(child.exitCode !== null || child.signalCode !== null, "owned PTY process reaped");
	});
	const exitCode = await exited;
	if (timedOut || exitCode !== 0) {
		try { t.diagnostic(await readFile(join(agent, "timing-trace.json"), "utf8")); } catch { /* startup failed */ }
		t.diagnostic(tail.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ""));
	}
	assert.equal(timedOut, false, "controlled offline fixture must reach its own finish boundary");
	assert.equal(exitCode, 0, "controlled offline fixture must exit normally");
	const proof = JSON.parse(await readFile(join(agent, "timing-proof.json"), "utf8"));
	assert.equal(proof.counts[0], 0, "native main settlement while jobs run is not an interaction completion");
	if (proof.entries.length !== 1) t.diagnostic(tail.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ""));
	assert.equal(proof.entries.length, 1, `one external request has one final timing entry: ${JSON.stringify(proof)}`);
	assert.equal(proof.entries[0].version, 5);
	assert.equal(proof.entries[0].scope, "interaction");
	assert.equal(proof.entries[0].status, "settled");
	assert.ok(proof.entries[0].totalMs >= 500, "autonomous idle gaps belong to elapsed work");
	assert.ok(proof.entries[0].totalMs >= proof.elapsed - 100, "the timer spans actual native runs rather than adding their active durations");
	assert.equal(proof.timingLeaked, false, "timing observations never enter provider messages");
	const bark = (await readFile(join(base, "bark-events.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
	assert.deepEqual(bark.map(event => event.hook_event_name), ["UserPromptSubmit", "Stop"], "Bark notifies once, at the interaction end timing also uses");
	assert.ok(bark[1].duration_ms >= 500 && bark[1].duration_ms >= proof.elapsed - 100, "Bark reports the same main-agent wall span");
	if (mode === "no-notifications") {
		assert.deepEqual(proof.kinds, ["user"]);
		assert.equal(proof.providerCalls, 4, "measurement starts no result run when the notification consumer is absent");
	} else {
		assert.deepEqual(proof.kinds, ["user", "custom", "custom"]);
		assert.equal(proof.counts[1], 0, "a delivered result beside a running sibling does not finish timing");
		assert.equal(proof.bashSeen, true); assert.equal(proof.agentSeen, true);
		assert.equal(proof.providerCalls, 6, "unfinished Tasklist data starts no extra continuation");
	}
});

test("installed Pi: request timing lands before the assistant message and footer metrics move only at persistence", { timeout: 40_000 }, async t => {
	try { await access("/usr/bin/script"); } catch { t.skip("requires util-linux script"); return; }
	const installedPath = (process.env.PATH ?? "").split(":").filter(entry => !entry.includes("node_modules/.bin")).join(":");
	if (spawnSync("pi", ["--version"], { env: { PATH: installedPath }, timeout: 5000 }).status !== 0) { t.skip("requires installed Pi"); return; }
	const base = await mkdtemp(join(tmpdir(), "metric-lanes-"));
	const agent = join(base, "agent"); await mkdir(agent);
	await writeFile(join(agent, "settings.json"), JSON.stringify({ packages: [], compaction: { enabled: false } }));
	// The capture fixture loads first to wrap setFooter; the observer loads last to run after work-timing's message_end.
	const args = ["pi", "--no-extensions", "--no-context-files", "--no-skills", "--no-prompt-templates", "--approve",
		"-e", join(root, "tests/fixtures/metric-lanes.ts"), "-e", join(root, "extensions/status-footer/index.ts"),
		"-e", join(root, "extensions/work-timing/index.ts"), "-e", join(root, "tests/fixtures/metric-lanes-observer.ts"),
		"--model", "lanes-fixture/fixture", "--thinking", "off", "--tui-mode", "fullscreen", "--", "lanes fixture"];
	const child = spawn("script", ["-q", "-e", "-f", "-c", `stty cols 200 rows 40; exec ${args.map(quote).join(" ")}`, "/dev/null"], {
		cwd: base, detached: true, env: { PATH: installedPath, HOME: base, TMPDIR: base, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_TELEMETRY: "0", TERM: "xterm-256color" },
	});
	let tail = "";
	const capture = (data: Buffer) => {
		tail = (tail + data.toString()).slice(-5000);
		if (data.toString().includes("\u001b[6n")) child.stdin.write("\u001b[1;1R");
	};
	child.stdout.on("data", capture); child.stderr.on("data", capture);
	const exited = new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
	let timedOut = false;
	const timeout = setTimeout(() => { timedOut = true; if (child.pid) { try { process.kill(-child.pid, "SIGTERM"); } catch { /* stopped */ } } }, 30_000);
	t.after(async () => {
		clearTimeout(timeout);
		if (child.exitCode === null && child.signalCode === null && child.pid) {
			try { process.kill(-child.pid, "SIGKILL"); } catch { /* stopped */ }
		}
		await exited.catch(() => {});
		await rm(base, { recursive: true, force: true });
	});
	const exitCode = await exited;
	if (timedOut || exitCode !== 0) t.diagnostic(tail.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ""));
	assert.equal(timedOut, false);
	assert.equal(exitCode, 0);
	const proof = JSON.parse(await readFile(join(agent, "metric-lanes.json"), "utf8")) as {
		samples: Array<{ at: string; footer: string; working?: string; tail: string[] }>;
		contexts: string[][]; payloadLeak: boolean; finalFooter: string; entries: Array<{ type: string; customType?: string; data?: unknown; message?: { role?: string; timestamp?: number; durationMs?: number } }>;
	};
	const { collectLaneTotals, usageMetricFields, timingMetricFields, parseLaneTotals } = await import("../extensions/shared/usage-metrics.ts");
	const metricsOf = (footer: string) => footer.split(" | ").filter(segment => /^(↑|✻|TTFT|\d+ tok\/s)/.test(segment)).join(" | ");

	// Host precondition: each request entry is appended from message_end and lands immediately before its assistant message.
	const assistants = proof.entries.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.type === "message" && entry.message?.role === "assistant");
	assert.equal(assistants.length, 2);
	for (const { entry, index } of assistants) {
		const timing = proof.entries[index - 1];
		assert.equal(timing?.customType, "work-timing-request");
		const data = timing?.data as { messageTimestamp: number; ttftMs?: number; thinkingMs: number };
		assert.equal(data.messageTimestamp, entry.message?.timestamp);
		assert.ok((data.ttftMs ?? 0) > 0 && (data.ttftMs ?? 0) <= (entry.message?.durationMs ?? 0), "TTFT is positive and within the request duration");
	}
	assert.ok(((proof.entries[assistants[0]!.index - 1]?.data as { thinkingMs: number }).thinkingMs) >= 400);

	// Inside the window, the reader sees the timing entry without its assistant message, and the footer is unchanged.
	const ends = proof.samples.filter(sample => sample.at === "message-end");
	const starts = proof.samples.filter(sample => sample.at === "request-start");
	const turnEnds = proof.samples.filter(sample => sample.at === "turn-end");
	assert.equal(ends.length, 2);
	for (const sample of ends) assert.equal(sample.tail.at(-1), "custom:work-timing-request");
	assert.equal(metricsOf(starts[0]!.footer), "", "an empty session shows no metrics");
	assert.equal(metricsOf(ends[0]!.footer), metricsOf(starts[0]!.footer), "the first request moves nothing before persistence");
	assert.equal(metricsOf(starts[1]!.footer), metricsOf(turnEnds[0]!.footer), "the next request start shows the previous settled values");
	assert.equal(metricsOf(ends[1]!.footer), metricsOf(turnEnds[0]!.footer), "the footer ignores the in-window timing entry");
	assert.notEqual(metricsOf(turnEnds[1]!.footer), metricsOf(ends[1]!.footer), "persistence settles the request into the footer");
	// The working row already shows the request's settled values from its message_end handling.
	assert.match(ends[0]!.working ?? "", / • ↑1\.0k ↓30 CH0\.0% • ✻ \S+ • TTFT \d\.\ds • \d+ tok\/s$/);

	// Offline recomputation: footer and completion entry equal the shared aggregation of the persisted entries.
	const session = collectLaneTotals(proof.entries);
	const expected = [usageMetricFields(session).map(field => field.text).join(" "), timingMetricFields(session).map(field => field.text).join(" ")].join(" | ");
	assert.equal(metricsOf(proof.finalFooter), expected);
	assert.match(expected, /^↑1\.2k ↓40 R1\.0k CH45\.5% \| ✻ \S+ TTFT \d\.\ds \d+ tok\/s$/);
	const summary = proof.entries.find(entry => entry.customType === "work-timing")?.data as { version: number; metrics: unknown };
	assert.equal(summary.version, 5);
	assert.deepEqual(parseLaneTotals(summary.metrics), session, "one interaction covers the whole fresh session");

	// Timing entries never reach the model.
	assert.equal(proof.payloadLeak, false);
	for (const roles of proof.contexts) assert.ok(roles.every(role => role !== "custom"));
});
