# Retained shell

`extensions/retained-shell/index.ts` is the TUI/RPC retained execution path for Pi's builtin `bash` tool. It does not replace the host agent loop. A terminal that the tool call itself does not return is delivered once, on an idle wake or the next model request.

## Owner

Pi's builtin `bash`, created through `createBashTool` / `createLocalBashOperations`, waits until the process exits; its timeout and abort kill the process. The extension detects the effective tool source at runtime rather than treating workstation configuration as product truth. PowerShell, MCP tools, and any extension that has already registered `bash` are outside this path.

The extension claims `bash` only when the merged tool source is still `builtin` and the session mode is `tui` or `rpc`. Print and JSON keep the native draining tool, with its native `timeout` support. Retained-only parameters are rejected before command effects in these modes; no post-exit wake is promised. A non-builtin `bash` is left in place, and the extension emits one `csheng.shell.execution` event with `phase: "unavailable"`. It does not start a second shell to bypass that owner.

Managed child processes are print/JSON Pi processes. Their shell calls stay on the native draining tool, so this extension does not return `running` from a child tool call or change candidate freeze.

## Execution

A started command gets an execution id, a bounded output tail, and a finite deadline. The id is not a process id. The default deadline is 600 seconds. `timeout` or `deadlineSeconds` selects a different finite deadline, up to Pi's existing timeout ceiling. The deadline kills that same process. It is not a second launch.

A non-background call may stay in the tool call for a short foreground window, default 2 seconds and at most 30. If the command exits in that window, the call returns that terminal result. If it is still running, the call returns `status: running` and the process continues. `background: true` returns as soon as the execution is running. Output collection and the start event begin at spawn, not when the deadline fires.

`action: "inspect"` reads the current execution and does not start a process. `action: "wait"` waits only for that execution, or until `waitSeconds` or the tool abort releases the wait. Releasing the wait does not kill the process. `action: "renew"` moves the deadline of the same running execution. `action: "cancel"` stops it. Host session shutdown stops running executions and records `interrupted`. An ordinary turn settlement does not.

A running call has one tool result. The terminal state is not written back onto that call id. Unknown exit codes stay unknown and are not reported as 0. Cancel, deadline, and shutdown settle when the process and its pipes close, so already-written output is not dropped at the kill call. Observer failures do not fail or strand the execution. An already-aborted start does not spawn. Terminal records are capped and process handles are released after close. Commands and wakes are scoped to the session and branch; a real session or branch switch interrupts the old running owner and keeps that scope's final result inspectable. Idle and compaction do not shut executions down.

## Model delivery

TUI/RPC completion uses the shared wake reservation. Queuing `sendMessage` is not consumption. A fact is consumed when `context_with_system` projects it into request preparation, or when the host emits `tool_execution_end` for a returned `inspect` / `wait` / original terminal result. This is delivery evidence, not proof of provider success or model understanding. A terminal that arrives before that return does not also wake. A busy run projects the terminal onto the next request and does not append it to the in-flight request. An idle main gets one wake. A co-loaded workflow reminder merges into that reserved turn instead of starting a second model. Abort, provider error, user input, and session or branch switch drop a queued wake without acknowledging it and without a hidden retry. The fact stays inspectable. Print/JSON and an unclaimed bash owner do not wake.

The event `version` is 1. Fields are `executionId`, `owner` (`pi-bash`), `sessionId`, `branchAnchor`, `toolCallId`, `phase`, `status`, `exitCode`, `deadlineAt`, `truncated`, `outputTail`, and `notification`. Terminal notifications are `idle-wake-or-next-request`. `started` and `renewed` are `not-a-completion`. `unavailable` uses `wake-unavailable` and means this process did not claim bash. Live output remains on `inspect`; the event is not sent per output line.

## Removal

Removing the extension restores builtin bash for later sessions. The host must run session shutdown before unloading an active owner; shutdown awaits its owned process/pipe closure. Stopped executions need no further kill, and unrelated processes are not targeted. No migration or user setting is required.
