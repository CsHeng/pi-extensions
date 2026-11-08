# Cache Keepalive

`extensions/cache-keepalive/index.ts` keeps an idle main session's prompt cache warm while Pi 1.5.0's own idle cache warming is unreliable. That warmer stops silently once the active context contains a `custom_message`, compaction summary or branch summary. Job Notifications delivers results as custom messages, so most working sessions are affected. The extension registers no tool, command, UI or context content.

## Activation

The extension acts only while Pi's effective `cacheWarming` setting is `"streaming"`, Pi's default. In that mode Pi still warms during long tool runs and stops when the run settles, and this extension covers the idle phase that follows. With `"idle"` it stands down so the official warmer is not doubled; with `"off"` it respects the choice of no warming. Returning to the official warmer is therefore a settings change: set `"idle"`. The setting is read again before every refresh, so a change applies to a pending refresh.

Only TUI and RPC sessions are warmed; print and JSON runs, including managed children, exit after their run. The model API must be `anthropic-messages`, and the model must declare `promptCache` for the active retention tier (`PI_CACHE_RETENTION=long` selects `long`; otherwise `short`).

## Behavior

The extension remembers the last `before_provider_request` payload of the current run and when it was sent. It never returns a replacement, so real requests are unchanged. Pi's own one-token warm replays are not captured. After `agent_settled`, if the payload names the active model and its thinking configuration is absent, disabled or adaptive, the extension schedules a refresh on Pi 1.5.0's warmer schedule:

- The first refresh is `min(0.9 × TTL, TTL − 10 s)` after the captured request: 270 s for a 300 s lifetime. Later refreshes use the same delay after each refresh starts.
- A timer that fires more than half the remaining margin late stops instead of paying a full rewrite of an expired entry.
- Warming ends 30 minutes after the last real request.
- Each refresh must satisfy Pi's idle economics, `0.15 × missCost − warmCost ≥ $0.05`, priced from the last assistant usage with the model's cost table.

A refresh calls `ctx.modelRegistry.streamSimple` with `maxRetries: 0`, the session ID and an `onPayload` that substitutes the captured payload with `max_tokens: 1`. Pi resolves the provider authentication, and no extension hook sees the refresh. Input, a new run or provider request, model or thinking-level change, compaction, tree navigation, and session start or shutdown cancel the schedule and abort an in-flight refresh. A failed refresh is recorded and not retried, because the next slot would come after the entry expired.

## Records

Each refresh appends one context-free custom entry, `csheng-cache-keepalive` (version 1). It holds provider, model, `outcome` (`warmed` or `error`), the response `usage` with cost, and the expected saving, or a bounded error text. Extensions cannot append Pi `usage` entries, so refresh cost appears in neither Pi's session totals nor the footer; these entries are the audit record. With `showCacheMissNotices: true` each successful refresh also shows a `Cache kept warm: $…` notice.

## Limits And Removal

The replay equals the real request only if no later-loaded extension replaces Anthropic payloads; `fast-gpt` changes only OpenAI requests. A relay that loses entries can still miss after a refresh; the refresh then reports a cache write, and the schedule continues because the entry is warm again. Removing the extension restores plain Pi behavior and leaves no state to migrate.

The extension is a workaround with an exit: the architecture open question OQ-3 in `$AGENT_ARCHITECTURE_DIR/docs/architecture/open-questions.md` records when to recheck Pi releases and how to switch back.

## Verification

Deterministic unit tests cover capture, eligibility, schedule, economics, cancellation, failure, late timers, settings stand-down and the replay request:

```bash
bun test tests/cache-keepalive.test.ts
bun run typecheck
```

A real provider cache hit is outside offline evidence. It was checked once with a disposable agent directory and the source extension loaded with `-e`; the dated result is in the architecture repository's `docs/evaluations/pi-integration/`.
