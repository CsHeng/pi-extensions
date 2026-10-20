/** Capability and operation guidance shared by tool registration and the delegation probe lane. */

export const SUBAGENT_TOOL_DESCRIPTION = "Delegate bounded work to a separate agent context and operate the resulting Agents. create takes tasks with a role, an objective, a readable label and explicit access; independent tasks may run in parallel, and each writable Git root is prepared in an isolated worktree that yields one candidate bundle. inspect alone lists this session's Agents and the handles needed to act on them; join waits for one run within a bounded observation budget. An accepted receipt means submitted, not completed. Evaluate the report before choosing apply, continue or close, and cancel work you no longer need. Trusted host tools run with host privileges; access grants are not an OS sandbox.";

export const SUBAGENT_TOOL_PROMPT_SNIPPET = "Delegate bounded tasks to separate agent contexts: explorer investigates, reviewer evaluates, worker implements. Declare explicit access, find Agents with a bare inspect, wait with join, and apply, continue or close after evaluating the result.";

export const SUBAGENT_TOOL_PROMPT_GUIDELINES: readonly string[] = [
	"Start work with create. An accepted receipt, or an Agent still running, is not completed work: continue independent work or finish the turn, then act on the completion result instead of polling.",
	"Use a bare inspect to recover this session's Agents after resume, compaction or a forgotten handle; it lists handles and their usable results without waiting. inspect with runId or handle and join with runId answer different questions: join waits within its observation budget, and its expiry leaves the run going.",
	"Declare access explicitly as read or write over absolute paths; write includes read, and one task may span several Git roots. Labels are batch-local: unique within one call, reusable by a later call, and only ordering dependencies. Role selects purpose and routing, not permission.",
	"Copy returned handle, candidateId and expectedEpisode values exactly. apply merges one accepted candidate; continue needs a message plus the exact expectedEpisode; cancel names runId and optionally one task handle; close retains or discards owned resources. Unsupported older records stay excluded and unknown outcomes are reported rather than retried automatically.",
];
