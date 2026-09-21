import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readlink, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

/** Git owns content versions; the caller owns task/episode authority and writer exclusion. */
export interface GitInput { commit: string; tree: string }
export interface GitTaskWorkspace {
	version: 1;
	id: string;
	repo: string;
	path: string;
	commonDir: string;
	gitDir: string;
	inputBase: string;
	ownedRefs: Record<string, string>;
	dependencyRoots?: Array<"node_modules">;
}
export interface GitCandidate {
	id: string;
	workspaceId: string;
	inputBase: string;
	commit: string;
	tree: string;
	changedPaths: string[];
}
export type GitMergeResult =
	| { status: "clean"; tree: string }
	| { status: "conflict"; tree: string; details: string };
export type GitApplyResult =
	| { status: "applied"; parentInput: string; tree: string; changedPaths: string[] }
	| { status: "conflict"; parentInput: string; tree: string; details: string };
export type GitRefreshResult =
	| { status: "refreshed"; previousInput: string; inputBase: string; tree: string }
	| { status: "conflict"; previousInput: string; parentInput: string; candidate: GitCandidate; tree: string; details: string };
export class GitWorkspaceError extends Error {
	readonly code: string;
	readonly detail: string;
	constructor(code: string, detail = "") { super(code); this.name = "GitWorkspaceError"; this.code = code; this.detail = detail; }
}
const MAX_OUTPUT = 64 * 1024 * 1024;
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const ID = /^[a-f0-9-]{36}$/;
const absent = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const contained = (root: string, file: string) => { const part = relative(root, file); return part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part); };
function oid(value: string): string { if (!OID.test(value)) throw new GitWorkspaceError("invalid_git_object"); return value; }
function environment(index?: string): NodeJS.ProcessEnv {
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
	return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_TERMINAL_PROMPT: "0", GIT_LITERAL_PATHSPECS: "1", LC_ALL: "C",
		GIT_AUTHOR_NAME: "Managed subagent", GIT_AUTHOR_EMAIL: "subagent@localhost",
		GIT_COMMITTER_NAME: "Managed subagent", GIT_COMMITTER_EMAIL: "subagent@localhost",
		...(index ? { GIT_INDEX_FILE: index } : {}) };
}
interface Result { status: number; stdout: Buffer; stderr: Buffer }
interface RunOptions { input?: Buffer | string; index?: string; allowed?: readonly number[]; readOnly?: boolean; signal?: AbortSignal | undefined; timeoutMs?: number }
/** Typed callers own argv policy. Read queries share process limits, never checkpoint/apply operations. */
export function runReadGit(repo: string, args: readonly string[], options: Pick<RunOptions, "input" | "allowed" | "signal" | "timeoutMs"> = {}): Promise<Result> {
 return run(repo, args, { ...options, readOnly: true });
}
async function run(repo: string, args: readonly string[], options: RunOptions = {}): Promise<Result> {
	return new Promise((fulfill, reject) => {
		if (options.signal?.aborted) { reject(new GitWorkspaceError("git_aborted")); return; }
		const readOptions = options.readOnly ? ["--no-pager", "--no-replace-objects", "-c", "core.attributesFile=/dev/null", "-c", "core.untrackedCache=false", "-c", "gc.auto=0", "-c", "maintenance.auto=false", "-c", "protocol.allow=never"] : [];
		const child = spawn("git", [...readOptions, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-C", repo, ...args], {
			env: { ...environment(options.index), ...(options.readOnly ? { GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_ATTR_NOSYSTEM: "1", GIT_PAGER: "cat", GIT_CONFIG_COUNT: "0" } : {}) },
			stdio: ["pipe", "pipe", "pipe"], // Stay in the managed child's process group for owner shutdown.
		});
		const output: Buffer[] = []; const errors: Buffer[] = [];
		let size = 0; let failure: string | undefined;
		const kill = () => { try { child.kill("SIGKILL"); } catch { /* already exited */ } };
		const abort = () => { failure = "git_aborted"; kill(); };
		options.signal?.addEventListener("abort", abort, { once: true });
		const timer = setTimeout(() => { failure = "git_timeout"; kill(); }, Math.min(options.timeoutMs ?? 30_000, 30_000));
		const collect = (parts: Buffer[]) => (chunk: Buffer) => {
			size += chunk.length;
			if (size > (options.readOnly ? 1024 * 1024 : MAX_OUTPUT)) { failure = "git_output_limit"; kill(); }
			else parts.push(chunk);
		};
		child.stdout.on("data", collect(output)); child.stderr.on("data", collect(errors));
		child.once("error", error => { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); reject(new GitWorkspaceError("git_unavailable", error.message)); });
		child.once("close", status => {
			clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
			const result = { status: status ?? -1, stdout: Buffer.concat(output), stderr: Buffer.concat(errors) };
			if (failure || !(options.allowed ?? [0]).includes(result.status)) reject(new GitWorkspaceError(failure ?? "git_command_failed", result.stderr.toString("utf8").slice(0, 4096)));
			else fulfill(result);
		});
		// Some commands reject before consuming input; report their exit status, not an unhandled EPIPE.
		child.stdin.on("error", () => {}); child.stdin.end(options.input);
	});
}
const text = async (repo: string, args: readonly string[], options: Parameters<typeof run>[2] = {}) => (await run(repo, args, options)).stdout.toString("utf8").trim();
function paths(buffer: Buffer): string[] {
	const decoded = buffer.toString("utf8");
	if (!Buffer.from(decoded, "utf8").equals(buffer)) throw new GitWorkspaceError("unsupported_path_encoding");
	return [...new Set(decoded.split("\0").filter(Boolean))];
}
async function root(repo: string): Promise<string> {
	const canonical = await realpath(repo);
	if (await realpath(await text(canonical, ["rev-parse", "--show-toplevel"])) !== canonical) throw new GitWorkspaceError("repository_root_required");
	return canonical;
}
async function common(repo: string): Promise<string> { return realpath(resolve(repo, await text(repo, ["rev-parse", "--git-common-dir"]))); }
async function commitTree(repo: string, tree: string, parent?: string): Promise<string> {
	return oid(await text(repo, ["commit-tree", oid(tree), ...(parent ? ["-p", oid(parent)] : [])], { input: "Managed execution checkpoint\n" }));
}
const excludedPath = (path: string, roots: readonly string[]) => roots.some(root => path === root || path.startsWith(`${root}/`));
async function supportedInput(repo: string, excluded: readonly string[] = []): Promise<string[]> {
	if ((await run(repo, ["ls-files", "--unmerged", "-z"])).stdout.length) throw new GitWorkspaceError("unresolved_index_conflict");
	if (await text(repo, ["config", "--get", "core.sparseCheckout"], { allowed: [0, 1] }) === "true") throw new GitWorkspaceError("unsupported_sparse_checkout");
	const stages = (await run(repo, ["ls-files", "--stage", "-z"])).stdout.toString("utf8");
	if (stages.split("\0").some(line => line.startsWith("160000 "))) throw new GitWorkspaceError("unsupported_submodule_input");
	const files = paths((await run(repo, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])).stdout).filter(path => !excludedPath(path, excluded));
	if (files.length > 100_000) throw new GitWorkspaceError("source_entry_limit");
	let bytes = 0;
	const visible: string[] = [];
	for (const file of files) {
		if (!contained(repo, resolve(repo, file))) throw new GitWorkspaceError("source_path_escape");
		let info; try { info = await lstat(join(repo, file)); } catch (error) { if (absent(error)) continue; throw error; }
		bytes += info.size; if (bytes > 8 * 1024 ** 3) throw new GitWorkspaceError("source_size_limit");
		if (info.isSymbolicLink()) {
			const link = await readlink(join(repo, file));
			if (isAbsolute(link) || !contained(repo, resolve(dirname(join(repo, file)), link))) throw new GitWorkspaceError("unsupported_external_symlink");
			try { if (!contained(repo, await realpath(join(repo, file)))) throw new GitWorkspaceError("unsupported_external_symlink"); }
			catch (error) { if (!absent(error)) throw error; }
		} else if (!info.isFile() && !info.isDirectory()) throw new GitWorkspaceError("unsupported_source_entry");
		if (!info.isDirectory()) visible.push(file);
	}
	if (files.length) {
		const attributes = (await run(repo, ["check-attr", "-z", "--stdin", "filter", "working-tree-encoding"], { input: `${files.join("\0")}\0` })).stdout.toString("utf8").split("\0");
		for (let i = 2; i < attributes.length; i += 3) {
			if (attributes[i] && !["unspecified", "unset"].includes(attributes[i]!)) throw new GitWorkspaceError("unsupported_content_filter");
		}
	}
	return visible;
}

/** Captures visible tracked/non-ignored source, not staging categories or ignored dependencies. */
export async function captureGitInput(repository: string, parent?: string, excluded: readonly "node_modules"[] = []): Promise<GitInput> {
	const repo = await root(repository);
	const files = await supportedInput(repo, excluded);
	const directory = await mkdtemp(join(tmpdir(), "csheng-git-index-"));
	const index = join(directory, "index");
	try {
		// A fresh index has no stat-cache false positives and no stale deleted
		// entries. Git's inventory supplies tracked (even ignored) and visible
		// nonignored paths; literal NUL pathspecs never import ignored siblings.
		await run(repo, ["read-tree", "--empty"], { index });
		if (files.length) await run(repo, ["add", "--force", "--pathspec-from-file=-", "--pathspec-file-nul"], { index, input: `${files.join("\0")}\0` });
		if ((await run(repo, ["ls-files", "--stage", "-z"], { index })).stdout.toString("utf8").split("\0").some(line => line.startsWith("160000 "))) throw new GitWorkspaceError("unsupported_submodule_input");
		const tree = oid(await text(repo, ["write-tree"], { index }));
		const head = parent ?? await text(repo, ["rev-parse", "--verify", "HEAD"], { allowed: [0, 128] });
		return { tree, commit: await commitTree(repo, tree, head || undefined) };
	} finally { await rm(directory, { recursive: true, force: true }); }
}
async function retain(workspace: GitTaskWorkspace, suffix: string, commit: string): Promise<string> {
	if (!ID.test(workspace.id) || !/^[a-z0-9/-]+$/.test(suffix)) throw new GitWorkspaceError("invalid_workspace_identity");
	const ref = `refs/csheng/subagents/${workspace.id}/${suffix}`;
	const previous = workspace.ownedRefs[ref];
	await run(workspace.repo, ["update-ref", ref, oid(commit), previous ?? ""]);
	workspace.ownedRefs[ref] = commit;
	return ref;
}
/** Pin a prepared input while its task waits for a worktree/capacity lease. */
export async function retainGitInput(repository: string, id: string, input: GitInput): Promise<string> {
	if (!/^session_[a-f0-9-]{36}$/.test(id)) throw new GitWorkspaceError("invalid_workspace_identity");
	const repo = await root(repository);
	const ref = `refs/csheng/subagents/inputs/${id}`;
	await run(repo, ["update-ref", ref, oid(input.commit), ""]);
	return ref;
}
export async function inspectGitInput(repository: string, ref: string, input: GitInput): Promise<void> {
	if (!/^refs\/csheng\/subagents\/inputs\/session_[a-f0-9-]{36}$/.test(ref)) throw new GitWorkspaceError("invalid_workspace_identity");
	const repo = await root(repository);
	if (await text(repo, ["rev-parse", "--verify", ref]) !== oid(input.commit)) throw new GitWorkspaceError("owned_ref_changed");
	if (await text(repo, ["rev-parse", `${input.commit}^{tree}`]) !== oid(input.tree)) throw new GitWorkspaceError("input_tree_mismatch");
}
export async function discardGitInput(repository: string, ref: string, input: GitInput): Promise<void> {
	if (!/^refs\/csheng\/subagents\/inputs\/session_[a-f0-9-]{36}$/.test(ref)) throw new GitWorkspaceError("invalid_workspace_identity");
	await run(await root(repository), ["update-ref", "-d", ref, oid(input.commit)]);
}

/** The returned ownership record must be persisted by the managed-session owner. */
export async function createGitTaskWorkspace(repository: string, destination: string, input: GitInput): Promise<GitTaskWorkspace> {
	const repo = await root(repository); oid(input.commit); oid(input.tree);
	if (await text(repo, ["rev-parse", `${input.commit}^{tree}`]) !== input.tree) throw new GitWorkspaceError("input_tree_mismatch");
	await mkdir(dirname(resolve(destination)), { recursive: true });
	const path = join(await realpath(dirname(resolve(destination))), resolve(destination).split(sep).at(-1)!);
	if (path === repo) throw new GitWorkspaceError("workspace_is_parent");
	if (contained(repo, path) && (await run(repo, ["check-ignore", "--quiet", "--", path], { allowed: [0, 1] })).status !== 0) throw new GitWorkspaceError("nested_workspace_must_be_ignored");
	try { await lstat(path); throw new GitWorkspaceError("workspace_destination_exists"); } catch (error) { if (!absent(error)) throw error; }
	const workspace: GitTaskWorkspace = { version: 1, id: randomUUID(), repo, path, commonDir: await common(repo), gitDir: "", inputBase: input.commit, ownedRefs: {} };
	await retain(workspace, "input", input.commit);
	try {
		await run(repo, ["worktree", "add", "--detach", "--", path, input.commit]);
		workspace.gitDir = await realpath(await text(path, ["rev-parse", "--absolute-git-dir"]));
	}
	catch (error) {
		// Only release our ref; Git owns any failed checkout diagnostics at this destination.
		for (const [ref, value] of Object.entries(workspace.ownedRefs)) await run(repo, ["update-ref", "-d", ref, value]);
		throw error;
	}
	return workspace;
}
export async function inspectGitWorkspace(workspace: GitTaskWorkspace): Promise<void> {
	if (workspace.version !== 1 || !ID.test(workspace.id) || workspace.path === workspace.repo) throw new GitWorkspaceError("invalid_workspace_identity");
	await root(workspace.repo);
	if (await root(workspace.path) !== workspace.path || await realpath(await text(workspace.path, ["rev-parse", "--absolute-git-dir"])) !== workspace.gitDir) throw new GitWorkspaceError("workspace_registration_changed");
	if (await common(workspace.repo) !== workspace.commonDir || await common(workspace.path) !== workspace.commonDir) throw new GitWorkspaceError("workspace_repository_mismatch");
	if (!(await lstat(join(workspace.path, ".git"))).isFile()) throw new GitWorkspaceError("workspace_not_linked");
	const records = (await run(workspace.repo, ["worktree", "list", "--porcelain", "-z"])).stdout.toString("utf8").split("\0\0");
	if (!records.some(record => record.split("\0").includes(`worktree ${workspace.path}`))) throw new GitWorkspaceError("workspace_not_registered");
	for (const [ref, value] of Object.entries(workspace.ownedRefs)) {
		if (!ref.startsWith(`refs/csheng/subagents/${workspace.id}/`) || !OID.test(value)) throw new GitWorkspaceError("invalid_owned_ref");
		if (await text(workspace.repo, ["rev-parse", "--verify", ref]) !== value) throw new GitWorkspaceError("owned_ref_changed");
	}
}
async function changed(repo: string, before: string, after: string): Promise<string[]> {
	return paths((await run(repo, ["diff", "--name-only", "--no-renames", "-z", oid(before), oid(after), "--"])).stdout);
}
export async function freezeGitCandidate(workspace: GitTaskWorkspace): Promise<GitCandidate> {
	await inspectGitWorkspace(workspace);
	const input = await captureGitInput(workspace.path, workspace.inputBase, workspace.dependencyRoots);
	const changedPaths = await changed(workspace.repo, workspace.inputBase, input.commit);
	const selected = new Set(changedPaths); let bytes = 0;
	for (const entry of (await run(workspace.repo, ["ls-tree", "-rlz", input.commit])).stdout.toString("utf8").split("\0")) {
		const tab = entry.indexOf("\t"); if (tab < 0 || !selected.has(entry.slice(tab + 1))) continue;
		const size = Number(entry.slice(0, tab).trim().split(/\s+/).at(-1));
		if (!Number.isSafeInteger(size) || size < 0) throw new GitWorkspaceError("unsupported_candidate_entry");
		bytes += size; if (bytes > MAX_OUTPUT) throw new GitWorkspaceError("candidate_limit");
	}
	const id = randomUUID(); await retain(workspace, `candidate/${id}`, input.commit);
	return { id, workspaceId: workspace.id, inputBase: workspace.inputBase, ...input, changedPaths };
}
function candidateOwner(workspace: GitTaskWorkspace, candidate: GitCandidate): void {
	if (candidate.workspaceId !== workspace.id || !ID.test(candidate.id) || workspace.ownedRefs[`refs/csheng/subagents/${workspace.id}/candidate/${candidate.id}`] !== candidate.commit) throw new GitWorkspaceError("candidate_owner_mismatch");
	oid(candidate.inputBase); oid(candidate.commit); oid(candidate.tree);
}
/** The explicit base prevents inherited dirty input from becoming a worker change. */
export async function mergeGitCandidate(repository: string, inputBase: string, parent: string, worker: string): Promise<GitMergeResult> {
	const result = await run(repository, ["merge-tree", "--write-tree", `--merge-base=${oid(inputBase)}`, oid(parent), oid(worker)], { allowed: [0, 1] });
	const lines = result.stdout.toString("utf8").split("\n"); const tree = oid(lines[0]!);
	return result.status === 0 ? { status: "clean", tree } : { status: "conflict", tree, details: lines.slice(1).join("\n") };
}
/** Caller serializes parent mutations. No index write, reset, stash, auto-accept, or forced resolution. */
export async function applyGitCandidate(workspace: GitTaskWorkspace, candidate: GitCandidate): Promise<GitApplyResult> {
	await inspectGitWorkspace(workspace); candidateOwner(workspace, candidate);
	if (await text(workspace.repo, ["rev-parse", `${candidate.commit}^{tree}`]) !== candidate.tree) throw new GitWorkspaceError("candidate_tree_mismatch");
	if (await text(workspace.repo, ["rev-parse", `${candidate.commit}^`]) !== candidate.inputBase) throw new GitWorkspaceError("candidate_base_mismatch");
	if (JSON.stringify(await changed(workspace.repo, candidate.inputBase, candidate.commit)) !== JSON.stringify(candidate.changedPaths)) throw new GitWorkspaceError("candidate_paths_mismatch");
	const parent = await captureGitInput(workspace.repo);
	await retain(workspace, `integration/${randomUUID()}`, parent.commit);
	const result = await mergeGitCandidate(workspace.repo, candidate.inputBase, parent.commit, candidate.commit);
	if (result.status === "conflict") return { ...result, parentInput: parent.commit };
	const patch = (await run(workspace.repo, ["diff", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", parent.tree, result.tree, "--"])).stdout;
	const changedPaths = await changed(workspace.repo, parent.tree, result.tree);
	if (patch.length) {
		await run(workspace.repo, ["apply", "--check", "--binary", "--whitespace=nowarn", "-"], { input: patch });
		await run(workspace.repo, ["apply", "--binary", "--whitespace=nowarn", "-"], { input: patch });
	}
	return { status: "applied", parentInput: parent.commit, tree: result.tree, changedPaths };
}
/** Explicit, idle-writer refresh. A conflict preserves both workspaces and all three input versions. */
export async function refreshGitInputs(workspace: GitTaskWorkspace): Promise<GitRefreshResult> {
	const candidate = await freezeGitCandidate(workspace);
	const parent = await captureGitInput(workspace.repo);
	await retain(workspace, `refresh/${randomUUID()}`, parent.commit);
	const previousInput = workspace.inputBase;
	const result = await mergeGitCandidate(workspace.repo, previousInput, parent.commit, candidate.commit);
	if (result.status === "conflict") return { ...result, previousInput, parentInput: parent.commit, candidate };
	// Only the task's isolated worktree/index changes. The previous candidate remains pinned.
	await run(workspace.path, ["read-tree", "--reset", "-u", result.tree]);
	await retain(workspace, "input", parent.commit);
	workspace.inputBase = parent.commit;
	return { status: "refreshed", previousInput, inputBase: parent.commit, tree: result.tree };
}
/** Explicit discard only. Does not prune the repository, delete user branches, or collect global objects. */
export async function discardGitWorkspace(workspace: GitTaskWorkspace): Promise<void> {
	await inspectGitWorkspace(workspace);
	await run(workspace.repo, ["worktree", "remove", "--force", "--", workspace.path]);
	for (const [ref, expected] of Object.entries(workspace.ownedRefs)) {
		await run(workspace.repo, ["update-ref", "-d", ref, expected]);
		delete workspace.ownedRefs[ref];
	}
}