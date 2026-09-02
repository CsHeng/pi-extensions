#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.HERDR_FAKE_DIR;
if (!dir) {
	process.stderr.write("fake-herdr requires HERDR_FAKE_DIR\n");
	process.exit(2);
}

const scenario = JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8"));
const argv = process.argv.slice(2);

function redact(values) {
	const copy = [...values];
	if (copy[0] === "agent" && copy[1] === "prompt" && copy.length >= 4) {
		copy[3] = { omitted: true, bytes: Buffer.byteLength(String(values[3] ?? ""), "utf8") };
	}
	const separator = copy.indexOf("--");
	if (separator >= 0) {
		const rest = values.slice(separator + 1);
		copy.splice(separator + 1, copy.length, { omitted: true, bytes: rest.reduce((total, item) => total + Buffer.byteLength(String(item), "utf8"), 0) });
	}
	return copy;
}

appendFileSync(join(dir, "commands.jsonl"), `${JSON.stringify({ argv: redact(argv) })}\n`);

if (scenario.hang === true) {
	setInterval(() => {}, 1 << 30);
	await new Promise(() => {});
}

function success(id, result) {
	process.stdout.write(`${JSON.stringify({ id, result })}\n`);
	process.exit(0);
}

function fail(id, code, message, exit = 1) {
	process.stderr.write(`${JSON.stringify({ id, error: { code, message } })}\n`);
	process.exit(exit);
}

const statePath = join(dir, "state.json");
function loadState() {
	try { return JSON.parse(readFileSync(statePath, "utf8")); } catch { return {}; }
}
function saveState(update) {
	writeFileSync(statePath, JSON.stringify({ ...loadState(), ...update }));
}

function agentInfo(overrides = {}, base = scenario.agent ?? {}) {
	const state = loadState();
	return {
		terminal_id: base.terminal_id ?? "term1",
		agent_status: overrides.agent_status ?? state.status ?? base.status ?? "idle",
		workspace_id: base.workspace_id ?? "w2",
		tab_id: base.tab_id ?? "w2:t1",
		pane_id: base.pane_id ?? "w2:p1",
		focused: false,
		revision: base.revision ?? 1,
		name: base.name ?? "codex-worker",
		agent: base.kind ?? "codex",
		cwd: base.cwd ?? "/repo",
		foreground_cwd: base.cwd ?? "/repo",
		state_change_seq: base.state_change_seq ?? 1,
		interactive_ready: base.interactive_ready ?? true,
		...(base.session ? { agent_session: base.session } : {}),
		...overrides,
	};
}

if (argv[0] === "--version") {
	process.stdout.write(`${scenario.version ?? "herdr 0.8.2"}\n`);
	process.exit(0);
}

if (scenario.syntaxError === true) {
	process.stderr.write("usage: herdr\n");
	process.exit(2);
}

if (scenario.nonJson === true) {
	process.stdout.write("not-json\n");
	process.exit(0);
}

if (argv[0] === "agent" && argv[1] === "get") {
	if (scenario.missingAgent === true) fail("cli:agent:get", "agent_not_found", "missing");
	success("cli:agent:get", { type: "agent_info", agent: agentInfo() });
}

if (argv[0] === "agent" && argv[1] === "start") {
	if (scenario.start === "auth") fail("cli:agent:start", "agent_auth_blocked", "auth");
	if (scenario.start === "not-ready") fail("cli:agent:start", "agent_not_ready", "not ready");
	if (scenario.start === "failed") fail("cli:agent:start", "agent_start_failed", "failed");
	const argvEcho = scenario.argvEcho === true ? ["--secret", "value"] : [];
	const startedAgent = scenario.startedAgent ?? scenario.agent ?? {};
	success("cli:agent:start", { type: "agent_started", agent: agentInfo({ agent_status: "idle" }, startedAgent), argv: argvEcho });
}

if (argv[0] === "agent" && argv[1] === "prompt") {
	if (scenario.promptError) fail("cli:agent:prompt", scenario.promptError, scenario.promptError);
	const status = scenario.promptStatus ?? "idle";
	saveState({ status });
	success("cli:agent:prompt", { type: "agent_prompted", agent: agentInfo({ agent_status: status }) });
}

if (argv[0] === "agent" && argv[1] === "wait") {
	if (scenario.waitError) fail("cli:agent:wait", scenario.waitError, scenario.waitError);
	if (scenario.malformedWait === true) success("cli:agent:wait", { type: "agent_info" });
	const status = scenario.waitStatus ?? scenario.promptStatus ?? "idle";
	saveState({ status });
	success("cli:agent:wait", { type: "agent_info", agent: agentInfo({ agent_status: status }) });
}

if (argv[0] === "agent" && argv[1] === "read") {
	if (scenario.readError) fail("cli:agent:read", scenario.readError, scenario.readError);
	process.stdout.write(String(scenario.readText ?? ""));
	process.exit(0);
}

if (argv[0] === "agent" && argv[1] === "send-keys") {
	if (scenario.interrupt === "unconfirmed") fail("cli:agent:send-keys", "timeout", "unconfirmed");
	if (scenario.interrupt === "unexpected") success("cli:agent:send-keys", { type: "agent_info" });
	success("cli:agent:send-keys", { type: "ok" });
}

if (argv[0] === "worktree" && argv[1] === "create") {
	const path = scenario.worktreePath ?? "/repo-worktree";
	success("cli:worktree:create", {
		type: "worktree_created",
		workspace: {
			workspace_id: "w2",
			number: 2,
			label: "work",
			focused: false,
			pane_count: 1,
			tab_count: 1,
			active_tab_id: "w2:t1",
			agent_status: "unknown",
			worktree: {
				repo_key: "repo",
				repo_name: "repo",
				repo_root: scenario.repoRoot ?? "/repo.git",
				checkout_path: path,
				is_linked_worktree: true,
			},
		},
		tab: { tab_id: "w2:t1", workspace_id: "w2", number: 1, label: "tab", focused: false, pane_count: 1, agent_status: "unknown" },
		root_pane: {
			pane_id: "w2:p1",
			terminal_id: "term1",
			workspace_id: "w2",
			tab_id: "w2:t1",
			focused: false,
			agent_status: "unknown",
			revision: 1,
		},
		worktree: {
			path,
			is_bare: false,
			is_detached: false,
			is_prunable: false,
			is_linked_worktree: true,
			label: "work",
		},
	});
}

fail("cli:unknown", "herdr_protocol_error", "unknown", 2);
