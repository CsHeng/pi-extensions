import assert from "node:assert/strict";
import test from "node:test";
import { validateLiveRun } from "../scripts/run-live-subagents-e2e.ts";

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

function sessions(routeSource: string, candidateStatus: "not-applied" | "applied" = "not-applied") {
	return [
		{
			handle: "session_explore",
			role: "explorer",
			episode: 1,
			state: "idle",
			route: { ...routes.explorer, source: routeSource },
			result: { id: "explore", role: "explorer", status: "succeeded", output: tokens.explore, usage },
		},
		{
			handle: "session_review",
			role: "reviewer",
			episode: 1,
			state: "idle",
			route: { ...routes.reviewer, source: routeSource },
			result: { id: "review", role: "reviewer", status: "succeeded", output: tokens.review, usage },
		},
		{
			handle: "session_worker",
			role: "worker",
			episode: 1,
			state: "idle",
			route: { ...routes.worker, source: routeSource },
			result: { id: "worker", role: "worker", status: "succeeded", output: "created result.txt", usage },
			candidate: {
				id: "candidate_worker",
				episode: 1,
				status: candidateStatus,
				changedPaths: ["result.txt"],
				appliedPaths: candidateStatus === "applied" ? ["result.txt"] : [],
			},
		},
	];
}

function result(action: string, invocationId: string, extra: Record<string, unknown> = {}) {
	return {
		schemaVersion: 2,
		action,
		status: "succeeded",
		requestTelemetry: telemetry(invocationId),
		sessions: [],
		...extra,
	};
}

function toolEvents(details: object): string[] {
	return [
		JSON.stringify({ type: "tool_execution_start", toolName: "csheng_subagent_sessions" }),
		JSON.stringify({ type: "tool_execution_end", toolName: "csheng_subagent_sessions", result: { details } }),
		JSON.stringify({ type: "message_end", message: { role: "toolResult", toolName: "csheng_subagent_sessions", details } }),
	];
}

function eventStream(routeSource = "package-default", options: { replay?: boolean; apply?: boolean; close?: boolean } = {}) {
	const created = sessions(routeSource);
	const applied = sessions(routeSource, "applied")[2];
	const lines = [
		...toolEvents(result("create", "create", {
			requestTelemetry: telemetry("create", { requestedTasks: 3, admittedTasks: 3, launchedChildren: 3 }),
			sessions: created,
		})),
	];
	if (options.replay !== false) {
		lines.push(...toolEvents(result("create", "replay", {
			requestTelemetry: telemetry("replay", { requestedTasks: 3, admittedTasks: null, launchedChildren: 0, replayedEpisodes: 3 }),
			sessions: created,
		})));
	}
	if (options.apply !== false) {
		lines.push(...toolEvents(result("apply", "apply", { sessions: [applied] })));
	}
	if (options.close !== false) {
		for (const session of created) {
			lines.push(...toolEvents(result("close", `close-${session.role}`, {
				sessions: [{ ...session, state: "closed", ...(session.role === "worker" ? { candidate: applied?.candidate } : {}) }],
			})));
		}
	}
	return lines.join("\n");
}

const summary = {
	result: "pass",
	source: "temporary",
	packageExtensions: 3,
	tasks: 3,
	roles: ["explorer", "reviewer", "worker"],
	routeSource: "package-default",
	roleRoutes: {
		explorer: "openai-codex/gpt-5.6-luna:medium",
		reviewer: "openai-codex/gpt-5.6-sol:high",
		worker: "openai-codex/gpt-5.6-terra:high",
	},
	profileMode: "role-default",
	workerConvergence: "applied",
	launchedChildren: 3,
} as const;

test("live E2E oracle requires managed create, explicit worker apply, close, and unique requestTelemetry", () => {
	assert.deepEqual(validateLiveRun(eventStream(), tokens, `${tokens.worker}\n`, "temporary"), summary);
	assert.throws(() => validateLiveRun(eventStream("user-config"), tokens, `${tokens.worker}\n`, "installed"), /route_not_package_default/);
	assert.throws(() => validateLiveRun(eventStream(), tokens, "wrong\n", "installed"), /worker_content_mismatch/);
	assert.throws(() => validateLiveRun(eventStream("package-default", { apply: false }), tokens, `${tokens.worker}\n`, "installed"), /worker_apply_missing/);
	assert.throws(() => validateLiveRun(eventStream("package-default", { close: false }), tokens, `${tokens.worker}\n`, "installed"), /session_not_closed/);
});
