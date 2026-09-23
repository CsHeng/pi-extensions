import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getAgentDir, loadProjectContextFiles, loadSkills, type Skill } from "@earendil-works/pi-coding-agent";

export interface CapturedProjectSkill { path: string; name: string }

export interface ChildGuidance {
	contextFiles: Array<{ path: string; content: string }>;
	skillPaths: string[];
	readRoots: string[];
	physicalRoots: string[];
}

function within(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function ignoredPrivate(path: string, sourceRoot: string): boolean {
	try { execFileSync("git", ["-C", sourceRoot, "check-ignore", "-q", "--", relative(sourceRoot, path)], { stdio: "ignore" }); return true; }
	catch { return false; }
}

/** Captured repo resources never fall back to mutable parent bytes; only ignored private resources may. */
function sourcePath(path: string, sourceRoot: string, childRoot: string): string | undefined {
	if (!within(sourceRoot, path)) return path;
	const captured = join(childRoot, relative(sourceRoot, path));
	if (existsSync(captured)) return captured;
	return ignoredPrivate(path, sourceRoot) ? path : undefined;
}

export function selectedProjectSkills(sourceRoot: string, skills: readonly Skill[]): CapturedProjectSkill[] {
	return skills.filter(skill => skill.sourceInfo.scope === "project" && within(sourceRoot, skill.filePath) && !ignoredPrivate(skill.filePath, sourceRoot))
		.map(skill => ({ path: relative(sourceRoot, skill.filePath), name: skill.name }));
}

function nativeSkills(cwd: string, agentDir: string, paths: string[]): Skill[] {
	// Public native parser, not DefaultResourceLoader.reload(): the latter can provision
	// configured packages and mutate installation state merely to resolve paths.
	return loadSkills({ cwd, agentDir, includeDefaults: false, skillPaths: paths }).skills;
}

/** Discover native guidance without package installation or importing parent conversation state. */
export async function prepareChildGuidance(sourceRoot: string, childRoot: string, inheritSkills: boolean, agentDir = getAgentDir(), homeDir = homedir(), parentSkills?: readonly Skill[], projectSkills?: readonly CapturedProjectSkill[]): Promise<ChildGuidance> {
	const sourceContexts = loadProjectContextFiles({ cwd: sourceRoot, agentDir });
	const childContexts = loadProjectContextFiles({ cwd: childRoot, agentDir }).filter(file => within(childRoot, file.path));
	// Original ancestors precede the child's native repository override; never import managed-storage ancestors.
	const contextFiles = [...sourceContexts.filter(file => !within(sourceRoot, file.path) || (childContexts.length === 0 && sourcePath(file.path, sourceRoot, childRoot) === file.path)), ...childContexts];
	const skillPaths: string[] = [];
	if (inheritSkills) {
		// In a normal Pi turn the already-loaded effective set owns exclusions and
		// precedence; its project file paths are remapped to the captured snapshot.
		// Direct service callers without that set use non-provisioning native parsing.
		const snapshotProject = projectSkills?.map(skill => ({ filePath: join(sourceRoot, skill.path), name: skill.name })) ?? [];
		const discovered = parentSkills === undefined ? [
			...(projectSkills === undefined ? nativeSkills(childRoot, agentDir, [join(childRoot, ".pi", "skills"), join(childRoot, ".agents", "skills")]) : snapshotProject),
			...(projectSkills === undefined ? nativeSkills(sourceRoot, agentDir, [join(sourceRoot, ".pi", "skills"), join(sourceRoot, ".agents", "skills")]) : []),
			...nativeSkills(childRoot, agentDir, [join(agentDir, "skills"), join(homeDir, ".agents", "skills")]),
		] : [
			...snapshotProject,
			...parentSkills.filter(skill => skill.sourceInfo.scope !== "temporary" && !(projectSkills !== undefined && skill.sourceInfo.scope === "project" && within(sourceRoot, skill.filePath) && !ignoredPrivate(skill.filePath, sourceRoot))),
		];
		const names = new Set<string>();
		for (const skill of discovered) {
			if (names.has(skill.name)) continue;
			const mappedFile = sourcePath(skill.filePath, sourceRoot, childRoot);
			if (!mappedFile) continue;
			const mapped = basename(mappedFile) === "SKILL.md" ? dirname(mappedFile) : mappedFile;
			const owner = await realpath(mapped); // CLI catalog and guard both use the pinned installed owner.
			if (!skillPaths.includes(owner)) { skillPaths.push(owner); names.add(skill.name); }
		}
	}
	const readRoots = [...new Set([...contextFiles.map(file => file.path), ...skillPaths.map(path => statSync(path).isFile() ? dirname(path) : path)])];
	const physicalRoots: string[] = [];
	for (const path of readRoots) {
		if (!isAbsolute(path) || resolve(path) !== path) throw new Error("guidance path must be absolute");
		physicalRoots.push(await realpath(path)); // Pin the selected symlink owner for each episode.
	}
	return { contextFiles, skillPaths, readRoots, physicalRoots };
}
