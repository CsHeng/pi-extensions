/** Parent-visible tool declaration text, shared by tool registration and the delegation probe lane. */

export const SUBAGENT_TOOL_DESCRIPTION = "Submit bounded session-owned asynchronous tasks; accepted receipts are not completed work. Workers inherit a fixed Git input in an owned linked worktree; optional repository selects one explicitly authorized Git root per worker, otherwise the parent repository. Initial write regions are advisory. Inspect/join terminal evidence, explicitly apply Git candidates, refresh idle input, cancel, continue or close. Trusted host tools are not an OS sandbox.";

export const SUBAGENT_TOOL_PROMPT_SNIPPET = "Submit async explorer/reviewer/worker tasks; join/inspect, refresh, cancel, apply and close explicitly; parent owns acceptance.";

export const SUBAGENT_TOOL_PROMPT_GUIDELINES: readonly string[] = [
	"Use a flat batch for independent tasks. A submission receipt means accepted, not completed. Continue useful parent work; join only at a real dependency. No polling loop. Print mode is foreground; mode=foreground is available in interactive/RPC hosts.",
	"Workers require scope [\".\"] relative to their target. Use repository for an explicitly authorized sibling Git root; it does not grant authority or multi-repository writes. Git candidates contain actual changes, not only initial writePaths. Refresh input explicitly while idle; continue retains the same input, worktree and native history. No automatic apply, acceptance, retry or recovery.",
	"Use the exact returned handle/episode/candidateId. Close unneeded records with explicit retain/discard. Legacy records are inspect/close-only. Task cancellation uses runId and taskId; freeze-critical cancellation is too late.",
];
