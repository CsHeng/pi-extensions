import { readdirSync } from "node:fs";
import { join } from "node:path";

export type LaneKind = "fast" | "isolated" | "pi-host" | "ui-host";

const fast_files = ['agents-config-source.test.ts', 'cache-keepalive.test.ts', 'execution-quiescence.test.ts', 'fast-gpt.test.ts', 'jobs-ui.test.ts', 'notices-continuity.test.ts', 'notices-recovery.test.ts', 'notices.test.ts', 'live-agents-e2e.test.ts', 'prepared-input.test.ts', 'settlement.test.ts', 'status-footer.test.ts', 'agents-async-evaluator.test.ts', 'agents-context-delivery.test.ts', 'agents-continuity.test.ts', 'agents-contract.test.ts', 'agents-managed-dispatch.test.ts', 'agents-managed-observer.test.ts', 'agents-observability.test.ts', 'agents-observation-hooks.test.ts', 'agents-observation-metrics.test.ts', 'agents-observer-events.test.ts', 'agents-protocol.test.ts', 'agents-reliability.test.ts', 'agents-render.test.ts', 'agents-scheduler.test.ts', 'agents-session-contracts.test.ts', 'agents-session-supervisor.test.ts', 'agents-telemetry.test.ts', 'agents-ui-integration.test.ts', 'agents-ui.test.ts', 'agents-workspace.test.ts', 'tasks-ui.test.ts', 'tasks-view.test.ts', 'usage-metrics.test.ts', 'work-timing.test.ts', 'tasklist-async-agents.test.ts', 'tasklist-co-load.test.ts', 'tasklist-command-barrier.test.ts', 'tasklist-delivery-contract.test.ts', 'tasks-ui-render.test.ts', 'tasks-ui-records.test.ts', 'host-continuation-conformance.test.ts', 'tasklist-provider-schema.test.ts'] as const;
const isolated_files = ['agent-bark.test.ts', 'bun-toolchain.test.ts', 'duration-timer.test.ts', 'installed-agents-probe.test.ts', 'installed-tasklist-probe.test.ts', 'notices-coload.test.ts', 'multi-skill-mentions.test.ts', 'package.test.ts', 'publish-local-package.test.ts', 'repository-boundary.test.ts', 'async-bash.test.ts', 'session-cost-report.test.ts', 'agents-async-git-components.test.ts', 'agents-async-host.test.ts', 'agents-async-runtime.test.ts', 'agents-candidates.test.ts', 'agents-continuation.test.ts', 'agents-delegation-probe.test.ts', 'agents-evaluator.test.ts', 'agents-extension.test.ts', 'agents-git-read.test.ts', 'agents-git-workspace.test.ts', 'agents-guard.test.ts', 'agents-guidance-guard.test.ts', 'agents-guidance-native.test.ts', 'agents-guidance.test.ts', 'agents-host-contract.test.ts', 'agents-managed-sessions.test.ts', 'agents-native-continuation.test.ts', 'agents-native-observation.test.ts', 'agents-provenance.test.ts', 'agents-repository-policy.test.ts', 'agents-routing.test.ts', 'agents-runner.test.ts', 'agents-session-ui.test.ts', 'agents-session-view.test.ts', 'agents-worker-inputs.test.ts', 'agents-worker-tools.test.ts', 'test-lane-inventory.test.ts', 'tasklist-host.test.ts', 'tasklist.test.ts'] as const;
const pi_host_files = ['agent-bark-installed-host.test.ts', 'notices-installed-host.test.ts', 'async-bash-host.test.ts', 'agents-git-read-host.test.ts', 'agents-native-evolution.test.ts', 'agents-stream-host.test.ts', 'tasklist-installed-host.test.ts'] as const;
const ui_host_files = ['multi-skill-mentions-installed.test.ts', 'agents-cc-tui.test.ts', 'work-timing-tui.test.ts', 'tasklist-progress-tui.test.ts'] as const;

export const LANE_GROUPS = {
  fast: fast_files,
  isolated: isolated_files,
  "pi-host": pi_host_files,
  "ui-host": ui_host_files,
} as const satisfies Record<LaneKind, readonly string[]>;

export function validateLaneGroups(groups: Record<LaneKind, readonly string[]> = LANE_GROUPS): string[] {
	const problems: string[] = [];
	const seen = new Map<string, LaneKind>();
	for (const lane of Object.keys(groups) as LaneKind[]) {
		for (const file of groups[lane]) {
			const prior = seen.get(file);
			if (prior !== undefined) problems.push(`duplicate assignment: ${file} (${prior}, ${lane})`);
			else seen.set(file, lane);
		}
	}
	return problems;
}

function buildAssignments(groups: Record<LaneKind, readonly string[]>): Record<string, LaneKind> {
	const out: Record<string, LaneKind> = {};
	for (const lane of Object.keys(groups) as LaneKind[]) {
		for (const file of groups[lane]) out[file] = lane;
	}
	return out;
}

export const assignments = buildAssignments(LANE_GROUPS);

export function sourceInventory(): string[] {
	return Object.keys(assignments).sort();
}

export function inventoryProblemsForDiscovered(discovered: string[]): string[] {
	const problems = [...validateLaneGroups()];
	const assigned = new Set(Object.keys(assignments));
	for (const name of discovered) {
		if (!assigned.has(name)) problems.push(`unassigned: ${name}`);
	}
	for (const name of assigned) {
		if (!discovered.includes(name)) problems.push(`missing file: ${name}`);
	}
	return problems;
}

export function inventoryProblems(testsDirectory: string): string[] {
	const discovered = readdirSync(testsDirectory).filter(name => name.endsWith(".test.ts"));
	return inventoryProblemsForDiscovered(discovered);
}

export function filesForLane(lane: "fast" | "isolated" | "host-optional" | "host-required" | "ui-required"): string[] {
	return sourceInventory().filter(name => {
		const kind = assignments[name];
		switch (lane) {
			case "fast": return kind === "fast";
			case "isolated": return kind === "isolated";
			case "host-optional": return kind === "pi-host" || kind === "ui-host";
			case "host-required": return kind === "pi-host";
			case "ui-required": return kind === "ui-host";
			default: return false;
		}
	});
}
