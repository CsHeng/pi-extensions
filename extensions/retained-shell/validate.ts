/** Structured bash start/control validation. Command text is never parsed as an action. */

const CONTROL = new Set(["inspect", "wait", "renew", "cancel"]);

export interface ShellCallParams {
	command?: string;
	timeout?: number;
	action?: string;
	executionId?: string | null;
	background?: boolean;
	deadlineSeconds?: number;
	waitSeconds?: number;
	foregroundSeconds?: number;
}

function positiveFinite(value: number | undefined): boolean {
	return value === undefined || (typeof value === "number" && Number.isFinite(value) && value > 0);
}

export function validateShellCall(params: ShellCallParams): { ok: true } | { ok: false; message: string } {
	const action = params.action;
	const suppliedId = params.executionId !== undefined && params.executionId !== null;
	const validId = typeof params.executionId === "string" && params.executionId.length > 0;
	const control = action !== undefined && CONTROL.has(action);
	const starting = action === undefined || action === "run";
	const problems: string[] = [];
	if (starting && suppliedId) problems.push(action === "run" ? "run cannot include executionId" : "executionId requires an explicit control action");
	if (action !== undefined && action !== "run" && !CONTROL.has(action)) problems.push("action must be run, inspect, wait, renew, or cancel");
	if (control && !validId) problems.push(action + " requires executionId");
	if (control && params.command !== undefined) problems.push("command is only valid when starting an execution");
	if (control && params.background !== undefined) problems.push("background is only valid when starting an execution");
	if (control && params.foregroundSeconds !== undefined) problems.push("foregroundSeconds is only valid when starting an execution");
	if (control && params.timeout !== undefined) problems.push("timeout is only valid when starting an execution");
	if (control && action !== "renew" && params.deadlineSeconds !== undefined) problems.push("deadlineSeconds is only valid for run or renew");
	if (control && action !== "wait" && params.waitSeconds !== undefined) problems.push("waitSeconds is only valid for wait");
	if (action === "renew" && params.deadlineSeconds === undefined) problems.push("renew requires deadlineSeconds");
	for (const key of ["timeout", "deadlineSeconds", "waitSeconds", "foregroundSeconds"] as const) {
		if (!positiveFinite(params[key])) problems.push(key + " must be a positive finite number of seconds");
	}
	if (problems.length === 0) return { ok: true };
	return {
		ok: false,
		message: "Incompatible bash arguments: " + problems.join("; ") + ". Start with {\"command\":\"bun test\"}. Control an existing execution with {\"action\":\"inspect\",\"executionId\":\"exec_example\"}. No process was started and no execution was changed.",
	};
}
