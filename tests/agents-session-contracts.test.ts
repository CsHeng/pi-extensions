import { before as ensureScopeBefore } from "node:test";
import { mkdir as ensureScopeMkdir } from "node:fs/promises";
ensureScopeBefore(async () => { await ensureScopeMkdir("/tmp/scope", { recursive: true }); await ensureScopeMkdir("/tmp/src", { recursive: true }); });
import assert from "node:assert/strict";
import { zstdDecompressSync } from "node:zlib";
import test from "node:test";
import { normalizeContext, validateToolArguments, type JsonObject, type Model } from "@earendil-works/pi-ai";
import { stream as responses } from "@earendil-works/pi-ai/api/openai-responses";
import { stream as codexResponses } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { PEER_TOOL_SURFACE, peerToolDefinitions } from "../extensions/agents/peer-tools.ts";
import { ManagedError, parseSessionRequest } from "../extensions/agents/session-contracts.ts";

test("field diagnostics distinguish missing, unexpected and invalid fields without echoing values", () => {
	const refusal = (request: unknown) => {
		try { parseSessionRequest(request); } catch (error) { assert.ok(error instanceof ManagedError); return error; }
		throw new Error("expected rejection");
	};
	for (const [request, kind, fields] of [
		[{}, "missingFields", ["action"]],
		[{ action: "join" }, "missingFields", ["runId"]],
		[{ action: "reconcile", handle: "h" }, "missingFields", ["expectedEpisode"]],
		[{ action: "reconcile", handle: "h", expectedEpisode: 1, disposition: "discard" }, "unexpectedFields", ["disposition"]],
		[{ action: "apply", handle: "h", expectedEpisode: 1 }, "missingFields", ["candidateId"]],
		[{ action: "join", runId: "run", taskId: "worker" }, "unexpectedFields", ["taskId"]],
		[{ action: "inspect", runId: "run", waitSeconds: 1 }, "unexpectedFields", ["waitSeconds"]],
		[{ action: "inspect", arbitraryPermission: "private-field-value" }, "unexpectedFields", ["arbitraryPermission"]],
		[{ action: "private-action-value" }, "invalidFields", ["action"]],
		[{ action: "inspect", handle: "../private-path-value" }, "invalidFields", ["handle"]],
	] as const) {
		const error = refusal(request);
		for (const field of ["missingFields", "unexpectedFields", "invalidFields"] as const) assert.deepEqual(error[field], field === kind ? fields : undefined);
		assert.doesNotMatch(JSON.stringify(error), /private-.*-value/);
	}
	assert.deepEqual(parseSessionRequest({ action: "join", runId: "run" }), { action: "join", runId: "run" });
	assert.equal(parseSessionRequest({ action: "cancel", runId: "run", taskId: "worker" }).taskId, "worker");
});

test("waiting budgets are observation-only, finite and not capped to short host windows", () => {
 for (const waitSeconds of [0, 0.01, 1800, 3_000_000]) assert.equal(parseSessionRequest({ action: "join", runId: "run", waitSeconds }).waitSeconds, waitSeconds);
 assert.equal(parseSessionRequest({ action: "join", runId: "run", mode: "foreground", waitSeconds: 1800 }).waitSeconds, 1800);
 for (const waitSeconds of [-1, NaN, Infinity, Number.MAX_VALUE]) assert.throws(() => parseSessionRequest({ action: "join", runId: "run", waitSeconds }));
 assert.throws(() => parseSessionRequest({ action: "inspect", runId: "run", waitSeconds: 1 }), /invalid_action_fields/);
 assert.throws(() => parseSessionRequest({ action: "create", mode: "async", tasks: [], waitSeconds: 1 }));
});

test("the internal session engine parses strict disjoint action fields without caller replay tokens", () => {
	assert.deepEqual(parseSessionRequest({ action: "inspect" }), { action: "inspect" });
	assert.equal(parseSessionRequest({ action: "close", handle: "h", expectedEpisode: 1 }).disposition, undefined);
	assert.throws(() => parseSessionRequest({ action: "create" }), /missing_create_fields/);
	assert.throws(() => parseSessionRequest({ action: "create", requestId: "r", tasks: [{ id: "a", role: "explorer", objective: "work", access: [{ permission: "read", scope: "/tmp/scope" }] }] }), /invalid_session_request/);
	assert.throws(() => parseSessionRequest({ action: "continue", episodes: [{ handle: "h", expectedEpisode: 1, message: "go", requestId: "r" }] }), /invalid_session_request/);
	assert.throws(() => parseSessionRequest({ action: "inspect", tasks: [] }), /invalid_session_request/);
	assert.throws(() => parseSessionRequest({ action: "inspect", handle: "../native.jsonl" }));
	assert.throws(() => parseSessionRequest({ action: "apply", handle: "h", expectedEpisode: 1 }), /missing_candidate/);
	const extra = (() => { try { parseSessionRequest({ action: "close", handle: "h", expectedEpisode: 1, arbitraryPermission: true }); } catch (error) { return error as ManagedError; } throw new Error("expected rejection"); })();
	assert.equal(extra.code, "invalid_session_request");
	assert.deepEqual(extra.unexpectedFields, ["arbitraryPermission"]);
	assert.equal(extra.missingFields, undefined);
	assert.throws(() => parseSessionRequest({ action: "create", tasks: [{ id: "a", role: "explorer", objective: "work", access: [{ permission: "read", scope: "/tmp/scope" }], repository: "/tmp/scope" }] }), /invalid_session_request/);
	const episode = { handle: "h", expectedEpisode: 1, message: "continue" };
	assert.throws(() => parseSessionRequest({ action: "continue", episodes: [episode, episode] }), /invalid_episodes/);
	assert.throws(() => parseSessionRequest({ action: "continue", episodes: [{ ...episode, message: "汉".repeat(30_000) }] }), /message_too_large/);
	assert.equal(parseSessionRequest({ action: "continue", episodes: [episode] }).episodes?.length, 1);
	for (const objective of ["x".repeat(20_000), "汉".repeat(10_000)]) {
		assert.throws(() => parseSessionRequest({ action: "create", tasks: [{ id: "a", role: "explorer", access: [{ permission: "read", scope: "/tmp/scope" }], objective }] }));
	}
	assert.throws(() => parseSessionRequest({ action: "create", tasks: [{ id: "a", role: "explorer", access: [{ permission: "read", scope: "/tmp/scope" }], objective: "work", inputs: ["汉".repeat(40_000)] }] }));
});

test("task labels are readable, hyphens allowed, and ambiguous dependencies fail before admission", () => {
	const task = (id: string, dependsOn?: string[]) => ({ id, role: "explorer" as const, objective: "work", access: [{ permission: "read" as const, scope: "/tmp/scope" }], ...(dependsOn ? { dependsOn } : {}) });
	assert.equal(parseSessionRequest({ action: "create", tasks: [task("fix-parser_tests-2")] }).tasks?.[0]?.id, "fix-parser_tests-2");
	assert.equal(parseSessionRequest({ action: "create", tasks: [task("Read /src: α"), task("Run tests", ["Read /src: α"])] }).tasks?.length, 2);
	assert.throws(() => parseSessionRequest({ action: "create", tasks: [task("build"), task("build")] }), /duplicate_task_id/);
	assert.throws(() => parseSessionRequest({ action: "create", tasks: [task("build"), task("fix", ["missing"])] }), /unknown_dependency/);
	for (const invalid of ["", "   ", "x".repeat(65)]) assert.throws(() => parseSessionRequest({ action: "create", tasks: [task(invalid)] }), /invalid_session_request/);
});

test("all seven peer schemas survive the real OpenAI request serializers and reject internal or wrong-operation fields", async () => {
	const tools = peerToolDefinitions(async () => { throw new Error("Schema validation never executes a tool"); });
	const shapes = [
		["invoke_agent", ["name", "role", "prompt", "access"], { name: "fix-parser", role: "custom-role", prompt: "Repair", access: [{ permission: "write", scope: "/tmp/scope" }] }],
		["message_agent", ["to", "message"], { to: "fix-parser", message: "check findings" }],
		["list_agents", [], { name: "fix-parser" }],
		["wait_agents", [], { names: ["fix-parser"], waitSeconds: 5 }],
		["stop_agent", ["name"], { name: "fix-parser", revert: true }],
		["release_agent", ["name"], { name: "fix-parser", disposition: "retain" }],
		["agent_candidate", ["name", "action"], { name: "fix-parser", action: "apply" }],
	] as const;
	assert.deepEqual(tools.map(tool => tool.name), shapes.map(([name]) => name));
	assert.deepEqual(PEER_TOOL_SURFACE.map(tool => tool.name), tools.map(tool => tool.name));
	const validate = (tool: (typeof tools)[number], args: unknown) => validateToolArguments(tool, { type: "toolCall", id: "fixture", name: tool.name, arguments: args as JsonObject });
	for (const [name, required, args] of shapes) {
		const tool = tools.find(item => item.name === name)!;
		const schema = tool.parameters as Record<string, unknown>;
		assert.equal(schema.type, "object");
		assert.equal(schema.additionalProperties, false);
		assert.deepEqual(schema.required ?? [], [...required]);
		validate(tool, args);
		for (const field of ["handle", "expectedEpisode", "candidateId", "requestId", "runId", "tasks"]) {
			assert.throws(() => validate(tool, { ...args, [field]: "internal" }), new RegExp(field));
		}
		for (const field of required) {
			const missing = { ...args } as Partial<Record<string, unknown>>;
			delete missing[field];
			assert.throws(() => validate(tool, missing));
		}
	}
	assert.throws(() => validate(tools[0]!, { ...shapes[0][2], access: "not-a-list" }));
	assert.throws(() => validate(tools[0]!, { ...shapes[0][2], name: "../private" }));
	assert.throws(() => validate(tools[6]!, { ...shapes[6][2], action: "join" }));

	for (const api of ["openai-responses", "openai-codex-responses"] as const) {
		const model: Model<typeof api> = {
			id: "schema-fixture", name: "Schema fixture", api, provider: api === "openai-responses" ? "openai" : "openai-codex",
			baseUrl: "https://fixture.invalid/v1", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024,
		};
		let payload: { tools: Array<{ name: string; parameters: Record<string, unknown> }> } | undefined;
		const fetch: typeof globalThis.fetch = async (_url, init) => {
			const body = new Headers(init?.headers).get("content-encoding") === "zstd" ? zstdDecompressSync(init!.body as Uint8Array).toString() : String(init?.body);
			payload = JSON.parse(body);
			const event = { type: "response.completed", response: { id: "fixture", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } } };
			return new Response(`event: response.completed\ndata: ${JSON.stringify(event)}\n\n`, { headers: { "content-type": "text/event-stream" } });
		};
		const claims = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url");
		const options = { apiKey: `fixture.${claims}.fixture`, fetch, transport: "sse" as const, maxRetries: 0 };
		const context = normalizeContext({ messages: [{ role: "user" as const, content: "fixture", timestamp: 1 }], tools });
		const result = await (api === "openai-responses"
			? responses(model as Model<"openai-responses">, context, options)
			: codexResponses(model as Model<"openai-codex-responses">, context, options)).result();
		assert.equal(result.stopReason, "stop", result.errorMessage);
		assert.deepEqual(payload!.tools.map(tool => tool.name), shapes.map(([name]) => name));
		for (const [name, required] of shapes) {
			const schema = payload!.tools.find(entry => entry.name === name)!.parameters;
			assert.equal(schema.type, "object");
			assert.equal(schema.anyOf, undefined, "a provider-compatible object root, not a union");
			assert.equal(schema.oneOf, undefined);
			assert.deepEqual(schema.required ?? [], [...required]);
		}
	}
});
