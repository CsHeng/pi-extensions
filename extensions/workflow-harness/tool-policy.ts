import { isAbsolute, relative, resolve, sep } from "node:path";
import { existsSync, lstatSync, realpathSync } from "node:fs";

import { authorityMatches, type ExactUserAuthority } from "./authority.ts";
import type { LifecycleState, ObservedOperation } from "./session-state.ts";
import type { TaskNodeV1 } from "./task-graph.ts";

export type CapabilityKind = "read-only" | "path-mutation" | "shell" | "mixed";

export interface ToolCapability {
	name: string;
	kind: CapabilityKind;
	pathFields: string[];
}

export const DEFAULT_CAPABILITIES: readonly ToolCapability[] = [
	{ name: "read", kind: "read-only", pathFields: ["path"] },
	{ name: "grep", kind: "read-only", pathFields: ["path"] },
	{ name: "find", kind: "read-only", pathFields: ["path"] },
	{ name: "ls", kind: "read-only", pathFields: ["path"] },
	{ name: "write", kind: "path-mutation", pathFields: ["path"] },
	{ name: "edit", kind: "path-mutation", pathFields: ["path"] },
	{ name: "bash", kind: "shell", pathFields: [] },
	{ name: "apply_patch", kind: "mixed", pathFields: [] },
] as const;

export interface ToolGateContext {
	workspaceRoot: string;
	lifecycle: LifecycleState;
	task?: TaskNodeV1;
	attemptId?: string;
	exactUserAuthority?: ExactUserAuthority;
	capabilities?: readonly ToolCapability[];
}

export interface ToolGateDecision {
	allow: boolean;
	reason?: string;
	operation?: ObservedOperation;
}

const PROTECTED_PARTS = new Set([".git", ".ssh", ".gnupg", "credentials"]);
const PROTECTED_NAMES = /(^|\/)(\.env(?:\.|$)|[^/]*(?:private[-_.]?key|id_rsa|id_ed25519|credentials)[^/]*)$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeWorkspacePath(workspaceRoot: string, candidate: string): string {
	const canonicalWorkspace = realpathSync(workspaceRoot);
	const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(canonicalWorkspace, candidate);
	const local = relative(canonicalWorkspace, absolute);
	if (!local || local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) throw new Error("path escapes the managed workspace");
	let cursor = canonicalWorkspace;
	for (const part of local.split(sep)) {
		cursor = resolve(cursor, part);
		if (!existsSync(cursor)) break;
		if (lstatSync(cursor).isSymbolicLink()) throw new Error("path contains a symbolic-link component");
		const canonical = realpathSync(cursor);
		const canonicalLocal = relative(canonicalWorkspace, canonical);
		if (canonicalLocal === ".." || canonicalLocal.startsWith(`..${sep}`) || isAbsolute(canonicalLocal)) throw new Error("canonical path escapes the managed workspace");
	}
	return local.split(sep).join("/");
}

function pathInScope(path: string, scopes: readonly string[]): boolean {
	return scopes.some((scope) => path === scope || path.startsWith(`${scope}/`));
}

function protectedPath(path: string): boolean {
	return path.split("/").some((part) => PROTECTED_PARTS.has(part)) || PROTECTED_NAMES.test(path);
}

function operationId(attemptId: string, toolName: string, paths: readonly string[]): string {
	return `${attemptId}:${toolName}:${paths.join("|") || "uncontained"}`;
}

export function gateToolCall(toolName: string, input: unknown, context: ToolGateContext): ToolGateDecision {
	const capability = (context.capabilities ?? DEFAULT_CAPABILITIES).find((item) => item.name === toolName);
	if (!capability) return { allow: false, reason: `unknown tool ${toolName} fails closed in managed mode` };
	if (capability.kind === "mixed") return { allow: false, reason: `mixed tool ${toolName} fails closed in managed mode` };
	if (!isRecord(input)) return { allow: false, reason: `${toolName} input must be an object` };

	let paths: string[];
	try {
		paths = capability.pathFields
			.map((field) => input[field])
			.filter((value): value is string => typeof value === "string" && value.length > 0)
			.map((value) => normalizeWorkspacePath(context.workspaceRoot, value));
	} catch (error) {
		return { allow: false, reason: error instanceof Error ? error.message : "invalid tool path" };
	}
	if (paths.some(protectedPath)) return { allow: false, reason: "credential or protected path access is outside managed authority" };

	if (capability.kind === "read-only") return { allow: true };
	if (!context.task || !context.attemptId || context.lifecycle !== "execute") {
		return { allow: false, reason: "mutation requires one harness-admitted active task attempt" };
	}
	if (capability.kind === "path-mutation") {
		if (paths.length !== capability.pathFields.length) return { allow: false, reason: "mutation path is not statically observable" };
		if (paths.some((path) => !pathInScope(path, context.task?.writePaths ?? []))) {
			return { allow: false, reason: "mutation path is outside the admitted task slice" };
		}
		return {
			allow: true,
			operation: {
				operationId: operationId(context.attemptId, toolName, paths),
				attemptId: context.attemptId,
				toolName,
				paths,
				suspendedContainment: false,
			},
		};
	}

	if (!authorityMatches(context.exactUserAuthority, context.task.taskId, toolName, input)) {
		return { allow: false, reason: "shell requires one exact direct user authorization and records suspended containment" };
	}
	return {
		allow: true,
		operation: {
			operationId: operationId(context.attemptId, toolName, []),
			attemptId: context.attemptId,
			toolName,
			paths: [],
			suspendedContainment: true,
		},
	};
}
