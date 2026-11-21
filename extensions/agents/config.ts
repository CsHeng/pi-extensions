import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	EXECUTION_PROFILES,
	THINKING_PROFILES,
	THINKING_LEVELS,
	type ExecutionProfile,
	type ThinkingProfile,
	type RouteSource,
	type ThinkingLevel,
} from "./contracts.ts";
import { ROLE_NAME_PATTERN } from "./role-definitions.ts";

export { THINKING_LEVELS } from "./contracts.ts";
export const ROUTE_CONFIG_FILE = "agent-routes.json";
export type ConfiguredThinking = "$parent" | ThinkingLevel;

const PACKAGE_CONFIG_PATH = fileURLToPath(new URL("../../config/agent-routes.json", import.meta.url));
const DEFAULT_GLOBAL_CONCURRENCY = 10;
const DEFAULT_ROLE_CONCURRENCY = { explorer: 4, reviewer: 4, worker: 2 };
type PackagedRole = keyof typeof DEFAULT_ROLE_CONCURRENCY;
type ByRole<T> = Record<string, T> & Record<PackagedRole, T>;

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

export interface EffectiveAgentConfig {
	maxConcurrency: number;
	routes: ByRole<RoleRouteConfig>;
	roles: ByRole<{ inheritSkills: boolean }>;
	thinkingProfiles: Partial<Record<ThinkingProfile, ConfiguredThinking>>;
	thinkingProfileSources: Partial<Record<ThinkingProfile, RouteSource>>;
}

export interface ConfigLoadResult {
	config?: EffectiveAgentConfig;
	diagnostic?: { code: "invalid_route_config"; message: string };
	source?: ConfigSourceSnapshot;
}

export interface ConfigSourceSnapshot {
	packageBytes: Buffer;
	userBytes?: Buffer;
	/** Selected filename only, never raw routes or an agent-directory path. */
	userFile?: typeof ROUTE_CONFIG_FILE;
}

interface ParseOptions {
	base?: EffectiveAgentConfig;
	source?: RouteSource;
}

export function neutralRoute(maxConcurrency: number): RoleRouteConfig {
	return {
		candidates: [{ model: "$parent", thinking: "$parent" }],
		maxConcurrency,
		source: "parent",
		executionProfiles: {},
	};
}

export function defaultConfig(): EffectiveAgentConfig {
	return {
		maxConcurrency: DEFAULT_GLOBAL_CONCURRENCY,
		roles: { explorer: { inheritSkills: true }, reviewer: { inheritSkills: true }, worker: { inheritSkills: true } },
		routes: {
			explorer: neutralRoute(DEFAULT_ROLE_CONCURRENCY.explorer),
			reviewer: neutralRoute(DEFAULT_ROLE_CONCURRENCY.reviewer),
			worker: neutralRoute(DEFAULT_ROLE_CONCURRENCY.worker),
		},
		thinkingProfiles: {},
		thinkingProfileSources: {},
	};
}

function cloneConfig(config: EffectiveAgentConfig): EffectiveAgentConfig {
	return {
		maxConcurrency: config.maxConcurrency,
		roles: Object.fromEntries(Object.entries(config.roles).map(([role, settings]) => [role, { ...settings }])) as EffectiveAgentConfig["roles"],
		routes: Object.fromEntries(Object.entries(config.routes).map(([role, route]) => [role, {
			...route,
			candidates: route.candidates.map((candidate) => ({ ...candidate })),
			executionProfiles: Object.fromEntries(Object.entries(route.executionProfiles).map(([profile, profileRoute]) => [
				profile,
				{ ...profileRoute, candidates: profileRoute.candidates.map((candidate) => ({ ...candidate })) },
			])),
		}])) as EffectiveAgentConfig["routes"],
		thinkingProfiles: { ...config.thinkingProfiles },
		thinkingProfileSources: { ...config.thinkingProfileSources },
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
	role: string,
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

function parseRoute(value: unknown, role: string, source: RouteSource, base: RoleRouteConfig): RoleRouteConfig {
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

function rejectLegacyProfileConfig(value: Record<string, unknown>): void {
	// Typed rejection only. Do not alias, apply, or rewrite a legacy reasoningProfiles mapping.
	if ("reasoningProfiles" in value) {
		throw new Error("reasoningProfiles is not accepted; use thinkingProfiles. The configuration file was not rewritten.");
	}
}

export function parseConfig(value: unknown, options: ParseOptions = {}): EffectiveAgentConfig {
	if (!isRecord(value)) throw new Error("route configuration must be an object");
	rejectLegacyProfileConfig(value);
	assertKnownKeys(value, ["maxConcurrency", "routes", "roles", "thinkingProfiles"], "configuration");
	const source = options.source ?? "user-config";
	const base = cloneConfig(options.base ?? defaultConfig());
	if (value.maxConcurrency !== undefined) {
		base.maxConcurrency = parsePositiveLimit(value.maxConcurrency, "maxConcurrency");
	}
	if (value.thinkingProfiles !== undefined) {
		if (!isRecord(value.thinkingProfiles)) throw new Error("thinkingProfiles must be an object");
		assertKnownKeys(value.thinkingProfiles, THINKING_PROFILES, "thinkingProfiles");
		for (const profile of THINKING_PROFILES) {
			if (value.thinkingProfiles[profile] === undefined) continue;
			base.thinkingProfiles[profile] = parseThinking(value.thinkingProfiles[profile], `thinkingProfiles.${profile}`);
			base.thinkingProfileSources[profile] = source;
		}
	}
	if (value.roles !== undefined) {
		if (!isRecord(value.roles)) throw new Error("roles must be an object");
		for (const [role, entry] of Object.entries(value.roles)) {
			if (!ROLE_NAME_PATTERN.test(role)) throw new Error("roles contains an invalid role name");
			if (!isRecord(entry)) throw new Error(`roles.${role} must be an object`);
			assertKnownKeys(entry, ["inheritSkills"], `roles.${role}`);
			if (typeof entry.inheritSkills !== "boolean") throw new Error(`roles.${role}.inheritSkills must be a boolean`);
			base.roles[role] = { inheritSkills: entry.inheritSkills };
		}
	}
	if (value.routes !== undefined) {
		if (!isRecord(value.routes)) throw new Error("routes must be an object");
		for (const [role, entry] of Object.entries(value.routes)) {
			if (!ROLE_NAME_PATTERN.test(role)) throw new Error("routes contains an invalid role name");
			const existing = Object.hasOwn(base.routes, role) ? base.routes[role] : undefined;
			base.routes[role] = parseRoute(entry, role, source, existing ?? neutralRoute(base.maxConcurrency));
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
	// The canonical file is the only user source. Invalid/unsafe input is an error, not permission
	// to fall back to another file; the user file is never rewritten.
	try {
		return { packageBytes, userBytes: await readRegularFile(join(agentDir, ROUTE_CONFIG_FILE), "route configuration"), userFile: ROUTE_CONFIG_FILE };
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
