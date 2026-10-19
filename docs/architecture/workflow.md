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

Session start, branch navigation and successful compaction append a bounded `csheng-workflow-tasks` native custom message when a list or recovery diagnostic exists. A host-induced pause appends another only when the persisted task revision changes. These are historical, read-only state notifications, not per-request `context` transforms: they remain at their original transcript position across ordinary tools and provider retries, and later workflow receipts or boundary snapshots supersede older state. Normal task mutations already have durable tool receipts and do not add duplicate snapshots. Each snapshot includes at most twelve tasks, prioritizes unfinished work, bounds titles/notes, omits ephemeral tool telemetry and points to inspect when more items exist. It conveys no new authority.

Context-only messages use Pi's non-waking append path; streaming insertion waits for a safe tool boundary. When overflow compaction has already selected a host-owned retry, its snapshot joins that retry's native input queue so it is present before the request rather than arriving after its first response. This does not introduce a task-only continuation. Removing the extension leaves these messages as inert history, like ordinary task-tool receipts.

`extensions/tasks-ui/` owns the read-only TUI view. Workflow publishes a minimal owner-scoped snapshot on the extension event bus after state is committed; it does not render the widget or import the view. The bottom line appears when the session has a published task list, unless the user has toggled it hidden. It uses the same collapsed summary as the other above-editor panels. The expanded section preserves the goal, notes, task rows, state variants and bounded overflow of the Tasks renderer. `/tasks-ui list` remains a separate full-list action in a central read-only overlay; it does not change bottom-section visibility. Bare toggle and explicit show/hide commands report the resulting on/off state. `/tasks-ui` is the canonical view command; `/workflow-ui` remains a compatibility alias for show, hide, list, and toggle. A fullscreen header click toggles only Tasks' inline expansion without opening a dialog or taking editor focus. `/tasks-ui expand` and `/tasks-ui collapse` provide the same controls without a mouse. Tasks, Jobs and Subagents maintain independent folding and visibility even though they share one above-editor widget; manual hiding and fold choices survive later updates. Headless modes mount no widget and do not disable the workflow tool. Display failures cannot roll back a committed task update.

The latest non-workflow tool name and failure flag are observed in memory and exposed through inspect. This is execution feedback, not certified evidence or a completion gate. No source hashing, filesystem scope inventory, observation binding, assertion parsing or automatic task acceptance occurs.

## Continuation And Interruption

Workflow publishes the committed task list and does not schedule a model wake. Task-list-only automatic continuation is temporarily disabled at the user's request because it was unstable, could trigger while design confirmation was still pending, and offered limited benefit. This includes active unpaused todo/doing work, task changes, resume, and new interactive/RPC input. The list remains available for tracking, context and recovery; an unfinished item is not user confirmation to continue a design or implementation. Whether to re-enable or redesign this capability is deferred in `$AGENT_ARCHITECTURE_DIR/docs/architecture/open-questions.md` (OQ-1), not decided by the current disablement.

[Loop notifications](loop-notifications.md) still delivers unobserved retained-shell and subagent terminal results, even if a sibling is still running. A completion notice supplies evidence, not approval, task acceptance or permission to apply a candidate. Print/JSON modes do not receive these wakes.

A real host abort or an unrecovered provider failure pauses unfinished tracking. The notification fence is attempt-local. A recovered normal completion is not marked interrupted solely because an earlier attempt failed. Replayed accepted receipts are not live executions. Workflow never turns execution events into task completion.

If only event-dependent work remains, the model may end the turn with tasks unfinished. Ending a turn is not task completion and does not require a fabricated blocker, a tracking pause, or a list update.

## Persistence And Recovery

Each changed list is appended as a schema-v5 `csheng-workflow-state` snapshot before replacing its in-memory state. A failed append preserves the prior record and returns a tracking error. Read-only observations are not persisted. A historical `remindedRevision` field remains readable as inert data; it neither schedules a wake nor requires migration.

On session/branch recovery, unfinished current-version tasks remain inspectable and visible but start paused. The main agent reconciles present intent and may resume. Recovery does not replay business operations, restart children or infer permission.

Only the latest workflow snapshot is considered. Unsupported older completion-contract snapshots and malformed latest snapshots are ignored with an explicit diagnostic; no older snapshot is silently substituted. There is no legacy acceptance reader, migration engine or claim that old work completed. `set` records the current list explicitly. Removing the extension leaves inert history.

## Verification Ownership

Focused store tests cover task creation, revision, completion, blockers, cancellation, no-op updates, persistence failure and safe recovery. UI tests cover visible statuses, cancelled counts, clipping, terminal sanitization and read-only controls. Synthetic-host tests cover ordinary work without tracking, durable boundary snapshots, the absence of task-only continuation, public settlement ordering and asynchronous executor coexistence. Cache regressions compare consecutive complete provider inputs, including the leading prompt and tool declarations, instead of only checking that an injection disappeared. They cover active tracking, real manual/threshold/overflow compaction, recovery, provider retry and an asynchronously running child; compaction itself is an intentional context boundary rather than an append-only assertion. Recovery regressions exercise provider error followed by internal retry, legal task mutation/control and normal settlement, alongside genuine cancellation and unrecovered failure protection. Provider-schema tests use injected offline transports. Installed-host and TUI probes remain explicit integration lanes; they do not establish live-model adherence or delivery acceptance.

Product source changes do not update the copied daily package or an already running Pi process. Publication, restart/load and any live effectiveness measurement remain separate authorized actions.
