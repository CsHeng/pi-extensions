import assert from "node:assert/strict";
import test from "node:test";
import { validateLiveRun } from "../scripts/run-live-agents-e2e.ts";

const tokens = {
	explore: "EXPLORE_fixture",
	review: "REVIEW_fixture",
	worker: "WORKER_fixture",
};

const routes = {
	explorer: { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "medium" },
	reviewer: { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" },
	worker: { provider: "openai-codex", model: "gpt-5.6-terra", thinking: "high" },
} as const;

const usage = { input: 4, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 6, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function telemetry(invocationId: string, extra: Record<string, unknown> = {}) {
	return {
		version: 1,
		ownerSessionId: "owner",
		invocationId,
		startedAtMs: 1,
		durationMs: 1,
		extensionEpoch: "ext",
		configurationEpoch: "cfg",
		requestedTasks: null,
		admittedTasks: null,
		launchedChildren: 0,
		replayedEpisodes: 0,
		...extra,
	};
}

const labels = { explorer: "explore", reviewer: "review", worker: "worker" } as const;
function view(role: keyof typeof routes, routeSource: string, extra: Record<string, unknown> = {}) {
	const output = role === "explorer" ? tokens.explore : role === "reviewer" ? tokens.review : tokens.worker;
	return { handle: `session_${role}`, label: labels[role], role, episode: 1, state: "idle", route: { ...routes[role], source: routeSource },
		result: { id: labels[role], role, status: "succeeded", output, usage }, ...extra };
}
const candidate = (status: "not-applied" | "applied") => ({ id: "candidate_worker", episode: 1, status, changedPaths: ["result.txt"], appliedPaths: status === "applied" ? ["result.txt"] : [] });

function result(op: string, action: string, invocationId: string, extra: Record<string, unknown> = {}) {
	return { schemaVersion: 5, op, action, status: "succeeded", requestTelemetry: telemetry(invocationId), sessions: [], ...extra };
}

function toolEvents(toolName: string, details: object, args: object = {}): string[] {
	return [
		JSON.stringify({ type: "tool_execution_start", toolName, args }),
		JSON.stringify({ type: "tool_execution_end", toolName, result: { details } }),
	];
}

function eventStream(routeSource = "user-config", options: { apply?: boolean; release?: boolean; retired?: boolean; handleArg?: boolean } = {}) {
	const lines: string[] = [];
	for (const role of ["explorer", "reviewer", "worker"] as const) {
		lines.push(...toolEvents("invoke_agent", result("invoke", "create", `create-${role}`, {
			kind: "execution",
			requestTelemetry: telemetry(`create-${role}`, { requestedTasks: 1, admittedTasks: 1, launchedChildren: 1 }),
			sessions: [view(role, routeSource, role === "worker" ? { candidate: candidate("not-applied") } : {})],
		}), { name: labels[role], role, ...(options.handleArg ? { handle: "x" } : {}) }));
	}
	lines.push(...toolEvents("wait_agents", { schemaVersion: 5, op: "wait", sessions: [] }));
	if (options.apply !== false) lines.push(...toolEvents("agent_candidate", result("candidate", "apply", "apply", { sessions: [view("worker", routeSource, { candidate: candidate("applied") })] })));
	if (options.release !== false) {
		for (const role of ["explorer", "reviewer", "worker"] as const) lines.push(...toolEvents("release_agent", result("release", "close", `close-${role}`, { sessions: [view(role, routeSource, { state: "closed" })] })));
	}
	if (options.retired) lines.push(JSON.stringify({ type: "tool_execution_start", toolName: "agent" }));
	return lines.join("\n");
}

const summary = {
	result: "pass",
	source: "temporary",
	packageExtensions: 3,
	agents: 3,
	roles: ["explorer", "reviewer", "worker"],
	routeSources: { explorer: "user-config", reviewer: "user-config", worker: "user-config" },
	profileMode: "role-default",
	workerWorkspace: "isolated",
	workerConvergence: "applied",
	released: 3,
	launchedChildren: 3,
} as const;

test("live E2E oracle requires three named invocations, an explicit isolated worker apply, releases and unique requestTelemetry", () => {
	assert.deepEqual(validateLiveRun(eventStream(), tokens, `${tokens.worker}\n`, "temporary"), summary);
	assert.deepEqual(validateLiveRun(eventStream("package-default"), tokens, `${tokens.worker}\n`, "installed").routeSources.worker, "package-default");
	assert.throws(() => validateLiveRun(eventStream(), tokens, "wrong\n", "installed"), /worker_content_mismatch/);
	assert.throws(() => validateLiveRun(eventStream("user-config", { apply: false }), tokens, `${tokens.worker}\n`, "installed"), /worker_apply_missing/);
	assert.throws(() => validateLiveRun(eventStream("user-config", { release: false }), tokens, `${tokens.worker}\n`, "installed"), /session_not_released/);
	assert.throws(() => validateLiveRun(eventStream("user-config", { retired: true }), tokens, `${tokens.worker}\n`, "installed"), /retired_agent_tool_called/);
	assert.throws(() => validateLiveRun(eventStream("user-config", { handleArg: true }), tokens, `${tokens.worker}\n`, "installed"), /tool_call_carries_internal_identity/);
});
