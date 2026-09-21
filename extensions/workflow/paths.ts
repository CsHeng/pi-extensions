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

/** Resolve link components before parent traversal; missing tails retain a bounded future identity. */
export async function pathIdentity(input: string, followLeaf = true): Promise<PathIdentity> {
 const absolute = absolutePath(input, process.cwd());
 let current = parse(absolute).root;
 let remaining = absolute.slice(current.length).split(sep).filter(Boolean);
 const links: PathIdentity["links"] = [];
 while (remaining.length) {
  const component = remaining.shift()!;
  if (component === ".") continue;
  if (component === "..") { current = dirname(current); continue; }
  const candidate = join(current, component);
  if (!followLeaf && remaining.length === 0) return { physical: join(await realpath(current), component), links };
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
    remaining = [...target.slice(current.length).split(sep).filter(Boolean), ...remaining];
   } else {
    current = dirname(candidate);
    remaining = [...target.split(sep).filter(Boolean), ...remaining];
   }
  } else {
   current = candidate;
  }
 }
 // Existing targets use the platform's physical-path oracle, not a lexical projection.
 return { physical: await realpath(absolute), links };
}
