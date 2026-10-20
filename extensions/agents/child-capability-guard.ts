import { createHash } from "node:crypto";
import { recordCapabilityInvalidation, registerObservationHooks } from "./observation-hooks.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CHILD_MARKER_ENV } from "./contracts.ts";
import { authorizePath, loadCapability } from "./path-policy.ts";
import { GIT_READ_TOOL, registerGitRead } from "./git-read.ts";
import { getManagedRole, toolsForAccess } from "./roles.ts";
import { isNativePathTool, isNativeShellTool } from "./native-context.ts";

function requestedPath(toolName: string, input: unknown): string | undefined {
	if (typeof input !== "object" || input === null) return undefined;
	const record = input as Record<string, unknown>;
	const value = record.path ?? record.file_path;
	if (typeof value === "string") return value;
	if (toolName === "grep" || toolName === "find" || toolName === "ls") return ".";
	return undefined;
}

export default async function childCapabilityGuard(pi: ExtensionAPI): Promise<void> {
	if (process.env[CHILD_MARKER_ENV] !== "1") return;
	const loaded = await loadCapability();
	let fatalReason = loaded.error;
	let failureRecorded = false;
	const recordFailure = (): void => {
		if (!failureRecorded) { recordCapabilityInvalidation(pi); failureRecorded = true; }
	};
	registerObservationHooks(pi, { child: true, capabilityKey: loaded.manifest ? createHash("sha256").update(JSON.stringify(loaded.manifest)).digest("hex") : null });
	if (loaded.manifest) registerGitRead(pi, loaded.manifest);
	if (loaded.manifest) pi.on("before_agent_start", event => {
		// Let Pi discover APPEND_SYSTEM.md before adding the child role.
		event.systemPromptOptions.appendSystemPrompt = [event.systemPromptOptions.appendSystemPrompt, getManagedRole(loaded.manifest!.role, loaded.manifest!.grants.some(grant => grant.permission === "write")).systemPrompt].filter(Boolean).join("\n\n");
		// The original project's ancestor chain replaces managed-storage ancestors; the
		// snapshot file is already selected by the native loader's override precedence.
		if (loaded.manifest!.guidance) event.systemPromptOptions.contextFiles = loaded.manifest!.guidance!.contextFiles;
	});

	pi.on("tool_call", async (event) => {
		if (!loaded.manifest || fatalReason) {
			recordFailure();
			return { block: true, terminate: true, reason: fatalReason ?? "Child capability is unavailable." };
		}
		// The typed tool checks all repository/path/revision inputs itself on every execution.
		const granted = new Set(toolsForAccess(loaded.manifest.grants.some(grant => grant.permission === "write")));
		if (isNativeShellTool(event.toolName)) {
			// A read or write grant keeps the cooperative host shell; it is not a path grant.
			return undefined;
		}
		if (event.toolName === GIT_READ_TOOL) {
			if (!granted.has(event.toolName)) return { block: true, terminate: false, reason: `Tool ${event.toolName} is outside the granted capability.` };
			return undefined;
		}
		if (!isNativePathTool(event.toolName)) {
			// Configured extension, MCP and custom tools are eligible because the effective
			// host catalog exposes them. This is a trusted host, not an OS sandbox.
			return undefined;
		}
		if (!granted.has(event.toolName)) {
			return { block: true, terminate: false, reason: `Tool ${event.toolName} is outside the granted capability.` };
		}
		const path = requestedPath(event.toolName, event.input);
		if (path === undefined) return { block: true, terminate: false, reason: `Tool ${event.toolName} did not provide a path.` };
		const decision = await authorizePath(loaded.manifest, event.toolName, path);
		if (!decision.allowed) {
			if (decision.fatal) {
				fatalReason = decision.reason ?? "Child capability is unavailable.";
				recordFailure();
			}
			return { block: true, terminate: decision.fatal === true, reason: decision.reason ?? "Path denied." };
		}
		return undefined;
	});
}
