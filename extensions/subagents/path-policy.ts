import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
	CHILD_CAPABILITY_ENV,
	CHILD_CAPABILITY_MANIFEST_VERSION,
	isSafePathGrammar,
	type CapabilityGrant,
	type ChildCapabilityManifest,
	type NormalizedChildCapability,
	type RoleName,
} from "./contracts.ts";
import { pathContains } from "./access.ts";
import { toolsForAccess } from "./roles.ts";

export interface PathDecision {
	allowed: boolean;
	fatal?: boolean;
	reason?: string;
	resolvedPath?: string;
}

export interface CapabilityLoadResult {
	manifest?: NormalizedChildCapability;
	error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRole(value: unknown): value is RoleName {
	return value === "explorer" || value === "reviewer" || value === "worker";
}

function isPermission(value: unknown): value is "read" | "write" {
	return value === "read" || value === "write";
}

const MANIFEST_KEYS = new Set(["version", "role", "cwd", "grants", "roots", "guidance"]);

function parsePin(value: unknown): { dev: number; ino: number } | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value) || Object.keys(value).length !== 2 || typeof value.dev !== "number" || typeof value.ino !== "number" || !Number.isSafeInteger(value.dev) || !Number.isSafeInteger(value.ino) || value.dev < 0 || value.ino < 0) {
		throw new Error("invalid access identity");
	}
	return { dev: value.dev, ino: value.ino };
}

function parseAnchor(value: unknown): { path: string; dev: number; ino: number } | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value) || Object.keys(value).length !== 3 || typeof value.path !== "string" || !isAbsolute(value.path) || resolve(value.path) !== value.path || typeof value.dev !== "number" || typeof value.ino !== "number" || !Number.isSafeInteger(value.dev) || !Number.isSafeInteger(value.ino) || value.dev < 0 || value.ino < 0) {
		throw new Error("invalid access anchor");
	}
	return { path: value.path, dev: value.dev, ino: value.ino };
}

export function parseCapability(value: unknown): NormalizedChildCapability {
	if (!isRecord(value) || value.version !== CHILD_CAPABILITY_MANIFEST_VERSION || !isRole(value.role) || typeof value.cwd !== "string") {
		throw new Error("capability manifest has an unsupported version, role, or cwd");
	}
	if (Object.keys(value).some((key) => !MANIFEST_KEYS.has(key))) throw new Error("capability manifest contains unknown fields");
	if (!Array.isArray(value.grants) || !Array.isArray(value.roots)) throw new Error("capability manifest grants and roots are required");
	const grants: CapabilityGrant[] = value.grants.map((entry) => {
		if (!isRecord(entry) || !isPermission(entry.permission) || typeof entry.path !== "string" || !isAbsolute(entry.path) || resolve(entry.path) !== entry.path) throw new Error("capability grant must be a canonical absolute path");
		const pin = parsePin(entry.pin);
		const anchor = parseAnchor(entry.anchor);
		return { permission: entry.permission, path: entry.path, ...(pin ? { pin } : {}), ...(anchor ? { anchor } : {}) };
	});
	const roots = value.roots.map((entry) => {
		if (!isRecord(entry) || typeof entry.id !== "string" || !/^[a-z0-9]{32}$/.test(entry.id) || typeof entry.source !== "string" || typeof entry.path !== "string" || !isPermission(entry.permission)) throw new Error("capability root is invalid");
		if (!isAbsolute(entry.source) || !isAbsolute(entry.path) || resolve(entry.source) !== entry.source || resolve(entry.path) !== entry.path) throw new Error("capability root paths must be canonical");
		return { id: entry.id, source: entry.source, path: entry.path, permission: entry.permission };
	});
	if (!isAbsolute(value.cwd) || resolve(value.cwd) !== value.cwd) throw new Error("capability cwd must be canonical");
	let guidance: NormalizedChildCapability["guidance"];
	if (value.guidance !== undefined) {
		if (!isRecord(value.guidance) || Object.keys(value.guidance).some((key) => !["contextFiles", "readRoots", "physicalRoots"].includes(key)) || !Array.isArray(value.guidance.readRoots) || !Array.isArray(value.guidance.physicalRoots) || !Array.isArray(value.guidance.contextFiles)) throw new Error("invalid guidance capability");
		const readRoots = value.guidance.readRoots as unknown[];
		const physicalRoots = value.guidance.physicalRoots as unknown[];
		const files = value.guidance.contextFiles as unknown[];
		if (readRoots.length !== physicalRoots.length || readRoots.some((path) => typeof path !== "string" || !isAbsolute(path)) || physicalRoots.some((path) => typeof path !== "string" || !isAbsolute(path))) throw new Error("invalid guidance paths");
		if (!files.every((file) => isRecord(file) && typeof file.path === "string" && typeof file.content === "string" && isAbsolute(file.path))) throw new Error("invalid guidance files");
		guidance = { readRoots: readRoots as string[], physicalRoots: physicalRoots as string[], contextFiles: files as Array<{ path: string; content: string }> };
	}
	return { version: CHILD_CAPABILITY_MANIFEST_VERSION, role: value.role, cwd: resolve(value.cwd), grants, roots, ...(guidance ? { guidance } : {}) };
}

export async function assertCanonicalGrants(manifest: Pick<NormalizedChildCapability, "grants">): Promise<void> {
	for (const grant of manifest.grants) {
		const coveredReadPin = grant.permission === "read" && manifest.grants.some(other => other.permission === "write" && pathContains(other.path, grant.path));
		if (grant.pin && !coveredReadPin) {
			const info = await lstat(grant.path);
			if ((!info.isFile() && !info.isDirectory()) || info.dev !== grant.pin.dev || info.ino !== grant.pin.ino) throw new Error("access identity changed");
			const physical = await realpath(grant.path).catch(() => grant.path);
			if (physical !== grant.path) throw new Error("access path is no longer canonical");
		}
		if (grant.anchor) {
			const info = await lstat(grant.anchor.path);
			if (!info.isDirectory() || info.dev !== grant.anchor.dev || info.ino !== grant.anchor.ino || await realpath(grant.anchor.path) !== grant.anchor.path) throw new Error("access anchor changed");
		}
	}
}

export async function loadCapability(env: NodeJS.ProcessEnv = process.env): Promise<CapabilityLoadResult> {
	const manifestPath = env[CHILD_CAPABILITY_ENV];
	if (!manifestPath) return { error: "child capability manifest is missing" };
	try {
		const info = await lstat(manifestPath);
		if (!info.isFile() || info.isSymbolicLink()) return { error: "child capability manifest must be a regular non-symlink file" };
		if ((info.mode & 0o077) !== 0) return { error: "child capability manifest permissions are too broad" };
		const manifest = parseCapability(JSON.parse(await readFile(manifestPath, "utf8")) as unknown);
		await assertCanonicalGrants(manifest);
		return { manifest };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

function covering(grants: readonly CapabilityGrant[], target: string, write: boolean): CapabilityGrant | undefined {
	const matches = grants.filter((grant) => pathContains(grant.path, target) && (!write || grant.permission === "write"));
	// A writable range owns the path: its stable anchor must never be shadowed by a
	// read-only evidence pin, so an authorized leaf replacement stays possible.
	return matches.find((grant) => grant.permission === "write") ?? matches[0];
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

/** Nearest component that exists; an authorized new path may have a missing tail. */
async function nearestExisting(target: string): Promise<string> {
	let current = target;
	for (;;) {
		try { await lstat(current); return current; }
		catch (error) {
			if (!isNodeError(error) || error.code !== "ENOENT") throw error;
			const parent = dirname(current);
			if (parent === current) throw error;
			current = parent;
		}
	}
}

/** True when any existing component from `root` to `target` is a symlink; a missing tail is not one. */
async function hasSymlinkComponent(root: string, target: string): Promise<boolean> {
	const relation = relative(root, target);
	if (relation === "" || relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) return relation !== "";
	let current = root;
	for (const component of relation.split(sep)) {
		current = resolve(current, component);
		try { if ((await lstat(current)).isSymbolicLink()) return true; }
		catch (error) { if (isNodeError(error) && error.code === "ENOENT") return false; throw error; }
	}
	return false;
}

/**
 * `container` is already trusted (a matched pin or a verified physical chain).
 * The nearest existing target component must resolve physically inside it; a missing
 * tail is created under that container and never follows an existing symlink out.
 */
async function containedPhysical(container: string, target: string): Promise<PathDecision | undefined> {
	let physicalContainer: string;
	let physicalTarget: string;
	try {
		physicalContainer = await realpath(container);
		physicalTarget = await realpath(await nearestExisting(target));
	} catch {
		return { allowed: false, fatal: true, reason: "Path could not be checked safely." };
	}
	if (physicalTarget === physicalContainer || pathContains(physicalContainer, physicalTarget)) return undefined;
	return { allowed: false, fatal: true, reason: "Path escapes the pinned grant." };
}

/**
 * Walk from `anchor` to the filesystem root. A missing tail is the expected shape of
 * an authorized new path; any existing symlink on the chain means the anchored range
 * no longer names the prepared object, including ancestors above the child cwd.
 */
async function anchorChain(anchor: string): Promise<PathDecision | undefined> {
	let current = anchor;
	for (;;) {
		try {
			if ((await lstat(current)).isSymbolicLink()) return { allowed: false, fatal: true, reason: "The granted path anchor or an ancestor is a symlink." };
		} catch (error) {
			if (!isNodeError(error) || (error.code !== "ENOENT" && error.code !== "ENOTDIR")) return { allowed: false, fatal: true, reason: "Path could not be checked safely." };
		}
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

export async function authorizePath(
	manifest: ChildCapabilityManifest,
	toolName: string,
	requestedPath: string,
): Promise<PathDecision> {
	const capability = parseCapability(manifest);
	const write = toolName === "edit" || toolName === "write";
	const allowedTools = toolsForAccess(capability.grants.some((grant) => grant.permission === "write"));
	if (toolName === "bash") return { allowed: false, reason: "Shell is cooperative and is not a path grant." };
	if (!allowedTools.includes(toolName) && toolName !== "read") return { allowed: false, reason: `Tool ${toolName} is outside the granted capability.` };
	if (!isSafePathGrammar(requestedPath) || requestedPath.includes("\0")) return { allowed: false, reason: "Path is unsafe." };
	const target = isAbsolute(requestedPath) ? resolve(requestedPath) : resolve(capability.cwd, requestedPath);
	const guidance = write ? undefined : capability.guidance?.readRoots.find((root) => pathContains(root, target));
	const grant = covering(capability.grants, target, write);
	if (!grant && !guidance) return { allowed: false, reason: write ? "Path is outside the write grant." : "Path is outside the read grant." };
	// Relative paths resolve only against cwd. Do not search another grant for a matching relative name.
	const resolved = target;
	if (write && grant && relative(grant.path, resolved).split(sep)[0] === ".git") return { allowed: false, reason: "Managed Git metadata is not a source write." };
	try {
		if (grant) {
			// Read-only evidence keeps an immutable identity; a writable or missing
			// selector binds to a stable existing parent so an authorized leaf may be
			// created, deleted or atomically replaced without widening the range.
			if (grant.pin) {
				let info;
				try { info = await lstat(grant.path); }
				catch { return { allowed: false, fatal: true, reason: "Access identity changed." }; }
				if ((!info.isFile() && !info.isDirectory()) || info.dev !== grant.pin.dev || info.ino !== grant.pin.ino) return { allowed: false, fatal: true, reason: "Access identity changed." };
				const decision = await containedPhysical(grant.path, resolved);
				if (decision) return decision;
				return { allowed: true, resolvedPath: resolved };
			}
			if (grant.anchor) {
				let info;
				try { info = await lstat(grant.anchor.path); }
				catch { return { allowed: false, fatal: true, reason: "Access anchor changed." }; }
				if (!info.isDirectory() || info.dev !== grant.anchor.dev || info.ino !== grant.anchor.ino) return { allowed: false, fatal: true, reason: "Access anchor changed." };
				// A writable selector never follows a symlink, even one that resolves inside the range.
				if (write && await hasSymlinkComponent(grant.anchor.path, resolved)) return { allowed: false, fatal: true, reason: "Writes through symlinks are not allowed." };
				const decision = await containedPhysical(grant.anchor.path, resolved);
				if (decision) return decision;
				// The anchor proves stable ancestry, not a wider read grant. A mutable
				// selected leaf may not redirect reads to its otherwise ungranted siblings.
				if (!write) {
					const existing = await nearestExisting(resolved);
					const physical = resolve(await realpath(existing), relative(existing, resolved));
					if (!pathContains(grant.path, physical)) return { allowed: false, reason: "Read target is outside the selected grant." };
				}
				return { allowed: true, resolvedPath: resolved };
			}
			// A synthesized current manifest without a recorded binding requires a physical,
			// symlink-free chain before trusting the nearest existing component.
			const anchor = await anchorChain(grant.path);
			if (anchor) return anchor;
			const container = await nearestExisting(grant.path);
			const decision = await containedPhysical(container, resolved);
			if (decision) return decision;
			return { allowed: true, resolvedPath: resolved };
		}
		// Guidance-only read: the build-time physical owner is the accepted container.
		const index = capability.guidance!.readRoots.indexOf(guidance!);
		const pinned = capability.guidance!.physicalRoots[index];
		if (pinned === undefined || await realpath(guidance!) !== pinned) return { allowed: false, fatal: true, reason: "Guidance owner changed." };
		const decision = await containedPhysical(guidance!, resolved);
		if (decision) return decision;
		return { allowed: true, resolvedPath: resolved };
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return { allowed: false, fatal: code !== "ENOENT" && code !== "ENOTDIR", reason: "Path could not be checked safely." };
	}
}
