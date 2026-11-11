---
name: evaluate-session-cost
description: "Use for read-only cost and prompt-cache evaluation of Pi sessions, either a time window or explicit session ids: Pi's Cache re-billed metric, rewrite-versus-provider-stall attribution, avoided-replay savings, per-model breakdown, and net cost with percentages."
---

# Evaluate Session Cost

Measure what a set of Pi sessions actually cost, how much context was re-billed after cache misses, and whether observation-pack rewrites paid for themselves. The evaluation is read-only: sessions, settings, ledgers, route files, and the running Pi process remain unchanged.

## Boundary

- Limit reads to session JSONL, `sol-pi/<session-id>/observation-pack/ledger.jsonl`, and the installed Pi model catalog; Pi SQLite, credentials, settings, and unrelated state remain outside the evaluation. The catalog supplies the cache-read rate only when a request reports zero cached tokens, matching Pi's fallback; runtime price overrides remain unavailable offline.
- Emit per-session ids, providers, and models; keep absolute paths, prompts, tool output, task objectives, and environment values out of the report.
- Treat every dollar as Pi's recorded nominal cost. For subscription providers (`openai-codex`, plan-backed `zai-coding-cn`, `deepseek`), recorded nominal costs support relative comparison inside one pricing regime; invoices establish actual charges.
- Report both attribution conventions and label them: `packIsolated` counts rewrite-coincident misses after a clean request; `packIsolated + packRiding` also includes those immediately following another miss. Causal attribution requires separate evidence.
- Treat savings as a counterfactual valuation; recorded credits belong to actual billing. The cache-read-price figure assumes a healthy cache; the input-price figure is a theoretical ceiling.
- Treat a stall as a usage signature requiring separate request-level investigation. Usage alone cannot distinguish prefix changes, routing, eviction, real misses, and incorrect provider reporting.
- Calibration converts the extension's chars/4 ledger units into provider tokens. Label the actual factor; its accuracy depends on content, and an error bound requires separate evidence.
- Use multiple representative windows to benchmark and support any recommendation to enable, disable, or reconfigure an extension.

## Run

From the `pi-extensions` repository:

```bash
bun \
  .agents/skills/evaluate-session-cost/scripts/session-cost-report.ts --window-hours 72
```

Explicit sessions bypass the window and may span projects:

```bash
bun \
  .agents/skills/evaluate-session-cost/scripts/session-cost-report.ts \
  --session <session-id-or-jsonl-path> --session <session-id-or-jsonl-path>
```

Useful options: `--agent-dir <dir>` (default `$PI_CODING_AGENT_DIR` or `~/.pi/agent`), `--now <iso>` to freeze a window for a reproducible report, `--format json`, `--output <new-file>` (refuses to overwrite), `--calibration <n>`, `--min-miss-tokens <n>`.

`--window-hours` scans both `sessions/**` parent sessions and `managed-agents/session_*/native.jsonl` child sessions. Child spend is real spend and belongs in the total; child ledgers are matched by session id.

## Interpret

1. Validate the metric against Pi's own surface before trusting a report. At defaults it follows Pi 0.85.1 across all providers: all assistant usage is counted, summaries reset cache history, and a miss must exceed 1024 tokens. `/session` tokens and miss counts should match exactly for the same snapshot; only dollar display rounding is expected. Re-billed dollars use that request's recorded paid rate, including cache writes. Zero paid cost stays zero. For complete misses, catalog versus runtime model-price differences can affect the dollar comparison.
2. Read the attribution table as a decomposition; causal attribution requires separate evidence. `packIsolated` means a rewrite coincides with a miss after a clean request; `packRiding` means the previous effective request also missed; the rewrite's incremental cost requires separate evidence. `stall` describes a same-model run of non-advancing cache reads; `other` includes model switches and isolated misses. First requests after a context reset are exempt from rebill.
3. Read savings only next to pack cost: `netStrict`, `netFull`, and `netOptimistic`. Report the convention you used with the number.
4. Compare before/after activation windows only when model and workload are comparable, and prefer per-model rows over window totals. On cheap providers the same avoided replays are worth cents, so value replay counts using the applicable price.
5. Investigate a low cache-hit rate using actual outgoing prefixes before claiming the client context only appends or attributing a defect to an extension. The evaluator cannot establish this from usage records.
6. Keep other extensions' settings and Pi unchanged when investigating a cache rate. Keep provider-side explanations provisional until a controlled reproduction or provider evidence distinguishes them.
7. State scope in the report: window bounds, `--now`, calibration, and that managed child sessions are included. Correction of a previously published number must name the metric that changed.

## Verify

```bash
bun test tests/session-cost-report.test.ts
bun run typecheck
```

Metric definitions, the worked example, and the known limits are in `references/metrics.md`.
