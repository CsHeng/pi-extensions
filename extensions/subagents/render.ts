import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	truncateHead,
	truncateLine,
} from "@earendil-works/pi-coding-agent";
import { truncateUtf8, utf8Bytes, type TaskResult, type EffectiveRoute } from "./contracts.ts";
import { isNativeObservation, type ObservedUsage } from "./observability.ts";
import type { SessionActionResult, SessionView } from "./session-contracts.ts";

const SUMMARY_SCALAR_CHARS = 300;

function singleLine(value: string): string {
	return truncateLine(value.replace(/\s+/g, " ").trim(), SUMMARY_SCALAR_CHARS).text;
}

export function formatDuration(durationMs: number | null): string {
	if (durationMs === null || !Number.isFinite(durationMs)) return "unknown";
	const milliseconds = Math.max(0, Math.floor(durationMs));
	if (milliseconds < 1_000) return `${milliseconds}ms`;
	if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)}s`;
	const minutes = Math.floor(milliseconds / 60_000);
	const seconds = (milliseconds % 60_000) / 1_000;
	return `${minutes}m ${seconds.toFixed(1)}s`;
}

export function formatClock(durationMs: number): string {
	const totalSeconds = Math.floor(Math.max(0, durationMs) / 1_000);
	const hours = Math.floor(totalSeconds / 3_600);
	const minutes = Math.floor((totalSeconds % 3_600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

function routeSummary(task: TaskResult): string {
	if (!task.route) return "";
	return ` route=${singleLine(`${task.route.provider}/${task.route.model}`)}:${singleLine(task.route.thinking)}`;
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

export function formatProgress(results: readonly TaskResult[], elapsedMs: number | null = null): string {
	const running = results.filter((result) => result.status === "running").length;
	const finished = results.filter((result) => result.status !== "pending" && result.status !== "running").length;
	const turns = results.reduce((total, result) => total + (result.activity?.assistantTurns ?? result.usage.turns), 0);
	const lines = [`Subagents ${running}/${results.length} running, ${finished} finished · ${turns} turns · ${elapsedMs === null ? "unknown" : formatClock(elapsedMs)}`];
	for (const result of results) {
		if (result.status === "pending") continue;
		if (result.status === "running" && result.activity) {
			const tools = result.activity.activeTools.length > 0 ? ` tool=${singleLine(result.activity.activeTools.join(","))}` : "";
			const errors = result.activity.errorCount > 0 ? ` errs=${result.activity.errorCount}` : "";
			lines.push(`[${singleLine(result.id)}] ${result.role} ${result.activity.phase}${routeSummary(result)} elapsed=${formatDuration(result.activity.elapsedMs)} turns=${result.activity.assistantTurns}${tools}${errors} inactive=${formatDuration(result.activity.inactiveForMs)}`);
			continue;
		}
		const elapsed = result.status === "running" && result.durationMs === 0
			? ""
			: ` elapsed=${formatDuration(result.durationMs)}`;
		lines.push(`[${singleLine(result.id)}] ${result.role} ${result.status}${routeSummary(result)}${elapsed}`);
	}
	return lines.join("\n");
}

interface NativeUsageSummary extends ObservedUsage {
	recorded: boolean;
}

function boundScalar(value: string): string {
	return truncateLine(value.replace(/[\u0000-\u001F\u007F\u2028\u2029]/g, " "), SUMMARY_SCALAR_CHARS).text;
}

function nativeUsageSummary(result: TaskResult | undefined): NativeUsageSummary {
	const observation = result?.observation;
	if (!isNativeObservation(observation) || !observation.available) {
		return { recorded: false, input: null, output: null, cacheRead: null, cacheWrite: null, totalTokens: null, cost: null };
	}
	const usage = observation.usage;
	return {
		recorded: true,
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		totalTokens: usage.totalTokens,
		cost: usage.cost,
	};
}

function truncateReport(text: string, maxBytes: number): { report: string; truncated: boolean } {
	const result = truncateUtf8(text, maxBytes);
	return { report: result.text, truncated: result.truncatedBytes > 0 };
}

function managedRoute(route: EffectiveRoute): Record<string, unknown> {
	return { provider: boundScalar(route.provider), model: boundScalar(route.model), thinking: boundScalar(route.thinking), source: route.source, selectionSource: route.selectionSource ?? null };
}

function sessionPayload(session: SessionView, reportBudget: number | null): Record<string, unknown> {
	const payload: Record<string, unknown> = {
		handle: boundScalar(session.handle),
		role: session.role,
		episode: session.episode,
		state: session.state,
		reportComplete: session.reportComplete,
	};
	const route = session.result?.route ?? session.route;
	if (route) payload.route = managedRoute(route);
	if (session.requestError) payload.requestError = { code: boundScalar(session.requestError.code), ...(session.requestError.detail ? { detail: boundScalar(session.requestError.detail) } : {}) };
	if (session.result) {
		const result: Record<string, unknown> = {
			id: boundScalar(session.result.id),
			status: session.result.status,
		};
		if (session.result.stopReason !== undefined) result.stopReason = boundScalar(session.result.stopReason);
		if (session.result.error) result.error = { code: boundScalar(session.result.error.code) };
		const output = session.result.output ?? "";
		if (reportBudget === null) {
			result.reportTruncated = true;
		} else {
			const clipped = truncateReport(output, reportBudget);
			result.report = clipped.report;
			result.reportTruncated = clipped.truncated;
		}
		payload.result = result;
	}
	if (session.candidate) {
		payload.candidate = {
			id: boundScalar(session.candidate.id),
			status: session.candidate.status,
			changedCount: session.candidate.changedPaths.length,
			appliedCount: session.candidate.appliedPaths.length,
		};
	}
	payload.nativeUsage = nativeUsageSummary(session.result);
	return payload;
}

function managedEnvelope(details: SessionActionResult, reportBudget: number | null): Record<string, unknown> {
	const payload: Record<string, unknown> = {
		schemaVersion: details.schemaVersion,
		action: details.action,
		status: details.status,
		sessions: details.sessions.map((session) => sessionPayload(session, reportBudget)),
	};
	if (details.warnings?.length) payload.warnings = details.warnings;
	if (details.error) payload.error = { code: boundScalar(details.error.code), ...(details.error.detail ? { detail: boundScalar(details.error.detail) } : {}), ...(details.error.missingFields ? { missingFields: details.error.missingFields } : {}) };
	return payload;
}

function stringifyManaged(details: SessionActionResult, reportBudget: number | null): string {
	return JSON.stringify(managedEnvelope(details, reportBudget));
}

export function formatManagedContent(details: SessionActionResult): string {
	const skeleton = stringifyManaged(details, null);
	if (utf8Bytes(skeleton) > DEFAULT_MAX_BYTES) return skeleton;
	const reportCount = Math.max(1, details.sessions.filter((session) => session.result).length);
	let high = Math.max(0, Math.floor((DEFAULT_MAX_BYTES - utf8Bytes(skeleton)) / reportCount));
	let low = 0;
	let best = skeleton;
	while (low <= high) {
		const middle = Math.floor((low + high) / 2);
		const candidate = stringifyManaged(details, middle);
		if (utf8Bytes(candidate) <= DEFAULT_MAX_BYTES) {
			best = candidate;
			low = middle + 1;
		} else {
			high = middle - 1;
		}
	}
	return best;
}

function stateMeaning(state: SessionView["state"]): string {
	switch (state) {
		case "idle": return "idle (no running process)";
		case "running": return "running";
		case "interrupted": return "interrupted";
		case "closed": return "closed";
	}
}

export function formatManagedResult(details: SessionActionResult, expanded = false): string {
	const lines = [
		`Managed session ${details.action ?? "request"}: ${details.status}`,
	];
	for (const warning of details.warnings ?? []) lines.push(`Warning: ${warning.message}`);
	if (details.error) lines.push(`request error=${boundScalar(details.error.code)}${details.error.detail ? ` cause=${boundScalar(details.error.detail)}` : ""}${details.error.missingFields?.length ? ` missing=${details.error.missingFields.join(",")}` : ""}`);
	for (const session of details.sessions) {
		const parts = [
			`[${boundScalar(session.handle)}] ${session.role} episode=${session.episode} ${stateMeaning(session.state)}`,
			`reportComplete=${session.reportComplete}`,
		];
		if (session.requestError) parts.push(`requestError=${boundScalar(session.requestError.code)}${session.requestError.detail ? ` cause=${boundScalar(session.requestError.detail)}` : ""}`);
		if (session.result) {
			parts.push(`episode-outcome=${session.result.status} id=${boundScalar(session.result.id)} elapsed=${formatDuration(session.result.durationMs)}`);
			if (session.result.stopReason !== undefined) parts.push(`stopReason=${boundScalar(session.result.stopReason)}`);
			if (session.result.error) parts.push(`result-error=${boundScalar(session.result.error.code)}`);
		}
		if (session.candidate) {
			parts.push(`candidate=${boundScalar(session.candidate.id)} apply=${session.candidate.status} changed=${session.candidate.changedPaths.length} applied=${session.candidate.appliedPaths.length}`);
		}
		const native = nativeUsageSummary(session.result);
		parts.push(native.recorded
			? `native-usage recorded input=${native.input} output=${native.output}`
			: "native-usage unrecorded");
		const route = session.result?.route ?? session.route;
		if (route) parts.push(`route=${boundScalar(route.provider)}/${boundScalar(route.model)} thinking=${boundScalar(route.thinking)} source=${route.source} selection=${route.selectionSource ?? "unknown"}`);
		lines.push(parts.join(" "));
	}
	// Reserve every session/candidate header before any expanded report can consume its budget.
	if (expanded) {
		const reports = details.sessions.filter((session) => session.result?.output);
		const budget = Math.max(0, Math.floor((DEFAULT_MAX_BYTES - utf8Bytes(lines.join("\n")) - reports.length * 512) / Math.max(1, reports.length)));
		const lineBudget = Math.max(0, Math.floor((DEFAULT_MAX_LINES - lines.length - reports.length * 4) / Math.max(1, reports.length)));
		for (const session of reports) {
			const clipped = truncateHead(session.result!.output, { maxBytes: budget, maxLines: lineBudget });
			lines.push(`--- [${boundScalar(session.handle)}] report ---`, clipped.content);
			if (clipped.truncated) lines.push("[Report display truncated; protocol completeness is independent.]");
		}
	}
	return boundToolContent(lines.join("\n"));
}
