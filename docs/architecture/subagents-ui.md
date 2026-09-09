# Subagents UI

`extensions/subagents-ui/index.ts` is a default-loaded TUI-only read-only observer of bounded managed `csheng.subagents.observer.v2` snapshots published by the core. It does not execute children, own cancellation, write the working row or footer, or persist session metadata.

## Surfaces

- `/subagents-ui` and `Ctrl+Alt+F` open a floating overlay inspector
- overlay content is bounded live model, thinking, assistant turns, elapsed time, launched/running/finished counts, and per-task status
- keyed status `csheng.subagents.status` and below-editor widget `csheng.subagents.panel` stay off by default (`enableWidget` is an explicit factory opt-in); the observer never appends custom completion entries

The overlay is display-only. It does not request cancellation. The structured managed tool result remains the outcome authority. Historical one-shot snapshot UI v1, including confirmed `csheng.subagents.cancel.request.v1` receipts and `csheng-subagents-run` entries, is not a current surface.

## Observation and lifecycle

Snapshots carry the parent session/branch anchor, runtime generation, invocation identity, and generation-wide increasing revision. They expose only bounded role, actual resolved provider/model/thinking (or unavailable), episode, execution phase/status, turns, and nullable elapsed/count facts. Fresh launches and active children come from native child lifecycle hooks, not task admission. Inspect/apply/close and pure replay produce no new live dispatch; a replay row in a mixed dispatch keeps its original episode and is never counted as a new child.

The producer emits a five-second heartbeat only during the foreground invocation and always clears it on settlement. The UI retains bounded current/latest-terminal observations while closed, so late opening needs no native-file polling. After fifteen seconds without an update, unfinished work becomes stale/unknown and elapsed extrapolation stops. Terminal values stay frozen. Foreign owners, retired generations and non-increasing revisions are ignored. Session start/tree/shutdown clears the cache and dismisses the overlay. Escape closes only the view, not the task. Arrow and page keys scroll within the terminal-derived viewport; wrapping uses terminal cell width.

## Verification

`tests/subagents-cc-tui.test.ts` runs the installed Pi TUI and installed CC in on and compact modes through a PTY, with this checkout's observer, a synthetic in-process provider, and disposable HOME/agent settings. It verifies shortcut-opened model/thinking, live counts and terminal updates while the partial tool marker is hidden. No provider network call or real settings change is involved. The test explicitly skips when the installed CC dependency or util-linux `script` is unavailable; such a skip is not co-load evidence. Separate native-session tests own actual explorer/worker/reviewer execution and candidate evidence; the PTY stimulus does not claim to launch a native child.

## Independence

The extension listens through `pi.events` and validates every payload. It is inert in RPC, JSON, and print modes. It must not call `setWorkingMessage` or `setFooter`. Removing it leaves `csheng_subagent_sessions` unchanged. Removing the core leaves this extension idle and safe. `status-footer` and `work-timing` remain independent TUI contracts and are not replaced by this overlay.

See [`subagents.md`](subagents.md) and [`subagent-execution.md`](subagent-execution.md) for the separate execution, provenance, and observation contracts.
