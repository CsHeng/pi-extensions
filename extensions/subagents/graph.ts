import { isAbsolute, normalize, relative, sep } from "node:path";
import type { RepositoryTarget } from "./repository-policy.ts";
import {
	EXECUTION_PROFILES,
	HARD_LIMITS,
	REASONING_PROFILES,
	ROLE_NAMES,
	isSafePathGrammar,
	utf8Bytes,
	type ExecutionProfile,
	type ReasoningProfile,
	type RoleName,
	type SubagentTask,
	type SubagentToolInput,
	type TaskError,
} from "./contracts.ts";

// Kept local to avoid making filesystem policy depend on graph topology.
const ROLE_SET = new Set<RoleName>(ROLE_NAMES);
const EXECUTION_PROFILE_SET = new Set<ExecutionProfile>(EXECUTION_PROFILES);
const REASONING_PROFILE_SET = new Set<ReasoningProfile>(REASONING_PROFILES);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_LOCK = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export interface NormalizedTask extends SubagentTask {
	/** Admission-only physical identities; stored separately from the model-authored task. */
	externalReadPins?: Array<{ dev: number; ino: number }>;
	repositoryTarget?: RepositoryTarget;
	inputs: string[];
	dependsOn: string[];
	writePaths: string[];
	verification: string[];
	resourceLocks: string[];
}

export type GraphValidation =
	| { ok: true; tasks: NormalizedTask[] }
	| { ok: false; error: TaskError };

function fail(code: string, message: string): GraphValidation {
	return { ok: false, error: { code, message } };
}

export function normalizeRepositoryPath(value: string, allowRoot: boolean): string | undefined {
	if (!value || value.includes("\0") || isAbsolute(value)) return undefined;
	const normalized = normalize(value);
	if (normalized === ".." || normalized.startsWith(`..${sep}`)) return undefined;
	if (!allowRoot && (normalized === "." || normalized === sep)) return undefined;
	return normalized;
}

function pathContains(root: string, child: string): boolean {
	if (root === ".") return true;
	const relation = relative(root, child);
	return relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

function pathsOverlap(left: string, right: string): boolean {
	return pathContains(left, right) || pathContains(right, left);
}

function hasDependencyPath(from: string, to: string, dependencies: ReadonlyMap<string, readonly string[]>): boolean {
	const visited = new Set<string>();
	const stack = [...(dependencies.get(from) ?? [])];
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current || visited.has(current)) continue;
		if (current === to) return true;
		visited.add(current);
		stack.push(...(dependencies.get(current) ?? []));
	}
	return false;
}

export function validateGraphStructure(input: SubagentToolInput): GraphValidation {
	if (!Array.isArray(input.tasks) || input.tasks.length < 1 || input.tasks.length > HARD_LIMITS.maxTasks) {
		return fail("invalid_graph_size", `A graph must contain 1 through ${HARD_LIMITS.maxTasks} tasks.`);
	}

	const ids = new Set<string>();
	const normalized: NormalizedTask[] = [];
	for (const [index, task] of input.tasks.entries()) {
		if (!SAFE_ID.test(task.id)) return fail("invalid_task_id", `Task at index ${index} has an invalid id.`);
		if (ids.has(task.id)) return fail("duplicate_task_id", `Task id ${task.id} is duplicated.`);
		ids.add(task.id);
		if (!ROLE_SET.has(task.role)) return fail("invalid_role", `Task ${task.id} has an unsupported role.`);
		if (!task.objective.trim() || utf8Bytes(task.objective) > HARD_LIMITS.maxObjectiveBytes) {
			return fail("invalid_objective", `Task ${task.id} objective is empty or exceeds the byte limit.`);
		}
		if (task.executionProfile !== undefined && !EXECUTION_PROFILE_SET.has(task.executionProfile)) {
			return fail("invalid_execution_profile", `Task ${task.id} has an unsupported execution profile.`);
		}
		if (task.reasoningProfile !== undefined && !REASONING_PROFILE_SET.has(task.reasoningProfile)) {
			return fail("invalid_reasoning_profile", `Task ${task.id} has an unsupported reasoning profile.`);
		}
		if (task.repository !== undefined && (task.role !== "worker" || !isSafePathGrammar(task.repository) || !isAbsolute(task.repository))) {
			return fail("invalid_task_repository", `Task ${task.id} repository requires an explicitly authorized absolute worker Git root.`);
		}
		const inputs = task.inputs ?? [];
		if (utf8Bytes(inputs.join("")) > HARD_LIMITS.maxInputBytes) {
			return fail("input_too_large", `Task ${task.id} inputs exceed the byte limit.`);
		}
		if (task.scope.length < 1 || task.scope.some((entry) => !isSafePathGrammar(entry))) {
			return fail("invalid_scope", `Task ${task.id} scope must contain only safe path strings. Prefer repository-relative paths and '.'.`);
		}
		const externalReadRoots = [...(task.externalReadRoots ?? [])];
		if (externalReadRoots.length > HARD_LIMITS.maxExternalReadRoots) {
			return fail("invalid_external_read_root", `Task ${task.id} exceeds the external read root limit.`);
		}
		if (externalReadRoots.some((entry) => !isSafePathGrammar(entry) || !isAbsolute(entry))) {
			return fail("invalid_external_read_root", `Task ${task.id} external read root must be an absolute safe path.`);
		}
		const writePaths = (task.writePaths ?? []).map((entry) => isSafePathGrammar(entry) ? normalizeRepositoryPath(entry, false) : undefined);
		if (writePaths.some((entry) => entry === undefined)) {
			return fail("invalid_write_path", `Task ${task.id} has an unsafe write path.`);
		}
		const safeWrites = writePaths as string[];
		if (task.role !== "worker" && safeWrites.length > 0) {
			return fail("read_only_write_paths", `Read-only task ${task.id} cannot declare write paths.`);
		}
		if (new Set(safeWrites).size !== safeWrites.length) {
			return fail("duplicate_write_path", `Task ${task.id} repeats a write path.`);
		}
		const dependsOn = task.dependsOn ?? [];
		if (new Set(dependsOn).size !== dependsOn.length || dependsOn.includes(task.id)) {
			return fail("invalid_dependencies", `Task ${task.id} has duplicate or self dependencies.`);
		}
		const resourceLocks = task.resourceLocks ?? [];
		if (resourceLocks.some((lock) => !SAFE_LOCK.test(lock)) || new Set(resourceLocks).size !== resourceLocks.length) {
			return fail("invalid_resource_lock", `Task ${task.id} has an invalid or duplicate resource lock.`);
		}
		const projectedPrompt = utf8Bytes(task.objective) + utf8Bytes(inputs.join("")) + dependsOn.length * HARD_LIMITS.maxPredecessorOutputBytes;
		if (projectedPrompt > HARD_LIMITS.maxPromptBytes) {
			return fail("prompt_too_large", `Task ${task.id} projected prompt exceeds the byte limit.`);
		}
		normalized.push({
			...task,
			scope: [...task.scope],
			inputs: [...inputs],
			dependsOn: [...dependsOn],
			writePaths: safeWrites,
			verification: [...(task.verification ?? [])],
			resourceLocks: [...resourceLocks],
			externalReadRoots,
		});
	}

	for (const task of normalized) {
		const unknown = task.dependsOn.find((dependency) => !ids.has(dependency));
		if (unknown) return fail("unknown_dependency", `Task ${task.id} depends on unknown task ${unknown}.`);
	}

	const dependencies = new Map(normalized.map((task) => [task.id, task.dependsOn] as const));
	for (const task of normalized) {
		if (hasDependencyPath(task.id, task.id, dependencies)) {
			return fail("dependency_cycle", `Task graph contains a cycle involving ${task.id}.`);
		}
	}

	// Initial write regions are planning hints. Each managed task owns an
	// independent Git worktree; only explicit resourceLocks serialize execution.

	return { ok: true, tasks: normalized };
}

export function validateGraphRelationships(tasks: readonly NormalizedTask[]): GraphValidation {
	for (const task of tasks) {
		if (task.writePaths.some((writePath) => !task.scope.some((root) => pathContains(root, writePath)))) {
			return fail("write_outside_scope", `Task ${task.id} declares a write outside its read scope.`);
		}
	}
	return { ok: true, tasks: [...tasks] };
}
