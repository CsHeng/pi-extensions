import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ConfigSourceSnapshot } from "./config.ts";
import type { ProvenanceTelemetry } from "./contracts.ts";

export const PROVENANCE_DIR = "subagent-provenance";
export const PROVENANCE_MANIFEST = "current.json";
export const PROVENANCE_LOCK = ".provenance-lock";
const MANIFEST_VERSION = 1 as const;
const LOCK_WAIT_MS = 2_000;
const STALE_LOCK_MS = 30_000;
const MAX_STALE_CLEANUP = 8;
const TOKEN_FILE = "owner";
const TIME_FILE = "acquiredAt";

export interface ProvenanceDependencies {
	now?(): number;
	randomId?(): string;
	agentDir?: string;
	sourceRoot?: string;
	listSourceFiles?(root: string): Promise<Array<{ name: string; bytes: Buffer }>>;
}

interface Manifest {
	version: typeof MANIFEST_VERSION;
	extensionFingerprint: string;
	extensionEpoch: string;
	extensionActivatedAtMs: number;
	configurationFingerprint: string;
	configurationEpoch: string;
	configurationActivatedAtMs: number;
}

export interface ProvenanceCore {
	observeExtension(): Promise<ProvenanceTelemetry>;
	observeConfiguration(snapshot: ConfigSourceSnapshot): Promise<ProvenanceTelemetry>;
}

function sha256(parts: Array<string | Buffer>): string {
	const hash = createHash("sha256");
	for (const part of parts) hash.update(part);
	return hash.digest("hex");
}

export function fingerprintConfig(snapshot: ConfigSourceSnapshot): string {
	return sha256([
		"package",
		snapshot.packageBytes,
		"user",
		snapshot.userBytes ?? Buffer.from("-"),
	]);
}

export async function fingerprintSources(files: Array<{ name: string; bytes: Buffer }>): Promise<string> {
	const sorted = [...files].sort((left, right) => left.name.localeCompare(right.name));
	const hash = createHash("sha256");
	for (const file of sorted) {
		hash.update(file.name);
		hash.update("\0");
		hash.update(file.bytes);
	}
	return hash.digest("hex");
}

async function defaultListSourceFiles(root: string): Promise<Array<{ name: string; bytes: Buffer }>> {
	const entries = await readdir(root, { withFileTypes: true });
	const files: Array<{ name: string; bytes: Buffer }> = [];
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
		files.push({ name: entry.name, bytes: await readFile(join(root, entry.name)) });
	}
	return files;
}

function isManifest(value: unknown): value is Manifest {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return record.version === MANIFEST_VERSION
		&& typeof record.extensionFingerprint === "string"
		&& typeof record.extensionEpoch === "string"
		&& typeof record.extensionActivatedAtMs === "number"
		&& Number.isFinite(record.extensionActivatedAtMs)
		&& typeof record.configurationFingerprint === "string"
		&& typeof record.configurationEpoch === "string"
		&& typeof record.configurationActivatedAtMs === "number"
		&& Number.isFinite(record.configurationActivatedAtMs)
		&& Object.keys(record).length === 7;
}

async function privateDir(path: string): Promise<boolean> {
	try {
		const handle = await open(path, "r");
		try {
			const info = await handle.stat();
			return info.isDirectory() && (info.mode & 0o077) === 0;
		} finally {
			await handle.close();
		}
	} catch {
		return false;
	}
}

async function privateFile(path: string): Promise<boolean> {
	try {
		const handle = await open(path, "r");
		try {
			const info = await handle.stat();
			return info.isFile() && (info.mode & 0o077) === 0;
		} finally {
			await handle.close();
		}
	} catch {
		return false;
	}
}

export function createProvenance(dependencies: ProvenanceDependencies = {}): ProvenanceCore {
	const now = dependencies.now ?? Date.now;
	const randomId = dependencies.randomId ?? randomUUID;
	const sourceRoot = dependencies.sourceRoot ?? fileURLToPath(new URL(".", import.meta.url));
	const listSourceFiles = dependencies.listSourceFiles ?? defaultListSourceFiles;
	const agentDir = () => dependencies.agentDir ?? getAgentDir();
	let cachedExtension: { fingerprint: string; epoch: string; activatedAtMs: number } | undefined;
	let cachedConfiguration: { fingerprint: string; epoch: string } | undefined;

	async function root(): Promise<string | undefined> {
		const directory = join(agentDir(), PROVENANCE_DIR);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		return await privateDir(directory) ? directory : undefined;
	}

	async function cleanupStale(directory: string): Promise<void> {
		let removed = 0;
		const entries = await readdir(directory, { withFileTypes: true });
		for (const entry of entries) {
			if (removed >= MAX_STALE_CLEANUP) break;
			if (!entry.name.startsWith(`${PROVENANCE_LOCK}.`) && !entry.name.startsWith(`${PROVENANCE_MANIFEST}.`)) continue;
			await rm(join(directory, entry.name), { recursive: true, force: true });
			removed += 1;
		}
	}

	async function withLock<T>(directory: string, action: (token: string) => Promise<T>): Promise<T | undefined> {
		const lockPath = join(directory, PROVENANCE_LOCK);
		const token = randomUUID();
		const deadline = now() + LOCK_WAIT_MS;
		while (true) {
			try {
				await mkdir(lockPath, { mode: 0o700 });
				if (!await privateDir(lockPath)) return undefined;
				await writeFile(join(lockPath, TOKEN_FILE), token, { encoding: "utf8", mode: 0o600 });
				await writeFile(join(lockPath, TIME_FILE), String(now()), { encoding: "utf8", mode: 0o600 });
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
				if (now() >= deadline) return undefined;
				try {
					const acquired = Number(await readFile(join(lockPath, TIME_FILE), "utf8"));
					if (Number.isFinite(acquired) && now() - acquired > STALE_LOCK_MS) {
						const owner = await readFile(join(lockPath, TOKEN_FILE), "utf8");
						const quarantine = join(directory, `${PROVENANCE_LOCK}.${randomUUID()}`);
						await rename(lockPath, quarantine);
						const quarantinedOwner = await readFile(join(quarantine, TOKEN_FILE), "utf8");
						if (quarantinedOwner !== owner) return undefined;
						continue;
					}
				} catch {
					return undefined;
				}
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
		}
		try {
			return await action(token);
		} finally {
			try {
				const owner = await readFile(join(lockPath, TOKEN_FILE), "utf8");
				if (owner === token) await rm(lockPath, { recursive: true, force: true });
			} catch {
				/* leave an unreadable lock in place rather than deleting another owner's lease */
			}
			await cleanupStale(directory).catch(() => {});
		}
	}

	async function readManifest(directory: string): Promise<Manifest | undefined> {
		const path = join(directory, PROVENANCE_MANIFEST);
		if (!await privateFile(path)) return undefined;
		try {
			const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
			return isManifest(parsed) ? parsed : undefined;
		} catch {
			return undefined;
		}
	}

	async function writeManifest(directory: string, token: string, manifest: Manifest): Promise<boolean> {
		const lockPath = join(directory, PROVENANCE_LOCK);
		const owner = await readFile(join(lockPath, TOKEN_FILE), "utf8");
		if (owner !== token) return false;
		const temp = join(directory, `${PROVENANCE_MANIFEST}.${token}`);
		await writeFile(temp, `${JSON.stringify(manifest)}\n`, { encoding: "utf8", mode: 0o600 });
		if (!await privateFile(temp)) {
			await rm(temp, { force: true });
			return false;
		}
		const stillOwner = await readFile(join(lockPath, TOKEN_FILE), "utf8");
		if (stillOwner !== token) {
			await rm(temp, { force: true });
			return false;
		}
		await rename(temp, join(directory, PROVENANCE_MANIFEST));
		return true;
	}

	return {
		async observeExtension() {
			try {
				const files = await listSourceFiles(sourceRoot);
				const fingerprint = await fingerprintSources(files);
				const directory = await root();
				if (!directory) return { available: false };
				const observed = await withLock(directory, async (token) => {
					const current = await readManifest(directory);
					if (cachedExtension && current && current.extensionEpoch !== cachedExtension.epoch) {
						return cachedExtension.fingerprint === fingerprint && cachedConfiguration
							? {
								available: true as const,
								extensionEpoch: cachedExtension.epoch,
								configurationEpoch: cachedConfiguration.epoch,
							}
							: { available: false as const };
					}
					if (current && current.extensionFingerprint === fingerprint) {
						cachedExtension = {
							fingerprint,
							epoch: current.extensionEpoch,
							activatedAtMs: current.extensionActivatedAtMs,
						};
						return {
							available: true as const,
							extensionEpoch: current.extensionEpoch,
							configurationEpoch: current.configurationEpoch,
						};
					}
					const epoch = randomId();
					const activatedAtMs = now();
					const manifest: Manifest = {
						version: MANIFEST_VERSION,
						extensionFingerprint: fingerprint,
						extensionEpoch: epoch,
						extensionActivatedAtMs: activatedAtMs,
						configurationFingerprint: current?.configurationFingerprint ?? "",
						configurationEpoch: current?.configurationEpoch ?? epoch,
						configurationActivatedAtMs: current?.configurationActivatedAtMs ?? activatedAtMs,
					};
					if (!await writeManifest(directory, token, manifest)) return { available: false as const };
					cachedExtension = { fingerprint, epoch, activatedAtMs };
					return { available: true as const, extensionEpoch: epoch, configurationEpoch: manifest.configurationEpoch };
				});
				return observed ?? { available: false };
			} catch {
				return { available: false };
			}
		},
		async observeConfiguration(snapshot) {
			try {
				const fingerprint = fingerprintConfig(snapshot);
				if (cachedConfiguration?.fingerprint === fingerprint && cachedExtension) {
					return {
						available: true,
						extensionEpoch: cachedExtension.epoch,
						configurationEpoch: cachedConfiguration.epoch,
					};
				}
				const directory = await root();
				if (!directory) return { available: false };
				const observed = await withLock(directory, async (token) => {
					const current = await readManifest(directory);
					if (!current || !cachedExtension) return { available: false as const };
					if (current.extensionEpoch !== cachedExtension.epoch) {
						if (cachedConfiguration?.fingerprint === fingerprint) {
							return {
								available: true as const,
								extensionEpoch: cachedExtension.epoch,
								configurationEpoch: cachedConfiguration.epoch,
							};
						}
						cachedConfiguration = undefined;
						return { available: false as const };
					}
					if (current.configurationFingerprint === fingerprint) {
						cachedConfiguration = { fingerprint, epoch: current.configurationEpoch };
						return {
							available: true as const,
							extensionEpoch: current.extensionEpoch,
							configurationEpoch: current.configurationEpoch,
						};
					}
					const epoch = randomId();
					const manifest: Manifest = {
						...current,
						configurationFingerprint: fingerprint,
						configurationEpoch: epoch,
						configurationActivatedAtMs: now(),
					};
					if (!await writeManifest(directory, token, manifest)) return { available: false as const };
					cachedConfiguration = { fingerprint, epoch };
					return {
						available: true as const,
						extensionEpoch: current.extensionEpoch,
						configurationEpoch: epoch,
					};
				});
				return observed ?? { available: false };
			} catch {
				return { available: false };
			}
		},
	};
}
