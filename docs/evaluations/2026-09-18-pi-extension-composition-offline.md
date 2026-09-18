# Pi Extension Composition: Bounded Offline Evidence

Date: 2026-09-18. Stable owner: [Pi extension integration map](../architecture/pi-extension-integration.md). Probe: [`scripts/probe-local-extension-composition.ts`](../../scripts/probe-local-extension-composition.ts).

This record establishes selected composition mechanisms, not acceptance of every installed extension together. No user configuration, extension implementation, installation, or provider selection was changed. RTK was not installed. The public adapter source was fetched before the offline run; no real inference, MCP server, Herdr, Bark notification, or browser service was invoked by the probe.

## Baseline and Evidence Classes

- **C — configuration:** allowlisted selected package filters and feature booleans, not complete settings. Selection is not proof of loading or feature activation in an existing process.
- **S — source:** local fixed-version code inspection. This establishes implementation paths, not their execution in the user's session.
- **O — offline observation:** actual Pi dependency host, explicit extension factories, official faux provider, disposable environment. It does not establish the currently running Pi's owners or loading order.
- **U — unverified:** real-process ownership, full-package co-load, UI patches, external integrations, model behavior, filtering fidelity, and savings.

| Component | Checked baseline | Scope |
| --- | --- | --- |
| Pi / repository SDK | `0.85.1` | Actual host event loop and tool registry in the offline run |
| First-party package | `@csheng/pi-extensions@0.1.0` | Source map; no full-package co-load claim |
| SoL-Pi | `bd005888b9b8a3fcdb511feb91fc27d3dfa8f2b1` | Local source; tracked lockfile modification is not treated as pristine release equivalence |
| pi-cc-extensions | `0.8.71` | Actual write-override leaf; full TUI stack not loaded |
| pi-mcp-adapter / pi-web-access | `2.31.0` / `0.29.0` | Static behavior map only |
| rpiv-todo | `2.10.1` | Installed, but its extensions are excluded by package selection |
| RTK Pi adapter | `6d104308c56c0a51250f8a200e5056787128fb65` | Actual adapter; `pi.exec` replaced with a fixed protocol fixture |

**Current configuration observation:** global SoL `actionFusion=true`, `observationPack=true`, `evidencePreservingReducer=false`, `onlineContextCompact=false`; project `.pi/sol-pi.json` absent. These are local choices, not SoL defaults: all four source defaults are false. CC `enableWorkingMessage=false`; first-party plan-mode is excluded; MCP package Skills are excluded, which does not exclude its extension.

SoL initializes features once at `session_start`. Editing its JSON after initialization does not unregister already installed tools/hooks. This session's exposed schema included `edit.then_run` but no `write.then_run`; that is a narrow interface observation, not a post-restart owner audit. No existing session transcript or full system prompt was exported.

## Oracle and Isolation

The probe reuses `tests/fixtures/workflow/host-fixture.ts`: actual `createAgentSession`, resource loader, extension runner, built-in tools and JSONL session manager, with the official faux provider. Explicit factories suppress automatic package/Skill/context-file discovery. It loads CC's `installWriteOverride` and SoL's fusion leaf at `session_start`, matching their registration point without importing CC's private renderer patches or SoL's disabled reducer/compaction branches.

Before dynamic imports, the process replaces its environment with a minimal PATH plus temporary HOME, agent directory and TMPDIR; real credentials are not inherited into the fixture. `fetch` throws, model refresh is off, and the selected provider is faux. This is isolation for a trusted-source test, **not an OS/network sandbox** for arbitrary extension code. No listening service is started. Session roots, runtime archives and temporary homes are removed after disposal, including failed-test cleanup; each successful harness disposal is checked for directory removal.

Dependency console output is discarded before source imports and during fixture execution; only a diagnostic count is retained, not raw error text. Separate receipt writers emit allowlisted results. An injected private-path diagnostic checks the discard sink, and any additional dependency console diagnostic fails the probe. This covers the inspected dependencies' console paths, not hostile code that bypasses console or a general OS output sandbox.

RTK's real `session_start` version check and `tool_call` handler execute, but `pi.exec("rtk", ...)` returns fixture responses: version `0.23.0`, then a rewrite to a harmless `printf`. This verifies interception and composition, **not the RTK binary's command support, semantic filtering, diagnostics, security, or actual token savings**.

## Results

| Case | Asserted observation | Limit |
| --- | --- | --- |
| CC only | `write` has CC metadata execution, no `then_run`; native `edit` has no fusion schema | Not CC TUI rendering acceptance |
| SoL only | Both `write` and `edit` expose `then_run`; fused write executes the command | Only fusion leaf loaded |
| CC then SoL | `write` remains CC's, `edit` is SoL's; source metadata differs | Controlled factory order, not observed user load order |
| SoL then CC | Both tools remain SoL's; CC detects external `write` and yields | No automatic wrapper composition or shared CC metadata |
| RTK + fusion | One top-level bash causes exactly one rewrite; fused write and edit run without additional bash events or rewrite calls | Actual adapter, stubbed CLI |
| Fusion failure | `exit 7` makes outer edit an error with `[then_run:failed]`, but edited file remains changed | No rollback; cancellation/crash cases not exercised |
| Real host event order | `tool_execution_start → tool_call → execute → tool_result → tool_execution_end` for each executed top-level call | Blocked/preparation-failure branches inspected statically, not exercised here |
| Pack + successful fusion | Large compound write result is full for two context projections, replaced on the third | Projection counts, not provider delivery receipts |
| History + recall | Full result remains in native memory and JSONL; `obs_recall` restores the middle fixture text from its archive | Does not test resume, compaction, missing archives or archive corruption |
| RTK + pack | Small post-rewrite fixture output reaches history/context and is not packed | Real RTK filtering and large post-RTK archives not exercised |
| Dependency diagnostics | Injected console diagnostic discarded; zero unexpected diagnostic writes in the successful run | Direct low-level output by arbitrary future code is not covered |
| Cleanup | Disposable homes, session roots and archives removed; no services started | Managed explorer registry/native retention is a separate existing policy |

All listed assertions passed in the final offline run. The exact source fingerprints below accompany the probe's redacted JSON receipt. The probe remains opt-in, outside `npm test`, because external locally installed source trees are not repository-owned test dependencies.

### Important Interpretations

1. **Compact off does not remove fusion.** Feature gates are independent. CC also has its own write override, unrelated to online compaction. Pack changes later context projections, not the write executor or schema.
2. **Fusion creates one outer observation.** The command directly invokes a bash definition; it is not a second top-level agent tool call. Outer `edit/write` guards can still block it. A bash-only guard or RTK adapter does not cover its nested command; observers must not invent a bash event.
3. **Do not reverse the host events in the diagram.** The nested `pi-agent-core` dependency owns dispatch. `tool_execution_start` precedes argument preparation and `tool_call`; `tool_result` precedes `tool_execution_end`. Reading only SDK callback declarations led to an incorrect candidate ordering during exploration; actual host execution and the core implementation resolve it.
4. **Pack and RTK are different layers.** Pack sees the result that reaches `context`, which may already have been filtered or transformed. Its recall cannot reconstruct output discarded before that boundary. The test establishes no inherent hook collision, but not semantic fidelity or a performance benefit.
5. **Workflow capture is not a pristine executor receipt.** Start observers run before command rewriting; end observers receive post-`tool_result` data. A fused mutation/check is still one compound observation. Later `context` packing is outside that observation, and end-hook arrival alone does not establish semantic acceptance.

## Source Fingerprints

Hashes identify the inspected/tested local bytes; they are not a full npm tarball, dependency-tree or release-integrity attestation.

| Source | SHA-256 |
| --- | --- |
| CC `extensions/renderer/tool/diff/index.ts` | `4f55b7b8db5bf42d94888d1051e3a202253706c4dc66506a77ef407015c71f00` |
| SoL `src/sol-pi/extensions/action-fusion/index.ts` | `c9123d9e0608a89559d78712d92d3e3e9a89d1bd3f3a96f0b2c3537e1dd23dc0` |
| SoL `src/sol-pi/extensions/action-fusion/then-run.ts` | `7d11bd97ed7bfb5c1a438f319c1343601f5eab26a07263ace2c9fd692b39385a` |
| SoL `src/sol-pi/extensions/observation-pack/index.ts` | `d259cd43fdbb082892950ac7efd5ddb92b65d97203285d91c3d05e90b101c6ad` |
| SoL `src/sol-pi/extensions/observation-pack/observation.ts` | `0ecbadb764200075656efedac82416cd8dde8dba9101d92bf5736f386539e2f2` |
| RTK `hooks/pi/rtk.ts` | `d1555e0af5872a30ed04059423350bdb38302f200a9642c5a9bcc519c95a2257` |

## Reproduction

Use an already provisioned checkout with its pinned dependencies. Supply the installed source package roots explicitly; no package discovery or installation is performed. First place the [pinned public RTK adapter](https://raw.githubusercontent.com/rtk-ai/rtk/6d104308c56c0a51250f8a200e5056787128fb65/hooks/pi/rtk.ts) in a caller-owned temporary file. The probe checks its SHA-256 before importing it. An internet fetch to obtain that file is outside the offline execution lane.

```bash
node --experimental-strip-types scripts/probe-local-extension-composition.ts \
  --sol-root "$SOL_PI_ROOT" \
  --cc-root "$CC_EXTENSIONS_ROOT" \
  --rtk-source "$RTK_ADAPTER_FILE"
```

The probe emits bounded case results, hashes and cleanup status, not tool inputs, sessions, provider selections or absolute source paths. Remove the caller-owned RTK source file after the run. Recheck source gates and oracle assumptions when versions/fingerprints change rather than interpreting an old passing receipt as a new compatibility guarantee.

## Documentation Review

One independent read-only reviewer checked the map, evidence record, probe and index additions. Both material candidates were accepted: the diagram must branch on preparation success before `tool_call`, and dependency console errors require suppression before the outer exception handler can redact them. The diagram and probe were repaired accordingly; the added diagnostic assertion belongs to the same offline oracle. Targeted re-review returned **pass**; it did not independently rerun the checks. No extension implementation or installed package was changed to make the checks pass.

Validation passed: `npm run typecheck`, the repaired offline probe, 20 local Markdown link targets, Markdown prose and documentation-boundary checks, and diff whitespace checks. The single merged sequence diagram parses/renders with Pi's installed `grok-mermaid` and no warnings after replacing reserved semicolons in labels. This is a local renderer check, not a full upstream Mermaid CLI/browser compatibility test. The complete repository test suite and live integration lanes were not run for this documentation/probe-only change.

## Remaining Verification Boundary

- Actual resolved package order and winning tool `sourceInfo` after a fresh daily Pi startup, including project trust/overrides.
- Full CC renderer/compact-thinking/private-patch compatibility and other UI writer combinations.
- Real RTK binary behavior, command families, exit/signal fidelity and output loss; no recommendation to install it follows from this probe.
- Workflow/web follow-up races and queued-input/abort interactions under full co-load.
- Native Pi compaction, SoL online compaction, packing recovery and model evidence use; SoL online compaction was not loaded in the test.
- MCP internal approvals and server lifecycle, loose notification latency/side effects, Herdr, and real managed child dispatch.
- Package release integrity beyond the listed local byte fingerprints.
