import assert from "node:assert/strict";
import test from "node:test";
import { validateLiveRun } from "../scripts/run-live-subagents-e2e.ts";

const tokens = {
	explore: "EXPLORE_fixture",
	review: "REVIEW_fixture",
	worker: "WORKER_fixture",
};

function eventStream(routeSource = "parent"): string {
	const tasks = [
		{ id: "explore", role: "explorer", status: "succeeded", output: tokens.explore },
		{ id: "review", role: "reviewer", status: "succeeded", output: tokens.review },
		{ id: "worker", role: "worker", status: "succeeded", output: "created result.txt", convergence: "applied" },
	].map((task) => ({
		...task,
		route: { provider: "fixture", model: "parent", source: routeSource },
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

test("live E2E oracle requires all fixed roles, parent routing, and worker convergence", () => {
	assert.deepEqual(validateLiveRun(eventStream(), tokens, `${tokens.worker}\n`, "temporary"), {
		result: "pass",
		source: "temporary",
		packageExtensions: 3,
		tasks: 3,
		roles: ["explorer", "reviewer", "worker"],
		routeSource: "parent",
		sharedParentRoute: true,
		workerConvergence: "applied",
	});
	assert.throws(() => validateLiveRun(eventStream("user-config"), tokens, `${tokens.worker}\n`, "installed"), /route_not_parent/);
	assert.throws(() => validateLiveRun(eventStream(), tokens, "wrong\n", "installed"), /worker_content_mismatch/);
});
