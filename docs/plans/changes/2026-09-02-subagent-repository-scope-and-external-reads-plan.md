```toml
artifact_kind = "plan"
plan_version = 1
approval_status = "approved"
approval_basis = "The user explicitly approved this plan and authorized implementation in pi-extensions through a delegate-return Herdr handoff to the user-owned grok-impl launch profile on 2026-09-02."
decision_state = "approved"
approved_design = "docs/plans/changes/2026-09-02-subagent-repository-scope-and-external-reads-design.md"
approved_design_sha256 = "c378a12d2c44dc8dde3be2a9ab91e88451f8b31be33b5d7a4f22814eb67f7668"
implementation_authority = true
review_required = true
review_status = "passed_after_repair"
```

# Subagent Repository Scope Resolution And External Reads Plan

## Milestone objective

Implement the approved repository-aware path contract in `pi-extensions` without changing model routing, scheduling limits, worker write authority, telemetry schema, user configuration, or any sibling repository.

The completed runtime will:

- interpret all task `scope` entries from one canonical parent Git toplevel;
- safely canonicalize current-repository absolute and parent-traversing spellings;
- preserve contained missing scope for existing create-file workers and absence checks;
- reject physical escape, non-Git parent workspaces, unsafe path strings, and undeclared external access before child launch;
- allow at most eight exact external Git-contained read roots on explorer/reviewer tasks only;
- produce manifest v2 while retaining strict manifest-v1 read compatibility for in-place source skew;
- keep worker snapshots, exact writes, convergence, child cwd, and every mutation repository-local;
- keep extension-authored telemetry, progress, probes, evaluator output, and debug rendering free of external-root values without rewriting bounded untrusted child output.

This plan does not install or publish the package, make provider calls, edit Pi user state, commit, push, deploy, add cross-repository workers, or introduce a repository permission registry.

## Approved decisions and stop conditions

The approved design fixes these boundaries:

- `scope` is repository-root based for every role and is canonicalized only after current-project trust;
- missing internal scope remains admissible through nearest-existing-ancestor containment;
- `writePaths` remains strict, exact, repository-relative, and worker-only;
- `externalReadRoots` is explicit, absolute, existing, Git-contained, max eight, and explorer/reviewer-only;
- external project resources are not loaded and external paths never enter child cwd or worker snapshots;
- the parent call is the external-read capability grant; the extension does not read Pi trust storage;
- one invalid task still rejects the complete batch;
- manifest v2 is produced, exact v1 is read as no-external-root compatibility, and unknown or widened v1 manifests fail closed;
- runtime telemetry stays schema version two and stores no path or repository counter;
- bounded child output remains untrusted evidence and is not silently path-redacted.

Return `needs_design_decision` instead of widening implementation if any task requires external worker reads, another repository as child cwd, external writes, arbitrary non-Git roots, persistent aliases, per-task permission prompts, partial graph admission, a telemetry-version change, or mutation of Pi user state.

## Prerequisites and authority

| Prerequisite | Status |
| --- | --- |
| Approved design exists and its hash matches the plan header | Satisfied at plan creation; recheck before implementation |
| Repository root is `pi-extensions` and unrelated work is inventoried | Required implementation preflight |
| Plan approval and repository implementation authority | Granted for the bounded `pi-extensions` write sets through the requested Herdr delegate-return handoff |
| Provider credentials or live-call authority | Not required |
| User repository registry, Pi trust-file access, or sibling-repository mutation | Not permitted or required |
| Commit, push, publication, deployment, or global install authority | Not granted |

Implementation is authorized only within the declared `pi-extensions` write sets through the requested Herdr delegate-return handoff. This approval does not authorize commit, push, publication, deployment, provider calls, user-state writes, persistent installation, or sibling-repository mutation.

## Oracle strategy

The protected boundary is filesystem capability admission and child tool authorization. Use deterministic contract examples, disposable Git worktrees, physical symlink fixtures, component tests, fake child integration, runner prompt capture, and existing offline package probes.

| Boundary | Oracle | Fixture / owning suite | Failure meaning |
| --- | --- | --- | --- |
| Public task and manifest shapes | TypeBox/schema contract examples | `tests/subagents-contract.test.ts` | Caller compatibility, bounds, roles, or stable error contract drifted |
| Git-root and path canonicalization | Table-driven component tests | New disposable-Git repository-policy suite | Scope was misbased, escaped physically, or lost create-file compatibility |
| Graph relationships after canonicalization | Deterministic graph examples | Repository-policy plus scheduler/workspace tests | Write containment, dependency, or conflict checks saw noncanonical paths |
| Child read/write authorization | Security-boundary examples | `tests/subagents-guard.test.ts` with internal/external/symlink fixtures | External capability widened, traversal escaped, or writes reached external roots |
| Prompt and manifest handoff | Fake Pi subprocess capture | `tests/subagents-runner.test.ts` | Child received ambiguous roots, wrong manifest version, or unbounded prompt data |
| Trust/order/runtime integration | Fake extension dependencies and child | `tests/subagents-extension.test.ts` | Filesystem probing happened before trust, invalid paths launched, or roots reached the wrong subsystem |
| Stable product behavior | Documentation review and package gates | Stable docs, `npm run check`, offline probes | Runtime and maintained truth disagree or package integration regressed |

No live provider oracle is justified. The changed behavior is fully deterministic and provider-independent.

Oracle deletion, assertion weakening, broad “any error” matching, string-prefix containment, bulk snapshot updates, child-output rewriting, or external-write acceptance requires explicit review and is not an in-scope repair.

## Execution order

```text
G0 plan approval + pi-extensions implementation authority
└── PEX-100 freeze additive task, path, error, and manifest contracts
    ├── PEX-200 implement canonical repository admission and graph normalization
    └── PEX-300 implement manifest compatibility and external-read guard policy

PEX-200 -> PEX-400 render bounded canonical roots into the child prompt
PEX-200 + PEX-300 + PEX-400 -> PEX-500 integrate trust/order/root/capability execution
PEX-500 -> PEX-600 synchronize stable truth
PEX-600 -> INT-700 full deterministic verification and bounded implementation review
```

After PEX-100 freezes shared contracts, PEX-200 and PEX-300 have disjoint write sets and are factually independent. PEX-400 depends on the normalized task shape from PEX-200. PEX-500 and all acceptance/review decisions remain active-parent convergence work.

This plan records factual dependencies only. A later implementation owner may choose serial execution; it must not manufacture hard edges between independent slices or delegate final verification, adjudication, repair selection, truth acceptance, or completion claims.

## Tasks

### PEX-100 — Freeze task, path, error, and manifest contracts

**Depends on:** G0

**Objective:** Add the approved public field and private manifest types before behavior changes.

**Write set:**

- `extensions/subagents/contracts.ts`
- `tests/subagents-contract.test.ts`

**Changes:**

- Add `HARD_LIMITS.maxExternalReadRoots = 8` and a 4,096-byte per-path limit.
- Add optional `externalReadRoots` to `SubagentTaskSchema` and `SubagentTask`, bounded to eight nonempty strings with an explorer/reviewer-only model-facing description.
- Update the `scope` description to prefer repository-relative paths and `.` while explaining that physically contained spellings are canonicalized and external roots use their own field.
- Preserve exact repository-relative `writePaths` wording and behavior.
- Add the approved stable error codes without renaming existing historical codes.
- Define exact private manifest v1 and v2 shapes plus a normalized runtime capability shape. V1 has no external field; v2 adds `externalReadRoots`.
- Keep runtime telemetry schema at version two with no new path/root counters.
- Keep every omitted-field caller valid.

**Completion conditions:**

- old explorer, reviewer, and worker task fixtures still validate;
- explorer/reviewer fixtures accept zero through eight external roots and reject nine;
- the schema remains additive and rejects unknown task fields;
- stable error codes and manifest versions are exact;
- telemetry v2 types remain byte-for-byte shape-compatible except for unrelated TypeScript type imports.

**Verification:**

```bash
node --experimental-strip-types --test tests/subagents-contract.test.ts
npm run typecheck
```

**Recovery:** Fix forward inside the write set. If the public field requires a telemetry or persisted-session migration, stop with `needs_design_decision`.

### PEX-200 — Canonicalize repository paths and preserve graph invariants

**Depends on:** PEX-100

**Objective:** Introduce one repository-policy owner for Git discovery, safe path grammar, physical containment, and canonical task paths before graph relationship checks.

**Write set:**

- `extensions/subagents/repository-policy.ts` (new)
- `extensions/subagents/graph.ts`
- `extensions/subagents/workspace.ts`
- `tests/subagents-repository-policy.test.ts` (new)
- `tests/subagents-workspace.test.ts`
- `tests/subagents-scheduler.test.ts`

**Changes:**

- Move or extract canonical Git-toplevel discovery from `workspace.ts` into the new repository-policy module; use Git itself so linked worktrees are supported.
- Add an injectable bounded Git/filesystem resolver seam for deterministic extension tests without ambient repository dependence.
- Enforce the shared path grammar before prompt-bound values are admitted: max 4,096 UTF-8 bytes; no NUL, ASCII C0 controls, DEL, or Unicode line/paragraph separators.
- Separate structural graph validation from trusted asynchronous repository admission and post-canonicalization graph relationship validation.
- Resolve all relative `scope`, including leading parent traversal, from the canonical Git toplevel; absolute scope remains absolute for containment evaluation.
- For existing targets, use physical canonical paths. For absent internal targets, require the nearest existing ancestor to resolve inside the Git root and retain a normalized repository-relative lexical path.
- Convert current-repository paths to canonical repository-relative form and use those values for `write_outside_scope`, prompt projection, graph output, worker setup, and child capability creation.
- Resolve each external root as an existing canonical file or directory inside a Git worktree; reject nonabsolute syntax, unavailable/non-Git/special targets, current-repository targets, worker declarations, and post-canonicalization duplicates with the approved code.
- Keep worker `writePaths` lexical, exact, repository-relative, and unchanged.
- Make `workspace.ts` consume the shared root helper so read-only and worker roots cannot drift.
- Keep complete-batch admission and existing dependency/cycle/lock/concurrent-write semantics.
- Ensure typed error messages are actionable but contain no raw absolute target.

**Oracle matrix:**

- ordinary `.`, nested directory, and file scopes;
- absolute current-root and nested current-repository scopes;
- `../<current-repository>/...` physically returning to the root;
- sibling absolute and parent-traversing paths;
- existing internal symlink resolving inside versus outside;
- missing internal file with contained parent, including a worker exact new-file target;
- non-Git current cwd;
- unsafe control characters and overlong path values;
- external Git toplevel, subdirectory, and file;
- external missing, non-Git, special, current-repository, duplicate-canonical, and worker-declared roots;
- canonical scope still enforcing exact write containment and concurrent conflicts.

**Verification:**

```bash
node --experimental-strip-types --test \
  tests/subagents-repository-policy.test.ts \
  tests/subagents-workspace.test.ts \
  tests/subagents-scheduler.test.ts
npm run typecheck
```

**Recovery:** Fix forward. Never recover by using string-prefix containment, treating any discovered Git repository as implicit authority, or changing `writePaths` semantics. If Git-toplevel resolution cannot be made deterministic through current public/runtime dependencies, stop before integration.

### PEX-300 — Enforce manifest v1/v2 and external read capabilities

**Depends on:** PEX-100

**Objective:** Permit exact external reads without weakening the existing internal read or write guard.

**Write set:**

- `extensions/subagents/path-policy.ts`
- `tests/subagents-guard.test.ts`

**Changes:**

- Parse exact manifest v1 as internal roots plus `externalReadRoots: []`; reject v1 objects that carry external fields.
- Parse manifest v2 with separate internal and external roots; reject unknown versions.
- Require every v2 external root to be absolute and already canonical. Reject relative values and symlink aliases even when they eventually resolve to an otherwise admitted target.
- Require internal read roots and every write path to remain under the manifest root.
- Reject any worker external root and any explorer/reviewer write capability.
- For relative read requests, resolve only under the internal root; traversal cannot select an external root.
- For absolute reads, require a declared internal or external file/subtree match and then repeat physical `realpath` containment at access time.
- Preserve file-valued root exactness and directory subtree semantics.
- Reject undeclared absolute paths, external symlink escapes, missing/moved targets, and all external edit/write attempts.
- Leave fixed role tool lists and guard interception names unchanged.

**Oracle matrix:**

- unchanged internal scoped reads and exact worker writes;
- exact v1 compatibility and v1 external-field rejection;
- exact v2 internal and external parsing;
- declared external file and directory access through each applicable fixed read-only tool: `read`, `grep`, `find`, and `ls`;
- relative and noncanonical/symlink-alias external roots in a v2 manifest;
- undeclared external path, sibling of an external root, and relative traversal to the same target;
- symlink escape from internal and external roots, including real recursive `grep`/`find` behavior over an admitted directory containing a descendant symlink to undeclared content;
- worker external-root manifest and reviewer write manifest;
- unknown version and non-private capability loading behavior.

**Verification:**

```bash
node --experimental-strip-types --test tests/subagents-guard.test.ts
npm run typecheck
```

**Recovery:** Fix forward while retaining all existing write-path negative oracles. A guard change that requires external write authority returns `needs_design_decision`.

### PEX-400 — Render canonical external roots into bounded child input

**Depends on:** PEX-200

**Objective:** Give read-only children enough admitted path context without changing child cwd, tools, result evidence, or provider behavior.

**Write set:**

- `extensions/subagents/runner.ts`
- `tests/subagents-runner.test.ts`

**Changes:**

- Add an explicit “External read roots” block after internal read scope, rendering canonical admitted roots or `none`.
- Keep exact write-path and expected-parent-evidence blocks unchanged.
- Produce manifest v2 fixtures in current runner tests while retaining a dedicated v1 guard fixture under PEX-300.
- Preserve the existing complete-prompt byte ceiling and private mode-0600 capability file.
- Prove external roots do not change child cwd, tool list, model/thinking route, approval flag, diagnostic path, or write-path rendering.
- Keep bounded child output and stderr unchanged as untrusted evidence; do not implement longest-prefix content rewriting.

**Verification:**

```bash
node --experimental-strip-types --test tests/subagents-runner.test.ts
npm run typecheck
```

**Recovery:** Fix forward. If path rendering can bypass the approved grammar or prompt bound, stop rather than escaping or truncating individual path semantics silently.

### PEX-500 — Integrate trust, admission, capabilities, and runtime evidence

**Depends on:** PEX-200, PEX-300, PEX-400

**Objective:** Wire the canonical path policy into one foreground run while preserving route, scheduler, diagnostics, and convergence behavior.

**Write set:**

- `extensions/subagents/index.ts`
- `tests/subagents-extension.test.ts`

**Changes:**

- Retain schema/shape validation without filesystem probing, then check `ctx.isProjectTrusted()` before Git discovery, `realpath`, external-root inspection, route config loading, or diagnostic allocation.
- Inject the repository-policy resolver through `SubagentDependencies` for deterministic tests.
- Run trusted repository admission before relational graph validation, route resolution, diagnostics, scheduling, workspace creation, or child launch.
- Use the canonical Git toplevel as the read-only child root.
- Pass canonical internal scope and external roots to the child prompt and manifest v2.
- Keep worker child root as its private snapshot and require an empty external-root list.
- Propagate stable path-admission errors as failed schema-v2 run telemetry with requested counts, zero admitted tasks, zero launches, and no raw path text.
- Preserve current all-or-none graph admission, route selection, concurrency, dependency, activity, cancellation, diagnostics, and convergence semantics.
- Do not add external roots to extension-authored progress, final summary metadata, telemetry, debug rendering, or evaluator input fields. Confirm that a fake child echo remains bounded and unchanged.

**Integration oracles:**

- untrusted project invokes no repository resolver and launches no child;
- current-repository absolute and returning-parent scope reaches `runChild` in canonical repository-relative form;
- missing internal new-file scope remains admissible for a worker;
- sibling, non-Git, unsafe, and invalid external roots fail before config/diagnostic/child work;
- explorer/reviewer external roots reach only `task.externalReadRoots` and `capability.externalReadRoots`;
- child cwd remains the parent Git root and external roots never enter writes;
- worker declaration is rejected before workspace creation;
- omitted external roots preserve ordinary explorer, reviewer, and worker behavior;
- extension-authored result surfaces do not add raw external roots while fake child output is not rewritten;
- telemetry stays schema v2 and existing evaluator fixtures remain valid.

**Verification:**

```bash
node --experimental-strip-types --test \
  tests/subagents-extension.test.ts \
  tests/subagents-contract.test.ts \
  tests/subagents-repository-policy.test.ts \
  tests/subagents-guard.test.ts \
  tests/subagents-runner.test.ts \
  tests/subagents-workspace.test.ts \
  tests/subagents-scheduler.test.ts \
  tests/subagents-evaluator.test.ts
npm run typecheck
```

**Recovery:** Fix forward within the declared files. Any pressure to read Pi trust storage, prompt for permission from the tool, load target project resources, admit part of a graph, or add retry/fallback returns `needs_design_decision`.

### PEX-600 — Synchronize stable product truth

**Depends on:** PEX-500

**Objective:** Replace the current blanket path rejection and no-external-file wording with the verified bounded contract.

**Write set:**

- `AGENTS.md`
- `README.md`
- `docs/architecture/subagents.md`

**Changes:**

- State that current-repository scope is canonicalized against the Git toplevel after parent trust and that unsafe/escaping targets fail before launch.
- Document `externalReadRoots`, the eight-root limit, explorer/reviewer-only authority, Git containment, private prompt/session sensitivity, and no target project-resource loading.
- Document manifest v2 production plus strict v1 read compatibility and its source-skew rationale.
- Preserve no external-file write, single-repository worker snapshot/convergence, exact write files, no generic permission framework, and no telemetry path retention.
- Distinguish extension-authored redaction from bounded child-originated evidence that may echo a path.
- Record multi-repository workers and persistent repository selection as future designs, not implied capabilities.
- Leave historical design/plan artifacts unchanged.

**Verification:**

```bash
python3 /home/csheng/.agents/skills/organize-docs/scripts/normalize-markdown-prose.py \
  --root "$(git rev-parse --show-toplevel)" \
  --mode check \
  --immutable-manifest contracts/markdown-prose.toml
bash /home/csheng/.agents/skills/organize-docs/scripts/check-doc-boundaries.sh
git diff --check
```

Resolve the installed skill paths before execution rather than relying on these host-specific examples if the environment differs.

**Recovery:** Stable docs are updated only after runtime tests pass. If implementation behavior differs from the approved design, repair runtime or return to design; do not document an aspirational capability.

### INT-700 — Verify, review, and prepare handoff

**Owner:** Active parent

**Depends on:** PEX-600

**Objective:** Converge one exact diff and return evidence without installing, publishing, or transferring completion judgment.

**Preflight:**

- verify the approved design hash in this plan;
- record `git status --short` and preserve unrelated changes;
- ensure every changed runtime, test, and stable-doc file belongs to an approved write set;
- classify generated or incidental changes before proceeding;
- confirm no sibling repository or Pi user-state path changed.

**Focused red-green order:**

1. Run each new/changed narrow oracle before implementation and confirm failure for the intended missing behavior.
2. Complete PEX-100 through PEX-500 in dependency order, rerunning each task’s focused tests.
3. Run the complete focused subagent matrix from PEX-500.
4. Complete PEX-600 and run docs checks.
5. Run the repository gate and required offline probes.

**Complete deterministic validation:**

```bash
npm ci --ignore-scripts
npm run check
bash scripts/run-temporary-plan-mode-probe.sh
bash scripts/run-installed-plan-mode-probe.sh
bash scripts/run-temporary-subagents-probe.sh
bash scripts/run-installed-subagents-probe.sh
bash scripts/run-temporary-herdr-handoff-probe.sh
bash scripts/run-installed-herdr-handoff-probe.sh
git diff --check
```

The multi-skill mention probes and live subagent provider lane remain excluded because they require provider-call authority and do not prove this filesystem boundary.

**Independent implementation review:**

Run one bounded `review-change` evaluation over the approved design, this approved plan, the exact implementation diff, and verification evidence. Require review because the change modifies public path semantics, a private capability manifest, physical containment, external read authority, stable error codes, and stable architecture truth.

The active parent adjudicates every candidate. Apply at most one focused in-scope repair, then rerun affected focused checks, `npm run check`, required offline probes, docs checks when touched, and `git diff --check`. A scope, authority, containment, compatibility, or oracle defect returns to design or plan rather than widening the patch.

**Completion evidence:**

- exact changed-file list;
- design-hash confirmation;
- red-green focused test evidence;
- complete `npm run check` and offline-probe results;
- manifest-v1 skew compatibility and manifest-v2 external-read evidence;
- no-external-write and no-user-state-mutation evidence;
- stable truth/docs-check evidence;
- reviewer verdict, parent adjudications, and any one repair/rerun;
- explicit statement that no provider call, installation, commit, push, publication, or deployment occurred.

## Parallelism and convergence

PEX-200 and PEX-300 may execute independently after PEX-100 because their write sets are disjoint and their only shared input is the frozen contract. All other implementation order is serial by factual dependency.

No task in this plan owns semantic verification, review adjudication, repair choice, truth acceptance, or final completion. If a later implementation uses isolated workers, the active parent owns convergence and must preserve these exact write sets. There is no cross-repository writable task.

## Recovery and rollback policy

Use fix-forward recovery throughout:

- admission changes are pre-launch and cannot mutate repositories;
- guard failures terminate the affected child tool call without fallback;
- worker convergence retains its existing baseline/CAS checks and never sees external roots;
- manifest v1 read compatibility prevents source-skew rollback pressure;
- omitted `externalReadRoots` preserves current callers;
- no telemetry migration, user config, credential, or installed state needs rollback.

Stop immediately and report an authority breach if implementation reads or writes Pi trust/settings/credential files, mutates a sibling repository, adds an external write path, prompts automatically for permission, installs globally, calls a provider, or changes route configuration.

A guarded rollback is not planned. If verification exposes a material design defect, preserve the failed evidence, stop mutation, and return `needs_design_decision` rather than reverting unrelated work or weakening an oracle.

## Truth synchronization

PEX-600 owns stable product truth only after verified runtime behavior. The design and plan remain stage artifacts under `docs/plans/changes/` and are not runtime inputs. Historical artifacts continue to explain prior strict rejection but do not override current stable architecture after implementation.

## Review decision

Independent plan review was required because task ordering must preserve trust-before-probe, contract-before-parallel-slices, manifest compatibility, path-security oracles, and parent-owned convergence.

The reviewer returned `changes required` with two causal execution-readiness findings. Both were accepted and repaired in one focused edit:

- PEX-300 now requires v2 external roots to be absolute and already canonical, with explicit relative and symlink-alias rejection fixtures;
- PEX-300 now exercises each applicable read-only tool and real recursive `grep`/`find` behavior against descendant symlink escape rather than treating generic path authorization as sufficient.

Rechecking task dependencies, disjoint parallel write sets, authority, contract coverage, tool-specific security oracles, recovery, and truth sync yields `pass`. No material plan finding remains.

## Approval status

The plan is approved and bounded implementation authority has been granted for a Herdr `delegate-return` handoff to the user-owned `grok-impl` launch profile. Pi retains verification, review adjudication, repair selection, truth acceptance, and final completion ownership. Commit, push, publication, deployment, provider calls, Pi user-state changes, persistent installation, and any sibling-repository mutation remain separately unauthorized.
