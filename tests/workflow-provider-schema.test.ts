import assert from "node:assert/strict";
import test from "node:test";
import { zstdDecompressSync } from "node:zlib";
import { normalizeContext, validateToolArguments, type JsonObject, type Model } from "@earendil-works/pi-ai";
import { stream as responses } from "@earendil-works/pi-ai/api/openai-responses";
import { stream as codexResponses } from "@earendil-works/pi-ai/api/openai-codex-responses";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createGoalStore } from "../extensions/workflow/goal-store.ts";
import { registerGoalTool } from "../extensions/workflow/goal-tool.ts";

function fixture() {
	let tool: ToolDefinition | undefined;
	let writes = 0;
	let calls = 0;
	const store = createGoalStore(() => { writes += 1; });
	registerGoalTool({ registerTool(value: ToolDefinition) { tool = value; }, on() {} } as unknown as ExtensionAPI, store);
	assert.ok(tool);
	const ctx = {
		cwd: process.cwd(), sessionManager: { getSessionId: () => "schema-fixture" },
		tools: [], executeTool: async () => { throw new Error("nested tool execution is outside this schema fixture"); },
	} as unknown as ExtensionToolContext;
	return {
		tool, store, writes: () => writes,
		execute(args: Record<string, unknown>) {
			const params = validateToolArguments(tool!, { type: "toolCall", id: "fixture", name: tool!.name, arguments: args as JsonObject });
			return tool!.execute(`fixture-${++calls}`, params, undefined, undefined, ctx);
		},
	};
}

for (const api of ["openai-responses", "openai-codex-responses"] as const) {
	test(`workflow registration survives the real ${api} request serializer before task creation`, async () => {
		const { tool, writes } = fixture();
		const model: Model<typeof api> = {
			id: "schema-fixture", name: "Schema fixture", api, provider: api === "openai-responses" ? "openai" : "openai-codex",
			baseUrl: "https://fixture.invalid/v1", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024,
		};
		let payload: { tools: Array<{ name: string; parameters: Record<string, unknown> }> } | undefined;
		const fetch: typeof globalThis.fetch = async (_url, init) => {
			const body = new Headers(init?.headers).get("content-encoding") === "zstd" ? zstdDecompressSync(init!.body as Uint8Array).toString() : String(init?.body);
			payload = JSON.parse(body);
			const schema = payload!.tools.find((entry) => entry.name === tool.name)!.parameters;
			if (schema.type !== "object" || schema.anyOf || schema.oneOf || schema.allOf) {
				return new Response(JSON.stringify({ error: { message: "Invalid schema for function csheng_workflow: expected an object root without a union" } }), { status: 400, headers: { "content-type": "application/json" } });
			}
			const event = { type: "response.completed", response: { id: "fixture", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } } };
			return new Response(`event: response.completed\ndata: ${JSON.stringify(event)}\n\n`, { headers: { "content-type": "text/event-stream" } });
		};
		// Synthetic credentials and an injected transport: no settings, auth files or live calls.
		const claims = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url");
		const options = { apiKey: `fixture.${claims}.fixture`, fetch, transport: "sse" as const, maxRetries: 0 };
		const context = normalizeContext({ messages: [{ role: "user" as const, content: "fixture", timestamp: 1 }], tools: [tool] });
		const result = await (api === "openai-responses"
			? responses(model as Model<"openai-responses">, context, options)
			: codexResponses(model as Model<"openai-codex-responses">, context, options)).result();
		assert.equal(result.stopReason, "stop", result.errorMessage);
		assert.ok(payload);
		const schema = payload.tools.find((entry) => entry.name === tool.name)!.parameters;
		assert.equal(schema.type, "object");
		assert.deepEqual(schema.required, ["operation"]);
		assert.equal(schema.additionalProperties, false);
		assert.equal(writes(), 0, "tool registration must not create a task list");
	});
}

test("workflow rejects completion-protocol operations and fields before mutation", async () => {
 const harness = fixture();
 for (const args of [{ operation: "enroll" }, { operation: "report", facts: [] }, { operation: "inspect", expectedRevision: 1 }]) {
  await assert.rejects(async () => harness.execute(args), /Validation failed/);
  assert.equal(harness.writes(), 0);
 }
 const missing = await harness.execute({ operation: "set", goal: "Incomplete" });
 assert.equal((missing.details as { ok: boolean }).ok, false);
 await harness.execute({ operation: "set", goal: "Fixture", tasks: [{ id: "t", title: "Task" }] });
 assert.equal(harness.store.current()?.revision, 1);
 await harness.execute({ operation: "pause", reason: "fixture pause" });
 assert.equal(harness.store.current()?.paused, true);
});
