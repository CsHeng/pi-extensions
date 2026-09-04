import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	EXECUTION_PROFILES,
	REASONING_PROFILES,
	ROLE_NAMES,
	THINKING_LEVELS,
	type ExecutionProfile,
	type ReasoningProfile,
	type RoleName,
	type RouteSource,
	type ThinkingLevel,
} from "./contracts.ts";

export { THINKING_LEVELS } from "./contracts.ts";
export const ROUTE_CONFIG_FILE = "csheng-subagents.json";
export type ConfiguredThinking = "$parent" | ThinkingLevel;
export type DelegationGuidance = "off" | "balanced" | "aggressive";

const PACKAGE_CONFIG_PATH = fileURLToPath(new URL("../../config/csheng-subagents.json", import.meta.url));
const DEFAULT_GLOBAL_CONCURRENCY = 10;
const DEFAULT_ROLE_CONCURRENCY: Record<RoleName, number> = {
	explorer: 4,
	reviewer: 4,
	worker: 2,
};

export interface RouteCandidateConfig {
	model: string;
	thinking: ConfiguredThinking;
}

export interface ProfileRouteConfig {
	candidates: RouteCandidateConfig[];
	source: RouteSource;
}

export interface RoleRouteConfig {
	candidates: RouteCandidateConfig[];
	maxConcurrency: number;
	source: RouteSource;
	executionProfiles: Partial<Record<ExecutionProfile, ProfileRouteConfig>>;
}

export interface EffectiveSubagentConfig {
	guidance: DelegationGuidance;
	maxConcurrency: number;
	routes: Record<RoleName, RoleRouteConfig>;
	reasoningProfiles: Partial<Record<ReasoningProfile, ConfiguredThinking>>;
	reasoningProfileSources: Partial<Record<ReasoningProfile, RouteSource>>;
}

export interface ConfigLoadResult {
	config?: EffectiveSubagentConfig;
	diagnostic?: { code: "invalid_route_config"; message: string };
	source?: ConfigSourceSnapshot;
}

export interface ConfigSourceSnapshot {
	packageBytes: Buffer;
	userBytes?: Buffer;
}

interface ParseOptions {
	base?: EffectiveSubagentConfig;
	source?: RouteSource;
}

function neutralRoute(role: RoleName): RoleRouteConfig {
	return {
		candidates: [{ model: "$parent", thinking: "$parent" }],
		maxConcurrency: DEFAULT_ROLE_CONCURRENCY[role],
		source: "parent",
		executionProfiles: {},
	};
}

export function defaultConfig(): EffectiveSubagentConfig {
	return {
		guidance: "aggressive",
		maxConcurrency: DEFAULT_GLOBAL_CONCURRENCY,
		routes: {
			explorer: neutralRoute("explorer"),
			reviewer: neutralRoute("reviewer"),
			worker: neutralRoute("worker"),
		},
		reasoningProfiles: {},
		reasoningProfileSources: {},
	};
}

function cloneConfig(config: EffectiveSubagentConfig): EffectiveSubagentConfig {
	return {
		guidance: config.guidance,
		maxConcurrency: config.maxConcurrency,
		routes: Object.fromEntries(ROLE_NAMES.map((role) => [role, {
			...config.routes[role],
			candidates: config.routes[role].candidates.map((candidate) => ({ ...candidate })),
			executionProfiles: Object.fromEntries(Object.entries(config.routes[role].executionProfiles).map(([profile, route]) => [
				profile,
				{ ...route, candidates: route.candidates.map((candidate) => ({ ...candidate })) },
			])),
		}])) as Record<RoleName, RoleRouteConfig>,
		reasoningProfiles: { ...config.reasoningProfiles },
		reasoningProfileSources: { ...config.reasoningProfileSources },
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKnownKeys(record: Record<string, unknown>, known: readonly string[], owner: string): void {
	const extras = Object.keys(record).filter((key) => !known.includes(key));
	if (extras.length > 0) throw new Error(`${owner} contains unsupported fields: ${extras.join(", ")}`);
}

function parsePositiveLimit(value: unknown, owner: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
		throw new Error(`${owner} must be a positive safe integer`);
	}
	return value;
}

function parseThinking(value: unknown, owner: string): ConfiguredThinking {
	if (
		typeof value !== "string" ||
		(value !== "$parent" && !THINKING_LEVELS.includes(value as (typeof THINKING_LEVELS)[number]))
	) {
		throw new Error(`${owner} is unsupported`);
	}
	return value as ConfiguredThinking;
}

function parseCandidate(value: unknown, owner: string): RouteCandidateConfig {
	if (!isRecord(value)) throw new Error(`${owner} must be an object`);
	assertKnownKeys(value, ["model", "thinking"], owner);
	if (typeof value.model !== "string" || (value.model !== "$parent" && !value.model.includes("/"))) {
		throw new Error(`${owner}.model must be $parent or provider/model`);
	}
	return { model: value.model, thinking: parseThinking(value.thinking, `${owner}.thinking`) };
}

function parseCandidates(value: unknown, owner: string): RouteCandidateConfig[] {
	if (!Array.isArray(value) || value.length < 1 || value.length > 8) {
		throw new Error(`${owner} must contain 1 through 8 entries`);
	}
	return value.map((candidate, index) => parseCandidate(candidate, `${owner}[${index}]`));
}

function parseExecutionProfiles(
	value: unknown,
	role: RoleName,
	source: RouteSource,
	base: Partial<Record<ExecutionProfile, ProfileRouteConfig>>,
): Partial<Record<ExecutionProfile, ProfileRouteConfig>> {
	if (!isRecord(value)) throw new Error(`routes.${role}.executionProfiles must be an object`);
	assertKnownKeys(value, EXECUTION_PROFILES, `routes.${role}.executionProfiles`);
	const profiles = { ...base };
	for (const profile of EXECUTION_PROFILES) {
		const entry = value[profile];
		if (entry === undefined) continue;
		if (!isRecord(entry)) throw new Error(`routes.${role}.executionProfiles.${profile} must be an object`);
		assertKnownKeys(entry, ["candidates"], `routes.${role}.executionProfiles.${profile}`);
		profiles[profile] = {
			candidates: parseCandidates(entry.candidates, `routes.${role}.executionProfiles.${profile}.candidates`),
			source,
		};
	}
	return profiles;
}

function parseRoute(value: unknown, role: RoleName, source: RouteSource, base: RoleRouteConfig): RoleRouteConfig {
	if (!isRecord(value)) throw new Error(`routes.${role} must be an object`);
	assertKnownKeys(value, ["candidates", "maxConcurrency", "executionProfiles"], `routes.${role}`);
	return {
		candidates: value.candidates === undefined
			? base.candidates.map((candidate) => ({ ...candidate }))
			: parseCandidates(value.candidates, `routes.${role}.candidates`),
		maxConcurrency: value.maxConcurrency === undefined
			? base.maxConcurrency
			: parsePositiveLimit(value.maxConcurrency, `routes.${role}.maxConcurrency`),
		source: value.candidates === undefined ? base.source : source,
		executionProfiles: value.executionProfiles === undefined
			? { ...base.executionProfiles }
			: parseExecutionProfiles(value.executionProfiles, role, source, base.executionProfiles),
	};
}

export function parseConfig(value: unknown, options: ParseOptions = {}): EffectiveSubagentConfig {
	if (!isRecord(value)) throw new Error("route configuration must be an object");
	assertKnownKeys(value, ["guidance", "maxConcurrency", "routes", "reasoningProfiles"], "configuration");
	const source = options.source ?? "user-config";
	const base = cloneConfig(options.base ?? defaultConfig());
	if (value.guidance !== undefined) {
		if (value.guidance !== "off" && value.guidance !== "balanced" && value.guidance !== "aggressive") {
			throw new Error("guidance must be off, balanced, or aggressive");
		}
		base.guidance = value.guidance;
	}
	if (value.maxConcurrency !== undefined) {
		base.maxConcurrency = parsePositiveLimit(value.maxConcurrency, "maxConcurrency");
	}
	if (value.reasoningProfiles !== undefined) {
		if (!isRecord(value.reasoningProfiles)) throw new Error("reasoningProfiles must be an object");
		assertKnownKeys(value.reasoningProfiles, REASONING_PROFILES, "reasoningProfiles");
		for (const profile of REASONING_PROFILES) {
			if (value.reasoningProfiles[profile] === undefined) continue;
			base.reasoningProfiles[profile] = parseThinking(value.reasoningProfiles[profile], `reasoningProfiles.${profile}`);
			base.reasoningProfileSources[profile] = source;
		}
	}
	if (value.routes !== undefined) {
		if (!isRecord(value.routes)) throw new Error("routes must be an object");
		assertKnownKeys(value.routes, ROLE_NAMES, "routes");
		for (const role of ROLE_NAMES) {
			if (value.routes[role] !== undefined) base.routes[role] = parseRoute(value.routes[role], role, source, base.routes[role]);
		}
	}
	return base;
}

async function readRegularFile(path: string, owner: string): Promise<Buffer> {
	const info = await lstat(path);
	if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${owner} must be a regular non-symlink file`);
	return readFile(path);
}

function parseJsonBytes(bytes: Buffer, owner: string): unknown {
	try {
		return JSON.parse(bytes.toString("utf8")) as unknown;
	} catch (error) {
		if (error instanceof SyntaxError) throw new Error(`${owner} is not valid JSON`);
		throw error;
	}
}

export async function readConfigSources(agentDir = getAgentDir()): Promise<ConfigSourceSnapshot> {
	const packageBytes = await readRegularFile(PACKAGE_CONFIG_PATH, "packaged route configuration");
	const configPath = join(agentDir, ROUTE_CONFIG_FILE);
	try {
		return { packageBytes, userBytes: await readRegularFile(configPath, "route configuration") };
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return { packageBytes };
		throw error;
	}
}

export function parseConfigSources(snapshot: ConfigSourceSnapshot): ConfigLoadResult {
	try {
		const packaged = parseConfig(parseJsonBytes(snapshot.packageBytes, "packaged route configuration"), { source: "package-default" });
		if (!snapshot.userBytes) return { config: packaged, source: snapshot };
		return {
			config: parseConfig(parseJsonBytes(snapshot.userBytes, "route configuration"), { base: packaged, source: "user-config" }),
			source: snapshot,
		};
	} catch (error) {
		return {
			source: snapshot,
			diagnostic: {
				code: "invalid_route_config",
				message: error instanceof Error ? error.message : String(error),
			},
		};
	}
}

export async function loadConfig(agentDir = getAgentDir()): Promise<ConfigLoadResult> {
	try {
		return parseConfigSources(await readConfigSources(agentDir));
	} catch (error) {
		return {
			diagnostic: {
				code: "invalid_route_config",
				message: error instanceof Error ? error.message : String(error),
			},
		};
	}
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
