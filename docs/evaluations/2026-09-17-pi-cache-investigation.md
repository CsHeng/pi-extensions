# Independent Pi cache investigation, 2026-09-17

The reproducible finding is intermittent loss of reported cached input on the Codex OAuth Responses endpoint while the client preserves its previous input and request settings. It also occurs with hand-written HTTP requests that bypass Pi, extensions, skills, and Pi's message serializer. This isolates the short reproducer to the Codex interface/backend behavior. It does not establish a physical cache miss, a model-weights defect, a specific backend failure, or the cause of every historical cache miss.

The historical long freezes are real, but their exact trigger remains unresolved. The synthetic probes reproduced full misses and backwards cache movement, not a 50-request freeze. Historical JSONL cannot recover all original system prompts, tool definitions, request headers, extension transformations, or server-rendered context. These limits prevent assigning the entire historical re-billed amount to the mechanism seen in the short probes.

Evidence is retained in [the redacted measurements](2026-09-17-pi-cache-investigation.json). Investigation ran approximately 11:51–12:15 UTC. Only six explicitly selected parent sessions were evaluated; this is not a rolling-window report and does not include managed child spend. Historical costs are Pi's recorded nominal amounts. Probe costs use Pi's model-catalog rates and observed usage, not an invoice. No chars/4 calibration or observation-pack savings estimate is used.

The initial investigation added this report and its measurements. Runtime settings, installed packages, provider configuration, original sessions, and the existing uncommitted evaluator were left untouched during that investigation. A later same-day correction updated the evaluator and its tests and documentation, as recorded below. Synthetic probes used one in-flight model request at a time and read existing authentication without refreshing or persisting it. No real project prompts were sent by these probes.

## Historical accounting cross-check

The installed-version source's `computeCacheWaste` was evaluated independently of the session-cost skill. For the first 79 assistant messages of `01a09ea9-2bc9-7185-a350-6fb8c4efc740`, it exactly reproduced the user's historical Session Info screenshot after display rounding:

| Measurement | Independent result | Historical panel |
| --- | ---: | ---: |
| Uncached input | 1,307,405 | 1,307,405 |
| Cached input | 5,965,952 | 5,965,952 |
| Output | 43,154 | 43,154 |
| Total nominal cost | $21.197702 | $21.198 |
| Re-billed tokens | 1,098,617 | 1,098,617 |
| Re-billed nominal cost | $9.887553 | $9.888 |
| Misses | 45 | 45 |

The version-one evaluator differed from that host implementation. It counted only `openai-codex` for re-billing, retained the previous prompt across compaction, used a 1,000-token threshold instead of the host's strictly-greater-than-1,024 threshold, and could substitute modal prices for zero-cost records. Its `stall` attribution is a heuristic classification, not evidence that a provider caused the miss. The `packRiding` category likewise does not measure the counterfactual marginal cost of a rewrite.

| Parent session | Total nominal cost at audit | Host re-billed cost | Version-one evaluator re-billed cost |
| --- | ---: | ---: | ---: |
| `01a0acfc-af3f-74eb-abbe-1ac0341f1932` | $136.922582 | $49.557447 | $50.679774 |
| `01a0ae0e-0a2f-74d1-a3ed-1d4a212caf1b` | $87.477352 | $30.520638 | $30.772566 |
| `01a0adbb-5f7e-7410-944f-d92a37b56d8b` | $31.212798 | $0.135473 | $0 |

The Grok session has three host-counted misses. The earlier cross-provider comparison treated an uncomputed metric as zero. Grok's overall cache performance is still much better in this sample, but the previous zero cannot establish that all client prefixes were stable. The larger current total for `01a0ae0e` reflects messages added after the earlier conversation's report.

The most informative historical intervals are:

| Session prefix | Assistant ordinal interval | Constant cache read | Prompt growth | Preserved prior input pairs in offline reconstruction |
| --- | --- | ---: | --- | ---: |
| `01a0acfc` | 366–415 | 15,360 | 56,496 → 123,999 | 49/49 |
| `01a0ae0e` | 27–76 | 71,552 | 75,079 → 170,807 | 49/49 |
| `01a0850a` | 489–566 | 13,952 | 39,154 → 110,814 | 77/77 |

The ordinal here includes assistant records with usage, including unsuccessful records; it is not the evaluator's non-empty-content request ordinal. Reconstruction used Pi's `buildSessionContext`, `convertToLlm`, and `convertResponsesMessages` against each assistant entry's parent. Equality was checked over serialized prior input items. This verifies the persisted history and current core serializer, not the original wire request or live extension hooks. The two September 17 intervals alone demonstrate why a few hundred tokens of cache boundary granularity cannot explain the severe historical cases.

## Controlled live probes

Synthetic reference records were kept stable; each appended block added approximately 1,300 tokens. Request comparisons recorded hashes and equality checks without retaining prompts, authentication, or routing tokens in the evidence artifact. SSE probes compared the provider's terminal usage with Pi's parsed usage. Successful completed responses agreed. The installed binary was independently exercised with extension, skill, and context-file discovery disabled and one explicitly loaded synthetic tool.

| Probe | Observed cache behavior | Interpretation |
| --- | --- | --- |
| Pi AI, Luna, SSE, 8 requests | `0, 3456, 4480, 0, 5504, 8576, 9600, 10624` | Full miss with unchanged previous input and fixed parameters |
| Same setup with `thread-id`, 8 requests | Full miss at request 5 | Adding this header alone is insufficient |
| WebSocket plus `thread-id`, 8 requests | Full misses at requests 4 and 6 | This transport/header combination is also insufficient |
| Installed Pi 0.85.1, Luna, 9 requests | Full miss at request 4; later cache read drops from 8,704 to 6,656 | Reproduced outside the direct SDK harness |
| Hand-written HTTP, Luna, user messages only | Requests 2–3: input 4,931 → 6,239; cached 2,816 → 0 | Pi serialization and tool-call replay are unnecessary for reproduction |
| Identical whole HTTP body, 8 requests | First two requests miss; remaining six consistently read 2,816 of 3,623 tokens | Cache can work; a fixed boundary alone is not a freeze |
| Luna, one approximately 45,000-token addition, then append/repeat | Cache reaches 53,632 of 54,195 and stays there on identical repeats | Large growth alone did not trigger the historical failure |
| Terra, 5 requests | No full miss after first hit | Too small a sample to establish immunity |
| Sol, 5 requests | Request 4 returns zero cached tokens | Short full misses are not exclusive to Astra |
| Astra | One completed request; next request did not finish before local termination | No valid conclusion about Astra's live cache behavior from this arm |

The initial small historical Luna probe grew only from roughly 1.7k to 2.0k tokens. In these new Codex endpoint experiments, advancing cache values commonly move by 1,024 tokens or multiples thereof and are reported on a 128-token grid. Several identical values during small growth therefore cannot, by themselves, establish the same failure as the long historical freezes. This is observed endpoint behavior; it is not an assertion that every OpenAI model uses the same boundaries.

The service also returns `x-codex-turn-state`. An initial eight-request trial replaying it with `thread-id` had no full miss, so that apparent improvement was tested again with unique leading synthetic prefixes to avoid warming from earlier arms. The repeated HTTP/1.1 arms ran in control, replay, replay, control order. Only replay arms returned the opaque server value on subsequent requests; it was retained when later responses omitted the header.

The second fresh replay arm still returned zero cached tokens at request 5, after reading 5,888 at request 4. It later moved backwards from 7,936 to 6,912. The final control arm also had a full miss. Replaying turn state is therefore not a sufficient fix for this reproducer. These small arms do not estimate a reliable comparative miss rate or establish that the header has no value.

The public Responses API documents cache-affecting settings and a `prompt_cache_options.comparison_response_id` diagnostic. The tested Codex OAuth endpoint rejected `prompt_cache_options` as unsupported. The public API's diagnostic and newer cache-boundary rules cannot be assumed to apply to this endpoint. See [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching) and [cache diagnostics](https://developers.openai.com/api/docs/guides/prompt-caching/diagnostics).

## Cost and remaining uncertainty

Retained usage values the probes at **$0.252193 nominal**. This is an incomplete total: the second Astra request and one raw HTTP request that ended with an HTTP/2 stream failure have no retained final usage. Their cost is unknown. One Luna reasoning probe was locally aborted after terminal provider usage had been captured; its raw usage valuation is included even though Pi's aborted message recorded zero. The unsupported-parameter request is retained as a rejection, not a successful inference measurement.

The investigation establishes that stable client prefixes can lose reported cache reuse through the Codex OAuth route without any custom extension or skill. It rules out blaming Pi's usage parser for the completed synthetic misses and disproves the proposed headers or transport change as sufficient fixes. It does not prove that cache routing, eviction, delayed writes, hidden server context, usage accounting, or another backend mechanism is the cause. Reported misses alone are not proof of physical recomputation or a provider contract violation.

No package replacement or runtime patch is justified as a verified remedy by this evidence. The next decisive observation for the prolonged freezes is a contemporaneous trace of the actual failing session: final outgoing system/tool/input fingerprints and request settings, prior-input equality, raw response usage, transport transitions, and provider request identifiers. Historical JSONL and the short probes cannot substitute for that trace. An official Codex CLI comparison and an independently billed OpenAI API comparison were not performed; neither is claimed as evidence here.

## Same-day evaluator correction

Report schema version two now includes all providers and all assistant usage, preserves the ledger's separate non-empty-content ordinal, resets cache history at compaction and branch summaries, uses the exclusive 1,024-token noise floor, and includes cache-write tokens and their paid cost. Zero-charge requests no longer inherit another request's paid rate. Rewrite adjacency uses the previous effective request rather than the last historical miss. Classification remains descriptive, not causal.

The corrected evaluator was compared with the installed Pi 0.85.1 `computeCacheWaste` on the same in-memory JSONL snapshot for each of the six sessions. Tokens and miss counts matched exactly and dollars agreed within 1e-9. It also reproduced the 79-message historical panel checkpoint above. This comparison excludes counterfactual ledger savings and involves no provider calls.

| Session prefix | Re-billed tokens | Re-billed nominal cost | Misses |
| --- | ---: | ---: | ---: |
| `01a0acfc` | 5,506,383 | $49.557447 | 115 |
| `01a0ae0e` | 3,391,182 | $30.520638 | 97 |
| `01a0adbb` | 90,315 | $0.1354725 | 3 |
| `01a09ea9` | 2,050,346 | $18.453114 | 72 |
| `01a0850a` | 37,938,594 | $341.447346 | 416 |
| `01a09ec6` | 935,524 | $0.9033400944 | 9 |

On requests with zero cached tokens, Pi reads the runtime model registry's cache-read price. The evaluator uses the installed built-in catalog instead, without reading user settings. Runtime price overrides can therefore produce dollar differences on other sessions; tokens and miss counts do not depend on that fallback. This is documented in both output formats.

Validation passed: `npm ci --ignore-scripts`, `npm run check` (type checking, 541 tests, shell syntax), all eight temporary/installed offline probes for plan-mode, subagents, herdr-handoff, and workflow, and skill frontmatter validation. The focused evaluator suite contains eleven tests, including comparisons against the actual host calculation. No live inference was needed for this correction.

## Public evidence checked on 2026-09-17

Server-side accounting errors are a supported hypothesis with a confirmed historical precedent, not an established diagnosis for these sessions:

- **2026-07-10, confirmed accounting bug:** a GPT-5.6 API report showed 4,583 prompt tokens, 3,945 cached tokens, and 4,580 cache-write tokens. OpenAI staff member `andyw1` replied that some request types were accounted incorrectly, the bug had been fixed, and refunds would be calculated. This establishes a historical accounting defect, not that it persists or explains the Codex OAuth experiments. [Report and staff response](https://community.openai.com/t/question-about-gpt-5-6-api-cache-read-write-token-billing/1386256/8); [staff profile metadata](https://community.openai.com/u/andyw1.json).
- **2026-06-28, unresolved matching symptom:** Codex issue #30425 reports stable request fingerprints and cache keys but zero cached tokens on repeated 74,371-token requests, with successful cache reuse in adjacent traffic. The report is open; it does not distinguish physical misses from incorrect reporting. [Issue #30425](https://github.com/openai/codex/issues/30425).
- **2026-09-11, controlled Codex OAuth observations:** issue #44716 describes frozen request replays and HTTP/WebSocket session-header interventions. Cache reuse varied despite fixed JSON keys, and an unchanged baseline also returned zero. Its author explicitly limits the conclusion to reported usage and requests backend interpretation. It is open and does not validate a production header workaround. [Issue #44716](https://github.com/openai/codex/issues/44716).
- **2025-01-02–09, older billing discrepancy reports:** users reported high per-response cache counts but little cached usage in the dashboard/Usage API; later replies reported recovery and a support investigation of potential overcharges. These are historical user and moderator reports, not proof about current models. [Community thread](https://community.openai.com/t/dashboard-usage-vs-prompt-response-usage-not-matching/1078218).

The current official diagnostics documentation explicitly says that a changed cache key can produce a reported usage miss without a physical miss. This is a documented accounting distinction, not inherently a bug; the fixed-key probes here are not explained by that statement alone. Public API documentation also does not establish every behavior of the Codex-authenticated gateway. [Prompt cache diagnostics](https://developers.openai.com/api/docs/guides/prompt-caching/diagnostics).

The decisive missing evidence is provider-side correlation of request/response identifiers with physical cache reuse, emitted usage, and the account's actual debit. An API-key project's cost records could test billing reconciliation separately, but would not by itself establish Codex subscription quota behavior.
