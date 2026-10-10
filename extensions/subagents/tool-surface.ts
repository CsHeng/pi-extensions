/** Parent-visible tool declaration text, shared by tool registration and the delegation probe lane. */

export const SUBAGENT_TOOL_DESCRIPTION = "Submit bounded session-owned asynchronous tasks; accepted receipts are not completed work. One logical session may read and write multiple repositories through explicit access grants. Writable Git roots are prepared in isolated worktrees and frozen as one candidate bundle. Inspect/join terminal evidence, explicitly apply that bundle, refresh idle input, cancel, continue, close, or later discard retained resources. Trusted host tools are not an OS sandbox.";

export const SUBAGENT_TOOL_PROMPT_SNIPPET = "Submit async explorer/reviewer/worker tasks; join/inspect, refresh, cancel, apply and close explicitly; parent owns acceptance.";

export const SUBAGENT_TOOL_PROMPT_GUIDELINES: readonly string[] = [
	"Use a flat batch for independent tasks. A submission receipt means accepted, not completed. Continue useful parent work; join only at a real dependency. No polling loop. Print mode is foreground; mode=foreground is available in interactive/RPC hosts.",
	"Declare access as read or write grants over absolute paths. A scalar path and a one-item list are the same grant. Write includes read. Role and child identity do not grant or remove tools. One task may write several Git roots. * is rejected unless a finite enclosing scope is explicit. Refresh input explicitly while idle. No automatic apply, acceptance, retry or recovery.",
	"Pass returned handles, candidate ids and run ids unchanged. Do not add prefixes or encode episode in an id. Close retains or discards explicitly; a later discard releases a retained session. Unsupported older records are excluded, not migrated. Cancellation uses runId and taskId; freeze-critical cancellation is too late.",
];
