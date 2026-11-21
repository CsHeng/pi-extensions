import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, opendir, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { archiveBucket, archiveFilename, nativeArchiveDirectory, projectBucket } from "../extensions/agents/native-archive.ts";
import { privateDirectory, syncDirectory } from "../extensions/agents/private-directory.ts";

const USAGE = "Usage: bun scripts/export-agent-usage.ts --agent-dir <absolute-path> [--write]\nDry-run by default. Stop Pi and other session writers before running this offline export.";
const SOURCE_NAMES = ["managed-agents", "subagent-managed-sessions"] as const;
const UUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const PI_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;
const SELECTOR = /^[A-Za-z0-9][A-Za-z0-9._:/+@~\-]{0,255}$/;
const FILE_ID = /_([a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})\.jsonl$/i;
const MAX_REGISTRY = 2 * 1024 * 1024;
const CHUNK_BYTES = 256 * 1024;
const UNATTRIBUTED_USAGE = "agents.usage-unattributed";
const TOKENS = ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h", "reasoning", "totalTokens"] as const;
const COST = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;

type Row = Record<string, unknown>;
function record(value: unknown): Row | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Row : undefined;
}
function matches(value: unknown, pattern: RegExp): value is string {
	return typeof value === "string" && pattern.test(value);
}
function timestamp(value: unknown): value is string {
	if (!matches(value, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)) return false;
	const time = Date.parse(value);
	return Number.isFinite(time) && new Date(time).toISOString() === value;
}
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const amount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const json = (value: string): Row => {
	const parsed = record(JSON.parse(value));
	if (!parsed) throw new Error("invalid JSON object");
	return parsed;
};

function canonicalPath(value: unknown): value is string {
	return typeof value === "string" && Buffer.byteLength(value) <= 4096 && value.isWellFormed() && isAbsolute(value)
		&& resolve(value) === value && !/[\u0000-\u001f\u007f]/.test(value);
}

async function directory(path: string, allowMissing = false): Promise<boolean> {
	if (!canonicalPath(path)) throw new Error("unsafe directory path");
	try {
		if (!(await lstat(path)).isDirectory() || await realpath(path) !== path) throw new Error("unsafe directory");
		return true;
	} catch (error) {
		if (allowMissing && missing(error)) return false;
		throw error;
	}
}

class AbsentFile extends Error {}
class InvalidNativeLine extends Error {}

async function* stableChunks(path: string, limit = Number.MAX_SAFE_INTEGER): AsyncGenerator<Buffer, void> {
	if (!canonicalPath(path)) throw new Error("unsafe file path");
	await directory(dirname(path));
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(error => {
		if (missing(error)) throw new AbsentFile();
		throw error;
	});
	try {
		const before = await file.stat({ bigint: true });
		if (!before.isFile() || before.size > limit) throw new Error("unsafe or oversized file");
		const size = Number(before.size);
		for (let offset = 0; offset < size;) {
			const bytes = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, size - offset));
			const { bytesRead } = await file.read(bytes, 0, bytes.length, offset);
			if (!bytesRead) throw new Error("file changed while reading");
			offset += bytesRead;
			yield bytes.subarray(0, bytesRead);
		}
		await directory(dirname(path));
		const after = await lstat(path, { bigint: true });
		if (!after.isFile() || before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size
			|| before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error("file changed while reading");
	} finally { await file.close(); }
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

async function* nativeLines(path: string, onChunk?: (bytes: Buffer) => void, onPadding?: () => void): AsyncGenerator<Row, void> {
	let pieces: Buffer[] = [];
	for await (const bytes of stableChunks(path)) {
		onChunk?.(bytes);
		let start = 0;
		for (let end = bytes.indexOf(10); end !== -1; end = bytes.indexOf(10, start)) {
			const last = bytes.subarray(start, end);
			const line = pieces.length ? Buffer.concat([...pieces, last]) : last;
			pieces = [];
			start = end + 1;
			// Some destination logs contain a newline-delimited hole consisting solely of NUL bytes. It cannot encode a charge or identity. Keep scanning every other row.
			if (onPadding && line[0] === 0 && line.every(byte => byte === 0)) { onPadding(); continue; }
			let row: Row;
			try { row = json(utf8.decode(line)); }
			catch { throw new InvalidNativeLine(); }
			yield row;
		}
		if (start < bytes.length) pieces.push(bytes.subarray(start));
	}
	if (pieces.length) throw new InvalidNativeLine();
}

async function readRegistry(path: string, handle: string) {
	const chunks: Buffer[] = [];
	for await (const bytes of stableChunks(path, MAX_REGISTRY)) chunks.push(bytes);
	const registry = json(utf8.decode(Buffer.concat(chunks)));
	const owner = record(registry.owner);
	if (!owner || !canonicalPath(owner.repo) || !matches(owner.parentSessionId, PI_ID)
		|| registry.handle !== handle || !count(registry.version) || registry.version < 1) throw new Error("invalid registry");
	const native = record(registry.native);
	const bound = registry.version === 4 && !!native && matches(native.bucket, archiveBucket) && matches(native.filename, archiveFilename);
	if (registry.native !== undefined && !bound) throw new Error("invalid native binding");
	return { version: registry.version, owner: { repo: owner.repo, parentSessionId: owner.parentSessionId }, bound };
}

function usageSource(entry: Row): Row | undefined {
	if (entry.type === "message") {
		const message = record(entry.message);
		if (!message || typeof message.role !== "string") throw new Error("invalid native message");
		return message.role === "assistant" ? message : undefined;
	}
	return entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary" ? entry : undefined;
}

type TokenKey = typeof TOKENS[number];
type TokenSubtotal = Partial<Record<TokenKey, bigint>>;
type UsageFields = Partial<Record<TokenKey, number>> & { cost?: Row };

function addRecordedTokens(total: TokenSubtotal, fields: UsageFields | TokenSubtotal): void {
	for (const key of TOKENS) {
		const value = fields[key];
		if (value !== undefined) total[key] = (total[key] ?? 0n) + BigInt(value);
	}
}

function usageFields(value: unknown): { usage: UsageFields; partial: boolean } | undefined {
	const source = record(value);
	if (!source) return undefined;
	const usage: UsageFields = {};
	for (const key of TOKENS) if (count(source[key])) usage[key] = source[key];
	const cost = record(source.cost);
	const projectedCost: Row = {};
	for (const key of COST) if (amount(cost?.[key])) projectedCost[key] = cost[key];
	const hasCost = Object.keys(projectedCost).length > 0;
	if (hasCost) {
		if (typeof cost?.totalFromProvider === "boolean") projectedCost.totalFromProvider = cost.totalFromProvider;
		usage.cost = projectedCost;
	}
	if (!Object.keys(usage).length) return undefined;
	const partial = !["input", "output", "cacheRead", "cacheWrite", "totalTokens"].every(key => Object.hasOwn(usage, key))
		|| !COST.every(key => Object.hasOwn(projectedCost, key));
	return { usage, partial };
}

function rowIdentity(entry: Row, destination = false): string {
	let id = entry.id;
	if (destination && entry.nativeEntryId !== undefined) {
		if (typeof id !== "string" || !UUID.test(id.slice(0, 36)) || !matches(entry.nativeEntryId, PI_ID)
			|| id.slice(36) !== `_${entry.nativeEntryId}`) throw new Error("invalid projected usage identity");
		id = entry.nativeEntryId;
	}
	if (!matches(id, PI_ID) || !timestamp(entry.timestamp)) throw new Error("invalid usage identity");
	return `${id}\0${entry.timestamp}`;
}

interface Projection {
	path: string;
	bytes: Buffer;
	rows: string[];
	missingUsage: number;
	partialUsage: number;
	unattributedUsage: number;
	unattributedTokens: TokenSubtotal;
}

async function project(header: Row, entries: AsyncIterable<Row>, owner: Row, sessions: string): Promise<Projection> {
	if (!matches(header.id, UUID) || !timestamp(header.timestamp) || !canonicalPath(owner.repo)
		|| !matches(owner.parentSessionId, PI_ID) || owner.parentSessionId === header.id) throw new Error("invalid owner or native header");
	const path = join(sessions, projectBucket(owner.repo), "agents", `${header.timestamp.replace(/[:.]/g, "-")}_${header.id}.jsonl`);
	if (!canonicalPath(path)) throw new Error("invalid export path");
	// Local native readers require a nonempty cwd. This accounting-only file has no execution cwd; its containing bucket identifies the project.
	const output = [JSON.stringify({ type: "session", version: 3, id: header.id, timestamp: header.timestamp, cwd: ".", parentSessionId: owner.parentSessionId })];
	const seen = new Set<string>();
	const rows: string[] = [];
	const unattributedTokens: TokenSubtotal = {};
	let parentId: string | null = null;
	let missingUsage = 0, partialUsage = 0, unattributedUsage = 0;
	for await (const entry of entries) {
		if (typeof entry.type !== "string" || entry.type === "session" || !matches(entry.id, PI_ID)
			|| (entry.parentId !== null && !matches(entry.parentId, PI_ID))) throw new Error("invalid native entry");
		const source = usageSource(entry);
		if (!source) continue;
		if (seen.has(entry.id)) throw new Error("duplicate accounting entry ID");
		seen.add(entry.id);
		const identity = rowIdentity(entry);
		const fields = usageFields(source.usage);
		if (!fields) { missingUsage++; continue; }
		if (fields.partial) partialUsage++;
		const data: Row = {};
		if (matches(source.provider, SELECTOR)) data.provider = source.provider;
		if (matches(source.model, SELECTOR)) data.model = source.model;
		if (matches(source.responseModel, SELECTOR)) data.responseModel = source.responseModel;
		if (source === entry) data.timestamp = Date.parse(entry.timestamp as string);
		else if (count(source.timestamp) && source.timestamp <= 8.64e15) data.timestamp = source.timestamp;
		data.usage = fields.usage;
		// Native entry IDs are session-local. Some readers deduplicate them across all Pi files.
		const projectedId = `${header.id}_${entry.id}`;
		const base = { id: projectedId, nativeEntryId: entry.id, parentId, timestamp: entry.timestamp };
		if (data.provider && data.model) {
			output.push(JSON.stringify({ type: "message", ...base, message: { role: "assistant", content: [], ...data } }));
		} else {
			// Link retained IDs only. With incomplete attribution an inert custom row preserves facts without
			// letting a generic usage reader assign the charge to an adjacent assistant's model.
			unattributedUsage++;
			addRecordedTokens(unattributedTokens, fields.usage);
			output.push(JSON.stringify({ type: "custom", ...base, customType: UNATTRIBUTED_USAGE, data }));
		}
		parentId = projectedId;
		rows.push(identity);
	}
	return { path, bytes: Buffer.from(`${output.join("\n")}\n`), rows, missingUsage, partialUsage, unattributedUsage, unattributedTokens };
}

function summary(write: boolean) {
	return {
		mode: write ? "write" : "dry-run", coverage: "unavailable" as "complete" | "incomplete" | "unavailable",
		sourceRoots: { "managed-agents": "not-scanned", "subagent-managed-sessions": "not-scanned" } as Record<typeof SOURCE_NAMES[number], "present" | "absent" | "unavailable" | "not-scanned">,
		sourceDirectories: 0, sourceIssues: 0, duplicateSources: 0, conflictingSources: 0,
		emptyNativeFiles: 0, missingNativeFiles: 0, boundHandles: 0,
		missingUsageRows: 0, partialUsageRows: 0, unattributedUsageRows: 0,
		unattributedUsageSubtotal: Object.fromEntries(TOKENS.map(key => [key, null])) as Record<TokenKey, number | string | null>,
		scanIssues: 0, destinationPaddingRows: 0, ignoredSidecars: 0, emptyDestinationFiles: 0, identicalFiles: 0, existingSessions: 0, emptySessions: 0,
		unsafeDestinations: 0, readyFiles: 0, readyRows: 0, writtenFiles: 0, writtenRows: 0, writeFailures: 0,
		blocked: null as "agent-dir" | "export-lock" | "destination-scan" | null,
	};
}
type Summary = ReturnType<typeof summary>;

function sourceHandle(name: string): boolean {
	return /^[A-Za-z0-9]{1,128}$/.test(name) || (name.startsWith("session_") && UUID.test(name.slice(8)));
}

async function readSources(agentDir: string, sessions: string, report: Summary): Promise<Map<string, Projection>> {
	const candidates = new Map<string, Projection>();
	const conflicted = new Set<string>();
	const copies = new Map<string, number>();
	for (const source of SOURCE_NAMES) {
		const root = join(agentDir, source);
		try {
			if (!await directory(root, true)) { report.sourceRoots[source] = "absent"; continue; }
			report.sourceRoots[source] = "present";
			for await (const item of await opendir(root)) {
				if (!sourceHandle(item.name) || (!item.isDirectory() && !item.isSymbolicLink())) continue;
				report.sourceDirectories++;
				const dir = join(root, item.name);
				const registryPath = join(dir, "registry.json");
				const entries = nativeLines(join(dir, "native.jsonl"));
				let id: string | undefined;
				let nativeAbsent = false;
				try {
					const first = await entries.next().catch(error => {
						if (!(error instanceof AbsentFile)) throw error;
						nativeAbsent = true;
						return undefined;
					});
					const header = first?.value;
					if (header) {
						if (header.type !== "session" || !matches(header.id, UUID)) throw new Error("invalid native session");
						id = header.id.toLowerCase();
					} else if (!nativeAbsent) report.emptyNativeFiles++;
					const { version, owner, bound } = await readRegistry(registryPath, item.name);
					if (nativeAbsent) {
						if (!bound) throw new Error("missing private native file");
						report.boundHandles++;
						continue;
					}
					if (bound || version > 4) throw new Error("not a legacy-only registry");
					if (!header || !id) continue;
					const candidate = await project(header, entries, owner, sessions);
					const previous = candidates.get(id);
					if (previous?.path === candidate.path && previous.bytes.equals(candidate.bytes)
						&& previous.missingUsage === candidate.missingUsage && previous.partialUsage === candidate.partialUsage) increment(copies, id);
					else if (previous) conflicted.add(id);
					else candidates.set(id, candidate);
				} catch {
					if (nativeAbsent) report.missingNativeFiles++;
					report.sourceIssues++;
					if (id) conflicted.add(id);
				} finally { await entries.return(); }
			}
		} catch {
			report.sourceRoots[source] = "unavailable";
			report.sourceIssues++;
		}
	}
	for (const id of conflicted) if (candidates.delete(id)) report.conflictingSources++;
	for (const id of candidates.keys()) report.duplicateSources += copies.get(id) ?? 0;
	return candidates;
}

function increment(index: Map<string, number>, key: string): void {
	index.set(key, (index.get(key) ?? 0) + 1);
}

interface Existing {
	ids: Map<string, number>;
	rows: Map<string, number>;
	identical: Set<string>;
}

function isObservationLedger(sessions: string, path: string): boolean {
	const parts = relative(sessions, path).split(sep);
	return parts.length === 5 && /^--.*--$/.test(parts[0] ?? "") && parts[1] === "sol-pi"
		&& parts[3] === "observation-pack" && parts[4] === "ledger.jsonl";
}

async function scanExisting(sessions: string, candidates: Map<string, Projection>, report: Summary): Promise<Existing> {
	const existing: Existing = { ids: new Map(), rows: new Map(), identical: new Set() };
	const paths = new Map(Array.from(candidates, ([id, candidate]) => [candidate.path, id]));
	const candidateRows = new Set<string>();
	for (const candidate of candidates.values()) for (const key of candidate.rows) candidateRows.add(key);
	async function walk(dir: string): Promise<void> {
		if (!await directory(dir, dir === sessions)) return;
		for await (const item of await opendir(dir)) {
			const path = join(dir, item.name);
			const claims = new Set<string>();
			const idAtPath = paths.get(path);
			if (idAtPath) claims.add(idAtPath);
			try {
				// A symlink could hide a second scan path (even without a .jsonl suffix).
				if (item.isSymbolicLink()) throw new Error("unscannable symlink");
				if (item.isDirectory()) { await walk(path); continue; }
				if (!item.name.endsWith(".jsonl")) continue;
				const sidecar = isObservationLedger(sessions, path);
				const filenameId = FILE_ID.exec(item.name)?.[1]?.toLowerCase();
				if (filenameId) claims.add(filenameId);
				const expected = idAtPath ? candidates.get(idAtPath)?.bytes : undefined;
				let equal = !!expected;
				let offset = 0;
				const entries = nativeLines(path, expected ? bytes => {
					if (equal) equal = bytes.equals(expected.subarray(offset, offset + bytes.length));
					offset += bytes.length;
				} : undefined, () => { report.destinationPaddingRows++; });
				try {
					const first = await entries.next().catch(error => {
						if (!sidecar || !(error instanceof InvalidNativeLine)) throw error;
						return undefined;
					});
					const header = first?.value;
					// The known ledger path exempts non-native sidecars, never an identifiable native session.
					if (sidecar && (header?.type !== "session" || !matches(header.id, PI_ID))) { report.ignoredSidecars++; continue; }
					if (!header) { report.emptyDestinationFiles++; continue; }
					if (header.type !== "session" || !matches(header.id, PI_ID)) throw new Error("unscannable session header");
					claims.add(header.id.toLowerCase());
					for await (const entry of entries) {
						if (typeof entry.type !== "string" || entry.type === "session") throw new Error("unscannable session entry");
						const source = entry.type === "custom" && entry.customType === UNATTRIBUTED_USAGE ? record(entry.data) : usageSource(entry);
						if (!source?.usage) continue;
						const key = rowIdentity(entry, true);
						if (candidateRows.has(key)) increment(existing.rows, key);
					}
					if (idAtPath && equal && offset === expected?.length) existing.identical.add(idAtPath);
				} finally { await entries.return(); }
			} catch {
				report.scanIssues++;
			} finally {
				for (const id of claims) if (candidates.has(id)) increment(existing.ids, id);
			}
		}
	}
	try { await walk(sessions); }
	catch { report.scanIssues++; }
	return existing;
}

async function publish(candidate: Projection, sessions: string, bucket: string): Promise<void> {
	const dir = await nativeArchiveDirectory(sessions, bucket, true);
	const staged = join(dir, `.usage-${randomUUID()}.tmp`);
	const file = await open(staged, "wx", 0o600);
	try {
		try { await file.writeFile(candidate.bytes); await file.sync(); }
		finally { await file.close(); }
		await privateDirectory(dir, false);
		// A hard-link publishes completed bytes atomically and never replaces an existing entry.
		await link(staged, candidate.path);
	} finally { await unlink(staged); }
	await syncDirectory(dir);
}

async function run(agentDir: string, write: boolean): Promise<Summary> {
	const report = summary(write);
	try { await privateDirectory(agentDir, false, 0o022); }
	catch { report.blocked = "agent-dir"; return report; }
	const lockPath = join(agentDir, ".export-agent-usage.lock");
	if (write) {
		try { await (await open(lockPath, "wx", 0o600)).close(); }
		catch { report.blocked = "export-lock"; return report; }
	}
	try {
		const sessions = join(agentDir, "sessions");
		const candidates = await readSources(agentDir, sessions, report);
		if (!candidates.size) {
			if (report.conflictingSources) report.coverage = "incomplete";
			else if (Object.values(report.sourceRoots).includes("present") && !report.sourceIssues) report.coverage = "complete";
			return report;
		}
		const existing = await scanExisting(sessions, candidates, report);
		if (report.scanIssues) report.blocked = "destination-scan";
		const rowOwners = new Map<string, number>();
		for (const candidate of candidates.values()) {
			for (const key of candidate.rows) increment(rowOwners, key);
		}
		const unattributedTokens: TokenSubtotal = {};
		for (const id of [...candidates.keys()].sort()) {
			const candidate = candidates.get(id)!;
			report.missingUsageRows += candidate.missingUsage;
			report.partialUsageRows += candidate.partialUsage;
			const identical = existing.identical.has(id) && existing.ids.get(id) === 1 && candidate.rows.every(key => existing.rows.get(key) === 1);
			if (!identical && (existing.ids.has(id) || candidate.rows.some(key => existing.rows.has(key)))) { report.existingSessions++; continue; }
			if (!identical && candidate.rows.some(key => rowOwners.get(key)! > 1)) { report.conflictingSources++; continue; }
			if (!candidate.rows.length) { report.emptySessions++; continue; }
			report.unattributedUsageRows += candidate.unattributedUsage;
			addRecordedTokens(unattributedTokens, candidate.unattributedTokens);
			if (report.blocked) continue;
			if (identical) { report.identicalFiles++; continue; }
			const bucket = basename(dirname(dirname(candidate.path)));
			try { await nativeArchiveDirectory(sessions, bucket, false); }
			catch (error) { if (!missing(error)) { report.unsafeDestinations++; continue; } }
			report.readyFiles++;
			report.readyRows += candidate.rows.length;
			if (!write) continue;
			try {
				await publish(candidate, sessions, bucket);
				report.writtenFiles++;
				report.writtenRows += candidate.rows.length;
			} catch { report.writeFailures++; }
		}
		for (const key of TOKENS) {
			const total = unattributedTokens[key];
			if (total !== undefined) report.unattributedUsageSubtotal[key] = total <= Number.MAX_SAFE_INTEGER ? Number(total) : total.toString();
		}
		if (!report.blocked) report.coverage = report.sourceIssues || report.conflictingSources || report.missingUsageRows
			|| report.partialUsageRows || report.unattributedUsageRows || report.existingSessions || report.unsafeDestinations || report.writeFailures ? "incomplete" : "complete";
		return report;
	} finally {
		if (write) {
			try { await unlink(lockPath); }
			catch { report.writeFailures++; report.coverage = "incomplete"; }
		}
	}
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	if (args.length === 1 && args[0] === "--help") console.log(USAGE);
	else if (args[0] !== "--agent-dir" || !canonicalPath(args[1]) || (args.length !== 2 && !(args.length === 3 && args[2] === "--write"))) {
		console.error(USAGE);
		process.exitCode = 2;
	} else {
		try {
			const report = await run(args[1], args[2] === "--write");
			console.log(JSON.stringify(report));
			if (report.coverage !== "complete") process.exitCode = 1;
		} catch {
			console.error("Export failed before a complete receipt could be produced.");
			process.exitCode = 1;
		}
	}
}
