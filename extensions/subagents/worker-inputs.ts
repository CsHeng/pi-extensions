import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { MANAGED_LIMITS, ManagedError } from "./session-contracts.ts";
import { assertNoSymlinkComponent, type FileState } from "./workspace.ts";

import { inspectGitWorkspace, type GitTaskWorkspace } from "./git-workspace.ts";

export interface WorkerInputState { version: 1; dependencyRoots: Array<"node_modules">; parentDependencyKey: string; dependencyKey: string; gitWorkspace?: GitTaskWorkspace }
async function inputGitKey(source: string, state: WorkerInputState, budget: InventoryBudget): Promise<string> {
	if (!state.gitWorkspace) return validateGit(source, budget);
	if (state.gitWorkspace.path !== source) throw new ManagedError("worker_input_git_identity");
	await inspectGitWorkspace(state.gitWorkspace);
	return hash([state.gitWorkspace.id, state.gitWorkspace.gitDir, state.gitWorkspace.inputBase]);
}
const exec = promisify(execFile);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const absentKey = hash({ present: false });
const inside = (root: string, path: string) => { const part = relative(root, path); return part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part); };
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";

async function root(directory: string): Promise<void> {
	const info = await lstat(directory);
	if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory) throw new ManagedError("worker_input_root_invalid");
}

/** Read-only bounded inventory; logicalRoot maps staged links to their final private view. */
interface InventoryBudget { bytes: number; count: number }
interface LinkMapping { logical: string; physical: string }
async function validateLink(target: string, allowedRoot: string, mappings: readonly LinkMapping[]): Promise<void> {
	let remaining = relative(allowedRoot, target).split(sep).filter(Boolean); let current = allowedRoot; let links = 0;
	if (!inside(allowedRoot, target)) throw new ManagedError("worker_input_link_invalid");
	while (remaining.length) {
		const next = join(current, remaining.shift()!);
		const mapping = mappings.find((entry) => inside(entry.logical, next));
		const base = mapping?.physical ?? allowedRoot;
		const physical = mapping ? join(base, relative(mapping.logical, next)) : next;
		if (physical === base) await root(base); else await assertNoSymlinkComponent(base, dirname(physical));
		const info = await lstat(physical);
		if (info.isSymbolicLink()) {
			const link = await readlink(physical); const replacement = resolve(dirname(next), link);
			if (++links > 40 || isAbsolute(link) || !inside(allowedRoot, replacement)) throw new ManagedError("worker_input_link_invalid");
			remaining = [...relative(allowedRoot, replacement).split(sep).filter(Boolean), ...remaining]; current = allowedRoot;
		} else {
			if (remaining.length && !info.isDirectory()) throw new ManagedError("worker_input_link_invalid");
			if (!info.isDirectory() && !info.isFile()) throw new ManagedError("worker_input_special_entry");
			current = next;
		}
	}
}
async function inventory(directory: string, exclude: readonly string[] = [], logicalRoot = directory, allowedRoot = directory, budget: InventoryBudget = { bytes: 0, count: 0 }, mappings: readonly LinkMapping[] = [{ logical: logicalRoot, physical: directory }], allowDangling = false): Promise<Map<string, FileState>> {
	await root(directory);
	const entries = new Map<string, FileState>();
	const visit = async (current: string): Promise<void> => {
		for (const name of (await readdir(current)).sort()) {
			const file = join(current, name); const key = relative(directory, file);
			if (current === directory && exclude.includes(name)) continue;
			if (++budget.count > MANAGED_LIMITS.maxEntries) throw new ManagedError("worker_input_limit");
			await assertNoSymlinkComponent(directory, dirname(file));
			const info = await lstat(file); budget.bytes += info.size;
			if (budget.bytes > MANAGED_LIMITS.maxWorkspaceBytes) throw new ManagedError("worker_input_limit");
			if (info.isDirectory()) { entries.set(key, { kind: "directory", mode: info.mode & 0o777 }); await visit(file); }
			else if (info.isSymbolicLink()) {
				const link = await readlink(file);
				if (isAbsolute(link)) throw new ManagedError("worker_input_link_invalid");
				const target = resolve(dirname(join(logicalRoot, key)), link);
				if (!inside(allowedRoot, target)) throw new ManagedError("worker_input_link_invalid");
				try { await validateLink(target, allowedRoot, mappings); } catch (error) { if (!allowDangling || !missing(error)) throw error; }
				entries.set(key, { kind: "symlink", mode: info.mode & 0o777, link });
			} else if (info.isFile()) {
				await assertNoSymlinkComponent(directory, file);
				const data = await readFile(file);
				await assertNoSymlinkComponent(directory, file);
				if (data.length !== info.size) throw new ManagedError("worker_input_changed");
				entries.set(key, { kind: "file", mode: info.mode & 0o777, digest: createHash("sha256").update(data).digest("hex") });
			} else throw new ManagedError("worker_input_special_entry");
		}
	};
	await visit(directory); await root(directory);
	return entries;
}
const inventoryKey = (entries: Map<string, FileState>) => hash([...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));

export function workerGitEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const env = Object.fromEntries(Object.entries(source).filter(([name]) => !name.startsWith("GIT_")));
	return { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_LITERAL_PATHSPECS: "1" };
}
async function git(cwd: string, args: string[], input = ""): Promise<void> {
	const execution = exec("git", ["--literal-pathspecs", "-C", cwd, ...args], { env: workerGitEnvironment(), timeout: 30_000, maxBuffer: 1024 * 1024 });
	let inputFailed = false;
	execution.child.stdin?.on("error", () => { inputFailed = true; });
	if (input) execution.child.stdin?.end(input); else execution.child.stdin?.end();
	try { await execution; if (input && inputFailed) throw new Error("input unavailable"); } catch { throw new ManagedError("worker_input_git_failed"); }
}
async function validateGit(source: string, budget?: InventoryBudget): Promise<string> {
	const directory = join(source, ".git"); await root(source); await root(directory);
	for (const file of ["commondir", "gitdir", "objects/info/alternates", "objects/info/http-alternates"]) {
		try { await lstat(join(directory, file)); throw new ManagedError("worker_input_git_redirect"); }
		catch (error) { if (!missing(error)) throw error; }
	}
	const configPath = join(directory, "config");
	const info = await lstat(configPath);
	if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) throw new ManagedError("worker_input_git_invalid");
	const config = await readFile(configPath, "utf8");
	let section = "";
	for (const raw of config.split("\n")) {
		const line = raw.trim(); if (!line || line.startsWith("#") || line.startsWith(";")) continue;
		if (line.startsWith("[")) { section = line.toLowerCase(); if (section !== "[core]") throw new ManagedError("worker_input_git_redirect"); continue; }
		const match = /^([a-z]+)\s*=\s*(.*)$/i.exec(line);
		if (section !== "[core]" || !match || !["repositoryformatversion", "filemode", "bare", "logallrefupdates", "hookspath"].includes(match[1]!.toLowerCase())) throw new ManagedError("worker_input_git_redirect");
		if ((match[1]!.toLowerCase() === "bare" && match[2] !== "false") || (match[1]!.toLowerCase() === "hookspath" && match[2] !== "/dev/null")) throw new ManagedError("worker_input_git_redirect");
	}
	return inventoryKey(await inventory(directory, [], directory, directory, budget));
}
async function parentDependencies(repo: string, budget?: InventoryBudget): Promise<string> {
	await root(repo);
	try { return inventoryKey(await inventory(join(repo, "node_modules"), [], join(repo, "node_modules"), repo, budget)); }
	catch (error) { if (missing(error)) {
		try { await lstat(join(repo, "node_modules")); } catch (absent) { if (missing(absent)) return absentKey; throw absent; }
		throw new ManagedError("worker_input_link_invalid");
	} throw error; }
}
async function privateDependencies(source: string, state: WorkerInputState, budget?: InventoryBudget): Promise<string> {
	if (!state.dependencyRoots.length) return absentKey;
	try { await lstat(join(source, "node_modules")); } catch (error) { if (missing(error)) return absentKey; throw error; }
	return inventoryKey(await inventory(join(source, "node_modules"), [], join(source, "node_modules"), source, budget));
}
async function replaceDependencies(repo: string, source: string, expected: string): Promise<void> {
	const destination = join(source, "node_modules");
	const staging = join(dirname(source), `inputs_${randomUUID()}`);
	const previous = join(dirname(source), `inputs_old_${randomUUID()}`);
	let moved = false;
	try {
		if (expected !== absentKey) {
			await cp(join(repo, "node_modules"), staging, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
			if (inventoryKey(await inventory(staging, [], destination, source)) !== expected || await parentDependencies(repo) !== expected) throw new ManagedError("worker_input_changed");
		}
		await root(source);
		try { await lstat(destination); await rename(destination, previous); moved = true; } catch (error) { if (!missing(error)) throw error; }
		try { if (expected !== absentKey) await rename(staging, destination); }
		catch (error) { if (moved) { await rename(previous, destination); moved = false; } throw error; }
		await rm(previous, { recursive: true, force: true }); moved = false;
	} finally {
		await rm(staging, { recursive: true, force: true });
		// A failed restore is visible and retains the prior tree rather than deleting it.
		if (!moved) await rm(previous, { recursive: true, force: true });
	}
}

export function initialWorkerInputs(gitWorkspace: GitTaskWorkspace): WorkerInputState {
	return { version: 1, dependencyRoots: ["node_modules"], parentDependencyKey: absentKey, dependencyKey: absentKey, gitWorkspace };
}
export async function prepareWorkerInputs(repo: string, source: string, gitWorkspace?: GitTaskWorkspace, copyDependencies = true): Promise<WorkerInputState> {
	await root(repo); await root(source);
	let existing = false;
	try { await lstat(join(source, "node_modules")); existing = true; } catch (error) { if (!missing(error)) throw error; }
	// A dependency directory already copied as ordinary source remains ordinary source.
	const budget = { bytes: 0, count: 0 };
	await inventory(source, gitWorkspace ? [".git"] : [], source, source, budget, undefined, true);
	const parentDependencyKey = existing || !copyDependencies ? absentKey : await parentDependencies(repo, budget);
	const dependencyRoots: WorkerInputState["dependencyRoots"] = existing ? [] : ["node_modules"];
	if (parentDependencyKey !== absentKey) {
		// Match the parent's already-authoritative ignore policy; never import it.
		const check = exec("git", ["-C", repo, "check-ignore", "--quiet", "--", "node_modules"], { timeout: 30_000, maxBuffer: 1024 * 1024 });
		check.child.stdin?.end();
		try { await check; } catch { throw new ManagedError("worker_input_dependency_undeclared"); }
		await replaceDependencies(repo, source, parentDependencyKey);
	}
	if (gitWorkspace) {
		gitWorkspace.dependencyRoots = dependencyRoots;
		const state: WorkerInputState = { version: 1, dependencyRoots, parentDependencyKey, dependencyKey: parentDependencyKey, gitWorkspace };
		await inspectWorkerInputs(source, state);
		return state;
	}
	try { await lstat(join(source, ".git")); throw new ManagedError("worker_input_git_exists"); } catch (error) { if (!missing(error)) throw error; }
	await git(source, ["init", "--quiet", "--template="]);
	await git(source, ["config", "--local", "core.hooksPath", "/dev/null"]);
	await mkdir(join(source, ".git", "info"), { recursive: true, mode: 0o700 });
	await writeFile(join(source, ".git", "info", "exclude"), dependencyRoots.map((name) => `/${name}/\n`).join(""), { mode: 0o600 });
	const state: WorkerInputState = { version: 1, dependencyRoots, parentDependencyKey, dependencyKey: parentDependencyKey };
	const files = [...(await scanWorkerSource(source, state))].filter(([, entry]) => entry.kind !== "directory").map(([path]) => path);
	if (files.length) await git(source, ["add", "--force", "--pathspec-from-file=-", "--pathspec-file-nul"], `${files.join("\0")}\0`);
	await scanWorkerSource(source, state);
	return state;
}
export async function refreshWorkerInputs(repo: string, source: string, previous: WorkerInputState): Promise<WorkerInputState> {
	await inspectWorkerInputs(source, previous);
	// Ordinary source node_modules is synchronized by the source owner, not this layer.
	if (!previous.dependencyRoots.length) return previous;
	const budget = { bytes: 0, count: 0 };
	await inventory(source, [".git", ...previous.dependencyRoots], source, source, budget, undefined, true);
	await inputGitKey(source, previous, budget);
	const parentDependencyKey = await parentDependencies(repo, budget);
	if (parentDependencyKey !== previous.parentDependencyKey) await replaceDependencies(repo, source, parentDependencyKey);
	const state: WorkerInputState = { version: 1, dependencyRoots: ["node_modules"], parentDependencyKey, dependencyKey: absentKey, ...(previous.gitWorkspace ? { gitWorkspace: previous.gitWorkspace } : {}) };
	state.dependencyKey = await privateDependencies(source, state);
	return state;
}
async function inspectInputs(source: string, state: WorkerInputState, budget: InventoryBudget): Promise<{ dependencyKey: string; gitKey: string; environmentKey: string }> {
	if (state.version !== 1 || state.dependencyRoots.length > 1 || state.dependencyRoots.some((name) => name !== "node_modules")) throw new ManagedError("worker_input_state_invalid");
	const gitKey = await inputGitKey(source, state, budget); const dependencyKey = await privateDependencies(source, state, budget);
	return { dependencyKey, gitKey, environmentKey: hash([gitKey, dependencyKey]) };
}
export async function inspectWorkerInputs(source: string, state: WorkerInputState) {
	return inspectInputs(source, state, { bytes: 0, count: 0 });
}
export async function scanWorkerSource(source: string, state: WorkerInputState): Promise<Map<string, FileState>> {
	const budget = { bytes: 0, count: 0 };
	await inspectInputs(source, state, budget);
	return inventory(source, [".git", ...state.dependencyRoots], source, source, budget, undefined, true);
}
export async function scanSourceSnapshot(source: string): Promise<Map<string, FileState>> {
	try { await lstat(join(source, ".git")); throw new ManagedError("worker_input_git_exists"); } catch (error) { if (!missing(error)) throw error; }
	return inventory(source, [], source, source, undefined, undefined, true);
}
export async function workerSourceFingerprint(source: string, state: WorkerInputState): Promise<string> {
	return inventoryKey(await scanWorkerSource(source, state));
}
