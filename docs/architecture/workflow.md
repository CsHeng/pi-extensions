# Pi Task Tracking

`extensions/workflow/index.ts` registers `csheng_workflow`, an optional Pi task list for progress, observation, focus and recovery. It works without `agent-skills` and with other implementation or workflow Skills. Its presence does not require using it. Pi owns the model/tool loop; the main agent owns the user's requirements, task meaning, verification, review decisions and delivery acceptance.

Adding or removing this extension must not change business acceptance, necessary checks or review scope. A recorded task is a revisable representation of the work, not an extra user obligation. Tool success, subagent completion and source apply never automatically mark tasks done. The main agent marks a task done when the work meets the user's completion criteria based on available evidence. It records that judgment directly; the tool requires no structured attempt, fact, evidence-id, requirement-judgment or delivery-judgment receipt.

## Tool Interface

| Operation | Inputs and behavior |
| --- | --- |
| `set` | `goal` and the complete `tasks` list. Explicitly creates or replaces the list, including revising decomposition or removing unnecessary inferred steps. Each task needs `id` and `title`; omitted status defaults to `todo`. |
| `update` | Patches existing task ids atomically through `tasks`; may also revise `goal`. Change title, status or note. Use `set` to add or remove tasks. |
| `inspect` | Reads current state, any recovery diagnostic and the latest ephemeral tool observation. |
| `pause` | Requires the actual `reason`; pauses the list while preserving unfinished work and allowing ordinary task updates. It does not stop shell or subagent executions. |
| `resume` | Explicitly resumes a paused list after the main agent reconciles current work and authority. It adds no new permission. |
| `cancel` | Cancels unfinished items, preserving already-done items. A cancelled list cannot resume; an explicit `set` can record newly authorized work. |

Task statuses are `todo`, `doing`, `blocked`, `done` and `cancelled`. A blocked task requires a note naming the actual blocker; the main agent can change it back when resolved. `note: null` clears a note. Task ids must be unique; an update cannot repeat an id or refer to an unknown one. A set has at most 100 tasks, with bounded ids, titles and notes.

All-done lists display done. Cancelled work remains visible and distinct: mixed done/cancelled lists close without claiming that every item completed. An empty list does not imply completed business delivery. Independent todo/doing items remain actionable when another item is blocked.

```json
{
  "operation": "set",
  "goal": "Adjust the project environment",
  "tasks": [
    { "id": "config", "title": "Update project defaults" },
    { "id": "integration", "title": "Confirm affected entrypoints" }
  ]
}
```

```json
{
  "operation": "update",
  "tasks": [
    { "id": "config", "status": "done", "note": "Defaults updated" },
    { "id": "integration", "status": "doing" }
  ]
}
```

These items and notes are examples of the main agent's chosen work, not mandatory phases, tests or reports. Tracking updates should be useful progress records; a tracking failure never calls for rerunning a completed business operation to manufacture evidence. Mutation cancellation is scoped to the current tool invocation's AbortSignal, not an earlier provider error or automatic-wake fence. A cancelled write returns `ok: false` with `error.code: "call_cancelled"` and preserves the prior state; inspect remains read-only, and later active invocations may update, resume or cancel normally. Validation and persistence failures are not reported as cancellation.

## Context, Display And Observation

The public `context` hook adds one read-only current-list projection and replaces earlier projections of its own type. It includes at most twelve tasks, prioritizes unfinished work, bounds titles/notes and points to inspect when more items exist. This keeps the current list visible after compaction or recovery without imposing input-alignment acknowledgments. The projection conveys no new authority.

`extensions/tasks-ui/` owns the read-only TUI view. Workflow publishes a minimal owner-scoped snapshot on the extension event bus after state is committed; it does not render the widget or import the view. The bottom line appears when the session has a published task list, unless the user has toggled it hidden. It uses the same collapsed summary as the other above-editor panels. The expanded section preserves the goal, notes, task rows, state variants and bounded overflow of the Tasks renderer. `/tasks-ui list` remains a separate full-list action in a central read-only overlay; it does not change bottom-section visibility. Bare toggle and explicit show/hide commands report the resulting on/off state. `/tasks-ui` is the canonical view command; `/workflow-ui` remains a compatibility alias for show, hide, list, and toggle. A fullscreen header click toggles only Tasks' inline expansion without opening a dialog or taking editor focus. `/tasks-ui expand` and `/tasks-ui collapse` provide the same controls without a mouse. Tasks, Jobs and Subagents maintain independent folding and visibility even though they share one above-editor widget; manual hiding and fold choices survive later updates. Headless modes mount no widget and do not disable the workflow tool. Display failures cannot roll back a committed task update.

The latest non-workflow tool name and failure flag are observed in memory and exposed through inspect/context. This is execution feedback, not certified evidence or a completion gate. No source hashing, filesystem scope inventory, observation binding, assertion parsing or automatic task acceptance occurs.

## Continuation And Interruption

Workflow publishes the committed task list and does not schedule a model wake. [Loop notifications](loop-notifications.md) may continue an active unpaused todo/doing list once after settlement, and only when no retained-shell or subagent execution is unfinished or unknown. That continuation adds no checks or review and does not invoke children or apply candidates. A running execution blocks the task-list continuation; its terminal is still delivered.

An unchanged list, a note-only update, inspect, and tool observations do not renew a consumed opportunity. A real task change or new interactive/RPC input can permit another one. Paused, cancelled, all-terminal and wholly blocked lists do not renew. Print/JSON modes do not renew.

A real host abort or an unrecovered provider failure pauses unfinished tracking. The notification fence is attempt-local. A recovered normal completion is not marked interrupted solely because an earlier attempt failed. Replayed accepted receipts are not live executions. Workflow never turns execution events into task completion.

If only event-dependent work remains, the model may end the turn with tasks unfinished. Ending a turn is not task completion and does not require a fabricated blocker, a tracking pause, or a list update.

## Persistence And Recovery

Each changed list is appended as a schema-v5 `csheng-workflow-state` snapshot before replacing its in-memory state. A failed append preserves the prior record and returns a tracking error. Read-only observations are not persisted. Reminder disposition belongs to loop-notifications and is not a second policy in the task snapshot. A historical `remindedRevision` field remains readable and is not migrated.

On session/branch recovery, unfinished current-version tasks remain inspectable and visible but start paused. The main agent reconciles present intent and may resume. Recovery does not replay business operations, restart children or infer permission.

Only the latest workflow snapshot is considered. Unsupported older completion-contract snapshots and malformed latest snapshots are ignored with an explicit diagnostic; no older snapshot is silently substituted. There is no legacy acceptance reader, migration engine or claim that old work completed. `set` records the current list explicitly. Removing the extension leaves inert history.

## Verification Ownership

Focused store tests cover task creation, revision, completion, blockers, cancellation, no-op updates, persistence failure and safe recovery. UI tests cover visible statuses, cancelled counts, clipping, terminal sanitization and read-only controls. Synthetic-host tests cover ordinary work without tracking, current context projection, bounded continuation, public settlement ordering and asynchronous executor coexistence. Recovery regressions exercise provider error followed by internal retry, legal task mutation/control and normal settlement, alongside genuine cancellation and unrecovered failure protection. Provider-schema tests use injected offline transports. Installed-host and TUI probes remain explicit integration lanes; they do not establish live-model adherence or delivery acceptance.

Product source changes do not update the copied daily package or an already running Pi process. Publication, restart/load and any live effectiveness measurement remain separate authorized actions.
