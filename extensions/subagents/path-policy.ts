import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { CHILD_CAPABILITY_ENV, type ChildCapabilityManifest, type RoleName } from "./contracts.ts";
import { getRole } from "./roles.ts";

export interface PathDecision {
	allowed: boolean;
	reason?: string;
	resolvedPath?: string;
}

export interface CapabilityLoadResult {
	manifest?: ChildCapabilityManifest;
	error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contains(root: string, target: string): boolean {
	const relation = relative(root, target);
	return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
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
	if (relation === "" || relation.startsWith("..") || isAbsolute(relation)) return relation.startsWith("..");
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

function isRole(value: unknown): value is RoleName {
	return value === "explorer" || value === "reviewer" || value === "worker";
}

export function parseCapability(value: unknown): ChildCapabilityManifest {
	if (!isRecord(value) || value.version !== 1 || !isRole(value.role) || typeof value.root !== "string") {
		throw new Error("capability manifest has an invalid version, role, or root");
	}
	if (!Array.isArray(value.readRoots) || !value.readRoots.every((entry) => typeof entry === "string")) {
		throw new Error("capability manifest readRoots must be strings");
	}
	if (!Array.isArray(value.writePaths) || !value.writePaths.every((entry) => typeof entry === "string")) {
		throw new Error("capability manifest writePaths must be strings");
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
	return { version: 1, root, role: value.role, readRoots, writePaths };
}

export async function loadCapability(env: NodeJS.ProcessEnv = process.env): Promise<CapabilityLoadResult> {
	const manifestPath = env[CHILD_CAPABILITY_ENV];
	if (!manifestPath) return { error: "child capability manifest is missing" };
	try {
		const info = await lstat(manifestPath);
		if (!info.isFile() || info.isSymbolicLink()) return { error: "child capability manifest must be a regular non-symlink file" };
		if ((info.mode & 0o077) !== 0) return { error: "child capability manifest permissions are too broad" };
		return { manifest: parseCapability(JSON.parse(await readFile(manifestPath, "utf8")) as unknown) };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

export async function authorizePath(
	manifest: ChildCapabilityManifest,
	toolName: string,
	requestedPath: string,
): Promise<PathDecision> {
	const role = getRole(manifest.role);
	if (!role.tools.includes(toolName)) return { allowed: false, reason: `Tool ${toolName} is not allowed for role ${manifest.role}.` };
	if (requestedPath.includes("\0")) return { allowed: false, reason: "Path contains a null byte." };
	const target = resolve(manifest.root, requestedPath);
	if (!contains(manifest.root, target)) return { allowed: false, reason: "Path escapes the child root." };

	const write = toolName === "edit" || toolName === "write";
	const allowedRoots = write ? manifest.writePaths : manifest.readRoots;
	const lexicalMatch = write ? allowedRoots.includes(target) : allowedRoots.some((root) => contains(root, target));
	if (!lexicalMatch) return { allowed: false, reason: write ? "Path is not an exact declared write file." : "Path is outside the declared read scope." };

	try {
		const physicalRoot = await realpath(manifest.root);
		const existing = await nearestExisting(target);
		const physicalExisting = await realpath(existing);
		if (!contains(physicalRoot, physicalExisting)) return { allowed: false, reason: "Path resolves outside the child root." };
		if (write && await hasSymlinkComponent(manifest.root, target)) {
			return { allowed: false, reason: "Writes through symlinks are not allowed." };
		}
		if (!write) {
			try {
				const physicalTarget = await realpath(target);
				const physicalReadRoots = await Promise.all(manifest.readRoots.map(async (root) => {
					try { return await realpath(root); } catch { return root; }
				}));
				if (!physicalReadRoots.some((root) => contains(root, physicalTarget))) {
					return { allowed: false, reason: "Path resolves outside the declared read scope." };
				}
			} catch (error) {
				if (!isNodeError(error) || error.code !== "ENOENT") throw error;
			}
		}
		return { allowed: true, resolvedPath: target };
	} catch (error) {
		return { allowed: false, reason: error instanceof Error ? error.message : String(error) };
	}
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
