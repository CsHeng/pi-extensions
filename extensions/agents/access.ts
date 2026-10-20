import { isAbsolute, relative, resolve, sep } from "node:path";
import { isSafePathGrammar } from "./contracts.ts";

export const ACCESS_PERMISSIONS = ["read", "write"] as const;
export type AccessPermission = (typeof ACCESS_PERMISSIONS)[number];

export interface AccessRule {
	permission: AccessPermission;
	scope: string | string[];
}

export interface NormalizedAccessPath {
	permission: AccessPermission;
	path: string;
}

export interface TaskRoot {
	id: string;
	source: string;
	permission: AccessPermission;
	git: boolean;
	paths: string[];
	/** Prepared worktree for a write root, or the source path for a direct read. */
	path?: string;
	target?: { declared: string; root: string; identities: Array<{ path: string; dev: number; ino: number }> };
	pins?: Array<{ path: string; dev: number; ino: number }>;
}

export class AccessError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "AccessError";
		this.code = code;
	}
}

export function declaredScopes(scope: string | string[]): string[] {
	return typeof scope === "string" ? [scope] : [...scope];
}

export function pathContains(root: string, target: string): boolean {
	const relation = relative(root, target);
	return relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

/**
 * One access grammar. A scalar path and a one-item list are the same grant.
 * Write includes read of that range. Overlapping rules combine.
 * `*` expands only inside an explicit finite universe; otherwise it is rejected.
 */
export function normalizeAccess(rules: readonly AccessRule[], universe?: readonly string[]): NormalizedAccessPath[] {
	if (!Array.isArray(rules) || rules.length < 1) throw new AccessError("invalid_access", "Access requires at least one read or write rule.");
	const collected: Array<{ permission: AccessPermission; path: string }> = [];
	for (const rule of rules) {
		if (!rule || (rule.permission !== "read" && rule.permission !== "write")) throw new AccessError("invalid_access", "Access permission must be read or write.");
		const scopes = declaredScopes(rule.scope);
		if (scopes.length < 1) throw new AccessError("invalid_access", "Access scope must name at least one path.");
		for (const entry of scopes) {
			if (!isSafePathGrammar(entry)) throw new AccessError("invalid_access", "Access scope contains an unsafe path.");
			if (entry === "*") {
				if (!universe?.length) throw new AccessError("unbounded_scope", "The all-selector needs an explicit finite enclosing scope. Name absolute paths instead.");
				for (const path of universe) {
					if (!isAbsolute(path)) throw new AccessError("unbounded_scope", "A bounded all-selector universe must contain absolute paths.");
					collected.push({ permission: rule.permission, path: resolve(path) });
				}
				continue;
			}
			if (!isAbsolute(entry)) throw new AccessError("invalid_access", "Access scope must be an absolute path, or * inside an explicit finite universe.");
			collected.push({ permission: rule.permission, path: resolve(entry) });
		}
	}
	const byPath = new Map<string, AccessPermission>();
	for (const item of collected) {
		const current = byPath.get(item.path);
		byPath.set(item.path, current === "write" || item.permission === "write" ? "write" : "read");
	}
	return [...byPath.entries()].map(([path, permission]) => {
		const coveredByWrite = [...byPath.entries()].some(([other, otherPermission]) => otherPermission === "write" && pathContains(other, path));
		return { path, permission: coveredByWrite ? "write" as const : permission };
	}).sort((left, right) => left.path.localeCompare(right.path));
}

export function sameAccess(left: readonly AccessRule[], right: readonly AccessRule[], universe?: readonly string[]): boolean {
	const a = normalizeAccess(left, universe);
	const b = normalizeAccess(right, universe);
	return a.length === b.length && a.every((item, index) => item.permission === b[index]?.permission && item.path === b[index]?.path);
}
