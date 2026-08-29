import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { HARD_LIMITS, ROLE_NAMES, type RoleName } from "./contracts.ts";

export const ROUTE_CONFIG_FILE = "csheng-subagents.json";
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ConfiguredThinking = "$parent" | (typeof THINKING_LEVELS)[number];
export type DelegationGuidance = "off" | "balanced" | "aggressive";

export interface RouteCandidateConfig {
	model: string;
	thinking: ConfiguredThinking;
}

export interface RoleRouteConfig {
	candidates: RouteCandidateConfig[];
	maxConcurrency: number;
	source: "parent" | "user-config";
}

export interface EffectiveSubagentConfig {
	guidance: DelegationGuidance;
	maxConcurrency: number;
	routes: Record<RoleName, RoleRouteConfig>;
	configPath: string;
}

export interface ConfigLoadResult {
	config?: EffectiveSubagentConfig;
	diagnostic?: { code: "invalid_route_config"; message: string };
}

function defaultRoute(role: RoleName): RoleRouteConfig {
	return {
		candidates: [{ model: "$parent", thinking: "$parent" }],
		maxConcurrency: role === "explorer" ? HARD_LIMITS.maxConcurrency : HARD_LIMITS.maxWorkers,
		source: "parent",
	};
}

export function defaultConfig(agentDir = getAgentDir()): EffectiveSubagentConfig {
	return {
		guidance: "aggressive",
		maxConcurrency: HARD_LIMITS.maxConcurrency,
		routes: {
			explorer: defaultRoute("explorer"),
			reviewer: defaultRoute("reviewer"),
			worker: defaultRoute("worker"),
		},
		configPath: join(agentDir, ROUTE_CONFIG_FILE),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKnownKeys(record: Record<string, unknown>, known: readonly string[], owner: string): void {
	const extras = Object.keys(record).filter((key) => !known.includes(key));
	if (extras.length > 0) throw new Error(`${owner} contains unsupported fields: ${extras.join(", ")}`);
}

function parsePositiveLimit(value: unknown, ceiling: number, owner: string): number {
	if (!Number.isInteger(value) || typeof value !== "number" || value < 1 || value > ceiling) {
		throw new Error(`${owner} must be an integer from 1 through ${ceiling}`);
	}
	return value;
}

function parseCandidate(value: unknown, owner: string): RouteCandidateConfig {
	if (!isRecord(value)) throw new Error(`${owner} must be an object`);
	assertKnownKeys(value, ["model", "thinking"], owner);
	if (typeof value.model !== "string" || (value.model !== "$parent" && !value.model.includes("/"))) {
		throw new Error(`${owner}.model must be $parent or provider/model`);
	}
	if (
		typeof value.thinking !== "string" ||
		(value.thinking !== "$parent" && !THINKING_LEVELS.includes(value.thinking as (typeof THINKING_LEVELS)[number]))
	) {
		throw new Error(`${owner}.thinking is unsupported`);
	}
	return { model: value.model, thinking: value.thinking as ConfiguredThinking };
}

function parseRoute(value: unknown, role: RoleName): RoleRouteConfig {
	if (!isRecord(value)) throw new Error(`routes.${role} must be an object`);
	assertKnownKeys(value, ["candidates", "maxConcurrency"], `routes.${role}`);
	if (!Array.isArray(value.candidates) || value.candidates.length < 1 || value.candidates.length > 8) {
		throw new Error(`routes.${role}.candidates must contain 1 through 8 entries`);
	}
	const roleCeiling = role === "worker" ? HARD_LIMITS.maxWorkers : HARD_LIMITS.maxConcurrency;
	return {
		candidates: value.candidates.map((candidate, index) => parseCandidate(candidate, `routes.${role}.candidates[${index}]`)),
		maxConcurrency:
			value.maxConcurrency === undefined
				? defaultRoute(role).maxConcurrency
				: parsePositiveLimit(value.maxConcurrency, roleCeiling, `routes.${role}.maxConcurrency`),
		source: "user-config",
	};
}

export function parseConfig(value: unknown, agentDir = getAgentDir()): EffectiveSubagentConfig {
	if (!isRecord(value)) throw new Error("route configuration must be an object");
	assertKnownKeys(value, ["guidance", "maxConcurrency", "routes"], "configuration");
	const base = defaultConfig(agentDir);
	if (value.guidance !== undefined) {
		if (value.guidance !== "off" && value.guidance !== "balanced" && value.guidance !== "aggressive") {
			throw new Error("guidance must be off, balanced, or aggressive");
		}
		base.guidance = value.guidance;
	}
	if (value.maxConcurrency !== undefined) {
		base.maxConcurrency = parsePositiveLimit(value.maxConcurrency, HARD_LIMITS.maxConcurrency, "maxConcurrency");
	}
	if (value.routes !== undefined) {
		if (!isRecord(value.routes)) throw new Error("routes must be an object");
		assertKnownKeys(value.routes, ROLE_NAMES, "routes");
		for (const role of ROLE_NAMES) {
			if (value.routes[role] !== undefined) base.routes[role] = parseRoute(value.routes[role], role);
		}
	}
	return base;
}

export async function loadConfig(agentDir = getAgentDir()): Promise<ConfigLoadResult> {
	const configPath = join(agentDir, ROUTE_CONFIG_FILE);
	try {
		const info = await lstat(configPath);
		if (info.isSymbolicLink() || !info.isFile()) {
			return { diagnostic: { code: "invalid_route_config", message: "route configuration must be a regular non-symlink file" } };
		}
		const parsed = JSON.parse(await readFile(configPath, "utf8")) as unknown;
		return { config: parseConfig(parsed, agentDir) };
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return { config: defaultConfig(agentDir) };
		return {
			diagnostic: {
				code: "invalid_route_config",
				message: error instanceof SyntaxError ? "route configuration is not valid JSON" : error instanceof Error ? error.message : String(error),
			},
		};
	}
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
