# Workflow task-list UI

Status: implemented and verified under the user’s “approve and $coding:implement-change” instruction. Delivery includes source, verification, and local snapshot publication, explicitly authorized by the user’s subsequent “publish” instruction on 2026-09-18. Commit, push, and a further snapshot publication were authorized by the user on 2026-09-19 together with the trigger-affordance copy, bounded row width, short task titles, and the vacuous-close guard.

## Objective and current evidence

Show this package's workflow tasks in Pi using the visual style of the locally installed `@juicesharp/rpiv-todo` 2.10.1. The reference is its above-editor widget, not a modal overlay: an accent heading with a count, `├─` / `└─` rows, status glyphs, dim supporting text, bounded overflow, and a trailing spacer.

Reference source inspected: `todo-overlay.ts`, `view/format.ts`, `state/selectors.ts`, `index.ts`, and `docs/overlay.md` in the installed rpiv package. Its default content budget is 12 rows, its own collapse binding is `ctrl+shift+t`, and Pi's tool-output expansion also expands its task list. It additionally owns a separate `todo` tool, task store, replay from tool results, and completed-row hiding at the next agent start. Those mechanisms are not required to reproduce the visual style.

The existing [workflow store](../../../extensions/workflow/store.ts) already owns committed state and validated branch replay. [WorkflowView](../../../extensions/workflow/contracts.ts) and [buildView](../../../extensions/workflow/reducer.ts) provide tasks, task readiness, criteria, attempts, and completion deficits. The [extension entry point](../../../extensions/workflow/index.ts) has no UI registration, and the tool currently returns a textual ledger projection.

Mutations also originate in alignment, branch reconciliation, automatic-review accounting, and evidence refresh. Refreshing a widget only after `csheng_workflow` tool results would miss these changes.

## Recommended boundary

Add a read-only UI module inside `extensions/workflow/`, backed by the existing store. Register a uniquely keyed `aboveEditor` widget only in `ctx.mode === "tui"`. Loading without a workset leaves the editor unchanged. No additional model tool, task persistence, provider request change, dependency, timer, or model continuation is needed.

| Option | Assessment |
| --- | --- |
| Internal workflow UI module reading the committed store | Recommended: one task owner and direct branch recovery, with a small presentation boundary. |
| Separate `workflow-ui` extension with an observer event protocol | Feasible if independently installing the view becomes a requirement; currently adds publication, initial hydration, owner validation, and load-order contracts. |
| Feed workflow tasks into rpiv's `todo` state | Rejected: creates a second task authority and loses workflow acceptance semantics. |

The approved UI is the narrow exception to the former no-widget boundary. Project instructions now allow this TUI-only read-only view while retaining the prohibitions on footer/working-message competition, extra state files, and UI-driven workflow mutations. The package still has nine extensions.

## Presentation

Illustrative active workset:

```text
● Tasks · 修复 workflow 请求 (1/5 accepted)
├─ ✓ T-1 定位 schema 拒绝原因
├─ ◐ T-2 修正参数声明
├─ ◇ T-3 回归验证 · awaiting acceptance
├─ ○ T-4 发布快照 · waits for T-2,T-3
└─ ! T-5 线上验证 · blocked

```

Use the host theme and terminal-cell width functions. Sanitize task text before styling; embedded newlines, escape sequences, and control characters cannot create extra rows or terminal commands. Show stable workflow task ids because they are useful for referring to tasks, even when the current view has no dependency edges. Render the task outcome, without adding a persisted short-title or `activeForm` field in this first version.

| Workflow state | Display |
| --- | --- |
| `pending`, dependencies ready | `○` normal text |
| `pending`, unresolved dependencies | `○` with dim unresolved predecessor ids |
| `running` | `◐` warning glyph, accent outcome |
| `awaiting_acceptance` | `◇` with explicit acceptance-pending label |
| `accepted`, with current recorded acceptance | `✓` success glyph, dim/struck-through outcome |
| `blocked` | `!` warning glyph and bounded reason |
| `paused` | `Ⅱ` dim row with paused label |
| `cancelled` / `superseded` | Excluded from the main count and compact rows; available in the full view as history |

The count is accepted active tasks / all active tasks in the current workset, independent of rows hidden for space. A known invalidated acceptance must not count as accepted. Reuse the reducer's completion/deficit facts rather than introducing another acceptance predicate. Rendering never fingerprints files or certifies checks.

An active workset with all tasks accepted is still active until the existing completion predicate allows `close/completed`. In that case, display the remaining criterion, attempt, alignment, or delivery deficit beneath the heading. Paused worksets and `needs_alignment` get explicit status text. The view must not invent a blocked reason from missing permission evidence or interpret failed/interrupted attempts as successful completion.

Keep source task order while everything fits. The normal widget has at most 12 content rows, including heading/status/overflow rows, plus a trailing spacer; use a lower terminal-height-derived budget on short terminals. When it overflows, retain running, awaiting-acceptance, and blocked work first, then other unfinished work, and finally accepted rows. Keep stable task order within a priority group. The final row reports omitted counts by actual state, not a blanket pending label.

Do not copy rpiv's automatic hiding of completed tasks on the next agent start. Workflow acceptance can later be invalidated, and tool/model turn boundaries do not delimit the workset. Accepted rows can be elided for space while their count remains stable. A closed workset collapses to a truthful completed/cancelled/superseded summary; a new workset restores the normal view. No workset means no widget. Recovery failure shows a compact state-unavailable warning, never a prior valid task list.

## Interaction

- `/workflow-ui` toggles compact and expanded widget presentation; compact is a heading and one expand hint.
- `/workflow-ui hide` and `/workflow-ui show` affect only the current session's view.
- `/workflow-ui list` opens a read-only scrollable full-task view, including dependency and block details and explicitly separated cancelled/superseded history. Use Pi's public custom-component API, bounded to terminal dimensions, with arrow/page scrolling and Escape to close. It sends no model input and awaits no acceptance decision.
- Do not bind rpiv's `ctrl+shift+t`, the subagent panel's `Ctrl+Alt+F`, or repurpose Pi's global tool expansion shortcut. A dedicated key can be added after choosing it with the user; the commands are sufficient for the first version.

Expansion/visibility/scroll position are ephemeral UI state. They do not alter workflow revision, delivered-input generation, review credit, task disposition, or authority. Full-view data comes from the same current committed projection, including after updates while the view is open.

## Update and lifecycle contract

Add an in-memory store change subscription with an unsubscribe function. Notify only after successful snapshot append and installation of the next state, and after branch replay has produced either valid state, no workset, or a recovery error. Rejected operations and deduplicated calls do not publish fictitious progress. The notification carries no separate durable task state.

The UI registers its widget through the public component factory once, then requests a render on committed changes. It reads the current projection when rendering, and recomputes formatting for the current width/theme. A UI observer failure must be isolated from the already committed ledger operation: disable the affected view and surface a bounded UI error without turning a successful mutation into a tool failure or retrying the mutation.

On session replacement or tree navigation, detach the old view before replay and attach/refresh only after the existing reconciliation finishes. Discard old view references and reset scroll state. Reload rebuilds the view from the validated workflow snapshot. Compaction does not replace workflow state by scraping `todo` or workflow tool-result messages. Shutdown closes the full view, unregisters the keyed widget, and unsubscribes. RPC, JSON, and print modes never mount widgets or invoke custom UI.

## Implementation surface and acceptance

Implemented source surfaces: `extensions/workflow/store.ts` for committed-change notification, `index.ts` for ordered UI lifecycle wiring, and focused `ui.ts` / `ui-render.ts` modules for presentation and interaction. Reducer semantics, tool schema, and snapshot format remain unchanged. The workflow boundary in `AGENTS.md`, its architecture page, and README now describe the implemented view.

Required evidence:

- Pure rendering checks for all eight dispositions, invalidated acceptance, active-but-not-complete worksets, stable counts, overflow selection, Chinese/emoji widths, narrow/short terminals, and terminal-control sanitization.
- Store/UI integration checks for every mutation origin, append failure, rejected/deduplicated operations, recovery failure, owner replacement, branch replay, and UI failure after a successful commit.
- Command checks proving view toggles and full-list inspection create no ledger writes, model messages, alignment generation changes, or review credit changes.
- Real installed-host PTY coverage with a synthetic provider: open, start, report, assess, block, amend, close, resize, hide/show, full-list scrolling, reload, and branch replacement. Co-load status-footer, work-timing, subagents-ui, and the installed CC rendering extension in on/compact modes using disposable settings. The working-message writer remains configured as in the existing TUI fixtures.
- Existing offline `npm run check` and temporary/installed workflow probes remain green. A skipped installed-host fixture is recorded as unverified, not passing UI evidence. No live provider inference is needed for this UI change.

Implementation endpoint: reviewed source, passing offline/installed-host UI evidence, and the local snapshot publication authorized by the user’s 2026-09-18 “publish” instruction. Pi restart remains user-operated. The earlier bug-fix commit/push authorization was task-scoped and does not authorize committing or pushing this UI change. Recovery is fix-forward; the view can be hidden without changing the workflow ledger.

Independent implementation review passed with no material findings over the store notifications, entry-point lifecycle, renderer, controller, and focused tests. The reviewer independently reran all 18 rendering/store/controller tests. Real-host PTY coverage and final repository checks are separate execution evidence; review alone is not their acceptance.


## Verification outcome

- `npm ci --ignore-scripts`: passed.
- `npm run check`: passed, including typecheck, 564 tests with no failures or skips, and shell syntax validation.
- All eight documented offline temporary/installed plan-mode, subagents, herdr-handoff and workflow probes: passed.
- The installed Pi PTY cases passed with CC on and compact, including actual tool-driven task states, an open full-list refresh, terminal resize, command isolation, reload, tree navigation and session replacement. The close stimulus used `cancelled`; reducer tests own the separate completed-workset predicate.
- Independent implementation review: pass, no material findings. Local documentation links and `git diff --check` passed.

This task delivers source and offline/synthetic-host evidence plus the explicitly authorized local snapshot publication. No live provider call, commit, or push was performed for the UI change. Daily Pi loads the published view after the user restarts it; verification of that user process is separate from the disposable-host tests above.

Publication completed on 2026-09-18 with `mise run publish-local-package`. All 61 packaged files matched the authored source by SHA-256, including both new workflow UI modules. The daily Pi process has not been restarted by this task.
