import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isSafePathGrammar, truncateUtf8, type NormalizedChildCapability } from "./contracts.ts";
import { authorizePath, parseCapability } from "./path-policy.ts";
import { runReadGit } from "./git-workspace.ts";

export const GIT_READ_TOOL = "git_read";
const text = Type.String({ minLength: 1, maxLength: 4096 });
export const gitReadParameters = Type.Object({
 operation: Type.Union([Type.Literal("status"), Type.Literal("diff"), Type.Literal("show"), Type.Literal("log")]),
 repository: text, paths: Type.Array(text, { minItems: 1, maxItems: 32 }),
 layer: Type.Optional(Type.Union([Type.Literal("commits"), Type.Literal("index"), Type.Literal("worktree")])),
 base: Type.Optional(text), head: Type.Optional(text),
 offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
}, { additionalProperties: false });
type Query = Static<typeof gitReadParameters>;
export interface GitReadResult {
 ok: boolean; code?: string; operation?: Query["operation"]; repository?: string; paths?: string[];
 layer?: string; base?: string; head?: string; blob?: string; complete?: boolean; text?: string;
 before?: string; after?: string; offset?: number; totalLines?: number;
}
class QueryError extends Error { readonly code: string; constructor(code: string) { super(code); this.code = code; } }
function requireRead(condition: unknown, code: string): asserts condition { if (!condition) throw new QueryError(code); }
const contains = (root: string, path: string) => { const rel = relative(root, path); return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); };
const oid = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const LIMIT = 64 * 1024;
const MAX_FILES = 4096;
function safePath(path: string): boolean {
 return isSafePathGrammar(path) && !isAbsolute(path) && !path.split(/[\\/]/).some(part => part === ".." || part === ".git") && !path.includes(":(") && !path.includes("\ufffd");
}
function revision(ref: string): string {
 requireRead(ref === "HEAD" || (ref.length <= 256 && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) && !ref.includes("..") && !ref.includes("//") && !ref.endsWith(".lock")), "invalid_revision");
 return ref;
}
async function exists(path: string): Promise<boolean> { try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } }
function names(output: Buffer): string[] {
 const value = output.toString("utf8"); requireRead(Buffer.from(value).equals(output), "unsupported_path_encoding");
 const paths = value.split("\0").filter(Boolean); requireRead(paths.length <= MAX_FILES, "path_limit");
 requireRead(paths.every(safePath), "invalid_path"); return [...new Set(paths)];
}

/** Authorize a historical lexical path without requiring a now-deleted leaf to exist. */
async function authorizeFile(cap: NormalizedChildCapability, repo: string, path: string): Promise<void> {
 requireRead(safePath(path), "invalid_path");
 const target = resolve(repo, path);
 const grants = [...cap.readRoots, ...cap.externalReadRoots];
 requireRead(contains(repo, target) && grants.some(root => contains(root, target)), "read_scope_denied");
 let parent = dirname(target);
 if (target === repo) parent = repo;
 while (!(await exists(parent))) { const next = dirname(parent); requireRead(next !== parent, "read_scope_denied"); parent = next; }
 const physical = await realpath(parent);
 // Grants are canonical. Never traverse parent symlinks, including aliases to a grant's ancestor.
 requireRead(physical === parent && contains(repo, physical), "read_scope_denied");
 if (await exists(target)) {
  const stat = await lstat(target);
  if (stat.isDirectory()) requireRead(await realpath(target) === target, "read_scope_denied");
 }
}

/** No external object stores, replacement history, or executable local configuration. */
async function metadata(repo: string, git: (args: string[], allowed?: number[]) => Promise<Buffer>): Promise<void> {
 const directory = (await git(["rev-parse", "--absolute-git-dir"])).toString().trim();
 const common = await realpath(resolve(repo, (await git(["rev-parse", "--git-common-dir"])).toString().trim()));
 const marker = join(repo, ".git"); const markerStat = await lstat(marker);
 if (markerStat.isDirectory()) requireRead(!markerStat.isSymbolicLink() && directory === marker && common === marker && await realpath(marker) === marker, "unsupported_git_layout");
 else {
  requireRead(markerStat.isFile() && !markerStat.isSymbolicLink() && dirname(directory) === join(common, "worktrees"), "unsupported_git_layout");
  requireRead(resolve((await readFile(join(directory, "gitdir"), "utf8")).trim()) === marker && await realpath(directory) === directory, "unsupported_git_layout");
 }
 for (const path of [join(common, "info/grafts"), join(common, "objects/info/alternates"), join(common, "objects/info/http-alternates")]) {
  requireRead(!(await exists(path)), "unsupported_object_source");
 }
 let count = 0;
 const noLinks = async (path: string): Promise<void> => {
  requireRead(++count <= 100_000, "metadata_limit");
  const stat = await lstat(path); requireRead(!stat.isSymbolicLink(), "unsupported_object_source");
  if (stat.isDirectory()) for (const entry of await readdir(path)) await noLinks(join(path, entry));
 };
 await noLinks(join(common, "objects"));
 const unsafe = await git(["config", "--local", "--no-includes", "--get-regexp", "^(include\\.|includeif\\.|filter\\.|extensions\\.(partialclone|worktreeconfig)|remote\\..*\\.promisor|core\\.worktree)"], [0, 1]);
 requireRead(!unsafe.length && !(await exists(join(common, "config.worktree"))) && !(await exists(join(directory, "config.worktree"))), "unsupported_git_config");
}

export async function queryGitRead(manifest: NormalizedChildCapability, input: unknown, signal?: AbortSignal): Promise<GitReadResult> {
 try {
  const cap = parseCapability(manifest);
  requireRead(cap.role === "reviewer" || cap.role === "explorer", "role_denied");
  requireRead(Check(gitReadParameters, input), "invalid_request");
  const q = input as Query;
  requireRead(q.operation === "diff" || q.layer === undefined, "invalid_request");
  requireRead(q.operation === "diff" || q.base === undefined, "invalid_request");
  requireRead(q.operation !== "status" || q.head === undefined, "invalid_request");
  requireRead(q.operation === "show" || q.offset === undefined, "invalid_request");
  requireRead(q.operation === "show" || q.operation === "log" || q.limit === undefined, "invalid_request");
  const selector = resolve(cap.root, q.repository);
  requireRead(!selector.split(sep).includes(".git"), "read_scope_denied");
  requireRead((await authorizePath(cap, "read", selector)).allowed, "read_scope_denied");
  const selected = (await lstat(selector)).isDirectory() ? selector : dirname(selector);
  const rootResult = await runReadGit(selected, ["rev-parse", "--show-toplevel"], { signal });
  const repo = await realpath(rootResult.stdout.toString().trim());
  const git = async (args: string[], allowed = [0]) => (await runReadGit(repo, args, { allowed, signal })).stdout;
  await metadata(repo, git);
  const paths = [...new Set(q.paths)];
  for (const path of paths) await authorizeFile(cap, repo, path);
  const resolveCommit = async (ref: string) => { const value = (await git(["rev-parse", "--verify", "--end-of-options", `${revision(ref)}^{commit}`])).toString().trim(); requireRead(oid.test(value), "invalid_revision"); return value; };
  const result: GitReadResult = { ok: true, operation: q.operation, repository: repo, paths, complete: true };
  const bounded = (buffer: Buffer) => { const value = buffer.toString("utf8"); requireRead(Buffer.from(value).equals(buffer) && !value.includes("\0"), "unsupported_binary_content"); result.complete = buffer.length <= LIMIT; result.text = truncateUtf8(value, LIMIT).text; };
  const diff = async (revisions: string[]) => {
   const options = ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--ignore-submodules=none", "--submodule=short", "--no-color"];
   const stats = await git([...options, "--numstat", "-z", ...revisions, "--", ...paths]);
   requireRead(!stats.toString().split("\0").some(entry => entry.startsWith("-\t-\t")), "unsupported_binary_content");
   bounded(await git([...options, ...revisions, "--", ...paths]));
  };
  if (q.operation === "show") {
   requireRead(paths.length === 1 && q.head, "invalid_request"); result.head = await resolveCommit(q.head);
   const tree = (await git(["ls-tree", "-z", "--full-tree", result.head, "--", paths[0]!])).toString();
   const entry = /^(100644|100755|120000) blob ([a-f0-9]+)\t([^\0]+)\0$/.exec(tree);
   requireRead(entry && oid.test(entry[2]!) && entry[3] === paths[0], "historical_file_unavailable"); result.blob = entry[2]!;
   const bytes = await git(["cat-file", "blob", result.blob!]);
   requireRead(!bytes.includes(0) && Buffer.from(bytes.toString()).equals(bytes), "unsupported_binary_content");
   const lines = bytes.toString().split("\n"); const offset = q.offset ?? 0; const limit = q.limit ?? 2000;
   result.offset = offset; result.totalLines = lines.length;
   bounded(Buffer.from(lines.slice(offset, offset + limit).join("\n")));
   result.complete = result.complete === true && offset === 0 && offset + limit >= lines.length;
  } else if (q.operation === "log") {
   result.head = await resolveCommit(q.head ?? "HEAD");
   const limit = Math.min(q.limit ?? 20, 100);
   const output = await git(["log", "--no-decorate", "--no-show-signature", `--max-count=${limit + 1}`, "--format=%H %ct %s", result.head, "--", ...paths]);
   const lines = output.toString().trimEnd().split("\n").filter(Boolean);
   bounded(Buffer.from(lines.slice(0, limit).join("\n"))); result.complete = result.complete === true && lines.length <= limit;
  } else if (q.operation === "diff" && (q.layer ?? "commits") === "commits") {
   requireRead(q.base && q.head, "invalid_request"); result.layer = "commits";
   result.base = await resolveCommit(q.base); result.head = await resolveCommit(q.head);
   await diff([result.base, result.head]);
  } else {
   requireRead(!q.base && !q.head, "invalid_request"); result.layer = q.operation === "status" ? "status" : q.layer!;
   const inventory = async () => {
    // Mutable submodule inspection can follow a different Git store; refuse it, not silently omit it.
    const index = await git(["ls-files", "--stage", "-z", "--", ...paths]);
    const tree = await git(["ls-tree", "-r", "-z", "HEAD", "--", ...paths], [0, 128]);
    requireRead(![index, tree].some(bytes => bytes.toString().split("\0").some(entry => entry.startsWith("160000 "))), "unsupported_mutable_gitlink");
    const files = names(await git(["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...paths]));
    for (const file of files) await authorizeFile(cap, repo, file);
    if (files.length) {
     const attributes = (await runReadGit(repo, ["check-attr", "-z", "--stdin", "filter", "working-tree-encoding"], { input: `${files.join("\0")}\0`, signal })).stdout.toString().split("\0");
     for (let i = 2; i < attributes.length; i += 3) requireRead(attributes[i] === "unspecified", "unsupported_content_filter");
    }
    return files;
   };
   const identity = async () => {
    // No Git conversion in identity probes, and no reads through symlink leaves.
    const files = await inventory(); const hash = createHash("sha256"); let bytes = 0;
    hash.update(await git(["rev-parse", "--verify", "HEAD"], [0, 128]));
    hash.update(await git(["ls-files", "--stage", "-z", "--", ...paths]));
    for (const file of files) {
     const absolute = join(repo, file); hash.update(file);
     if (!(await exists(absolute))) { hash.update("absent"); continue; }
     const stat = await lstat(absolute); requireRead(stat.isFile() || stat.isSymbolicLink(), "unsupported_source_entry");
     bytes += stat.size; requireRead(bytes <= 8 * 1024 * 1024, "identity_limit"); hash.update(String(stat.mode));
     hash.update(stat.isSymbolicLink() ? await readlink(absolute) : await readFile(absolute));
    }
    return hash.digest("hex");
   };
   result.before = await identity();
   // Recheck configuration immediately before commands capable of worktree conversion.
   await metadata(repo, git);
   if (q.operation === "status") {
    const output = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=all", "--no-renames", "--", ...paths]);
    const entries = output.toString().split("\0").filter(Boolean);
    for (const entry of entries) await authorizeFile(cap, repo, entry.slice(3));
    bounded(Buffer.from(entries.join("\n")));
   } else await diff(q.layer === "index" ? ["--cached"] : []);
   result.after = await identity();
   if (result.before !== result.after) { delete result.text; return { ...result, ok: false, code: "input_changed", complete: false }; }
  }
  return result;
 } catch (error) {
  return { ok: false, code: error instanceof QueryError ? error.code : (error as { code?: string }).code?.startsWith("git_") ? (error as { code: string }).code : "git_read_unavailable", complete: false };
 }
}

export function registerGitRead(pi: ExtensionAPI, capability: NormalizedChildCapability): void {
 if (!["explorer", "reviewer"].includes(capability.role)) return;
 pi.registerTool({ name: GIT_READ_TOOL, label: "Scoped Git read", parameters: gitReadParameters,
  description: "Read Git only within granted repository paths. Operations: status; diff with explicit commits base/head or layer index/worktree; show one path at head; log at head (default HEAD). repository must be a readable path within the intended Git owner; paths are literal owner-relative paths. Full commit IDs or ordinary ref names only, no shell, arbitrary Git flags or revision expressions. Results name resolved identities and completeness; incomplete/changed input is not a complete review. offset/limit page show lines; limit bounds log records. No writes, fetch, hooks, filters or role escalation.",
  async execute(_id, params, signal) { const result = await queryGitRead(capability, params, signal); return { content: [{ type: "text", text: JSON.stringify(result) }], details: result, ...(!result.ok ? { isError: true } : {}) }; },
 });
}
