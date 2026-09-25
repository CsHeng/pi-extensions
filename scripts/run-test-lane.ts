import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
// Reviewed entry inventory. A new test must be assigned before any source lane can pass.
const source = [
	"bun-toolchain.test.ts", "fast-gpt.test.ts", "herdr-handoff-client.test.ts",
	"herdr-handoff-config.test.ts", "herdr-handoff-contract.test.ts", "herdr-handoff-coordinator.test.ts",
	"herdr-handoff-envelope.test.ts", "herdr-handoff-extension.test.ts", "herdr-handoff-render.test.ts",
	"herdr-handoff-workspace.test.ts", "installed-herdr-handoff-probe.test.ts", "installed-subagents-probe.test.ts",
	"installed-workflow-probe.test.ts", "live-subagents-e2e.test.ts", "multi-skill-mentions.test.ts",
	"package.test.ts", "prepared-input.test.ts", "publish-local-package.test.ts", "repository-boundary.test.ts",
	"session-cost-report.test.ts", "settlement.test.ts", "status-footer.test.ts", "subagents-async-evaluator.test.ts",
	"subagents-async-git-components.test.ts", "subagents-async-host.test.ts", "subagents-async-runtime.test.ts",
	"subagents-candidates.test.ts", "subagents-cc-tui.test.ts", "subagents-context-delivery.test.ts",
	"subagents-continuation.test.ts", "subagents-continuity.test.ts", "subagents-contract.test.ts",
	"subagents-delegation-probe.test.ts", "subagents-evaluator.test.ts", "subagents-extension.test.ts",
	"subagents-git-read-host.test.ts", "subagents-git-read.test.ts", "subagents-git-workspace.test.ts",
	"subagents-guard.test.ts", "subagents-guidance-guard.test.ts", "subagents-guidance-native.test.ts",
	"subagents-guidance.test.ts", "subagents-host-contract.test.ts", "subagents-managed-dispatch.test.ts",
	"subagents-managed-observer.test.ts", "subagents-managed-sessions.test.ts", "subagents-native-continuation.test.ts",
	"subagents-native-observation.test.ts", "subagents-observability.test.ts", "subagents-observation-hooks.test.ts",
	"subagents-observation-metrics.test.ts", "subagents-observer-events.test.ts", "subagents-protocol.test.ts",
	"subagents-provenance.test.ts", "subagents-reliability.test.ts", "subagents-render.test.ts",
	"subagents-repository-policy.test.ts", "subagents-routing.test.ts", "subagents-runner.test.ts",
	"subagents-scheduler.test.ts", "subagents-session-contracts.test.ts", "subagents-session-supervisor.test.ts",
	"subagents-telemetry.test.ts", "subagents-ui-integration.test.ts", "subagents-ui.test.ts",
	"subagents-worker-inputs.test.ts", "subagents-worker-tools.test.ts", "subagents-workspace.test.ts",
	"work-timing-tui.test.ts", "work-timing.test.ts", "workflow-async-subagents.test.ts",
	"workflow-co-load.test.ts", "workflow-command-barrier.test.ts", "workflow-cross-root.test.ts",
	"workflow-delivery-contract.test.ts", "workflow-evidence.test.ts", "workflow-goal-host.test.ts",
	"workflow-goal-ui-render.test.ts", "workflow-goal-ui.test.ts", "workflow-goal.test.ts",
	"workflow-host-conformance.test.ts", "workflow-installed-host.test.ts", "workflow-paths.test.ts",
	"workflow-progress-tui.test.ts", "workflow-progress.test.ts", "workflow-provider-schema.test.ts",
];
// Conservative: a filesystem/process import or disposable fixture belongs to isolated feedback.
const isolated = new Set([
	"bun-toolchain.test.ts", "herdr-handoff-client.test.ts", "herdr-handoff-config.test.ts",
	"herdr-handoff-coordinator.test.ts", "herdr-handoff-envelope.test.ts", "herdr-handoff-workspace.test.ts",
	"installed-herdr-handoff-probe.test.ts", "installed-subagents-probe.test.ts", "installed-workflow-probe.test.ts",
	"multi-skill-mentions.test.ts", "package.test.ts", "publish-local-package.test.ts",
	"repository-boundary.test.ts", "session-cost-report.test.ts", "subagents-async-git-components.test.ts",
	"subagents-async-host.test.ts", "subagents-async-runtime.test.ts", "subagents-candidates.test.ts",
	"subagents-continuation.test.ts", "subagents-delegation-probe.test.ts", "subagents-evaluator.test.ts",
	"subagents-extension.test.ts", "subagents-git-read.test.ts", "subagents-git-workspace.test.ts",
	"subagents-guard.test.ts", "subagents-guidance-guard.test.ts", "subagents-guidance-native.test.ts",
	"subagents-guidance.test.ts", "subagents-host-contract.test.ts", "subagents-managed-sessions.test.ts",
	"subagents-native-continuation.test.ts", "subagents-native-observation.test.ts", "subagents-provenance.test.ts",
	"subagents-repository-policy.test.ts", "subagents-routing.test.ts", "subagents-runner.test.ts",
	"subagents-worker-inputs.test.ts", "subagents-worker-tools.test.ts", "workflow-cross-root.test.ts",
	"workflow-evidence.test.ts", "workflow-goal-host.test.ts", "workflow-goal.test.ts",
	"workflow-paths.test.ts", "workflow-progress.test.ts",
]);
const piHost = new Set(["subagents-git-read-host.test.ts", "workflow-installed-host.test.ts"]);
const uiHost = new Set(["subagents-cc-tui.test.ts", "work-timing-tui.test.ts", "workflow-progress-tui.test.ts"]);
const known = new Set(source);
const discovered = readdirSync(join(root, "tests")).filter(name => name.endsWith(".test.ts"));
if (known.size !== source.length || discovered.some(name => !known.has(name)) || source.some(name => !discovered.includes(name)) ||
	[...isolated, ...piHost, ...uiHost].some(name => !known.has(name)) ||
	[...isolated].some(name => piHost.has(name) || uiHost.has(name)) || [...piHost].some(name => uiHost.has(name))) {
	console.error("Test lane inventory drift or overlap; assign each tests/*.test.ts entry explicitly.");
	process.exit(1);
}

const lane = process.argv[2];
const names = source.filter(name => lane === "fast" ? !isolated.has(name) && !piHost.has(name) && !uiHost.has(name)
	: lane === "isolated" ? isolated.has(name)
	: lane === "host-optional" ? piHost.has(name) || uiHost.has(name)
	: lane === "host-required" ? piHost.has(name)
	: lane === "ui-required" ? uiHost.has(name) : false);
if (!["fast", "isolated", "host-optional", "host-required", "ui-required"].includes(lane ?? "")) {
	console.error("Usage: bun scripts/run-test-lane.ts fast|isolated|host-optional|host-required|ui-required");
	process.exit(2);
}
if (lane === "host-required" || lane === "ui-required") {
	const pi = spawnSync("pi", ["--version"], { encoding: "utf8", timeout: 5000 });
	if (pi.status !== 0) { console.error("Installed Pi unavailable; required host lane cannot pass."); process.exit(1); }
}
if (lane === "ui-required") {
	for (const path of ["/usr/bin/script", join(homedir(), ".pi/agent/npm/node_modules/pi-cc-extensions/extensions/index.ts")]) {
		if (!existsSync(path)) { console.error(`Required UI prerequisite unavailable: ${path}`); process.exit(1); }
	}
}
const args = ["test", "--timeout", "120000", ...names.map(name => `./tests/${name}`)];
if (lane === "ui-required") args.push("./tests/subagents-ui-tui.e2e.ts");
const result = spawnSync(process.execPath, args, { cwd: root, env: process.env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
if (result.error) console.error(result.error);
if ((lane === "host-required" || lane === "ui-required") && /\(skip\)|\(todo\)/.test(`${result.stdout ?? ""}\n${result.stderr ?? ""}`)) {
	console.error("Required host test skipped; host acceptance unavailable.");
	process.exit(1);
}
process.exit(result.status ?? 1);
