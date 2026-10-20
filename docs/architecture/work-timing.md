# Work-timing metrics

`work-timing` provides TUI timing feedback for one external human interaction: the prompt a person typed or sent, plus every native model run, tool call and idle gap that interaction produces. It owns the working row while a run is in flight and appends one context-free completion entry only after the main loop is genuinely settled and all work the interaction owns has stopped, including any pending or reserved result delivery. It does not judge whether the user's task is complete, account for provider billing, or control execution.

The interaction boundary is external input. A native `agent_settled` is an internal run boundary, not the end of the interaction: an automatic result wake that starts another main run remains part of the same span. A run started only by an extension, with no external input behind it, still paints the live row but appends no completion entry.

**The displayed tok/s is decode throughput, not thinking-only speed or end-to-end inference throughput.** Thinking is part of the decode window; waiting for the first output and running tools are outside that window. The letter R has a different meaning in the separate status footer.

## Metric legend

| Display or term | Meaning and scope | What it does not mean |
| --- | --- | --- |
| `Working...` / `Worked for` | Autonomous wall time of the current external interaction, from the accepted input through final quiescence, including its runs, tools and the idle gaps while owned async work runs | Pure model-compute time, sum of parallel child durations, or proof of business completion |
| `Interrupted after` | The interaction did not reach quiescence: the run was aborted, or new external input cut an awaiting span | A successful completion with a shorter duration |
| `Timed ... (state unavailable)` | Quiescence could not be verified from producer facts or delivery state | Permission to claim completion or a resumable measurement |
| `waited <duration>` | Pure human wait already excluded from work elapsed, recorded only when at least one second accumulated | Thinking time, the tool clock, or time while async work was progressing |
| Working-row `R` | Current turn's client-observed **thinking duration**; R abbreviates reasoning, a synonym here | The whole model request or the tok/s denominator |
| Working-row / completion-entry `ΣR` | Accumulated thinking duration across that external interaction's runs | Session-wide time or a duration to add again to decode time |
| Completion-entry thinking share | `ΣR / work elapsed`, displayed as a bounded percentage | Thinking's share of decode time, or a provider GPU-utilization measurement |
| Interaction scope | Raw native tool-call ids started in this interaction, plus producer execution/run identities adopted by an explicit control or query receipt | A resumable session-wide mission or a durable execution budget |
| `tok/s` | **Decode throughput**: eligible streamed-turn output tokens divided by their accumulated observed decode windows | Output divided by total work or by request-wide inference time |
| `⚙ <elapsed>` | The longest-running currently active tool, after at least two seconds; `+N` counts the other concurrent tools | Sum of parallel tools' durations or proof that the tool is making progress |
| `↑` / `↓` | Input/output counts accumulated across the current external interaction's runs; positive sides are shown | The footer's session-cumulative counts or a precise tokenizer measurement in every case |
| TTFT / pre-output wait | A separate conceptual latency before the first observed output signal | A separately retained or displayed work-timing metric today |
| Model request / inference | The broader conceptual model-call span, including more than thinking or decode | An alternative name for R, or the rate currently displayed |
| Status-footer `R` | Session-cumulative **cache-read tokens**, owned by `status-footer` | Thinking duration; distinguish the component and token/time units |

## Decode clock and output count

Each turn starts its decode clock on `thinking_start`, or the first `thinking_delta`, `text_delta` or `toolcall_delta`. The clock continues through thinking, text, tool-call arguments and stream stalls. It pauses at assistant `message_end` or the first `tool_execution_start`. These are client-observed stream boundaries, not access to a provider's internal prefill or GPU timers; “first token” in this display means the first eligible signal, which can be a thinking-start event before text arrives.

The rate accumulates only turns that have such a decode signal:

```text
Decode tok/s = sum(output count for eligible streamed turns)
               / (sum(observed decode milliseconds for those turns) / 1000)
```

It is a ratio of sums, not an average of per-turn rates. Pre-output wait/TTFT, tool execution and between-turn gaps do not enter this denominator. A usage-only turn can contribute to the interaction's token counters but has no measured decode window and contributes neither numerator nor denominator to tok/s. The rate is omitted until both eligible output and decode time are positive.

The current output-count helper takes the maximum of reported provider `usage.output` and `round(max(streamed delta characters, message output characters) / 4)`. Counted output kinds are thinking text, ordinary text and tool-call arguments. Consequently this display can use a character estimate even after provider usage arrives; it is not guaranteed exact token accounting. Do not add a separate provider reasoning-token field on top of output that already includes those tokens.

`↑` uses provider `usage.input`; providers can report cache-read/write usage separately, so it is not necessarily the complete prompt-token count. `↓` uses the output-count helper across the interaction's turns. An unreported/nonpositive side is omitted. The separate footer owns session-cumulative usage, cache fields and cost; the timing extension does not redefine them.

## Overlapping windows, not a timing pie chart

This illustrative single-turn timeline separates the initial wait, decode and tool execution while showing thinking inside decode:

```text
Time:              0s                    20s        24s             30s          40s
Observed work:     | pre-output wait      | thinking | text/tool args | tool runs |
Model request:    |----------------------- conceptual model span ---|
Decode window:                           |--------- 10s ------------|
Thinking (R):                            |--- 4s ---|
Tool elapsed:                                                       |--- 10s ---|
```

Suppose the decode window produces 600 output tokens. The displayed rate is **600 / 10 = 60 tok/s**, even though first output arrived after a 20-second wait. Replacing it with **600 / 30 = 20 tok/s** would be a different, request-wide average that hides the distinction between waiting and decoding. TTFT may be useful alongside decode speed, but must not be silently folded into its denominator.

In the same illustration, thinking is 4 seconds, total work is 40 seconds and its share is 10%. A consistent completion entry is:

```text
Worked for 40s • ↓ 600 tokens • ΣR 4s (10%) • 60 tok/s
```

The input side is omitted here only to keep the illustration focused. The 4 thinking seconds are already inside the 10 decode seconds; they are not added a second time. The completion entry does not retain a live tool clock after the tool has finished.

Real interactions can contain many turns, overlapping tools, missing or overlapping thinking-event boundaries and provider-specific stream behavior. This drawing explains the concepts, not an exact physical phase partition for every provider. There is no stored standalone TTFT value in the current work-timing entry; neither `totalMs - reasoningMs` nor `totalMs - generationMs` reconstructs one, because tools, gaps and other waits also contribute to total work.

## Interaction span and settlement

The span starts when the host reports input from a real external source (interactive or RPC). Extension-origin prompts are automatic continuation: they never start or cut an interaction, and an extension-origin run without an external input keeps the live row only. Queued steering or follow-up input during a streaming run stays inside that run and therefore inside the same interaction. If that run was started by an extension with no human behind it, the external input instead promotes it to a fresh interaction at the input moment: the run's earlier wall time, tokens and thinking are not interaction history, a mid-turn cut keeps only the post-input part of that turn (its decode window restarts at the cut), and the run's ongoing tool calls and adopted executions stay owned so the work the person is now waiting on is not lost. New external input while an interaction is only awaiting async work cuts the span: the earlier span is reported as `interrupted`, never as a completion, and a late notice from its old jobs cannot reopen it.

The host exposes no identity that pairs an `input` event with the run it starts, and prompt expansion or another handler's transform can change the text, so the binding is ordering-based rather than content-based. It is still exact: every user-message run comes from the host prompt path, which emits `input` first, while custom runs never emit `input`. The most recent input event is therefore the run's input, and every input event replaces or clears the pending start. In particular an extension-origin prompt clears it, so an input that another handler consumed without starting a run cannot let a much later automatic run inherit stale human intent. A handler that replaces human input with its own `sendUserMessage` is the accepted loss of that distinction; no supported correlation hook exists to keep it attached.

Settlement is passive and evidence-based. After `agent_settled` the extension pulls the shared execution-quiescence snapshot through the notification event bus and appends the summary only when the main loop is idle with no queued message, no in-scope execution is non-terminal, and no in-scope result delivery is pending or reserved for a wake. A settled run whose owned job still executes, or whose terminal result has not yet been delivered, produces no entry; the later delivery wake starts another native run inside the same span, and the single summary is written after that run settles and the same query is quiet. The extension registers no settlement waiter, timer-driven model continuation, widget or command for this; it does not infer completion from task state, assistant prose, elapsed thresholds or job duration.

Only executions attributable to the interaction count. Attribution is the raw `toolCallId` the host gave to any tool call started in the span, including tool calls of automatic result runs, or a producer execution identity explicitly adopted by a control or query receipt the model received (a retained shell `executionId` or an Agent `runId`). Executions already present when the span opens are recorded as excluded, so an older unrelated job neither prolongs the interaction nor becomes its work by accident. A producer that cannot report its facts, or a delivery state blocked for in-scope work, yields `unavailable` rather than a success claim.

Thinking events, token counters and decode windows aggregate only the main loop's own runs across the interaction. For a turn already decoding when a person joins an automatic run, only post-cut output characters are estimated as tokens; cumulative provider usage arriving later cannot import pre-input output, and that turn's already-sent prompt contributes no input tokens. A parallel child's duration is never added to wall time; child activity only prevents an idle gap from being classified as human wait. The idle gap between runs is part of work elapsed because the person was waiting on autonomous work, not on themselves.

Pure human wait is excluded. While an explicit extension UI prompt is open, elapsed time is attributed to human wait unless a related async execution is progressing; a native tool that is itself blocked on `confirm`, `select` or another prompt is not autonomous progress, so the ordinary in-tool prompt is human wait. If a child or retained Bash job is still working, that interval remains autonomous work. The attribution samples at prompt start and end, at tool boundaries and at observed fact changes, so it is accurate at those boundaries rather than a per-frame reconstruction. Accumulated human wait is stored as `humanWaitMs`, subtracted from `totalMs`, and displayed as `waited <duration>` when it reaches a second.

## Live and settled presentation

The live field order is work elapsed, the optional active-tool field, the input/output counts, `R / ΣR`, then tok/s. Work elapsed and token counts remain cumulative across the interaction and visible while tools run, subject to terminal-width compaction. The active tool timer excludes time spent waiting on extension UI prompts. A compound/fused tool call has its own tool clock; it does not imply an independently timed nested bash command. The native working row may stop between runs while the interaction is still open; its span state is retained until final quiescence and the final summary still covers the gap.

A one-second clock lane samples work elapsed, current-turn thinking, cumulative thinking and tool elapsed together. A stream lane refreshes counts and tok/s immediately while using that cached duration sample. Both lanes use one formatter and one working-line writer; lifecycle boundaries may refresh the complete sample. Unchanged text is not republished. This avoids alternating short and full working messages without pretending that a one-second UI cadence measures individual tokens.

The live label targets the host's single-line working row: fullscreen only renders a message's first line. It uses `process.stdout.columns`, then `COLUMNS`, then 80, subtracting the loader's two-column padding and the spinner's two leading columns. Fields preserve order and are omitted whole when they do not fit, instead of being truncated mid-field. The R/ΣR pair stays together with the active tool field at narrow widths. Resize repaints immediately.

The settled entry uses final cumulative values, replaces the live R/ΣR pair with cumulative thinking and its work-time share, and keeps every applicable field in order: status head, optional waited time, token counts, cumulative thinking with its share, then tok/s. The status head is `Worked for <duration>` for a settled interaction, `Interrupted after <duration>` for an aborted or newly cut span, and `Timed <duration> (state unavailable)` when quiescence could not be verified. It folds at ` • ` boundaries and word-wraps an individually over-wide field. Collapsed and expanded views render the same entry line. A nonzero sub-second thinking duration appears as `<1s`, avoiding an apparent `0s` next to a nonzero percentage.

## Persistence, ownership and compatibility

The `work-timing` entry is display-only and context-free. Existing names such as `reasoningMs`, `generationMs` and `streamedOutputTokens` retain their current meanings: thinking-event duration, observed decode windows and the output count of streamed turns. They are not relabeled as a newly measured inference or TTFT duration. Older records remain readable; version-one entries render without the cumulative token segment and missing rate inputs do not fabricate a speed. No history rewrite or schema migration is needed to clarify the terminology.

Version-four entries record `scope` (`interaction`, or `run` for the historical single-run meaning), `status` (`settled`, `interrupted` or `unavailable`) and `humanWaitMs`. Version-one to version-three entries are normalized in memory to the historical settled single-run scope: they render exactly as before and are never rewritten. Fields absent from an older version are not fabricated into it. `appendEntry` remains context-free, so the summary never enters a later model prompt.

`work-timing` must remain inactive in headless modes. Final settlement releases its interval and quiescence subscription; session shutdown, session replacement and branch change also release the session-scoped resize listener. A teardown caused by a session or branch boundary writes nothing into the next scope. Disabling/removing the extension stops future timing behavior; it does not rewrite retained session entries or transfer ownership of the working row to another first-party component. `status-footer` owns the footer and `agents-ui` its observer view independently.

When co-loaded with `pi-cc-extensions`, that package's independent `enableWorkingMessage` writer must be off for this extension to own the row without competition. Refresh frequency does not arbitrate writers. Configuration is user-owned: runtime code must not change another extension's settings or patch Pi UI methods to claim the row. Editing this source checkout does not establish what an already-running Pi process or copied installed package loaded.

This product document is the metric reference. Shared integration guidance lives at `$AGENT_ARCHITECTURE_DIR/docs/architecture/pi-extension-integration.md`; it explains composition, not another implementation or runtime dependency. Future TTFT instrumentation, different throughput definitions, UI relabeling and execution-observation changes require their own explicit behavior decisions rather than silently changing these counters.

## Source and verification references

- [Work-timing implementation](../../extensions/work-timing/index.ts): decode signals, token estimates, clocks, interaction scope, quiescence settlement, renderers and cleanup.
- [Execution-quiescence helper](../../extensions/shared/execution-quiescence.ts): the passive snapshot and observation boundary this extension consumes; the notification producers own the facts and delivery state.
- [Status-footer implementation](../../extensions/status-footer/index.ts): the separate cache-read R and session-cumulative usage.
- [Timing tests](../../tests/work-timing.test.ts): first-output start, stream stalls, thinking/tool-call output, tool pauses, usage-only exclusion, TTFT exclusion, formatting, idle-gap spans, delivery gating, adoption, cut/abort statuses, promotion with a mid-turn metric cutoff, in-tool prompt human wait and ordering-based input binding.
- [Installed-host TUI regression](../../tests/work-timing-tui.test.ts): actual Pi/CC rendering with the competing CC writer disabled in disposable settings. It does not prove which writers are enabled in an existing user process.

Documentation-only clarification needs applicable structure/link checks and source inspection, not tests over literal prose or a new full runtime validation cycle. Changes to timing behavior or TUI integration use the corresponding existing tests; broader checks follow the affected behavior rather than this document's existence.
