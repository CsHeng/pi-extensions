import { createHash } from "node:crypto";

import { childMarker, type ChildMarker } from "./activation.ts";
import { nativeSkillCommand, type SkillCapability, type WorkerIntent } from "./skill-discovery.ts";

export interface ChildDispatch {
	dispatchId: string;
	intent: WorkerIntent;
	command: string | null;
	marker: ChildMarker;
	brief: string;
	expectedTool: string;
}

function digest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function buildChildDispatch(
	runId: string,
	intent: WorkerIntent,
	brief: string,
	expectedTool: string,
	worker: SkillCapability | null,
): ChildDispatch {
	if (!brief.trim() || !expectedTool.trim()) throw new Error("child dispatch requires a bounded brief and typed result tool");
	const dispatchId = digest({ runId, intent, brief: digest(brief), expectedTool, worker: worker?.name ?? null });
	return {
		dispatchId,
		intent,
		command: worker ? nativeSkillCommand(worker) : null,
		marker: childMarker(runId, dispatchId),
		brief,
		expectedTool,
	};
}

export function validateChildResult(dispatch: ChildDispatch, toolName: string, dispatchId: string): void {
	if (toolName !== dispatch.expectedTool || dispatchId !== dispatch.dispatchId) throw new Error("child result does not match the pending dispatch");
}
