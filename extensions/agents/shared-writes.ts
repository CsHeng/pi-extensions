/**
 * Attribution for shared-workspace writers.
 *
 * Inside the child, the guard records the pre-image of each file the agent's own file tools
 * write in this turn and the digest each write left behind. After the writer has stopped, the
 * assigner can revert exactly the files whose current content is still what this agent left;
 * a file someone changed afterwards, or a change made through the shell, stays in place and is
 * reported. This is cooperative attribution on a trusted host, not an OS sandbox.
 */
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, copyFileSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { chmod, copyFile, lstat, readFile, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, sep } from "node:path";

type Before = { kind: "absent" } | { kind: "file"; blob: string; mode: number } | { kind: "other" };
type Row = { path: string; before: Before } | { path: string; after: string; mode?: number } | { path: string; ambiguous: true } | { shell: true };

const MANIFEST = "manifest.jsonl";
export const MAX_REPORTED_PATHS = 64;

export function sharedWritesDirectory(store: { path(handle: string): string }, record: { handle: string; episode: number }): string {
	return join(store.path(record.handle), "scratch", "shared-writes", String(record.episode));
}

function modeOf(path: string): number | undefined {
	try { const info = lstatSync(path); return info.isFile() ? info.mode & 0o7777 : undefined; }
	catch { return undefined; }
}

function digestFile(path: string): string | undefined {
	try { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
	catch { return undefined; }
}

export class SharedWriteRecorder {
	private readonly seen = new Set<string>();
	/** Digest each of this agent's writes left, to notice a change by someone else between two of its writes. */
	private readonly left = new Map<string, string | undefined>();
	private readonly modes = new Map<string, number | undefined>();
	private shell = false;
	constructor(private readonly directory: string) { mkdirSync(join(directory, "blobs"), { recursive: true, mode: 0o700 }); }
	private append(row: Row): void { appendFileSync(join(this.directory, MANIFEST), `${JSON.stringify(row)}\n`, { mode: 0o600 }); }
	beforeWrite(path: string): void {
		if (this.seen.has(path)) {
			if (this.left.get(path) !== digestFile(path) || this.modes.get(path) !== modeOf(path)) this.append({ path, ambiguous: true });
			return;
		}
		this.seen.add(path);
		let before: Before;
		try {
			const info = lstatSync(path);
			if (info.isFile()) {
				const blob = randomUUID();
				copyFileSync(path, join(this.directory, "blobs", blob));
				before = { kind: "file", blob, mode: info.mode & 0o7777 };
			} else before = { kind: "other" };
		} catch (error) { before = (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "absent" } : { kind: "other" }; }
		this.append({ path, before });
	}
	afterWrite(path: string): void {
		const after = digestFile(path), mode = modeOf(path);
		this.left.set(path, after); this.modes.set(path, mode);
		if (after) this.append({ path, after, ...(mode === undefined ? {} : { mode }) });
	}
	shellUsed(): void { if (!this.shell) { this.shell = true; this.append({ shell: true }); } }
}

export interface SharedWriteSummary {
	paths: string[];
	shell: boolean;
}

async function readRows(directory: string): Promise<Row[]> {
	let text: string;
	try { text = await readFile(join(directory, MANIFEST), "utf8"); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
	const rows: Row[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try { rows.push(JSON.parse(line) as Row); } catch { /* A torn final line from a stopped writer is skipped. */ }
	}
	return rows;
}

export async function readSharedWrites(directory: string): Promise<SharedWriteSummary> {
	const rows = await readRows(directory);
	const paths: string[] = [];
	for (const row of rows) if ("after" in row && typeof row.path === "string" && !paths.includes(row.path)) paths.push(row.path);
	return { paths, shell: rows.some(row => "shell" in row) };
}

export interface RevertOutcome {
	reverted: string[];
	kept: string[];
	shell: boolean;
}

const BLOB_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Parent side, after the writer has stopped: restore only files whose content is still what this
 * agent left and that nobody changed between its writes. The manifest lives in the agent's own
 * scratch, so every destination must lie inside one of `writable` (the agent's write grants).
 */
export async function revertSharedWrites(directory: string, writable: readonly string[]): Promise<RevertOutcome> {
	const rows = await readRows(directory);
	const before = new Map<string, Before>(), after = new Map<string, { digest: string; mode?: number | undefined }>(), ambiguous = new Set<string>();
	for (const row of rows) {
		if ("before" in row) { if (!before.has(row.path)) before.set(row.path, row.before); }
		else if ("after" in row) after.set(row.path, { digest: row.after, mode: row.mode });
		else if ("ambiguous" in row) ambiguous.add(row.path);
	}
	const roots = await Promise.all(writable.map(root => realpath(root).catch(() => undefined)));
	const contains = (root: string, path: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
	// Lexically and physically inside a grant: a parent replaced by a symlink leaves the path untouched.
	const inside = async (path: string) => {
		if (!isAbsolute(path) || normalize(path) !== path || !writable.some(root => contains(root, path))) return false;
		const parent = await realpath(dirname(path)).catch(() => undefined);
		return parent !== undefined && roots.some(root => root !== undefined && contains(root, join(parent, basename(path))));
	};
	const blobs = await realpath(join(directory, "blobs")).catch(() => undefined);
	const blobOk = async (blob: string) => {
		if (!BLOB_NAME.test(blob) || !blobs) return false;
		const info = await lstat(join(blobs, blob)).catch(() => undefined);
		return info?.isFile() === true;
	};
	const reverted: string[] = [], kept: string[] = [];
	const wellFormed = (prior: Before) => prior?.kind === "absent" || prior?.kind === "other" || prior?.kind === "file" && typeof prior.blob === "string" && Number.isInteger(prior.mode);
	for (const [path, prior] of before) {
		if (!wellFormed(prior) || !await inside(path) || prior.kind === "file" && !await blobOk(prior.blob)) { kept.push(path); continue; }
		const left = after.get(path);
		const current = digestFile(path);
		// Content and mode both still as the agent left them; a later permission change is someone else's work.
		const unchangedSince = left !== undefined && current === left.digest && (left.mode === undefined || modeOf(path) === left.mode);
		if (!unchangedSince || prior.kind === "other" || ambiguous.has(path)) { kept.push(path); continue; }
		try {
			if (prior.kind === "absent") await rm(path);
			else {
				const info = await lstat(path);
				if (!info.isFile()) { kept.push(path); continue; }
				await copyFile(join(blobs!, prior.blob), path);
				await chmod(path, prior.mode);
			}
			reverted.push(path);
		} catch { kept.push(path); }
	}
	return { reverted, kept, shell: rows.some(row => "shell" in row) };
}
