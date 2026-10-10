import { AccessError, declaredScopes, normalizeAccess, type NormalizedAccessPath, type TaskRoot } from "./access.ts";
import { isProductId } from "./identity.ts";
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
const SAFE_LOCK = /^[a-z0-9][a-z0-9._:/-]{0,127}$/;

export interface NormalizedTask extends SubagentTask {
	access: Array<{ permission: "read" | "write"; scope: string[] }>;
	grants: NormalizedAccessPath[];
	/** Admission-only root bindings; stored separately from the model-authored task. */
	roots?: TaskRoot[];
	inputs: string[];
	dependsOn: string[];
	verification: string[];
	resourceLocks: string[];
}

export type GraphValidation =
	| { ok: true; tasks: NormalizedTask[] }
	| { ok: false; error: TaskError };

function fail(code: string, message: string): GraphValidation {
	return { ok: false, error: { code, message } };
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
		if (!isProductId(task.id) || task.id.length > 64) return fail("invalid_task_id", `Task at index ${index} has an invalid id.`);
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
		const inputs = task.inputs ?? [];
		if (utf8Bytes(inputs.join("")) > HARD_LIMITS.maxInputBytes) {
			return fail("input_too_large", `Task ${task.id} inputs exceed the byte limit.`);
		}
		let grants: NormalizedAccessPath[];
		try {
			if (!Array.isArray(task.access) || task.access.length < 1 || task.access.length > 32) throw new AccessError("invalid_access", "Access requires one through 32 rules.");
			for (const rule of task.access) {
				const scopes = declaredScopes(rule.scope);
				if (scopes.length > 32 || scopes.some((entry) => !isSafePathGrammar(entry))) throw new AccessError("invalid_access", "Access scope must contain only safe path strings.");
			}
			grants = normalizeAccess(task.access);
		} catch (error) {
			const code = error instanceof AccessError ? error.code : "invalid_access";
			return fail(code, `Task ${task.id} access is invalid. Use absolute paths; * needs an explicit finite universe.`);
		}
		if (grants.length > 32) return fail("invalid_access", `Task ${task.id} exceeds the access path limit.`);
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
			access: task.access.map((rule) => ({ permission: rule.permission, scope: declaredScopes(rule.scope) })),
			grants,
			inputs: [...inputs],
			dependsOn: [...dependsOn],
			verification: [...(task.verification ?? [])],
			resourceLocks: [...resourceLocks],
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

	// Access grants are the capability. Explicit resourceLocks serialize shared destinations; disjoint roots overlap.

	return { ok: true, tasks: normalized };
}

export function validateGraphRelationships(tasks: readonly NormalizedTask[]): GraphValidation {
	return { ok: true, tasks: [...tasks] };
}
