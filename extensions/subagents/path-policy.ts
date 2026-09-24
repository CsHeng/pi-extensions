import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
	CHILD_CAPABILITY_ENV,
	CHILD_CAPABILITY_MANIFEST_V1,
	CHILD_CAPABILITY_MANIFEST_V2,
	isSafePathGrammar,
	type ChildCapabilityManifest,
	type NormalizedChildCapability,
	type RoleName,
} from "./contracts.ts";
import { getRole } from "./roles.ts";

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

function escapesRoot(relation: string): boolean {
	return relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation);
}

function contains(root: string, target: string): boolean {
	const relation = relative(root, target);
	return relation === "" || !escapesRoot(relation);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function isRole(value: unknown): value is RoleName {
	return value === "explorer" || value === "reviewer" || value === "worker";
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

async function nearestExisting(target: string): Promise<string> {
	let current = target;
	while (true) {
		try {
			await lstat(current);
			return current;
		} catch (error) {
			if (!isNodeError(error) || error.code !== "ENOENT") throw error;
			const parent = resolve(current, "..");
			if (parent === current) throw error;
			current = parent;
		}
	}
}

async function hasSymlinkComponent(root: string, target: string): Promise<boolean> {
	const relation = relative(root, target);
	if (relation === "") return false;
	if (escapesRoot(relation)) return true;
	let current = root;
	for (const component of relation.split(sep)) {
		current = resolve(current, component);
		try {
			if ((await lstat(current)).isSymbolicLink()) return true;
		} catch (error) {
			if (isNodeError(error) && error.code === "ENOENT") return false;
			throw error;
		}
	}
	return false;
}

function normalizedCapability(manifest: ChildCapabilityManifest): NormalizedChildCapability {
	if (manifest.version === CHILD_CAPABILITY_MANIFEST_V2) return manifest;
	return {
		version: CHILD_CAPABILITY_MANIFEST_V2,
		root: manifest.root,
		role: manifest.role,
		readRoots: manifest.readRoots,
		writePaths: manifest.writePaths,
		externalReadRoots: [],
	};
}

const MANIFEST_V1_KEYS = new Set(["version", "root", "role", "readRoots", "writePaths"]);
const MANIFEST_V2_KEYS = new Set([...MANIFEST_V1_KEYS, "externalReadRoots", "externalReadPins", "writeRoot", "guidance"]);

function assertExactManifestKeys(value: Record<string, unknown>, version: unknown): void {
	const allowed = version === CHILD_CAPABILITY_MANIFEST_V1 ? MANIFEST_V1_KEYS : MANIFEST_V2_KEYS;
	if (Object.keys(value).some((key) => !allowed.has(key))) {
		throw new Error("capability manifest contains unknown fields");
	}
}

function parseExternalReadRoots(value: Record<string, unknown>, version: unknown): string[] {
	if (version === CHILD_CAPABILITY_MANIFEST_V1) {
		if ("externalReadRoots" in value) {
			throw new Error("capability manifest v1 cannot contain external read roots");
		}
		return [];
	}
	if (!isStringArray(value.externalReadRoots)) {
		throw new Error("capability manifest externalReadRoots must be strings");
	}
	return value.externalReadRoots.map((entry) => {
		if (!isAbsolute(entry) || resolve(entry) !== entry) {
			throw new Error("capability manifest external read roots must be absolute and canonical");
		}
		return entry;
	});
}

export function parseCapability(value: unknown): NormalizedChildCapability {
	if (!isRecord(value) || (value.version !== CHILD_CAPABILITY_MANIFEST_V1 && value.version !== CHILD_CAPABILITY_MANIFEST_V2) || !isRole(value.role) || typeof value.root !== "string") {
		throw new Error("capability manifest has an invalid version, role, or root");
	}
	if (!isStringArray(value.readRoots)) {
		throw new Error("capability manifest readRoots must be strings");
	}
	if (!isStringArray(value.writePaths)) {
		throw new Error("capability manifest writePaths must be strings");
	}
	if (value.writeRoot !== undefined && (value.writeRoot !== true || value.version !== 2 || value.role !== "worker")) throw new Error("invalid source-root write capability");
	const externalReadRoots = parseExternalReadRoots(value, value.version);
	const externalReadPins = value.externalReadPins;
	if (externalReadPins !== undefined && (value.version !== 2 || !Array.isArray(externalReadPins) || externalReadPins.length !== externalReadRoots.length || !externalReadPins.every(pin => isRecord(pin) && Object.keys(pin).length === 2 && typeof pin.dev === "number" && Number.isSafeInteger(pin.dev) && typeof pin.ino === "number" && Number.isSafeInteger(pin.ino) && pin.dev >= 0 && pin.ino >= 0))) throw new Error("invalid external read identities");
	assertExactManifestKeys(value, value.version);
	let guidance: NormalizedChildCapability["guidance"];
	if (value.guidance !== undefined) {
		if (value.version !== 2 || !isRecord(value.guidance) || Object.keys(value.guidance).some(key => !["contextFiles", "readRoots", "physicalRoots"].includes(key)) || !isStringArray(value.guidance.readRoots) || !isStringArray(value.guidance.physicalRoots) || !Array.isArray(value.guidance.contextFiles) || !value.guidance.contextFiles.every(file => isRecord(file) && Object.keys(file).every(key => ["path", "content"].includes(key)) && typeof file.path === "string" && typeof file.content === "string")) throw new Error("invalid guidance capability");
		const roots = value.guidance.readRoots as string[];
		const physical = value.guidance.physicalRoots as string[];
		const files = value.guidance.contextFiles as Array<{ path: string; content: string }>;
		if (roots.length !== physical.length || roots.some(path => !isAbsolute(path) || resolve(path) !== path) || physical.some(path => !isAbsolute(path) || resolve(path) !== path) || files.some(file => !isAbsolute(file.path) || resolve(file.path) !== file.path || !roots.includes(file.path))) throw new Error("invalid guidance paths");
		guidance = { readRoots: roots, physicalRoots: physical, contextFiles: files };
	}
	if (!isAbsolute(value.root) || value.readRoots.some((entry) => !isAbsolute(entry)) || value.writePaths.some((entry) => !isAbsolute(entry))) {
		throw new Error("capability manifest paths must be absolute");
	}
	const root = resolve(value.root);
	const readRoots = value.readRoots.map((entry) => resolve(entry));
	const writePaths = value.writePaths.map((entry) => resolve(entry));
	if (readRoots.some((entry) => !contains(root, entry)) || writePaths.some((entry) => !contains(root, entry))) {
		throw new Error("capability manifest paths must stay inside the root");
	}
	if (value.role !== "worker" && writePaths.length > 0) {
		throw new Error("read-only capability cannot contain write paths");
	}
	return { version: CHILD_CAPABILITY_MANIFEST_V2, root, role: value.role, readRoots, writePaths, externalReadRoots, ...(externalReadPins ? { externalReadPins: externalReadPins as Array<{ dev: number; ino: number }> } : {}), ...(guidance ? { guidance } : {}), ...(value.writeRoot === true ? { writeRoot: true } : {}) };
}

export async function assertCanonicalExternalRoots(manifest: NormalizedChildCapability): Promise<void> {
	for (const [index, entry] of manifest.externalReadRoots.entries()) {
		let physical: string;
		try {
			physical = await realpath(entry);
		} catch {
			throw new Error("capability manifest external read roots must be absolute and canonical");
		}
		if (physical !== entry) {
			throw new Error("capability manifest external read roots must be absolute and canonical");
		}
		const pin = manifest.externalReadPins?.[index];
		if (pin) { const info = await lstat(entry); if ((!info.isFile() && !info.isDirectory()) || info.dev !== pin.dev || info.ino !== pin.ino) throw new Error("external read root identity changed"); }
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
		await assertCanonicalExternalRoots(manifest);
		return { manifest };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

async function physicalRoots(roots: readonly string[]): Promise<string[]> {
	return Promise.all(roots.map(async (root) => {
		try { return await realpath(root); } catch { return root; }
	}));
}

async function authorizeRead(
	capability: NormalizedChildCapability,
	toolName: string,
	target: string,
	lexicalRoots: readonly string[],
	confineToChildRoot: boolean,
	pinnedPhysical?: readonly string[],
): Promise<PathDecision> {
	const existing = await nearestExisting(target);
	const physicalExisting = await realpath(existing);
	const allowedPhysical = pinnedPhysical ?? await physicalRoots(lexicalRoots);
	if (confineToChildRoot) {
		const physicalRoot = await realpath(capability.root);
		if (!contains(physicalRoot, physicalExisting)) return { allowed: false, reason: "Path resolves outside the child root." };
	} else if (!allowedPhysical.some((root) => contains(root, physicalExisting))) {
		return { allowed: false, reason: "Path resolves outside the declared read scope." };
	}
	try {
		const physicalTarget = await realpath(target);
		if (!allowedPhysical.some((root) => contains(root, physicalTarget))) {
			return { allowed: false, reason: "Path resolves outside the declared read scope." };
		}
	} catch (error) {
		if (!isNodeError(error) || error.code !== "ENOENT") throw error;
	}
	return { allowed: true, resolvedPath: target };
}

async function selectedGuidanceRoots(capability: NormalizedChildCapability, target: string): Promise<{ paths: string[]; physical: string[] } | undefined> {
	const guidance = capability.guidance;
	if (!guidance) return undefined;
	const paths: string[] = [], physical: string[] = [];
	for (let index = 0; index < guidance.readRoots.length; index++) {
		const root = guidance.readRoots[index]!;
		if (!contains(root, target)) continue;
		const pinned = guidance.physicalRoots[index]!;
		if (await realpath(root) !== pinned) throw new Error("guidance owner changed");
		paths.push(root); physical.push(pinned);
	}
	return paths.length ? { paths, physical } : undefined;
}

export async function authorizePath(
	manifest: ChildCapabilityManifest,
	toolName: string,
	requestedPath: string,
): Promise<PathDecision> {
	const capability = normalizedCapability(manifest);
	try {
		if (!(await lstat(capability.root)).isDirectory() || await realpath(capability.root) !== capability.root) throw new Error("invalid root");
		await assertCanonicalExternalRoots(capability);
	} catch {
		return { allowed: false, fatal: true, reason: "Child capability root is unavailable or no longer canonical." };
	}
	const role = getRole(capability.role);
	if (!role.tools.includes(toolName)) return { allowed: false, reason: `Tool ${toolName} is not allowed for role ${capability.role}.` };
	if (requestedPath.includes("\0")) return { allowed: false, reason: "Path contains a null byte." };
	if (!isSafePathGrammar(requestedPath)) return { allowed: false, reason: "Path is unsafe." };

	const write = toolName === "edit" || toolName === "write";
	if (write) {
		const target = resolve(capability.root, requestedPath);
		if (!contains(capability.root, target)) return { allowed: false, reason: "Path escapes the child root." };
		if (capability.writeRoot) {
			if ([".git", "node_modules"].includes(relative(capability.root, target).split(sep)[0]!)) return { allowed: false, reason: "Managed metadata and dependencies are not source writes." };
		} else if (!capability.writePaths.includes(target)) return { allowed: false, reason: "Path is not an exact declared write file." };
		try {
			const physicalRoot = await realpath(capability.root);
			const existing = await nearestExisting(target);
			const physicalExisting = await realpath(existing);
			if (!contains(physicalRoot, physicalExisting)) return { allowed: false, reason: "Path resolves outside the child root." };
			if (await hasSymlinkComponent(capability.root, target)) {
				return { allowed: false, reason: "Writes through symlinks are not allowed." };
			}
			return { allowed: true, resolvedPath: target };
		} catch (error) {
			return pathCheckFailure(error);
		}
	}

	try {
		if (!isAbsolute(requestedPath)) {
			const target = resolve(capability.root, requestedPath);
			if (!contains(capability.root, target)) return { allowed: false, reason: "Path escapes the child root." };
			if (capability.readRoots.some((root) => contains(root, target))) return await authorizeRead(capability, toolName, target, capability.readRoots, true);
			const guidanceRoots = await selectedGuidanceRoots(capability, target);
			if (guidanceRoots) return await authorizeRead(capability, toolName, target, guidanceRoots.paths, false, guidanceRoots.physical);
			return { allowed: false, reason: "Path is outside the declared read scope." };
		}

		const target = resolve(requestedPath);
		const internalRoots = capability.readRoots.filter((root) => contains(root, target));
		if (internalRoots.length > 0) {
			if (!contains(capability.root, target)) return { allowed: false, reason: "Path escapes the child root." };
			return await authorizeRead(capability, toolName, target, internalRoots, true);
		}
		const guidanceRoots = await selectedGuidanceRoots(capability, target);
		if (guidanceRoots) return await authorizeRead(capability, toolName, target, guidanceRoots.paths, false, guidanceRoots.physical);
		const externalRoots = capability.externalReadRoots.filter((root) => contains(root, target));
		if (externalRoots.length === 0) return { allowed: false, reason: "Path is outside the declared read scope." };
		return await authorizeRead(capability, toolName, target, externalRoots, false);
	} catch (error) {
		return pathCheckFailure(error);
	}
}

function pathCheckFailure(error: unknown): PathDecision {
	return {
		allowed: false,
		fatal: !isNodeError(error) || !["ENOENT", "ENOTDIR"].includes(error.code ?? ""),
		reason: "Path could not be checked safely.",
	};
}
