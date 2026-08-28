import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export interface ProposalMessage {
	role: "user" | "assistant";
	text: string;
}

export interface FrozenArtifact {
	path: string;
	sha256: string;
	size: number;
}

export interface FrozenProposalV1 {
	schemaVersion: 1;
	messages: ProposalMessage[];
	artifacts: FrozenArtifact[];
	sha256: string;
}

export class ProposalError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

function digest(payload: string | Uint8Array): string {
	return createHash("sha256").update(payload).digest("hex");
}

function canonicalPayload(
	messages: readonly ProposalMessage[],
	artifacts: readonly FrozenArtifact[],
): string {
	return JSON.stringify({ schemaVersion: 1, messages, artifacts });
}

function workspacePath(workspaceRoot: string, reference: string): string {
	if (!reference || isAbsolute(reference) || reference.includes("\0")) {
		throw new ProposalError("unsafe-artifact-path", `unsafe artifact path: ${reference}`);
	}
	const absolute = resolve(workspaceRoot, reference);
	const local = relative(resolve(workspaceRoot), absolute);
	if (!local || local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) {
		throw new ProposalError("unsafe-artifact-path", `artifact escapes workspace: ${reference}`);
	}
	return absolute;
}

export async function freezeProposal(
	workspaceRoot: string,
	messages: readonly ProposalMessage[],
	artifactPaths: readonly string[],
): Promise<FrozenProposalV1> {
	if (messages.length === 0 || messages.some((item) => !item.text.trim())) {
		throw new ProposalError("invalid-proposal", "proposal requires non-empty messages");
	}
	if (new Set(artifactPaths).size !== artifactPaths.length) {
		throw new ProposalError("duplicate-artifact", "artifact paths must be unique");
	}

	const canonicalWorkspace = await realpath(workspaceRoot);
	const artifacts: FrozenArtifact[] = [];
	for (const reference of [...artifactPaths].sort()) {
		const absolute = workspacePath(canonicalWorkspace, reference);
		const metadata = await lstat(absolute);
		if (!metadata.isFile() || metadata.isSymbolicLink()) {
			throw new ProposalError("invalid-artifact", `artifact is not a regular file: ${reference}`);
		}
		const canonical = await realpath(absolute);
		if (canonical !== absolute) {
			throw new ProposalError("noncanonical-artifact", `artifact path is not canonical: ${reference}`);
		}
		const content = await readFile(absolute);
		artifacts.push({ path: reference, sha256: digest(content), size: content.byteLength });
	}

	const frozenMessages = messages.map((item) => ({ role: item.role, text: item.text }));
	return {
		schemaVersion: 1,
		messages: frozenMessages,
		artifacts,
		sha256: digest(canonicalPayload(frozenMessages, artifacts)),
	};
}
