import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CHILD_MARKER_ENV } from "./contracts.ts";
import { authorizePath, loadCapability } from "./path-policy.ts";

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

	pi.on("tool_call", async (event) => {
		if (!loaded.manifest) {
			return { block: true, terminate: true, reason: loaded.error ?? "Child capability is unavailable." };
		}
		if (!PATH_TOOLS.has(event.toolName)) {
			return { block: true, terminate: true, reason: `Tool ${event.toolName} is outside the child capability.` };
		}
		const path = requestedPath(event.toolName, event.input);
		if (path === undefined) return { block: true, terminate: true, reason: `Tool ${event.toolName} did not provide a path.` };
		const decision = await authorizePath(loaded.manifest, event.toolName, path);
		if (!decision.allowed) return { block: true, terminate: true, reason: decision.reason ?? "Path denied." };
		return undefined;
	});
}
