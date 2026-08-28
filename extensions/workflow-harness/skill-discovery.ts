import { createHash } from "node:crypto";

export interface CommandSourceInfo {
	path: string;
}

export interface PiCommandInfo {
	name: string;
	description?: string;
	source: string;
	sourceInfo: CommandSourceInfo;
}

export interface SkillCapability {
	name: string;
	description: string;
	sourcePath: string;
}

export interface SkillSnapshotV1 {
	schemaVersion: 1;
	skills: SkillCapability[];
	sha256: string;
}

export type WorkerIntent = "design" | "planning" | "implementation" | "review" | "normalization" | "verification";

export interface CapabilityResolution {
	snapshotSha256: string;
	intent: WorkerIntent;
	selectedName: string | null;
}

const SAFE_NAME = /^[a-z][a-z0-9_-]{0,95}$/;
const EXPLICIT_SKILL = /^\s*\/skill:([a-z][a-z0-9_-]{0,95})(?:\s|$)/;

function snapshotDigest(skills: readonly SkillCapability[]): string {
	return createHash("sha256").update(JSON.stringify({ schemaVersion: 1, skills })).digest("hex");
}

export function snapshotSkills(commands: readonly PiCommandInfo[]): SkillSnapshotV1 {
	const skills = commands
		.filter((command) => command.source === "skill")
		.map((command) => {
			const name = command.name.startsWith("skill:") ? command.name.slice("skill:".length) : command.name;
			if (!SAFE_NAME.test(name) || !command.sourceInfo?.path) throw new Error("invalid Pi Skill command metadata");
			return { name, description: command.description?.trim() ?? "", sourcePath: command.sourceInfo.path };
		})
		.sort((left, right) => left.name.localeCompare(right.name));
	if (new Set(skills.map((skill) => skill.name)).size !== skills.length) throw new Error("duplicate Pi Skill command name");
	if (new Set(skills.map((skill) => skill.sourcePath)).size !== skills.length) throw new Error("duplicate Pi Skill source path");
	return { schemaVersion: 1, skills, sha256: snapshotDigest(skills) };
}

export function explicitSkillSelection(text: string, snapshot: SkillSnapshotV1): SkillCapability | undefined {
	const name = EXPLICIT_SKILL.exec(text)?.[1];
	return name ? snapshot.skills.find((skill) => skill.name === name) : undefined;
}

export function correlateSkillRead(
	toolName: string,
	input: unknown,
	snapshot: SkillSnapshotV1,
): SkillCapability | undefined {
	if (toolName !== "read" || typeof input !== "object" || input === null) return undefined;
	const path = (input as Record<string, unknown>).path;
	if (typeof path !== "string") return undefined;
	return snapshot.skills.find((skill) => skill.sourcePath === path);
}

export function validateCapabilityResolution(
	resolution: CapabilityResolution,
	snapshot: SkillSnapshotV1,
): SkillCapability | null {
	if (resolution.snapshotSha256 !== snapshot.sha256) throw new Error("stale Skill capability resolution");
	if (resolution.selectedName === null) return null;
	const selected = snapshot.skills.find((skill) => skill.name === resolution.selectedName);
	if (!selected) throw new Error("resolved Skill is not present in the current snapshot");
	return selected;
}

export function nativeSkillCommand(skill: SkillCapability): string {
	if (!SAFE_NAME.test(skill.name)) throw new Error("unsafe Skill command name");
	return `/skill:${skill.name}`;
}
