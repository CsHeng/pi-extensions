import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	truncateHead,
	truncateLine,
} from "@earendil-works/pi-coding-agent";
import type { HandoffResult } from "./contracts.ts";

const SCALAR = 300;

function singleLine(value: string): string {
	return truncateLine(value.replace(/\s+/g, " ").trim(), SCALAR).text;
}

export function boundToolContent(content: string): string {
	const initial = truncateHead(content, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
	if (!initial.truncated) return content;
	const marker = `[Tool result truncated: ${initial.totalBytes} bytes, ${initial.totalLines} lines total]`;
	const markerBytes = Buffer.byteLength(`\n${marker}`, "utf8");
	const body = truncateHead(content, {
		maxBytes: Math.max(0, DEFAULT_MAX_BYTES - markerBytes),
		maxLines: Math.max(0, DEFAULT_MAX_LINES - 1),
	});
	return body.content ? `${body.content}\n${marker}` : marker;
}

export function formatHandoffResult(result: HandoffResult): string {
	const lines = [
		`Herdr handoff: action=${result.action} mode=${result.mode} bridge=${result.bridgeStatus}`,
		`workspace=${result.workspaceStatus} plan=${singleLine(result.planSha256.slice(0, 12))}`,
	];
	if (result.recipientKind) {
		const name = result.recipientName ? ` name=${singleLine(result.recipientName)}` : "";
		lines.push(`recipient kind=${singleLine(result.recipientKind)}${name}`);
	}
	if (result.lifecycleState) lines.push(`lifecycle=${result.lifecycleState}`);
	if (result.agentOutcome) lines.push(`agentOutcome=${result.agentOutcome} (unverified claim)`);
	if (result.workspace) lines.push(`changed=${result.workspace.changedPaths.length} violations=${result.workspace.violations.length}`);
	lines.push(`continuations clarification=${result.continuation.clarifications} repair=${result.continuation.repairs} wait=${result.continuation.recoveryWaits}`);
	if (result.bridgeStatus === "returned" || result.agentOutcome === "implemented") {
		lines.push("implementation claimed; parent verification required");
	}
	if (result.error) lines.push(`error=${singleLine(result.error.code)}`);
	return boundToolContent(lines.join("\n"));
}

export function formatStatus(input: {
	ready: boolean;
	version?: string;
	launchConfigValid: boolean;
	profileCount: number;
	active: boolean;
	handlePresent: boolean;
}): string {
	const version = input.version ? ` cli=${singleLine(input.version)}` : "";
	return [
		`herdr-handoff ready=${input.ready ? "yes" : "no"}${version}`,
		`launchConfig=${input.launchConfigValid ? "valid" : "invalid-or-absent"} profiles=${input.profileCount}`,
		`active=${input.active ? "yes" : "no"} handle=${input.handlePresent ? "yes" : "no"}`,
	].join("\n");
}
