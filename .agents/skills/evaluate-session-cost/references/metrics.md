# Session Cost Metrics

Metric schema version two, produced by `scripts/session-cost-report.ts`. Pi 0.85.1's `computeCacheWaste` is the comparison oracle in `tests/session-cost-report.test.ts`.

## Requests

Cost and token totals include every assistant message, including empty-content messages with usage. `calls` counts all assistant entries; it is not proof that each entry reached a provider. The separate ledger request ordinal retains the existing non-empty-content convention so empty messages do not shift observation-pack joins.

All providers participate in rebill accounting. `codexCalls` is an informational subset count only. An assistant message with zero prompt usage leaves the previous effective request unchanged. `compaction` and `branch_summary` reset that request and the cache-activity flag, including when followed by empty or zero-usage messages.

## Cache re-billed

For each effective request in order, with `total = input + cacheRead + cacheWrite`:

- Skip the first request after startup or a context reset.
- Skip a zero-cache request unless earlier requests since the reset reported cache reads or writes. A current cache read or write is also sufficient evidence of cache support.
- `rebill = min(previousTotal, total) - cacheRead`
- Count a miss only when `rebill > minMissTokens` (default 1024, exclusive). Smaller amounts contribute neither tokens nor dollars.

Re-billed dollars are `rebill * max(0, paidRate - readRate)`, with `paidRate = (cost.input + cost.cacheWrite) / (input + cacheWrite)`, or zero when the denominator is zero. This includes cache-write premiums and preserves zero recorded charges. Model switches count as misses, as they do in Pi. The metric estimates lost cache savings; it does not compare prompt contents or establish actual billing errors. Cache hit rate is `cacheRead / (input + cacheRead + cacheWrite)`.

## Attribution

A rewrite break is the first `placeholder` ledger event per observation id; later placeholder events for the same id re-report the same stable placeholder and are not breaks. Categories are assigned per miss, in this precedence:

| category | condition | reading |
|---|---|---|
| `packIsolated` | rewrite at this ledger ordinal, previous effective request had no counted miss | strict attribution convention |
| `packRiding` | rewrite at this ledger ordinal, previous effective request also missed | broader attribution convention |
| `stall` | member of a stalled run | non-advancing cache signature |
| `other` | everything else | model switch or isolated miss |

A *stalled run* is two or more consecutive counted misses on the same provider/model where `cacheRead` did not advance and the request total exceeds the previous request's `cacheRead`. Clean requests, model switches, and context resets break the run. These categories describe timing and usage only; neither provider fault nor zero incremental rewrite cost follows from them.

## Savings

Every placeholder event contributes `removedTokens * calibration * price` where `price` is the price of the model that owned the request at the event's ordinal:

- `cacheReadBasis` uses that model's cache-read price, falling back to its input price when the model has no cache discount.
- `inputBasis` uses the input price and is the theoretical ceiling.

`replayTokens` sums the raw ledger units. `calibration` defaults to 1.3, converting the extension's chars/4 estimate to provider tokens; the factor was fitted on codex sessions by comparing reconstructed context size with reported prompt totals, and varies with content mix.

Net conventions: `strict = cacheReadBasis - packIsolated`, `full = cacheReadBasis - (packIsolated + packRiding)`, `optimistic = inputBasis - (packIsolated + packRiding)`.

## Prices

For rebill, the paid rate always comes from the current request. When `cacheRead > 0`, the read rate is `cost.cacheRead / cacheRead`, including a zero rate. Otherwise Pi consults its runtime model registry; this offline evaluator uses the installed built-in catalog and zero for an unknown model. It does not read user model settings or credentials, so a runtime price override can produce a dollar difference on complete misses. The token and miss counts are unaffected.

Counterfactual savings use the owning request's recorded ratio when that token bucket is nonzero, preserving free requests. An absent bucket uses the modal positive recorded price for the same provider/model over buckets above 1000 tokens. These savings estimates do not alter rebill or recorded spend.

## Worked example

Synthetic six-request astra session (`input $10/M`, `cacheRead $1/M`), one packed observation replayed twice:

| ordinal | input | cacheRead | total | growth | rebill | category |
|---|---|---|---|---|---|---|
| 1 | 12000 | 0 | 12000 | 12000 | 0 | — |
| 2 | 200 | 11904 | 12104 | 104 | 96 | — |
| 3 | 5000 | 11000 | 16000 | 3896 | 1104 | packIsolated |
| 4 | 9000 | 11000 | 20000 | 4000 | 5000 | stall |
| 5 | 6000 | 11000 | 17000 | -3000 | 6000 | stall |
| 6 | 8000 | 1000 | 9000 | -8000 | 8000 | other |

Rebill 20104 tokens, $0.180936. Replays 40000 ledger units, savings $0.052 cache-read basis and $0.52 input basis, so `netFull = 0.052 - 0.009936 = 0.042064`. This fixture is covered by `tests/session-cost-report.test.ts`.

## Known limits

- Rewrites and provider stalls share one signature. Category assignment is a convention based on adjacency and stall runs, not a measured cause.
- Usage records cannot distinguish real cache misses from incorrect provider reporting, or explain a later jump in reported cached tokens.
- Child sessions are counted from their own native logs. If Pi later forwards child usage into the parent, that total would double-count; re-validate against Session Info before publishing.
- Savings are counterfactual; a larger unpacked prompt can change cache behavior, pricing, and future work, so neither valuation is a guaranteed realized saving.
- Cost fields are nominal for subscription providers. A plan-backed provider can report large token counts at zero dollars; the report keeps those at zero rather than importing a list price.
