/** Explicit path identity, including dangling ancestors and filesystem-order symlink targets. */
import { lstat, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

export const containsPath = (parent: string, child: string): boolean => {
 const rel = relative(parent, child);
 return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/** Anchor a declaration without erasing '..' after a symlink component. */
export const absolutePath = (entry: string, cwd: string): string => isAbsolute(entry) ? entry : `${isAbsolute(cwd) ? cwd : resolve(cwd)}${sep}${entry}`;

export interface PathIdentity {
 physical: string;
 links: { path: string; target: string }[];
 missing?: string;
}

/** A trailing separator requires a directory, just like a final '/.'. */
function components(path: string): string[] {
 const parts = path.split(sep === "\\" ? /[\\/]/ : sep).filter(Boolean);
 if (path.endsWith(sep) || (sep === "\\" && path.endsWith("/"))) parts.push(".");
 return parts;
}

/** Resolve link components before parent traversal; missing tails retain a bounded future identity. */
export async function pathIdentity(input: string, followLeaf = true): Promise<PathIdentity> {
 const absolute = absolutePath(input, process.cwd());
 let current = parse(absolute).root;
 let remaining = components(absolute.slice(current.length));
 const links: PathIdentity["links"] = [];
 while (remaining.length) {
  const component = remaining.shift()!;
  if (component === "." || component === "..") {
   // lstat(dir) alone does not require search permission inside dir. Do not let
   // lexical dot traversal bypass the filesystem's EACCES/ENOTDIR checks.
   await lstat(`${current}${sep}.`);
   if (component === "..") current = dirname(current);
   continue;
  }
  const candidate = join(current, component);
  if (!followLeaf && remaining.length === 0) {
   await lstat(`${current}${sep}.`);
   return { physical: join(await realpath(current), component), links };
  }
  let info;
  try { info = await lstat(candidate); }
  catch (error) {
   if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
   // Parent traversal cannot bypass a missing component on the filesystem.
   return { physical: remaining.includes("..") ? candidate : resolve(candidate, ...remaining), links, missing: candidate };
  }
  if (info.isSymbolicLink()) {
   if (links.length >= 40) throw new Error("symlink resolution limit");
   const target = await readlink(candidate);
   links.push({ path: candidate, target });
   if (isAbsolute(target)) {
    current = parse(target).root;
    remaining = [...components(target.slice(current.length)), ...remaining];
   } else {
    current = dirname(candidate);
    remaining = [...components(target), ...remaining];
   }
  } else {
   // Even '.' and '..' require the preceding component to be a directory.
   if (remaining.length && !info.isDirectory()) {
    throw Object.assign(new Error(`Not a directory: ${candidate}`), { code: "ENOTDIR" });
   }
   current = candidate;
  }
 }
 // Normalize only the walked physical path. Re-resolving the original spelling lets
 // runtimes that collapse '..' before following links undo filesystem-order traversal.
 return { physical: await realpath(current), links };
}
