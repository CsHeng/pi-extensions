# Subagents UI

`extensions/subagents-ui/index.ts` is a default-loaded, TUI-only, read-only session inspector. The core owns retained inventory and recorded accounting; the UI consumes correlated session-view replies and fresh managed observer snapshots. It does not execute children, own cancellation, reconcile registries, write the working row/footer, or persist session metadata.

## Surfaces

- `/subagents-ui` and `Ctrl+Alt+F` toggle a content-fitted floating overlay titled `Subagents · session <prefix>…`, not a batch or invocation.
- The summary separates live agents, retained agents, accepted episodes and stored states. Continuing a handle updates that agent's episode rather than creating another agent; replay does not manufacture an accepted episode.
- Fresh live rows are pinned above history, with a distinguishable handle, episode, role, turns and activity. Compact primary rows take precedence over optional assignment details. Ten live identities fit at 80×24; a physically insufficient viewport exposes a labeled, arrow-navigable live window instead of silently dropping rows.
- Enter expands or collapses retained history. History includes idle, interrupted, closed and unconfirmed persisted-running records, with separate outcome, retention, legacy and historical-branch labels. Provider/model/thinking remain visible when safely recorded. PageUp/PageDown request bounded history pages; arrows move through a page's wrapped physical rows without scrolling the live area away.
- The panel uses the theme's `selectedBg`, an accent title and muted rules. Width is content-fitted with an 80-column preference clamped to the terminal; height and wrapping follow actual terminal cells. The right-aligned `[ ✕ ]` title chip closes the view under supported fullscreen pointer capture. `Ctrl+Alt+F` also closes it; unhandled keys retain host behavior.
- Keyed status `csheng.subagents.status` and below-editor widget `csheng.subagents.panel` stay off by default (`enableWidget` is a factory opt-in). The observer never appends custom completion entries.

The structured managed tool result remains outcome authority. Showing retained history does not authorize continuation, apply, close or cancellation. Historical one-shot snapshot UI v1, including its cancellation receipts and completion entries, is not a current surface.

## Read scope and delivery

`extensions/subagents/session-view.ts` owns version-1 `csheng.subagents.session-view.request` and `csheng.subagents.session-view` events. Requests contain a request identity and page; replies contain the core-derived parent session, branch anchor, generation and retained-projection revision. The core checks project trust and reads only the same canonical repository and parent session. Same-session off-branch records are explicitly historical, while tool mutation retains its existing restrictive branch/owner checks.

Inventory reads existing managed registries, including closed and legacy records, without creating storage or changing registry bytes. History uses 20-row pages, independent of open-session admission limits. Every valid retained handle remains reachable; unreadable storage/records and unavailable accounting are visible, not a complete-looking empty success. Payloads are bounded and strictly validated. The versioned reply accepts at most 16 live rows, independently of the current ten-open-session execution limit.

The core caches retained inventory and saved episode observations. Lifecycle changes invalidate the projection and emit the data-free `csheng.subagents.session-view.changed` notification; an open UI requeries its current page. Heartbeats and ordinary repaint do not scan history. Concurrent queries share a read, and an older owner/revision read cannot replace a newer cached projection. The UI rejects foreign, superseded and mismatched replies, handles rapid navigation and owner changes, and displays an unavailable state if the core does not answer within four seconds.

Reload restores inventory observationally. Persisted `running` or `queued` alone does not establish a live child; no UI read resumes, reconciles, launches or rewrites it. Session start/tree/shutdown dismisses the old overlay and clears its observation/query state. Reopening queries the current session again.

## Live observations and usage

The stable `csheng.subagents.observer.v2` event still carries bounded live snapshots with payload version 3; version-2 rows remain readable. Legacy snapshots are live evidence, not a complete session-history or total-accounting source. Fresh child lifecycle hooks establish activity; inspection, apply, close and pure replay do not create new live dispatch. A five-second heartbeat keeps active observations fresh, and after fifteen seconds without evidence the UI marks unfinished activity unknown and stops elapsed extrapolation. Closing the overlay stops its timers, not the children.

The core aggregates saved per-episode native observations and deduplicates entries by `(ownerSessionId, entryId)`, including overlapping continuation observations. Session totals are independent of history page. Recorded turns, token metrics and cost expose complete, incomplete or unavailable coverage; incomplete known subtotals are labeled, and unknown values are never silently zero. Missing/invalid observations, identity conflicts, compaction, aggregate-only usage, unknown prices and numeric overflow retain uncertainty. There is no raw native JSONL fallback or claim that partial recorded usage equals final provider billing.

## Verification

`tests/subagents-session-ui.test.ts` composes real managed storage, the registered core event producer and the registered UI around synthetic execution. Its 37-handle/49-episode scenario covers complete navigation, live pinning, accounting and reload without launch or durable mutation. Store, accounting, session-view and UI suites separately cover owner isolation, continuation/replay, coverage failures, query races and cache invalidation.

`tests/subagents-cc-tui.test.ts` runs installed Pi and CC in on/compact modes through a PTY, proving live/settled updates and retained route details while partial tool output is hidden. `tests/subagents-ui-tui.e2e.ts` uses installed Pi, a synthetic offline provider and disposable HOME/agent settings. The test-only `@xterm/headless` terminal decodes the actual PTY output: Enter, PageUp/PageDown and arrows reach all history while ten live identities remain on screen; resizing the owned PTY from 80×24 to 40×24 and back preserves reachability. It also verifies settlement, keyboard close and the fullscreen close-chip click. Synthetic PTY stimuli do not claim to launch native children; existing native-session suites own that evidence.

Run `bun run e2e:subagents-ui` explicitly, or the non-skippable affected-UI gate `bun run e2e:ui-offline`. The standalone tests skip when installed Pi or util-linux `script` is absent; a skip is not acceptance. Set `CSHENG_UI_PACKAGE_ROOT` to an isolated package snapshot to run the same PTY checks against that candidate, and pair this with `scripts/run-installed-subagents-probe.sh <package-root>` for registration/source identity. No real settings or provider network calls are involved.

## Independence

The extension validates data received through `pi.events` and is inert in RPC, JSON and print modes. It must not call `setWorkingMessage` or `setFooter`. Removing it leaves `csheng_subagent_sessions` unchanged. Removing the core leaves the UI safe with unavailable history. `status-footer` and `work-timing` retain independent contracts.

See [Subagents](subagents.md) and [Managed Subagent Execution](subagent-execution.md) for execution, provenance, retained ownership and observation contracts.
