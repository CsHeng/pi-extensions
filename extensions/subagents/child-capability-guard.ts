import { createHash } from "node:crypto";
import { registerObservationHooks } from "./observation-hooks.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CHILD_MARKER_ENV } from "./contracts.ts";
import { authorizePath, loadCapability } from "./path-policy.ts";
import { GIT_READ_TOOL, registerGitRead } from "./git-read.ts";

const PATH_TOOLS = new Set(["read", "grep", "find", "ls", "edit", "write"]);

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
	registerObservationHooks(pi, { child: true, capabilityKey: loaded.manifest ? createHash("sha256").update(JSON.stringify(loaded.manifest)).digest("hex") : null });
	if (loaded.manifest) registerGitRead(pi, loaded.manifest);

	pi.on("tool_call", async (event) => {
		if (!loaded.manifest || fatalReason) {
			return { block: true, terminate: true, reason: fatalReason ?? "Child capability is unavailable." };
		}
		// The typed tool checks all repository/path/revision inputs itself on every execution.
		if (event.toolName === GIT_READ_TOOL && loaded.manifest.role !== "worker") return undefined;
		if (!PATH_TOOLS.has(event.toolName)) {
			return { block: true, terminate: false, reason: `Tool ${event.toolName} is outside the child capability.` };
		}
		const path = requestedPath(event.toolName, event.input);
		if (path === undefined) return { block: true, terminate: false, reason: `Tool ${event.toolName} did not provide a path.` };
		const decision = await authorizePath(loaded.manifest, event.toolName, path);
		if (!decision.allowed) {
			if (decision.fatal) fatalReason = decision.reason ?? "Child capability is unavailable.";
			return { block: true, terminate: decision.fatal === true, reason: decision.reason ?? "Path denied." };
		}
		return undefined;
	});
}
