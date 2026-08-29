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

function eventStream(routeSource = "package-default"): string {
	const tasks = [
		{ id: "explore", role: "explorer", status: "succeeded", output: tokens.explore },
		{ id: "review", role: "reviewer", status: "succeeded", output: tokens.review },
		{ id: "worker", role: "worker", status: "succeeded", output: "created result.txt", convergence: "applied" },
	].map((task) => ({
		...task,
		route: { ...routes[task.role as keyof typeof routes], source: routeSource },
	}));
	return [
		JSON.stringify({ type: "tool_execution_start", toolName: "csheng_subagents" }),
		JSON.stringify({
			type: "tool_execution_end",
			toolName: "csheng_subagents",
			result: { details: { status: "succeeded", tasks } },
		}),
	].join("\n");
}

test("live E2E oracle requires all fixed roles, package defaults, and worker convergence", () => {
	assert.deepEqual(validateLiveRun(eventStream(), tokens, `${tokens.worker}\n`, "temporary"), {
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
	});
	assert.throws(() => validateLiveRun(eventStream("user-config"), tokens, `${tokens.worker}\n`, "installed"), /route_not_package_default/);
	assert.throws(() => validateLiveRun(eventStream(), tokens, "wrong\n", "installed"), /worker_content_mismatch/);
});
