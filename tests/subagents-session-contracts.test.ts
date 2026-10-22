import { before as ensureScopeBefore } from "node:test";
import { mkdir as ensureScopeMkdir } from "node:fs/promises";
ensureScopeBefore(async () => { await ensureScopeMkdir("/tmp/scope", { recursive: true }); await ensureScopeMkdir("/tmp/src", { recursive: true }); });
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import test from "node:test";
import { normalizeContext, validateToolArguments, type JsonObject, type Model } from "@earendil-works/pi-ai";
import { stream as responses } from "@earendil-works/pi-ai/api/openai-responses";
import { stream as codexResponses } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { registerContinuationTool } from "../extensions/agents/continuation.ts";
import { ManagedSessionStore } from "../extensions/agents/managed-sessions.ts";
import { ManagedError, parseSessionRequest, SUBAGENT_SESSION_TOOL_NAME } from "../extensions/agents/session-contracts.ts";

test("field diagnostics distinguish missing, unexpected and invalid fields without echoing values", () => {
	const refusal = (request: unknown) => {
		try { parseSessionRequest(request); } catch (error) { assert.ok(error instanceof ManagedError); return error; }
		throw new Error("expected rejection");
	};
	for (const [request, kind, fields] of [
		[{}, "missingFields", ["action"]],
		[{ action: "join" }, "missingFields", ["runId"]],
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
	// The failed join is repaired by removing taskId, not by replacing its value.
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

test("one canonical agent tool exposes strict disjoint action fields without caller replay tokens", () => {
	assert.equal(SUBAGENT_SESSION_TOOL_NAME, "agent");
	assert.deepEqual(parseSessionRequest({ action: "inspect" }), { action: "inspect" });
	assert.equal(parseSessionRequest({ action: "close", handle: "h", expectedEpisode: 1 }).disposition, undefined);
	assert.throws(() => parseSessionRequest({ action: "create" }), /missing_create_fields/);
	// A caller-invented replay token is never part of the operation shape.
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

test("the agent schema survives the real OpenAI request serializers and rejects wrong action fields before execution", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "agent-schema-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	let tool: any;
	registerContinuationTool({ registerTool(value: any) { tool = value; }, registerCommand() {}, on() {}, appendEntry() {}, getActiveTools: () => ["agent"], events: { on() {}, emit() {} } } as any,
		{ store: new ManagedSessionStore(base), loadConfig: async () => { throw new Error("schema fixture never admits work"); } });
	assert.equal(tool.name, "agent");
	assert.equal(tool.parameters.type, "object");
	assert.equal(tool.parameters.additionalProperties, false);
	assert.equal(tool.parameters.properties.action.type, "string");
	assert.deepEqual(tool.parameters.properties.action.enum, ["create", "continue", "inspect", "apply", "close", "refresh", "join", "cancel"]);
	assert.equal(tool.parameters.properties.requestId, undefined, "no caller-invented replay identity");
	assert.equal(tool.parameters.properties.tasks.items.properties.requestId, undefined);
	assert.deepEqual(tool.parameters.properties.tasks.items.required, ["id", "role", "objective", "access"]);

	const ctx = { cwd: process.cwd(), sessionManager: { getSessionId: () => "schema-fixture" }, tools: [], executeTool: async () => { throw new Error("outside this fixture"); } } as any;
	const params = (args: Record<string, unknown>) => validateToolArguments(tool, { type: "toolCall", id: "fixture", name: "agent", arguments: args as JsonObject });
	const task = { id: "fix-parser-tests", role: "worker", objective: "Repair", access: [{ permission: "write", scope: "/tmp/scope" }] };
	// Both layers run before any managed effect: the provider validator narrows types, and the
	// operation contract rejects invented or misplaced fields that a provider tolerates.
	const rejection = (args: Record<string, unknown>): "provider" | "contract" | "accepted" => {
		let parsed: unknown;
		try { parsed = params(args); } catch { return "provider"; }
		try { parseSessionRequest(parsed); } catch { return "contract"; }
		return "accepted";
	};
	const invalid: Array<[Record<string, unknown>, "provider" | "contract"]> = [
		[{ tasks: [task] }, "provider"],
		[{ action: "create", tasks: "not-a-list" }, "provider"],
		[{ action: "inspect", tasks: [task] }, "contract"],
		[{ action: "apply", tasks: [task] }, "contract"],
		[{ action: "join", tasks: [task] }, "contract"],
		[{ action: "create" }, "contract"],
	];
	for (const [args, layer] of invalid) assert.equal(rejection(args), layer, JSON.stringify(args));
	// The provider validator itself refuses a caller-invented replay token.
	assert.throws(() => params({ action: "create", tasks: [task], requestId: "invented" }), /requestId/);
	// Valid operation shapes are accepted by the same validator that guards real provider tool calls.
	for (const args of [
		{ action: "inspect" },
		{ action: "create", mode: "async", tasks: [task] },
		{ action: "create", tasks: [task, { ...task, id: "review", role: "reviewer", access: [{ permission: "read", scope: "/tmp/scope" }], dependsOn: ["fix-parser-tests"] }] },
		{ action: "continue", episodes: [{ handle: "abc", expectedEpisode: 1, message: "go" }] },
		{ action: "join", runId: "abc", waitSeconds: 5 },
		{ action: "cancel", runId: "abc", taskId: "fix-parser-tests" },
		{ action: "apply", handle: "abc", expectedEpisode: 1, candidateId: "def" },
	]) params(args);

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
		const context = normalizeContext({ messages: [{ role: "user" as const, content: "fixture", timestamp: 1 }], tools: [tool] });
		const result = await (api === "openai-responses"
			? responses(model as Model<"openai-responses">, context, options)
			: codexResponses(model as Model<"openai-codex-responses">, context, options)).result();
		assert.equal(result.stopReason, "stop", result.errorMessage);
		const schema = payload!.tools.find((entry) => entry.name === "agent")!.parameters;
		assert.equal(schema.type, "object");
		assert.equal(schema.anyOf, undefined, "a provider-compatible object root, not a union");
		assert.equal(schema.oneOf, undefined);
		assert.deepEqual(schema.required, ["action"]);
	}
});
