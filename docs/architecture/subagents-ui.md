# Subagents UI

`extensions/subagents-ui/index.ts` is a default-loaded TUI-only read-only observer of bounded managed `csheng.subagents.observer.v2` snapshots published by the core. The event name is stable; current payloads are schema version 3, and the UI still accepts version 2 rows without assignment text or live tools. It does not execute children, own cancellation, write the working row or footer, or persist session metadata.

## Surfaces

- `/subagents-ui` and `Ctrl+Alt+F` toggle a content-fitted floating overlay inspector
- overlay content is launched/running/finished counts plus, for each task, a two-line block: role, assistant turns, and a bounded assignment headline on the first line; provider/model/thinking, status, elapsed time, and current tool names on the second
- the panel is padded and painted with the `selectedBg` background: an accent title row (`Subagents · <phase>`), a muted rule, a summary row, two rows per task, and a dim key footer; it fits the widest observed row above an 80-column floor, grows when new observations need more room, and never fills the terminal
- the title row right-aligns a `[ ✕ ]` chip one column inside the panel edge; `Ctrl+Alt+F` toggles the view closed and a fullscreen left click anywhere in that chip closes it on hosted Pi versions that dispatch overlay pointer events
- keyed status `csheng.subagents.status` and below-editor widget `csheng.subagents.panel` stay off by default (`enableWidget` is an explicit factory opt-in); the observer never appends custom completion entries

The overlay is display-only. It does not request cancellation. The structured managed tool result remains the outcome authority. Historical one-shot snapshot UI v1, including confirmed `csheng.subagents.cancel.request.v1` receipts and `csheng-subagents-run` entries, is not a current surface.

## Observation and lifecycle

Snapshots carry the parent session/branch anchor, runtime generation, invocation identity, and generation-wide increasing revision. They expose bounded role, actual resolved provider/model/thinking (or unavailable), episode, execution phase/status, turns, nullable elapsed/count facts, a single-line assignment `headline` projected from the parent objective, and current allowlisted `activeTools`. The headline is truncated display text, not the raw objective, output, path, or child prompt. Fresh launches and active children come from native child lifecycle hooks, not task admission. Inspect/apply/close and pure replay produce no new live dispatch; a replay row in a mixed dispatch keeps its original episode and is never counted as a new child.

The producer emits a five-second heartbeat only during the foreground invocation and always clears it on settlement. The UI retains bounded current/latest-terminal observations while closed, so late opening needs no native-file polling. After fifteen seconds without an update, unfinished work becomes stale/unknown and elapsed extrapolation stops. Terminal values stay frozen. Foreign owners, retired generations and non-increasing revisions are ignored. Session start/tree/shutdown clears the cache and dismisses the overlay. Closing affects only the view, not the task: `Ctrl+Alt+F` toggles it, the `[ ✕ ]` chip closes it under fullscreen pointer capture, and Escape is unbound. The title row stays pinned while the task body scrolls. The host resolves the panel's layout before every render, so the displayed width follows the widest observed row — never below the previous 80-column default, never wider than the terminal — and short content cannot leave surrounding transcript text interleaved with panel rows. Arrow and page keys scroll within the terminal-derived viewport; wrapping uses terminal cell width.

## Verification

`tests/subagents-cc-tui.test.ts` runs the installed Pi TUI and installed CC in on and compact modes through a PTY, with this checkout's observer, a synthetic in-process provider, and disposable HOME/agent settings. It verifies shortcut-opened model/thinking, live counts and terminal updates while the partial tool marker is hidden. `tests/subagents-ui-tui.e2e.ts` is a deliberate installed-host check (`npm run e2e:subagents-ui`, outside `npm test`) that runs the installed Pi TUI in fullscreen mode through a PTY and verifies that a left click on the rightmost column of the overlay's first row — the `✕` marker — dismisses the view. It resolves the installed `pi` rather than this checkout's pinned dev dependency, because that dependency's TUI never dispatches component pointer events, and it skips when that binary is absent. No provider network call or real settings change is involved in either test. Each test explicitly skips when util-linux `script` (and, for the CC test, the installed CC dependency) is unavailable; such a skip is not co-load evidence. Separate native-session tests own actual explorer/worker/reviewer execution and candidate evidence; the PTY stimuli do not claim to launch a native child.

## Independence

The extension listens through `pi.events` and validates every payload. It is inert in RPC, JSON, and print modes. It must not call `setWorkingMessage` or `setFooter`. Removing it leaves `csheng_subagent_sessions` unchanged. Removing the core leaves this extension idle and safe. `status-footer` and `work-timing` remain independent TUI contracts and are not replaced by this overlay.

See [`subagents.md`](subagents.md) and [`subagent-execution.md`](subagent-execution.md) for the separate execution, provenance, and observation contracts.
