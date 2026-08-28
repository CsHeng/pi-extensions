import { createHash } from "node:crypto";

import type { ReviewReason } from "./session-state.ts";

export interface ReviewBatch {
	dispatchId: string;
	targetSha256: string;
	acceptanceKey: string;
	reasonIds: string[];
}

function digest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function appendUnique(reasons: readonly ReviewReason[], reason: ReviewReason): ReviewReason[] {
	const copy = reasons.map((item) => structuredClone(item));
	return reasons.some((item) => item.reasonId === reason.reasonId) ? copy : [...copy, reason];
}

export function recordFormalReview(
	reasons: readonly ReviewReason[],
	stageInstanceId: string,
	targetSha256: string,
	acceptanceKey: string,
): ReviewReason[] {
	if (!stageInstanceId) throw new Error("formal review requires a stage instance");
	return appendUnique(reasons, {
		reasonId: `formal:${stageInstanceId}`,
		stageInstanceId,
		kind: "formal-stage",
		targetSha256,
		acceptanceKey,
		status: "pending",
	});
}

export function recordWorkerRequestedReview(
	reasons: readonly ReviewReason[],
	stageInstanceId: string | null,
	targetSha256: string,
	acceptanceKey: string,
): ReviewReason[] {
	return appendUnique(reasons, {
		reasonId: `worker:${digest({ stageInstanceId, targetSha256, acceptanceKey })}`,
		stageInstanceId,
		kind: "worker-requested-review",
		targetSha256,
		acceptanceKey,
		status: "pending",
	});
}

export function recordStandaloneReview(
	reasons: readonly ReviewReason[],
	targetSha256: string,
	acceptanceKey: string,
): ReviewReason[] {
	return appendUnique(reasons, {
		reasonId: `user:${digest({ targetSha256, acceptanceKey })}`,
		stageInstanceId: null,
		kind: "explicit-user",
		targetSha256,
		acceptanceKey,
		status: "pending",
	});
}

export function nextReviewBatch(reasons: readonly ReviewReason[]): ReviewBatch | undefined {
	const first = reasons.find((reason) => reason.status === "pending");
	if (!first) return undefined;
	const matching = reasons.filter(
		(reason) => reason.status === "pending" && reason.targetSha256 === first.targetSha256 && reason.acceptanceKey === first.acceptanceKey,
	);
	const reasonIds = matching.map((reason) => reason.reasonId).sort();
	return {
		dispatchId: `review:${digest({ targetSha256: first.targetSha256, acceptanceKey: first.acceptanceKey, reasonIds })}`,
		targetSha256: first.targetSha256,
		acceptanceKey: first.acceptanceKey,
		reasonIds,
	};
}

export function consumeReviewBatch(reasons: readonly ReviewReason[], batch: ReviewBatch): ReviewReason[] {
	const expected = nextReviewBatch(reasons);
	if (!expected || expected.dispatchId !== batch.dispatchId) throw new Error("review batch is stale or out of order");
	const consumed = new Set(batch.reasonIds);
	return reasons.map((reason) => (consumed.has(reason.reasonId) ? { ...reason, status: "consumed" } : { ...reason }));
}
