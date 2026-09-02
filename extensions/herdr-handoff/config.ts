import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	HARD_LIMITS,
	LAUNCH_CONFIG_FILE,
	utf8Bytes,
	type LaunchProfile,
} from "./contracts.ts";

export interface LaunchConfig {
	profiles: Record<string, LaunchProfile>;
	missing: boolean;
}

export type LaunchConfigLoadResult =
	| { ok: true; config: LaunchConfig }
	| { ok: false; code: "launch_config_invalid"; message: string };

export type LaunchProfileLookup =
	| { ok: true; profile: LaunchProfile }
	| { ok: false; code: "launch_profile_not_found"; message: string };

const IDENTIFIER = /^[a-z][a-z0-9_-]{0,31}$/;
const CONFIG_MESSAGE = "Launch configuration is invalid.";
const PROFILE_MESSAGE = "Launch profile was not found.";

function parseJsonNoDuplicates(text: string): unknown {
	assertNoDuplicateKeys(text);
	return JSON.parse(text) as unknown;
}

function assertNoDuplicateKeys(text: string): void {
	const stacks: Array<Set<string>> = [];
	let inString = false;
	let escaped = false;
	let token = "";
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index] as string;
		if (inString) {
			if (escaped) {
				escaped = false;
				token += char;
				continue;
			}
			if (char === "\\") {
				escaped = true;
				token += char;
				continue;
			}
			if (char === "\"") {
				inString = false;
				let cursor = index + 1;
				while (cursor < text.length && /\s/.test(text[cursor] as string)) cursor += 1;
				if ((text[cursor] as string) === ":" && stacks.length > 0) {
					const key = JSON.parse(`"${token}"`) as string;
					const current = stacks[stacks.length - 1] as Set<string>;
					if (current.has(key)) throw new Error("duplicate");
					current.add(key);
				}
				token = "";
				continue;
			}
			token += char;
			continue;
		}
		if (char === "\"") {
			inString = true;
			token = "";
			continue;
		}
		if (char === "{") stacks.push(new Set());
		if (char === "}") stacks.pop();
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKnownKeys(record: Record<string, unknown>, known: readonly string[]): void {
	const extras = Object.keys(record).filter((key) => !known.includes(key));
	if (extras.length > 0) throw new Error("unknown keys");
}

function parseIdentifier(value: unknown): string {
	if (typeof value !== "string" || !IDENTIFIER.test(value)) throw new Error("identifier");
	return value;
}

function parseArgs(value: unknown): string[] {
	if (!Array.isArray(value) || value.length > HARD_LIMITS.maxArgvItems) throw new Error("args");
	let total = 0;
	const args: string[] = [];
	for (const item of value) {
		if (typeof item !== "string" || item.includes("\0")) throw new Error("args");
		const size = utf8Bytes(item);
		if (size > HARD_LIMITS.maxArgvItemBytes) throw new Error("args");
		total += size;
		if (total > HARD_LIMITS.maxArgvTotalBytes) throw new Error("args");
		args.push(item);
	}
	return args;
}

function parseStartupTimeout(value: unknown): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isInteger(value) || typeof value !== "number") throw new Error("timeout");
	if (value < HARD_LIMITS.minStartupTimeoutMs || value > HARD_LIMITS.maxStartupTimeoutMs) throw new Error("timeout");
	return value;
}

function parseProfile(value: unknown): LaunchProfile {
	if (!isRecord(value)) throw new Error("profile");
	assertKnownKeys(value, ["kind", "args", "startupTimeoutMs"]);
	const profile: LaunchProfile = {
		kind: parseIdentifier(value.kind),
		args: parseArgs(value.args),
	};
	const startupTimeoutMs = parseStartupTimeout(value.startupTimeoutMs);
	if (startupTimeoutMs !== undefined) profile.startupTimeoutMs = startupTimeoutMs;
	return profile;
}

export function parseLaunchConfig(value: unknown): Record<string, LaunchProfile> {
	if (!isRecord(value)) throw new Error("object");
	assertKnownKeys(value, ["version", "profiles"]);
	if (value.version !== 1) throw new Error("version");
	if (!isRecord(value.profiles)) throw new Error("profiles");
	const profiles: Record<string, LaunchProfile> = {};
	for (const [id, entry] of Object.entries(value.profiles)) {
		if (!IDENTIFIER.test(id)) throw new Error("identifier");
		profiles[id] = parseProfile(entry);
	}
	return profiles;
}

export async function loadLaunchConfig(agentDir = getAgentDir()): Promise<LaunchConfigLoadResult> {
	const configPath = join(agentDir, LAUNCH_CONFIG_FILE);
	try {
		const info = await lstat(configPath);
		if (info.isSymbolicLink() || !info.isFile()) {
			return { ok: false, code: "launch_config_invalid", message: CONFIG_MESSAGE };
		}
		let parsed: unknown;
		try {
			parsed = parseJsonNoDuplicates(await readFile(configPath, "utf8"));
		} catch {
			return { ok: false, code: "launch_config_invalid", message: CONFIG_MESSAGE };
		}
		return { ok: true, config: { missing: false, profiles: parseLaunchConfig(parsed) } };
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			return { ok: true, config: { missing: true, profiles: {} } };
		}
		if (error instanceof Error) {
			return { ok: false, code: "launch_config_invalid", message: CONFIG_MESSAGE };
		}
		return { ok: false, code: "launch_config_invalid", message: CONFIG_MESSAGE };
	}
}

export function getLaunchProfile(config: LaunchConfig, profileId: string): LaunchProfileLookup {
	const profile = config.profiles[profileId];
	if (!profile) return { ok: false, code: "launch_profile_not_found", message: PROFILE_MESSAGE };
	return { ok: true, profile };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
