# Work-timing metrics

`work-timing` provides TUI timing feedback for one user message and every model turn and tool call it triggers. It owns the working row while that interaction is active and appends one context-free completion entry after `agent_settled`. It does not judge whether the user's task is complete, account for provider billing, or control execution.

**The displayed tok/s is decode throughput, not thinking-only speed or end-to-end inference throughput.** Thinking is part of the decode window; waiting for the first output and running tools are outside that window. The letter R has a different meaning in the separate status footer.

## Metric legend

| Display or term | Meaning and scope | What it does not mean |
| --- | --- | --- |
| `Working...` / `Worked for` | Work elapsed for the current user message, from `before_agent_start` through final settlement, including its turns, tools and intervening waits | Pure model-compute time or proof of business completion |
| Working-row `R` | Current turn's client-observed **thinking duration**; R abbreviates reasoning, a synonym here | The whole model request or the tok/s denominator |
| Working-row / completion-entry `ΣR` | Accumulated thinking duration across that user message's turns | Session-wide time or a duration to add again to decode time |
| Completion-entry thinking share | `ΣR / work elapsed`, displayed as a bounded percentage | Thinking's share of decode time, or a provider GPU-utilization measurement |
| `tok/s` | **Decode throughput**: eligible streamed-turn output tokens divided by their accumulated observed decode windows | Output divided by total work or by request-wide inference time |
| `⚙ <elapsed>` | The longest-running currently active tool, after at least two seconds; `+N` counts the other concurrent tools | Sum of parallel tools' durations or proof that the tool is making progress |
| `↑` / `↓` | Input/output counts accumulated for the current user message; positive sides are shown | The footer's session-cumulative counts or a precise tokenizer measurement in every case |
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

## Live and settled presentation

The live field order is work elapsed, the optional active-tool field, the input/output counts, `R / ΣR`, then tok/s. Work elapsed and token counts remain cumulative and visible while tools run, subject to terminal-width compaction. The active tool timer excludes time spent waiting on extension UI prompts. A compound/fused tool call has its own tool clock; it does not imply an independently timed nested bash command.

A one-second clock lane samples work elapsed, current-turn thinking, cumulative thinking and tool elapsed together. A stream lane refreshes counts and tok/s immediately while using that cached duration sample. Both lanes use one formatter and one working-line writer; lifecycle boundaries may refresh the complete sample. Unchanged text is not republished. This avoids alternating short and full working messages without pretending that a one-second UI cadence measures individual tokens.

The live label targets the host's single-line working row: fullscreen only renders a message's first line. It uses `process.stdout.columns`, then `COLUMNS`, then 80, subtracting the loader's two-column padding and the spinner's two leading columns. Fields preserve order and are omitted whole when they do not fit, instead of being truncated mid-field. The R/ΣR pair stays together with the active tool field at narrow widths. Resize repaints immediately.

The settled entry uses final cumulative values, replaces the live R/ΣR pair with cumulative thinking and its work-time share, and keeps every applicable field. It folds at ` • ` boundaries and word-wraps an individually over-wide field. Collapsed and expanded views render the same entry line. A nonzero sub-second thinking duration appears as `<1s`, avoiding an apparent `0s` next to a nonzero percentage.

## Persistence, ownership and compatibility

The `work-timing` entry is display-only and context-free. Existing names such as `reasoningMs`, `generationMs` and `streamedOutputTokens` retain their current meanings: thinking-event duration, observed decode windows and the output count of streamed turns. They are not relabeled as a newly measured inference or TTFT duration. Older records remain readable; version-one entries render without the cumulative token segment and missing rate inputs do not fabricate a speed. No history rewrite or schema migration is needed to clarify the terminology.

`work-timing` must remain inactive in headless modes and clean up its interval on settlement and session shutdown. Disabling/removing the extension stops future timing behavior; it does not rewrite retained session entries or transfer ownership of the working row to another first-party component. `status-footer` owns the footer and `subagents-ui` its observer view independently.

When co-loaded with `pi-cc-extensions`, that package's independent `enableWorkingMessage` writer must be off for this extension to own the row without competition. Refresh frequency does not arbitrate writers. Configuration is user-owned: runtime code must not change another extension's settings or patch Pi UI methods to claim the row. Editing this source checkout does not establish what an already-running Pi process or copied installed package loaded.

This product document is the metric reference. Shared integration guidance lives at `$AGENT_ARCHITECTURE_DIR/docs/architecture/pi-extension-integration.md`; it explains composition, not another implementation or runtime dependency. Future TTFT instrumentation, different throughput definitions, UI relabeling and execution-observation changes require their own explicit behavior decisions rather than silently changing these counters.

## Source and verification references

- [Work-timing implementation](../../extensions/work-timing/index.ts): decode signals, token estimates, clocks, renderers and cleanup.
- [Status-footer implementation](../../extensions/status-footer/index.ts): the separate cache-read R and session-cumulative usage.
- [Timing tests](../../tests/work-timing.test.ts): first-output start, stream stalls, thinking/tool-call output, tool pauses, usage-only exclusion, TTFT exclusion and formatting.
- [Installed-host TUI regression](../../tests/work-timing-tui.test.ts): actual Pi/CC rendering with the competing CC writer disabled in disposable settings. It does not prove which writers are enabled in an existing user process.

Documentation-only clarification needs applicable structure/link checks and source inspection, not tests over literal prose or a new full runtime validation cycle. Changes to timing behavior or TUI integration use the corresponding existing tests; broader checks follow the affected behavior rather than this document's existence.
