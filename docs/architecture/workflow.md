# Pi Task Tracking

`extensions/workflow/index.ts` registers `csheng_workflow`, an optional Pi task list for progress, observation, focus, recovery and bounded reminders. It works without `agent-skills` and with other implementation or workflow Skills. Its presence does not require using it. Pi owns the model/tool loop; the main agent owns the user's requirements, task meaning, verification, review decisions and delivery acceptance.

Adding or removing this extension must not change business acceptance, necessary checks or review scope. A recorded task is a revisable representation of the work, not an extra user obligation. Tool success, subagent completion and source apply never automatically mark tasks done. The main agent records its judgment directly; no attempt, fact, evidence id, requirement judgment or delivery judgment is needed to finish a task.

## Tool Interface

| Operation | Inputs and behavior |
| --- | --- |
| `set` | `goal` and the complete `tasks` list. Explicitly creates or replaces the list, including revising decomposition or removing unnecessary inferred steps. Each task needs `id` and `title`; omitted status defaults to `todo`. |
| `update` | Patches existing task ids atomically through `tasks`; may also revise `goal`. Change title, status or note. Use `set` to add or remove tasks. |
| `inspect` | Reads current state, any recovery diagnostic and the latest ephemeral tool observation. |
| `pause` | Requires the actual `reason`; disables reminders while preserving unfinished work and allowing ordinary task updates. |
| `resume` | Explicitly resumes a paused list after the main agent reconciles current work and authority. It adds no new permission. |
| `cancel` | Cancels unfinished items and disables reminders, preserving already-done items. A cancelled list cannot resume; an explicit `set` can record newly authorized work. |

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

The TUI widget appears when a list or recovery diagnostic exists. It displays the goal, done/cancelled counts and task statuses, uses dim strikethrough for done titles, and prioritizes active or blocked work when space is limited. `/workflow-ui`, `show`, `hide` and `list` control only the view. Manual hiding survives updates; a fresh extension load restores default visibility. Headless modes mount no widget. Display failures cannot roll back a committed task update.

The latest non-workflow tool name and failure flag are observed in memory and exposed through inspect/context. This is execution feedback, not certified evidence or a completion gate. No source hashing, filesystem scope inventory, observation binding, assertion parsing or automatic task acceptance occurs.

## Continuation And Interruption

In trusted TUI/RPC sessions, a list with todo/doing work may receive one ordinary follow-up after Pi's public settlement barrier and all settlement consumers finish. The reminder asks the main agent to continue useful work, revise unnecessary steps or record the real blocker/pause; it adds no checks or review obligations. It does not invoke children or apply candidates.

An unchanged list gets no second automatic reminder. Identical set/update operations, inspect, tool observations and new attempt-like labels do not establish task changes. A real task update or new interactive/RPC input permits another reminder. New user input enters the same ordinary main-agent context without an alignment ritual. Paused, cancelled, all-terminal and wholly blocked lists do not dispatch reminders.

The extension rechecks input/session ownership, abort, idle state, queued messages, project trust and tool availability at settlement. A real host abort or an unrecovered provider failure pauses unfinished tracking and suppresses automatic reminders. The wake fence is attempt-local: Pi's public `agent_start` retires the previous attempt's failure when internal retry/recovery starts a fresh attempt, even when `before_agent_start` does not run again. A recovered normal completion is not marked interrupted or paused solely because an earlier attempt failed. Print/JSON modes do not dispatch reminders. There are no private loop calls, polling timers or provider changes.

Managed subagent submissions with fresh current-invocation admission telemetry appear as pending facts in the reminder, not a global veto. The main may advance independent work or inspect ready results while siblings execute; if only event-dependent work remains, it can settle without inventing a blocker or updating tasks to renew reminders. Replayed accepted receipts without current admission do not imply live execution. Co-loaded executors and workflow share a thin idle-wake reservation through request preparation: a completion/attention turn carries the useful reminder rather than starting a second unchanged-revision turn. Workflow never turns execution events into task completion, and optional event integration does not require the subagent extension. Pending tracking is session-local and discarded on recovery.

## Persistence And Recovery

Each changed list is appended as a schema-v5 `csheng-workflow-state` snapshot before replacing its in-memory state. A failed append preserves the prior record and returns a tracking error. Read-only observations are not persisted. Reminder disposition is persisted before dispatch to avoid unchanged reminder loops.

On session/branch recovery, unfinished current-version tasks remain inspectable and visible but start paused. The main agent reconciles present intent and may resume. Recovery does not replay business operations, restart children or infer permission.

Only the latest workflow snapshot is considered. Unsupported older completion-contract snapshots and malformed latest snapshots are ignored with an explicit diagnostic; no older snapshot is silently substituted. There is no legacy acceptance reader, migration engine or claim that old work completed. `set` records the current list explicitly. Removing the extension leaves inert history.

## Verification Ownership

Focused store tests cover task creation, revision, completion, blockers, cancellation, no-op updates, persistence failure and safe recovery. UI tests cover visible statuses, cancelled counts, clipping, terminal sanitization and read-only controls. Synthetic-host tests cover ordinary work without tracking, current context projection, bounded continuation, public settlement ordering and asynchronous executor coexistence. Recovery regressions exercise provider error followed by internal retry, legal task mutation/control and normal settlement, alongside genuine cancellation and unrecovered failure protection. Provider-schema tests use injected offline transports. Installed-host and TUI probes remain explicit integration lanes; they do not establish live-model adherence or delivery acceptance.

Product source changes do not update the copied daily package or an already running Pi process. Publication, restart/load and any live effectiveness measurement remain separate authorized actions.
