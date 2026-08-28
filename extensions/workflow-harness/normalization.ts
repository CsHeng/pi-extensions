import { admitTaskGraph, type TaskGraphV1 } from "./task-graph.ts";

export interface SemanticCompletenessResult {
	omittedWork: string[];
	inventedWork: string[];
	unauthorizedReordering: string[];
}

export interface NormalizationSubmissionV1 {
	schemaVersion: 1;
	proposalSha256: string;
	graph: unknown;
	semanticCheck: SemanticCompletenessResult;
}

function emptyStrings(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim());
}

export function admitNormalization(
	submission: NormalizationSubmissionV1,
	expectedProposalSha256: string,
): TaskGraphV1 {
	if (submission.schemaVersion !== 1 || submission.proposalSha256 !== expectedProposalSha256) {
		throw new Error("normalization is not bound to the frozen proposal");
	}
	const check = submission.semanticCheck;
	if (!check || !emptyStrings(check.omittedWork) || !emptyStrings(check.inventedWork) || !emptyStrings(check.unauthorizedReordering)) {
		throw new Error("invalid semantic completeness result");
	}
	if (check.omittedWork.length || check.inventedWork.length || check.unauthorizedReordering.length) {
		throw new Error("semantic completeness check did not pass");
	}
	return admitTaskGraph(submission.graph);
}
