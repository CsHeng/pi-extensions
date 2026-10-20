/**
 * Native Pi tool classification for child processes.
 *
 * The extension does not own a second tool catalog. Pi's native resource loader and
 * the effective configured host catalog decide which extension, MCP and custom tools
 * reach a child. This module only identifies the native builtin tools whose inputs are
 * filesystem paths (and therefore remain subject to the explicit capability manifest)
 * and expresses explicit read-only intent without turning the selection into an allowlist.
 */

/** Native builtin tools whose primary input is a filesystem path. */
export const NATIVE_PATH_TOOLS = Object.freeze(["read", "grep", "find", "ls", "edit", "write"] as const);

/** Native path tools that mutate content; an explicit read grant removes them from the declared catalog. */
export const NATIVE_WRITE_TOOLS = Object.freeze(["edit", "write"] as const);

/** Native cooperative shell tools. A read or write grant keeps them; neither is a path grant. */
export const NATIVE_SHELL_TOOLS = Object.freeze(["bash", "powershell"] as const);

const PATH_TOOL_SET: ReadonlySet<string> = new Set(NATIVE_PATH_TOOLS);
const SHELL_TOOL_SET: ReadonlySet<string> = new Set(NATIVE_SHELL_TOOLS);

export function isNativePathTool(toolName: string): boolean {
	return PATH_TOOL_SET.has(toolName);
}

export function isNativeShellTool(toolName: string): boolean {
	return SHELL_TOOL_SET.has(toolName);
}

/**
 * Express explicit read-only intent as Pi's native exclude list for the mutating builtins.
 * A write grant adds no ceiling. The result is never an allowlist, so configured extension,
 * MCP and custom tools stay exactly as the host configured them.
 */
export function readOnlyToolArgs(write: boolean): string[] {
	return write ? [] : ["--exclude-tools", NATIVE_WRITE_TOOLS.join(",")];
}
