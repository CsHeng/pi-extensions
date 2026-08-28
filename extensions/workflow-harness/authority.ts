import { createHash } from "node:crypto";

export interface AuthoritySettingsV1 {
	version: 1;
	mode: "managed";
	policy: "default-deny";
}

export interface ExactUserAuthority {
	authorityId: string;
	taskId: string;
	toolName: string;
	inputSha256: string;
	source: "user";
	consumed: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function loadAuthoritySettings(value: unknown): AuthoritySettingsV1 {
	if (!isRecord(value) || Object.keys(value).sort().join("\0") !== ["mode", "policy", "version"].join("\0")) {
		throw new Error("workflow harness authority settings must use the closed version-1 schema");
	}
	if (value.version !== 1 || value.mode !== "managed" || value.policy !== "default-deny") {
		throw new Error("unsupported workflow harness authority settings");
	}
	return { version: 1, mode: "managed", policy: "default-deny" };
}

export function inputDigest(input: unknown): string {
	return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export function issueExactUserAuthority(input: {
	authorityId: string;
	taskId: string;
	toolName: string;
	toolInput: unknown;
	source: "user";
}): ExactUserAuthority {
	if (!input.authorityId || !input.taskId || !input.toolName || input.source !== "user") {
		throw new Error("uncontained authority requires one exact direct user decision");
	}
	return {
		authorityId: input.authorityId,
		taskId: input.taskId,
		toolName: input.toolName,
		inputSha256: inputDigest(input.toolInput),
		source: "user",
		consumed: false,
	};
}

export function authorityMatches(
	authority: ExactUserAuthority | undefined,
	taskId: string,
	toolName: string,
	input: unknown,
): authority is ExactUserAuthority {
	return Boolean(
		authority &&
		!authority.consumed &&
		authority.source === "user" &&
		authority.taskId === taskId &&
		authority.toolName === toolName &&
		authority.inputSha256 === inputDigest(input),
	);
}

export function consumeExactUserAuthority(authority: ExactUserAuthority): ExactUserAuthority {
	if (authority.consumed) throw new Error("exact user authority is already consumed");
	return { ...authority, consumed: true };
}
