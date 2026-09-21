/**
 * Bounded source/input fingerprints for workflow evidence (WF-03).
 *
 * A fingerprint binds a declared scope to an opaque digest at the moment an attempt or check
 * runs. Recomputation later proves that the same bytes were associated with the binding; it
 * never proves correctness. Scans that cannot establish a basis return `unavailable` instead of
 * an unchanged verdict.
 */
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { absolutePath, containsPath, pathIdentity } from "./paths.ts";

export const FINGERPRINT_LIMITS = Object.freeze({
	maxScopeEntries: 32,
	maxFiles: 4096,
	maxBytes: 16 * 1024 * 1024,
	maxDepth: 32,
});

const SKIPPED_DIRECTORIES = new Set([".git", "node_modules"]);

export interface BasisFingerprint {
	scope: string[];
	/** Opaque digest, or `unavailable` when no reliable basis was established. */
	fingerprint: string;
	state: "current" | "unavailable";
	note?: string;
}

const unavailable = (scope: string[], note: string): BasisFingerprint => ({ scope, fingerprint: "unavailable", state: "unavailable", note });

class ScanLimit extends Error {}

/** Ephemeral scan dependencies: never inflate durable evidence with a file inventory. */
export interface SourceDependencies { paths: Set<string>; links: Set<string> }
function recordIdentity(dependencies: SourceDependencies | undefined, identity: Awaited<ReturnType<typeof pathIdentity>>): void {
	for (const link of identity.links) dependencies?.links.add(link.path);
	if (identity.missing) dependencies?.links.add(identity.missing);
}

async function digestLink(hash: ReturnType<typeof createHash>, absolute: string, label: string, root: string | undefined, budget: { files: number; bytes: number }, explicit: boolean, dependencies?: SourceDependencies): Promise<void> {
	const leaf = await pathIdentity(absolute, false);
	dependencies?.links.add(leaf.physical);
	recordIdentity(dependencies, leaf);
	const target = await readlink(absolute);
	const identity = await pathIdentity(absolutePath(target, dirname(absolute)));
	recordIdentity(dependencies, identity);
	hash.update(`${label}\0symlink\0${target}\0${JSON.stringify(identity)}\n`);
	const contained = root !== undefined && containsPath(root, identity.physical);
	if (!explicit && !contained) throw new ScanLimit("symlink outside the declared scope");
	let info;
	try { info = await stat(absolute); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		hash.update(`${label}\0link-target-missing\n`);
		return;
	}
	if (!info.isFile() && !info.isDirectory()) throw new ScanLimit("non-regular symlink target");
	if (explicit && (!contained || info.isDirectory())) {
		// External link leaves certify identity only. Target content needs its own declaration.
		hash.update(`${label}\0link-identity\0${info.isDirectory() ? "directory" : "file"}\n`);
		return;
	}
	if (info.isDirectory()) throw new ScanLimit("directory symlink");
	if (++budget.files > FINGERPRINT_LIMITS.maxFiles) throw new ScanLimit("files");
	budget.bytes += info.size;
	if (budget.bytes > FINGERPRINT_LIMITS.maxBytes) throw new ScanLimit("bytes");
	dependencies?.paths.add(identity.physical);
	const content = await readFile(absolute);
	const digest = createHash("sha256").update(content).digest("hex");
	hash.update(`${label}\0link-file\0${info.size}\0${digest}\n`);
}

async function digestPath(hash: ReturnType<typeof createHash>, absolute: string, label: string, depth: number, budget: { files: number; bytes: number }, root: string | undefined, dependencies?: SourceDependencies): Promise<void> {
	if (depth > FINGERPRINT_LIMITS.maxDepth) throw new ScanLimit("depth");
	let info;
	try {
		info = await lstat(absolute);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			hash.update(`${label}\0missing\n`);
			return;
		}
		throw error;
	}
	if (info.isSymbolicLink()) {
		await digestLink(hash, absolute, label, root, budget, depth === 0, dependencies);
		return;
	}
	if (info.isFile()) {
		if (++budget.files > FINGERPRINT_LIMITS.maxFiles) throw new ScanLimit("files");
		budget.bytes += info.size;
		if (budget.bytes > FINGERPRINT_LIMITS.maxBytes) throw new ScanLimit("bytes");
		const content = await readFile(absolute);
		const digest = createHash("sha256").update(content).digest("hex");
		hash.update(`${label}\0file\0${info.size}\0${digest}\n`);
		return;
	}
	if (!info.isDirectory()) throw new ScanLimit("non-regular input");
	hash.update(`${label}/\n`);
	for (const name of (await readdir(absolute)).sort()) {
		if (SKIPPED_DIRECTORIES.has(name)) continue;
		await digestPath(hash, absolutePath(name, absolute), `${label}/${name}`, depth + 1, budget, root, dependencies);
	}
}

export async function fingerprintScope(declared: readonly string[] | undefined, cwd: string, dependencies?: SourceDependencies): Promise<BasisFingerprint> {
	const requested = (declared ?? []).map((entry) => entry.trim()).filter((entry) => entry.length > 0);
	const scope = [...new Set(requested.length > 0 ? requested : ["."])].sort();
	if (scope.length > FINGERPRINT_LIMITS.maxScopeEntries) return unavailable(scope.slice(0, FINGERPRINT_LIMITS.maxScopeEntries), "too many fingerprint scope entries; no partial basis was certified");
	const hash = createHash("sha256");
	const budget = { files: 0, bytes: 0 };
	hash.update("workflow-basis-v2\0");
	try {
		for (const entry of scope) {
			const absolute = absolutePath(entry, cwd);
			// Include dangling ancestor identities as well as the lexical declaration location.
			const identity = await pathIdentity(absolute);
			recordIdentity(dependencies, identity);
			hash.update(`${absolute}\0${JSON.stringify(identity)}\0`);
			// Retain workspace-local file-link semantics, but never infer external sibling grants.
			const localRoot = (await pathIdentity(cwd)).physical;
			let root: string | undefined = containsPath(resolve(cwd), absolute) && containsPath(localRoot, identity.physical) ? localRoot : undefined;
			try { if (root === undefined && (await lstat(absolute)).isDirectory()) root = identity.physical; }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
			await digestPath(hash, absolute, entry, 0, budget, root, dependencies);
		}
	} catch (error) {
		if (error instanceof ScanLimit) return unavailable(scope, `fingerprint scope exceeds the ${error.message} limit`);
		return unavailable(scope, `fingerprint scope could not be read: ${error instanceof Error ? error.message : String(error)}`);
	}
	return { scope, fingerprint: hash.digest("hex"), state: "current" };
}
