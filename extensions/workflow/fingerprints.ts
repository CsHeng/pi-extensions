/**
 * Bounded source/input fingerprints for workflow evidence (WF-03).
 *
 * A fingerprint binds a declared scope to an opaque digest at the moment an attempt or check
 * runs. Recomputation later proves that the same bytes were associated with the binding; it
 * never proves correctness. Scans that cannot establish a basis return `unavailable` instead of
 * an unchanged verdict.
 */
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

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

const within = (root: string, candidate: string): boolean => {
	const rel = relative(root, candidate);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

async function digestLink(hash: ReturnType<typeof createHash>, absolute: string, label: string, root: string, budget: { files: number; bytes: number }): Promise<void> {
	let target: string;
	try {
		target = await readlink(absolute);
	} catch {
		throw new ScanLimit("unreadable symlink");
	}
	// The link's own spelling is part of the basis: retargeting a declared input changes it.
	hash.update(`${label}\0symlink\0${target}\n`);
	const resolved = resolve(dirname(absolute), target);
	if (!within(root, resolved)) throw new ScanLimit("symlink outside the declared workspace");
	let info;
	try {
		info = await lstat(resolved);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			hash.update(`${label}\0link-target-missing\n`);
			return;
		}
		throw error;
	}
	if (info.isDirectory()) throw new ScanLimit("directory symlink");
	if (!info.isFile()) throw new ScanLimit("non-regular or chained symlink target");
	if (!within(await realpath(root), await realpath(resolved))) throw new ScanLimit("symlink outside the declared workspace");
	if (++budget.files > FINGERPRINT_LIMITS.maxFiles) throw new ScanLimit("files");
	budget.bytes += info.size;
	if (budget.bytes > FINGERPRINT_LIMITS.maxBytes) throw new ScanLimit("bytes");
	const content = await readFile(resolved);
	const digest = createHash("sha256").update(content).digest("hex");
	hash.update(`${label}\0link-file\0${info.size}\0${digest}\n`);
}

async function digestPath(hash: ReturnType<typeof createHash>, absolute: string, label: string, depth: number, budget: { files: number; bytes: number }, root: string): Promise<void> {
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
		await digestLink(hash, absolute, label, root, budget);
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
		await digestPath(hash, resolve(absolute, name), `${label}/${name}`, depth + 1, budget, root);
	}
}

export async function fingerprintScope(declared: readonly string[] | undefined, cwd: string): Promise<BasisFingerprint> {
	const requested = (declared ?? []).map((entry) => entry.trim()).filter((entry) => entry.length > 0);
	const scope = [...new Set(requested.length > 0 ? requested : ["."])].sort();
	if (scope.length > FINGERPRINT_LIMITS.maxScopeEntries) return unavailable(scope.slice(0, FINGERPRINT_LIMITS.maxScopeEntries), "too many fingerprint scope entries; no partial basis was certified");
	const hash = createHash("sha256");
	const budget = { files: 0, bytes: 0 };
	const root = resolve(cwd);
	try {
		for (const entry of scope) {
			const absolute = isAbsolute(entry) ? resolve(entry) : resolve(cwd, entry);
			await digestPath(hash, absolute, entry, 0, budget, root);
		}
	} catch (error) {
		if (error instanceof ScanLimit) return unavailable(scope, `fingerprint scope exceeds the ${error.message} limit`);
		return unavailable(scope, `fingerprint scope could not be read: ${error instanceof Error ? error.message : String(error)}`);
	}
	return { scope, fingerprint: hash.digest("hex"), state: "current" };
}
