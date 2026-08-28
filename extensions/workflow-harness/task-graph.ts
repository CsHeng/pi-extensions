import { isAbsolute, posix } from "node:path";

export type FormalRole = "design" | "planning" | "implementation" | "none";
export type RecoveryPolicy = "fix-forward" | "guarded-rollback";
export type TaskStatus = "pending" | "active" | "complete" | "blocked";

export interface ReviewPolicy {
	required: boolean;
	reasons: string[];
}

export interface TaskNodeV1 {
	taskId: string;
	description: string;
	dependsOn: string[];
	readPaths: string[];
	writePaths: string[];
	resourceLocks: string[];
	isolation: "controller-checkout" | "isolated-executor";
	verification: string[];
	doneWhen: string[];
	review: ReviewPolicy;
	attemptLimit: number;
	recovery: RecoveryPolicy;
}

export interface TaskGraphV1 {
	schemaVersion: 1;
	graphId: string;
	requestId: string;
	approved: boolean;
	rootFormalRole: FormalRole;
	terminalTaskIds: string[];
	tasks: TaskNodeV1[];
}

export interface TaskProgress {
	status: TaskStatus;
	attempts: number;
}

export type TaskProgressMap = Record<string, TaskProgress>;

export class GraphError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
const GLOB = /[*?\[\]{}]/;

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
		throw new GraphError("unknown-field", `${label} must contain exactly ${expected.join(", ")}`);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown, label: string, allowEmpty = true): string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
		throw new GraphError("invalid-field", `${label} must be a string array`);
	}
	if (!allowEmpty && value.length === 0) {
		throw new GraphError("invalid-field", `${label} must not be empty`);
	}
	if (new Set(value).size !== value.length) {
		throw new GraphError("duplicate-value", `${label} contains duplicates`);
	}
	return [...value];
}

function safePath(reference: string, label: string): string {
	if (
		!reference ||
		isAbsolute(reference) ||
		reference.includes("\\") ||
		reference.includes("\0") ||
		GLOB.test(reference) ||
		reference.split("/").some((part) => !part || part === "." || part === "..")
	) {
		throw new GraphError("unsafe-path", `${label} contains unsafe path: ${reference}`);
	}
	return posix.normalize(reference);
}

function refsOverlap(left: readonly string[], right: readonly string[]): boolean {
	return left.some((a) => right.some((b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)));
}

function parseReview(value: unknown, taskId: string): ReviewPolicy {
	if (!isRecord(value)) throw new GraphError("invalid-review", `${taskId} review must be an object`);
	exactKeys(value, ["required", "reasons"], `${taskId} review`);
	if (typeof value.required !== "boolean") {
		throw new GraphError("invalid-review", `${taskId} review.required must be boolean`);
	}
	const reasons = strings(value.reasons, `${taskId} review.reasons`);
	if (value.required !== (reasons.length > 0)) {
		throw new GraphError("invalid-review", `${taskId} review requirement and reasons disagree`);
	}
	return { required: value.required, reasons };
}

function parseTask(value: unknown): TaskNodeV1 {
	if (!isRecord(value)) throw new GraphError("invalid-task", "task must be an object");
	exactKeys(
		value,
		[
			"attemptLimit",
			"dependsOn",
			"description",
			"doneWhen",
			"isolation",
			"readPaths",
			"recovery",
			"resourceLocks",
			"review",
			"taskId",
			"verification",
			"writePaths",
		],
		"task",
	);
	if (typeof value.taskId !== "string" || !SAFE_TOKEN.test(value.taskId)) {
		throw new GraphError("invalid-task-id", "taskId is invalid");
	}
	if (typeof value.description !== "string" || !value.description.trim()) {
		throw new GraphError("invalid-task", `${value.taskId} description is required`);
	}
	if (value.isolation !== "controller-checkout" && value.isolation !== "isolated-executor") {
		throw new GraphError("invalid-isolation", `${value.taskId} isolation is invalid`);
	}
	if (value.recovery !== "fix-forward" && value.recovery !== "guarded-rollback") {
		throw new GraphError("invalid-recovery", `${value.taskId} recovery is invalid`);
	}
	if (!Number.isInteger(value.attemptLimit) || (value.attemptLimit as number) < 1 || (value.attemptLimit as number) > 2) {
		throw new GraphError("invalid-attempt-limit", `${value.taskId} attemptLimit must be 1 or 2`);
	}
	const readPaths = strings(value.readPaths, `${value.taskId} readPaths`).map((item) => safePath(item, value.taskId as string));
	const writePaths = strings(value.writePaths, `${value.taskId} writePaths`).map((item) => safePath(item, value.taskId as string));
	if (refsOverlap(readPaths, writePaths)) {
		throw new GraphError("scope-overlap", `${value.taskId} read and write paths overlap`);
	}
	return {
		taskId: value.taskId,
		description: value.description,
		dependsOn: strings(value.dependsOn, `${value.taskId} dependsOn`),
		readPaths,
		writePaths,
		resourceLocks: strings(value.resourceLocks, `${value.taskId} resourceLocks`),
		isolation: value.isolation,
		verification: strings(value.verification, `${value.taskId} verification`, false),
		doneWhen: strings(value.doneWhen, `${value.taskId} doneWhen`, false),
		review: parseReview(value.review, value.taskId),
		attemptLimit: value.attemptLimit as number,
		recovery: value.recovery,
	};
}

function dependencyClosure(tasks: readonly TaskNodeV1[], taskId: string): Set<string> {
	const byId = new Map(tasks.map((task) => [task.taskId, task]));
	const result = new Set<string>();
	const visit = (current: string): void => {
		for (const dependency of byId.get(current)?.dependsOn ?? []) {
			if (!result.has(dependency)) {
				result.add(dependency);
				visit(dependency);
			}
		}
	};
	visit(taskId);
	return result;
}

export function admitTaskGraph(value: unknown): TaskGraphV1 {
	if (!isRecord(value)) throw new GraphError("invalid-graph", "graph must be an object");
	exactKeys(
		value,
		["approved", "graphId", "requestId", "rootFormalRole", "schemaVersion", "tasks", "terminalTaskIds"],
		"graph",
	);
	if (value.schemaVersion !== 1) throw new GraphError("unsupported-version", "graph schema version must be 1");
	if (typeof value.graphId !== "string" || !SAFE_TOKEN.test(value.graphId)) throw new GraphError("invalid-graph-id", "graphId is invalid");
	if (typeof value.requestId !== "string" || !SAFE_TOKEN.test(value.requestId)) throw new GraphError("invalid-request-id", "requestId is invalid");
	if (typeof value.approved !== "boolean") throw new GraphError("invalid-approval", "approved must be boolean");
	if (!["design", "planning", "implementation", "none"].includes(value.rootFormalRole as string)) {
		throw new GraphError("invalid-formal-role", "rootFormalRole is invalid");
	}
	if (!Array.isArray(value.tasks) || value.tasks.length === 0) throw new GraphError("invalid-graph", "tasks must not be empty");
	const tasks = value.tasks.map(parseTask);
	const taskIds = tasks.map((task) => task.taskId);
	if (new Set(taskIds).size !== taskIds.length) throw new GraphError("duplicate-task", "task IDs must be unique");
	const known = new Set(taskIds);
	for (const task of tasks) {
		if (task.dependsOn.includes(task.taskId) || task.dependsOn.some((item) => !known.has(item))) {
			throw new GraphError("invalid-dependency", `${task.taskId} dependencies are invalid`);
		}
	}

	const visiting = new Set<string>();
	const visited = new Set<string>();
	const byId = new Map(tasks.map((task) => [task.taskId, task]));
	const visit = (taskId: string): void => {
		if (visiting.has(taskId)) throw new GraphError("cycle", "task graph contains a cycle");
		if (visited.has(taskId)) return;
		visiting.add(taskId);
		for (const dependency of byId.get(taskId)?.dependsOn ?? []) visit(dependency);
		visiting.delete(taskId);
		visited.add(taskId);
	};
	for (const taskId of taskIds) visit(taskId);

	const terminalTaskIds = strings(value.terminalTaskIds, "terminalTaskIds", false);
	if (terminalTaskIds.some((taskId) => !known.has(taskId))) throw new GraphError("invalid-terminal", "terminal task is unknown");
	const reachable = new Set(terminalTaskIds);
	for (const terminal of terminalTaskIds) for (const dependency of dependencyClosure(tasks, terminal)) reachable.add(dependency);
	if (tasks.some((task) => !reachable.has(task.taskId))) throw new GraphError("unreachable-task", "task is not required by a terminal");

	for (let leftIndex = 0; leftIndex < tasks.length; leftIndex += 1) {
		const left = tasks[leftIndex];
		if (!left) continue;
		for (let rightIndex = leftIndex + 1; rightIndex < tasks.length; rightIndex += 1) {
			const right = tasks[rightIndex];
			if (!right) continue;
			const ordered = dependencyClosure(tasks, left.taskId).has(right.taskId) || dependencyClosure(tasks, right.taskId).has(left.taskId);
			if (ordered) continue;
			if (refsOverlap(left.writePaths, right.writePaths) || left.resourceLocks.some((lock) => right.resourceLocks.includes(lock))) {
				throw new GraphError("unordered-conflict", `${left.taskId} and ${right.taskId} conflict without an ordering edge`);
			}
		}
	}

	return {
		schemaVersion: 1,
		graphId: value.graphId,
		requestId: value.requestId,
		approved: value.approved,
		rootFormalRole: value.rootFormalRole as FormalRole,
		terminalTaskIds,
		tasks,
	};
}

export function initialProgress(graph: TaskGraphV1): TaskProgressMap {
	return Object.fromEntries(graph.tasks.map((task) => [task.taskId, { status: "pending", attempts: 0 }]));
}

export function readyTasks(graph: TaskGraphV1, progress: TaskProgressMap): TaskNodeV1[] {
	if (!graph.approved) return [];
	const active = graph.tasks.find((task) => progress[task.taskId]?.status === "active");
	if (active) return [];
	const first = graph.tasks.find(
		(task) => progress[task.taskId]?.status === "pending" && task.dependsOn.every((dependency) => progress[dependency]?.status === "complete"),
	);
	return first ? [first] : [];
}

export function graphIsTerminal(graph: TaskGraphV1, progress: TaskProgressMap): boolean {
	return graph.terminalTaskIds.every((taskId) => progress[taskId]?.status === "complete");
}
