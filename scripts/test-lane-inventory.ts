import { readdirSync } from "node:fs";
import { join } from "node:path";

export type LaneKind = "fast" | "isolated" | "pi-host" | "ui-host";

const fast_files = ['fast-gpt.test.ts', 'live-subagents-e2e.test.ts', 'prepared-input.test.ts', 'settlement.test.ts', 'status-footer.test.ts', 'subagents-async-evaluator.test.ts', 'subagents-context-delivery.test.ts', 'subagents-continuity.test.ts', 'subagents-contract.test.ts', 'subagents-managed-dispatch.test.ts', 'subagents-managed-observer.test.ts', 'subagents-observability.test.ts', 'subagents-observation-hooks.test.ts', 'subagents-observation-metrics.test.ts', 'subagents-observer-events.test.ts', 'subagents-protocol.test.ts', 'subagents-reliability.test.ts', 'subagents-render.test.ts', 'subagents-scheduler.test.ts', 'subagents-session-contracts.test.ts', 'subagents-session-supervisor.test.ts', 'subagents-telemetry.test.ts', 'subagents-ui-integration.test.ts', 'subagents-ui.test.ts', 'subagents-workspace.test.ts', 'work-timing.test.ts', 'workflow-async-subagents.test.ts', 'workflow-co-load.test.ts', 'workflow-command-barrier.test.ts', 'workflow-delivery-contract.test.ts', 'workflow-goal-ui-render.test.ts', 'workflow-goal-ui.test.ts', 'workflow-host-conformance.test.ts', 'workflow-provider-schema.test.ts'] as const;
const isolated_files = ['bun-toolchain.test.ts', 'installed-subagents-probe.test.ts', 'installed-workflow-probe.test.ts', 'multi-skill-mentions.test.ts', 'package.test.ts', 'publish-local-package.test.ts', 'repository-boundary.test.ts', 'session-cost-report.test.ts', 'subagents-async-git-components.test.ts', 'subagents-async-host.test.ts', 'subagents-async-runtime.test.ts', 'subagents-candidates.test.ts', 'subagents-continuation.test.ts', 'subagents-delegation-probe.test.ts', 'subagents-evaluator.test.ts', 'subagents-extension.test.ts', 'subagents-git-read.test.ts', 'subagents-git-workspace.test.ts', 'subagents-guard.test.ts', 'subagents-guidance-guard.test.ts', 'subagents-guidance-native.test.ts', 'subagents-guidance.test.ts', 'subagents-host-contract.test.ts', 'subagents-managed-sessions.test.ts', 'subagents-native-continuation.test.ts', 'subagents-native-observation.test.ts', 'subagents-provenance.test.ts', 'subagents-repository-policy.test.ts', 'subagents-routing.test.ts', 'subagents-runner.test.ts', 'subagents-session-ui.test.ts', 'subagents-session-view.test.ts', 'subagents-worker-inputs.test.ts', 'subagents-worker-tools.test.ts', 'test-lane-inventory.test.ts', 'workflow-cross-root.test.ts', 'workflow-evidence.test.ts', 'workflow-goal-host.test.ts', 'workflow-goal.test.ts', 'workflow-paths.test.ts', 'workflow-progress.test.ts'] as const;
const pi_host_files = ['subagents-git-read-host.test.ts', 'subagents-native-evolution.test.ts', 'subagents-stream-host.test.ts', 'workflow-installed-host.test.ts'] as const;
const ui_host_files = ['subagents-cc-tui.test.ts', 'work-timing-tui.test.ts', 'workflow-progress-tui.test.ts'] as const;

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
