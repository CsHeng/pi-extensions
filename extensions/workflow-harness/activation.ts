import { createHash } from "node:crypto";

import type { FormalRole } from "./task-graph.ts";

export type AdmissionKind = "explicit-role" | "approved-graph" | "root-skill-selection";

export interface FormalAdmission {
	kind: AdmissionKind;
	formalRole: FormalRole;
	stageOrdinal: number;
	stageInstanceId: string | null;
	admissionSha256: string;
}

export interface ChildMarker {
	schemaVersion: 1;
	runId: string;
	dispatchId: string;
	rootActivation: false;
}

function sha256(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function admitRootRole(
	runId: string,
	kind: AdmissionKind,
	formalRole: FormalRole,
	stageOrdinal: number,
	sourceDigest: string,
): FormalAdmission {
	if (!runId || !sourceDigest || !Number.isInteger(stageOrdinal) || stageOrdinal < 0) throw new Error("invalid root admission");
	const admissionSha256 = sha256({ runId, kind, formalRole, stageOrdinal, sourceDigest });
	return {
		kind,
		formalRole,
		stageOrdinal,
		stageInstanceId: formalRole === "none" ? null : sha256({ runId, formalRole, stageOrdinal, admissionSha256 }),
		admissionSha256,
	};
}

export function childMarker(runId: string, dispatchId: string): ChildMarker {
	if (!runId || !dispatchId) throw new Error("invalid child marker");
	return { schemaVersion: 1, runId, dispatchId, rootActivation: false };
}

export function mayActivateRoot(inputSource: "interactive" | "rpc" | "extension", marker?: ChildMarker): boolean {
	return inputSource !== "extension" && marker === undefined;
}
