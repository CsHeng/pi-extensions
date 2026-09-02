import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	AGENT_OUTCOMES,
	HANDOFF_RETURN_PROTOCOL,
	HARD_LIMITS,
	RETURN_END_SENTINEL,
	RETURN_START_SENTINEL,
	type HandoffRequest,
} from "../extensions/herdr-handoff/contracts.ts";
import {
	buildHandoffPrompt,
	hashUtf8,
	parseRecipientReturn,
	readCanonicalPlan,
} from "../extensions/herdr-handoff/envelope.ts";

function request(planText = "Change only src/file.ts."): HandoffRequest {
	return {
		objective: "Implement the bounded change",
		plan: { source: "inline", text: planText },
		allowedWrites: ["src/file.ts"],
		nonGoals: ["Do not commit"],
		verification: ["focused test"],
	};
}

function returnEnvelope(handoffId: string, outcome = "implemented") {
	return {
		protocol: HANDOFF_RETURN_PROTOCOL,
		handoff_id: handoffId,
		outcome,
		summary: "claimed",
		changed_paths: ["src/file.ts"],
		verification: [{ check: "focused test", status: "passed", evidence: "ok" }],
		questions: [],
		risks: [],
	};
}

function wrap(envelope: unknown): string {
	return `noise\n${RETURN_START_SENTINEL}\n${JSON.stringify(envelope)}\n${RETURN_END_SENTINEL}\n`;
}

async function repo(t: test.TestContext): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "herdr-handoff-envelope-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "docs"));
	return root;
}

test("inline and file plans with identical bytes produce identical hashes", async (t) => {
	const root = await repo(t);
	const text = "Change only src/file.ts.\n";
	await writeFile(join(root, "docs", "plan.md"), text);
	const inline = await readCanonicalPlan(root, { source: "inline", text });
	const file = await readCanonicalPlan(root, { source: "file", path: "docs/plan.md" });
	assert.equal(inline.ok, true);
	assert.equal(file.ok, true);
	if (!inline.ok || !file.ok) return;
	assert.equal(inline.plan.planSha256, file.plan.planSha256);
	assert.equal(inline.plan.planSha256, hashUtf8(text));
	const prompt = buildHandoffPrompt({
		handoffId: "handoff-1",
		mode: "delegate-return",
		request: request(text),
		canonicalPlan: inline.plan,
	});
	assert.equal(prompt.ok, true);
	if (!prompt.ok) return;
	assert.match(prompt.prompt.prompt, /CANONICAL PLAN/);
	assert.match(prompt.prompt.prompt, /Change only src\/file\.ts/);
	assert.match(prompt.prompt.prompt, /physical output line under 96 columns/);
	assert.doesNotMatch(prompt.prompt.prompt, /docs\/plan\.md/);
});

test("plan path traversal, absolute, symlink, and non-regular files are rejected", async (t) => {
	const root = await repo(t);
	await writeFile(join(root, "docs", "plan.md"), "plan");
	const outside = await mkdtemp(join(tmpdir(), "herdr-handoff-outside-"));
	t.after(async () => rm(outside, { recursive: true, force: true }));
	await writeFile(join(outside, "secret.md"), "secret");
	await symlink(join(outside, "secret.md"), join(root, "docs", "link.md"));
	await mkdir(join(root, "docs", "dir"));
	for (const plan of [
		{ source: "file" as const, path: "../secret.md" },
		{ source: "file" as const, path: "/tmp/secret.md" },
		{ source: "file" as const, path: "docs/link.md" },
		{ source: "file" as const, path: "docs/dir" },
	]) {
		const result = await readCanonicalPlan(root, plan);
		assert.equal(result.ok, false, plan.path);
		if (!result.ok) {
			assert.equal(result.code, "plan_outside_repository");
			assert.doesNotMatch(result.message, /secret/);
		}
	}
});

test("oversized plans and prompts are rejected without echoing content", async () => {
	const huge = "x".repeat(HARD_LIMITS.maxPlanBytes + 1);
	const plan = await readCanonicalPlan("/tmp", { source: "inline", text: huge });
	assert.equal(plan.ok, false);
	if (!plan.ok) {
		assert.equal(plan.code, "plan_too_large");
		assert.equal(plan.message.includes(huge.slice(0, 32)), false);
	}
});

test("every recipient outcome parses from a unique sentinel pair", () => {
	for (const outcome of AGENT_OUTCOMES) {
		const parsed = parseRecipientReturn(wrap(returnEnvelope("id-1", outcome)), "id-1");
		assert.equal(parsed.ok, true, outcome);
		if (parsed.ok) assert.equal(parsed.envelope.outcome, outcome);
	}
});

test("prompt echoes and older handoffs do not shadow the final correlated return", () => {
	const promptEcho = `Emit one object between ${RETURN_START_SENTINEL} and ${RETURN_END_SENTINEL}.`;
	const parsed = parseRecipientReturn(
		`${promptEcho}\n${wrap(returnEnvelope("id-old"))}${wrap(returnEnvelope("id-1"))}`,
		"id-1",
	);
	assert.equal(parsed.ok, true);
	if (parsed.ok) assert.equal(parsed.envelope.handoff_id, "id-1");
});

test("duplicate current, missing, truncated, malformed, trailing, and mismatched returns fail closed", () => {
	const valid = wrap(returnEnvelope("id-1"));
	assert.equal(parseRecipientReturn("no sentinels", "id-1").ok, false);
	assert.equal(parseRecipientReturn(valid + valid, "id-1").ok, false);
	assert.equal(parseRecipientReturn(valid + `${RETURN_START_SENTINEL}{${RETURN_END_SENTINEL}`, "id-1").ok, false);
	assert.equal(parseRecipientReturn(`${RETURN_START_SENTINEL}{${RETURN_END_SENTINEL}`, "id-1").ok, false);
	assert.equal(parseRecipientReturn(wrap({ ...returnEnvelope("id-1"), protocol: "other" }), "id-1").ok, false);
	const mismatch = parseRecipientReturn(wrap(returnEnvelope("id-2")), "id-1");
	assert.equal(mismatch.ok, false);
	if (!mismatch.ok) assert.equal(mismatch.code, "return_id_mismatch");
	assert.equal(parseRecipientReturn(wrap({ ...returnEnvelope("id-1"), changed_paths: ["/tmp/x"] }), "id-1").ok, false);
	assert.equal(parseRecipientReturn(wrap({ ...returnEnvelope("id-1"), changed_paths: ["../x"] }), "id-1").ok, false);
	assert.equal(parseRecipientReturn(wrap({ ...returnEnvelope("id-1"), extra: true }), "id-1").ok, false);
	const failure = parseRecipientReturn("terminal dump SECRET_TOKEN\n" + wrap({ protocol: "bad" }), "id-1");
	assert.equal(failure.ok, false);
	if (!failure.ok) assert.doesNotMatch(failure.message, /SECRET_TOKEN/);
});
