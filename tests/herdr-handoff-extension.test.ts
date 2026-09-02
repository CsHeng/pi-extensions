import assert from "node:assert/strict";
import test from "node:test";
import { HANDOFF_STATUS_COMMAND, HANDOFF_TOOL_NAME, type HandoffResult } from "../extensions/herdr-handoff/contracts.ts";
import { createHerdrHandoffExtension } from "../extensions/herdr-handoff/index.ts";

interface Harness {
	tool?: any;
	commands: Map<string, any>;
	handlers: Map<string, Array<(...args: any[]) => any>>;
	pi: any;
}

function harness(): Harness {
	const commands = new Map<string, any>();
	const handlers = new Map<string, Array<(...args: any[]) => any>>();
	const value: Harness = {
		commands,
		handlers,
		pi: {
			registerTool(tool: any) { value.tool = tool; },
			registerCommand(name: string, command: any) { commands.set(name, command); },
			on(name: string, handler: (...args: any[]) => any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
			getActiveTools() { return [HANDOFF_TOOL_NAME]; },
			exec: async () => ({ stdout: "", stderr: "", code: 1, killed: false }),
		},
	};
	return value;
}

function context(trusted = true) {
	const notifications: Array<{ message: string; level: string }> = [];
	return {
		cwd: process.cwd(),
		isProjectTrusted() { return trusted; },
		ui: {
			notify(message: string, level: string) { notifications.push({ message, level }); },
		},
		notifications,
	};
}

test("extension registers the handoff tool, status command, and guidance", async () => {
	const state = harness();
	createHerdrHandoffExtension()(state.pi);
	assert.equal(state.tool.name, HANDOFF_TOOL_NAME);
	assert.deepEqual([...state.commands.keys()], [HANDOFF_STATUS_COMMAND]);
	const ctx = context();
	await state.commands.get(HANDOFF_STATUS_COMMAND).handler("", ctx);
	assert.match(ctx.notifications[0]?.message ?? "", /herdr-handoff/);
	assert.doesNotMatch(ctx.notifications[0]?.message ?? "", /argv/);
	const guidance = await state.handlers.get("before_agent_start")?.[0]?.({ systemPrompt: "base" }, ctx);
	assert.match(guidance.systemPrompt, /explicit user request/);
});

test("untrusted projects fail before Herdr is invoked", async () => {
	let execs = 0;
	const state = harness();
	state.pi.exec = async () => {
		execs += 1;
		return { stdout: "", stderr: "", code: 1, killed: false };
	};
	createHerdrHandoffExtension()(state.pi);
	const result = await state.tool.execute("call", {
		action: "begin",
		mode: "delegate-return",
		target: { type: "message-existing", target: "codex-worker", kind: "codex" },
		request: {
			objective: "x",
			plan: { source: "inline", text: "plan" },
			allowedWrites: ["src.ts"],
			nonGoals: [],
			verification: [],
		},
	}, undefined, undefined, context(false));
	assert.match(result.content[0].text, /error=/);
	assert.equal((result.details as HandoffResult).error?.code, "invalid_handoff_request");
	assert.equal(execs, 0);
});

test("trusted dispatch emits progress before Herdr work", async () => {
	const state = harness();
	createHerdrHandoffExtension()(state.pi);
	const updates: string[] = [];
	await state.tool.execute("call", {
		action: "begin",
		mode: "delegate-return",
		target: { type: "message-existing", target: "codex-worker", kind: "codex" },
		request: {
			objective: "x",
			plan: { source: "inline", text: "plan" },
			allowedWrites: ["src.ts"],
			nonGoals: [],
			verification: [],
		},
	}, undefined, (update: { content: Array<{ text: string }> }) => updates.push(update.content[0]?.text ?? ""), context(true));
	assert.ok(updates.some((text) => /in progress/.test(text)));
});

test("session_shutdown handler is registered and awaited", async () => {
	const state = harness();
	createHerdrHandoffExtension()(state.pi);
	const handler = state.handlers.get("session_shutdown")?.[0];
	assert.equal(typeof handler, "function");
	await handler?.({}, context());
});

test("tool_result marks failed bridge status as an error", async () => {
	const state = harness();
	createHerdrHandoffExtension()(state.pi);
	const handler = state.handlers.get("tool_result")?.[0];
	const failed = await handler?.({
		toolName: HANDOFF_TOOL_NAME,
		details: { bridgeStatus: "failed", workspaceStatus: "unavailable", action: "begin", error: { code: "agent_busy", message: "busy" } },
	});
	assert.deepEqual(failed, { isError: true });
	const ok = await handler?.({
		toolName: HANDOFF_TOOL_NAME,
		details: { bridgeStatus: "returned", workspaceStatus: "within_declared_writes", action: "begin" },
	});
	assert.deepEqual(ok, { isError: false });
});
