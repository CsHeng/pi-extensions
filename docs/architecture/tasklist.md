# Pi Tasklist

`extensions/tasklist/index.ts` registers `tasklist`, an optional passive Pi task list for focus and recovery. It works without `agent-skills` and with other implementation or workflow Skills. Its presence does not require using it. Pi owns the model/tool loop; the main agent owns the user's requirements, task meaning, verification, review decisions and delivery acceptance.

Adding or removing this extension must not change business acceptance, necessary checks or review scope. A recorded item is a revisable representation of the work, not an extra user obligation. Tool success, subagent completion and source apply never automatically mark items done. The main agent marks an item done when the work meets the user's completion criteria based on available evidence. It records that judgment directly; the tool requires no structured attempt, fact, evidence-id, requirement-judgment or delivery-judgment receipt.

The list is data, not an execution engine. There is no list-level pause or resume, no automatic pause on recovery or interruption, no tool-observation bookkeeping and no task-driven control of shell or subagent execution. Unfinished, blocked or cancelled items neither continue nor block a model turn or an execution result.

## Tool Interface

The extension exposes one model tool, `tasklist`, with no legacy alias.

| Operation | Inputs and behavior |
| --- | --- |
| `set` | `title` and the complete `tasks` list. Explicitly creates or replaces the list, including revising decomposition or removing unnecessary inferred steps. Each item needs `id` and `title`; omitted status defaults to `todo`. |
| `update` | Patches existing item ids atomically through `tasks`; may also revise `title`. Change title, status or note. Use `set` to add or remove items. |
| `inspect` | Reads the current list, or the unsupported-state diagnostic in place of an empty list. |
| `cancel` | Marks every unfinished item `cancelled` while preserving already-done items. It is a bulk item edit; it cannot stop an execution. |

Item statuses are `todo`, `doing`, `blocked`, `done` and `cancelled`. A blocked item requires a note naming the actual blocker; the main agent can change it back when resolved. `note: null` clears a note. Item ids must be unique; an update cannot repeat an id or refer to an unknown one. A list has at most 100 items, with bounded ids, titles and notes.

Completed, unfinished, blocked and cancelled items stay distinguishable as item data. Counts and summaries are derived for presentation only; they never mark business work complete. An empty list does not imply completed business delivery, and mixed done/cancelled work is never reported as all done.

```json
{
  "operation": "set",
  "title": "Adjust the project environment",
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

These items and notes are examples of the main agent's chosen work, not mandatory phases, tests or reports. Tracking updates should be useful progress records; a tracking failure never calls for rerunning a completed business operation to manufacture evidence. Mutation cancellation is scoped to the current tool invocation's AbortSignal, not an earlier provider error or automatic-wake fence. A cancelled write returns `ok: false` with `error.code: "call_cancelled"` and preserves the prior state; inspect remains read-only, and later active invocations may edit normally. Validation and persistence failures are not reported as cancellation.

## Context And Display

Session start, branch navigation and successful compaction append a bounded `csheng-workflow-tasks` native custom message when a list or unsupported-state diagnostic exists. These are historical, read-only state notifications, not per-request `context` transforms: they remain at their original transcript position across ordinary tools and provider retries, and later receipts or boundary snapshots supersede older state. Ordinary edits already have durable tool receipts and do not add duplicate snapshots. Each snapshot includes at most twelve items, prioritizes unfinished work, bounds titles/notes and points to inspect when more items exist. It conveys no new authority and never appears because of an interruption.

Context-only messages use Pi's non-waking append path; streaming insertion waits for a safe tool boundary. When overflow compaction has already selected a host-owned retry, its snapshot joins that retry's native input queue so it is present before the request rather than arriving after its first response. This does not introduce a task-only continuation. Removing the extension leaves these messages as inert history, like ordinary task-tool receipts.

`extensions/tasks-ui/` owns the read-only TUI view. The extension publishes a minimal owner-scoped snapshot on the extension event bus after state is committed; it does not render the widget or import the view. The view presents remaining work and item notes; it is not an execution queue. The bottom line appears when the session has a published list, unless the user has toggled it hidden, and uses the same collapsed summary as the other above-editor panels. The expanded section preserves the list title, notes, item rows, blocked indication and bounded overflow of the Tasks renderer. `/tasks-ui list` remains a separate full-list action in a central read-only overlay; it does not change bottom-section visibility. Bare toggle and explicit show/hide commands report the resulting on/off state. `/tasks-ui` is the canonical view command; `/workflow-ui` remains a compatibility alias for show, hide, list, and toggle. A fullscreen header click toggles only Tasks' inline expansion without opening a dialog or taking editor focus. `/tasks-ui expand` and `/tasks-ui collapse` provide the same controls without a mouse. Tasks, Jobs and Subagents maintain independent folding and visibility even though they share one above-editor widget; manual hiding and fold choices survive later updates. Headless modes mount no widget and do not disable the `tasklist` tool. Display failures cannot roll back a committed task edit.

## Facts And Continuation

The extension publishes the committed list as passive facts on the shared notification channel. Publication is unconditional and independent of notification delivery, Agent or shell state; the producer makes no delivery decision and knows nothing about consumers. The shared fact payload keeps its existing `goal` field name for the list title and reports `paused: false` because no pause exists; `cancelled` there is derived from item data only.

[Loop notifications](job-notifications.md) owns delivery. Task-list-only automatic continuation remains disabled, so task facts, edits, blocked items and unfinished work start no model turn and never delay retention of unobserved retained-shell or subagent terminal results. A completion notice supplies evidence, not approval, task acceptance or permission to apply a candidate. Print/JSON modes do not receive these wakes.

A real host abort or an unrecovered provider failure leaves the recorded list untouched: no automatic pause, status rewrite or notice is appended. If only event-dependent work remains, the model may end the turn with items unfinished. Ending a turn is not task completion and does not require a fabricated blocker or a list update.

## Persistence And Recovery

Each changed list is appended as a schema-v6 `csheng-workflow-state` snapshot before replacing its in-memory state. A failed append preserves the prior record and returns a tracking error.

Recovery reads the newest snapshot on the restored branch and makes it immediately usable data; no resume call is required. A supported schema-v5 snapshot is normalized in memory: its list title becomes `title`, and its removed list-level pause/cancel/reason/reminder control fields are dropped while every item keeps its written status and note. That normalization writes nothing. The next explicit model edit appends the current form, leaving the historical entry untouched.

Only the latest snapshot is considered. An unsupported or malformed latest snapshot yields an explicit diagnostic instead of an empty list, and `inspect`, edits and snapshots report that state; it is never rewritten, migrated or silently replaced by an older snapshot. `set` records a new list explicitly. There is no legacy acceptance reader, migration engine or claim that old work completed. Removing the extension leaves inert history.

## Verification Ownership

Focused store tests cover explicit edits, list titles, revision handling, blockers, cancellation distinct from completion, no-op edits, persistence failure, legacy normalization without rewrite, unsupported-version reporting and safe cancellation. UI tests cover visible statuses, blocked indication, cancelled counts, clipping, terminal sanitization and read-only controls. Synthetic-host tests cover ordinary work without tracking, durable boundary snapshots, passive fact publication, the absence of task-only continuation and of interruption-driven mutation, public settlement ordering and asynchronous executor coexistence. Cache regressions compare consecutive complete provider inputs, including the leading prompt and tool declarations, instead of only checking that an injection disappeared. They cover active tracking, real manual/threshold/overflow compaction, recovery and provider retry; compaction itself is an intentional context boundary rather than an append-only assertion. Provider-schema tests use injected offline transports. Installed-host and TUI probes remain explicit integration lanes; they do not establish live-model adherence or delivery acceptance.

Product source changes do not update the copied daily package or an already running Pi process. Publication, restart/load and any live effectiveness measurement remain separate authorized actions.
