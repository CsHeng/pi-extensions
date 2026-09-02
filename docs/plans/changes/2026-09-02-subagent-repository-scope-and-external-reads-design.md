```toml
artifact_kind = "design"
design_version = 1
design_depth = "design-full"
approval_status = "approved"
approval_basis = "The user endorsed the convergent Pi-session and Grok-session findings and explicitly authorized design-change followed by plan-change when no material ambiguity remained on 2026-09-02."
decision_state = "approved"
truth_impact = "high"
truth_sync_required = true
review_required = true
review_status = "passed_after_repair"
```

# Subagent Repository Scope Resolution And External Reads Design

## Objective

Replace string-shape-only `invalid_scope` admission with repository-aware path resolution, and add one bounded read-only mechanism for architecture-repository tasks that need evidence from sibling Git repositories.

The selected boundary has two reversible increments under one path-capability contract:

1. resolve every task `scope` against the trusted parent Git toplevel, canonicalize physically contained paths to repository-relative form, and reject only malformed, missing, or physically escaping paths;
2. allow explorer and reviewer tasks to declare exact absolute `externalReadRoots` that already exist inside another Git worktree, while keeping workers, snapshots, writes, convergence, and child cwd confined to the parent repository.

This design does not make one worker multi-repository, infer a repository from an arbitrary absolute path, add a persistent permission registry, read Pi trust storage, or load project resources from an external repository.

## Current truth and observed demand

`extensions/subagents/graph.ts` currently validates `scope` synchronously and lexically. Empty strings, absolute paths, and normalized leading parent traversal fail before the extension knows `ctx.cwd`, the Git toplevel, target existence, or physical symlink resolution. Read-only children are rooted at canonical `ctx.cwd`, while worker snapshots are rooted at the Git toplevel. The documented term “repository-relative” therefore has different physical bases for read-only and writable tasks.

The evaluated production sample contains seven `invalid_scope` calls, all rejected before child launch:

- two calls used absolute or parent-traversing spellings that physically resolved inside the current Git repository;
- four calls attempted read-only exploration or review of sibling Git repositories;
- one call mixed current-repository absolute paths with unavailable external paths.

The same sample contains no `concurrent_write_conflict` or `unexpected_worker_change` evidence. The observed problem is path admission and cross-repository read evidence, not convergence or concurrent worker writes.

The explicitly selected Grok session independently reached the same causal split: repository-contained path rewriting is the direct `invalid_scope` correction; sibling-repository reads require a separate explicit capability; cross-repository worker writes are a later design.

Schema descriptions already tell the parent to use repository-relative paths and `.`. Repeated production failures show that prose-only correction is insufficient.

## Design depth and architecture economics

This is `design-full` because it changes the public task schema, the interpretation of path authority, the private child capability manifest, and stable product truth.

| Option | Fit | Decision |
| --- | --- | --- |
| Preserve current rejection and improve prose | Lowest implementation cost, but the production sample proves repeated absolute and sibling path dispatch | Rejected |
| Canonicalize only current-repository paths | Corrects the direct bug without widening authority, but leaves four of seven observed calls without a usable read-only workflow | Selected as increment one, insufficient alone |
| Accept arbitrary absolute paths or `../sibling` through `scope` | Convenient but silently converts path spelling into external authority and cannot distinguish current-root aliases from sibling repositories | Rejected |
| Add a user-owned repository alias registry and per-task repository selection | Could support external workers later, but adds persistent permission state, configuration lifecycle, and multi-repository convergence before current evidence requires them | Deferred |
| Add exact per-call external read roots for read-only roles | Matches observed demand, reuses parent read authority, adds no persistent state, and preserves single-repository writes | Selected as increment two |
| Add multi-repository workers now | Requires repository selection, one snapshot and CAS boundary per repository, repository-qualified conflicts, and partial cross-repository convergence semantics | Rejected from this milestone |

The parent Pi process already has ordinary local-user read authority. Pi project trust controls project-resource loading; Pi documentation explicitly states that it is not a filesystem sandbox. Pi exposes `ctx.isProjectTrusted()` only for the current session context and no public arbitrary-path trust query. Therefore this extension must not read or infer `trust.json`, claim that a sibling inherited current-project trust, or introduce a hidden trust lookup.

The smallest sufficient authority is the exact task field supplied by the trusted parent call. External targets never become child cwd and their `.pi` settings, extensions, Skills, templates, or system prompt files are not loaded. Their file content remains untrusted evidence and retains ordinary local-agent prompt-injection risk.

The reconsideration trigger for a persistent repository registry or per-task repository selection is representative evidence that repeated exact external roots cause material dispatch toil, or an approved requirement for workers to operate in different repository roots. Neither is part of this milestone.

## Ownership and authority

| Owner | Owns | Does not own |
| --- | --- | --- |
| User | Approval of this capability change, local filesystem authority, provider cost, cancellation, and any later persistent repository registry or cross-repository write design | Child path normalization, manifest checks, scheduling, or convergence mechanics |
| Parent and Skills | Whether delegation is semantically appropriate, exact current and external read roots passed to a task, task decomposition, evidence interpretation, and parent-owned synthesis | Physical path containment, child tools, workspace isolation, or external writes |
| Pi | Current-session cwd and project-trust input, extension execution, child process hosting, and ordinary local-user file permissions | Arbitrary sibling-project trust lookup, child path capability policy, or multi-repository convergence |
| `pi-extensions` | Git-root discovery, task path canonicalization, external-read admission, private capability enforcement, bounded child prompts, typed failures, diagnostics redaction, tests, and stable truth | Loading external project resources, inferring undeclared roots, semantic trust in file content, external writes, or approval workflow |

Dispatch continues to require `ctx.isProjectTrusted()` for the parent project. Path and Git probing occurs only after that check.

## Selected task contract

### Current repository scope

`scope` remains required and bounded to 32 entries. Repository-relative paths and `.` remain the preferred model-facing form. Admission additionally accepts absolute or parent-traversing spellings only when they resolve inside the trusted parent Git toplevel.

Every model-visible path field (`scope`, `writePaths`, and `externalReadRoots`) is limited to 4,096 UTF-8 bytes per entry and rejects NUL, ASCII C0 controls, DEL, and Unicode line or paragraph separators. Canonical output is checked by the same grammar before prompt rendering. This intentionally excludes exotic control-character Git paths so one path cannot alter the line-oriented child prompt.

Resolution rules are exact:

1. Discover the parent Git toplevel with Git from `ctx.cwd`, then canonicalize it with `realpath`.
2. Resolve every `scope` entry against that Git toplevel. An absolute input remains absolute; every other input, including a leading `..`, is resolved from the Git toplevel rather than from an arbitrary session subdirectory.
3. Require lexical containment under the Git toplevel, resolve the target when it exists, or resolve its nearest existing ancestor when it is absent, and require component-aware physical containment under the canonical Git toplevel.
4. For an existing target, convert its physical target to canonical repository-relative form. For an absent target, retain its normalized repository-relative lexical path after ancestor containment succeeds. The toplevel becomes `.`.
5. Run `writePaths`-within-`scope`, dependency, prompt-size, and conflict admission against those canonical values.

A spelling such as an absolute path inside the repository or a parent traversal that leaves lexically and returns physically is corrected. A missing scope remains valid only when its nearest existing ancestor is physically contained; this preserves existing create-file workers and read-only absence checks while the child guard rechecks containment when a target later appears. A sibling repository, a non-Git parent workspace, or a symlink ancestor resolving outside the repository is rejected before route resolution, diagnostics allocation, workspace creation, or child launch.

This canonicalization applies only to read `scope`. Worker `writePaths` remain exact repository-relative files: no absolute path, parent traversal, directory inference, or external write is accepted. The asymmetry is deliberate because `writePaths` grants mutation and convergence authority.

Read-only child cwd and internal capability root change from canonical `ctx.cwd` to the canonical Git toplevel. Worker snapshots already use that basis, so all roles now interpret repository-relative paths consistently.

### External read roots

A task may add:

```text
externalReadRoots: string[]
```

The field has these rules:

- it is optional and limited to eight entries per task;
- only explorer and reviewer tasks may declare it; a worker declaration, including an explicit empty array, is rejected;
- every entry must be an absolute path satisfying the shared bounded path grammar;
- every target must exist and canonicalize with `realpath`;
- every target must be a file or directory physically contained in a Git worktree discovered through Git from that target or its containing directory;
- an entry physically inside the current parent repository is rejected with corrective guidance to use `scope`;
- exact duplicates after canonicalization are rejected;
- one external entry may name a Git toplevel, a subdirectory, or a file, and grants only that exact file or directory subtree;
- an external path is never added to `writePaths`, a worker inventory, snapshot, baseline, convergence diff, or parent apply operation.

An omitted field normalizes to an empty list and preserves all existing callers.

The task prompt renders admitted canonical external roots in a distinct “External read roots” block so the child can address them explicitly. Raw external paths may therefore exist in the private child prompt and retained private child session. Extension-authored progress, summary metadata, telemetry, evaluator reports, probes, and `/subagents-debug` rendering must not add or copy those roots. Bounded child output and stderr remain untrusted evidence and may echo a path or descendant; the extension does not rewrite that evidence or claim path secrecy. Tests distinguish extension-authored redaction from child-originated content.

## Admission pipeline

The current monolithic synchronous graph validation is split by authority:

1. schema and structural shape validation handles task count, IDs, roles, objective/input bounds, optional-field shapes, and dependency syntax without filesystem probing;
2. current-project trust is checked;
3. repository admission discovers the canonical parent Git root, canonicalizes internal scope, resolves external read roots, and returns typed pre-launch failures without raw path text;
4. relational graph validation evaluates canonical scope containment, exact writes, dependencies, cycles, resource locks, prompt projection, and concurrent write overlap;
5. route resolution, diagnostic allocation, scheduling, child launch, and convergence proceed unchanged.

A dedicated repository-policy module owns Git discovery and physical path resolution. `graph.ts` remains the deterministic owner of graph relationships and normalized task invariants. `workspace.ts` reuses the repository-root helper so worker snapshots and read-only children cannot drift to different roots.

No invalid task is partially admitted. One malformed task continues to reject the complete bounded batch, preserving current all-or-none graph admission.

## Typed failure contract

The following stable pre-launch codes make correction causal without rendering external paths:

- `repository_root_unavailable`: `ctx.cwd` does not resolve to an accessible Git worktree;
- `invalid_scope`: a scope entry violates the bounded path grammar or cannot be normalized;
- `scope_outside_repository`: a scope target or its nearest existing ancestor physically resolves outside the parent Git toplevel;
- `external_read_roots_forbidden`: a worker declares `externalReadRoots`;
- `invalid_external_read_root`: an external entry is not an absolute safe string;
- `external_read_root_unavailable`: the target is missing, inaccessible, special, or not contained in a Git worktree;
- `external_read_root_not_external`: the target is physically inside the parent repository and belongs in `scope`;
- `duplicate_external_read_root`: two inputs canonicalize to the same external target.

`write_outside_scope` retains its current exact meaning after scope canonicalization. Worker write and convergence errors remain unchanged.

Runtime telemetry remains schema version two. Existing requested/admitted/launched counts and `runErrorCode` are sufficient; no path, repository, or external-root counter is persisted. The evaluator already aggregates safe stable error codes and must not reconstruct or retain paths.

## Private child capability manifest version two

The private manifest producer advances from version one to version two:

```text
{
  version: 2,
  root,
  role,
  readRoots,
  externalReadRoots,
  writePaths
}
```

It is temporary, mode 0600, and not resumable runtime state. The guard accepts an exact version-one manifest as the previous in-memory producer shape and normalizes it to version two with `externalReadRoots: []`; version-one manifests cannot carry external fields. This compatibility protects an active old extension instance whose on-disk guard source changes during an in-place package update. The current producer emits only version two, and unknown versions fail closed. Version-one reader support remains owned by this extension until the guard is launch-pinned so producer/guard source skew is impossible.

Manifest parsing requires:

- `root`, internal `readRoots`, and `writePaths` to remain absolute and contained under `root`;
- `externalReadRoots` to be absolute canonical paths;
- workers to have no external roots;
- explorer/reviewer manifests to have no writes.

Path authorization separates reads from writes before applying containment:

- relative child paths always resolve under `root`; `..` cannot reach an external root;
- internal absolute reads remain permitted only when they match declared internal roots;
- an absolute external read must lexically match one declared external file or subtree and then physically resolve inside that same canonical root;
- undeclared absolute paths and external symlink escapes fail;
- writes must remain under `root`, match one exact declared write file, and pass every existing symlink and role check; external roots are never considered for writes.

The fixed role tool lists do not change. Explorer and reviewer remain read-only; worker tools and convergence remain repository-local.

## Scheduling, failure, and recovery

Scheduling and concurrency limits do not change. External reads introduce no write conflict or resource ownership and therefore add no scheduler edge or lock.

Admission failure launches no child and has no fallback. If a previously admitted internal or external target moves, appears through a symlink escape, disappears, or physically escapes before a child access, the guard blocks that tool call; the extension does not rediscover a replacement root.

Use fix-forward recovery. No user or project configuration is changed, and no repository contents are mutated by this capability itself. Worker convergence keeps its existing independent partial-result semantics, but external-read tasks cannot create a cross-repository partial write because they are read-only.

The producer moves to manifest version two while the guard retains exact version-one read compatibility for source-skew safety. Session shutdown still settles current children before extension teardown, but it is not treated as protection against an in-place on-disk package update.

## Explicit non-goals and future phases

Out of scope:

- external reads for workers;
- selecting another repository as child cwd;
- external or multi-repository `writePaths`;
- one worker snapshotting or converging multiple repositories;
- persistent repository aliases, allowlists, permission prompts, or generic permission policy;
- reading or modifying Pi settings, `trust.json`, credentials, or unrelated session state;
- loading external project settings, extensions, Skills, templates, system prompts, or AGENTS context as project resources;
- accepting arbitrary non-Git external paths;
- partial graph admission, automatic retry, fallback, or role rewriting;
- telemetry schema three or persisted raw path evidence;
- provider calls, installation, commit, push, publication, or deployment.

A future design may add per-task repository selection and repository-qualified worker isolation only after explicit demand and authority. It must define repository ownership, one snapshot and convergence boundary per writable task, repository-qualified conflict keys, cross-repository partial success, and recovery without reusing `externalReadRoots` as a write grant.

## Oracle strategy and acceptance evidence

Use contract tables, deterministic component tests with disposable Git worktrees, path-policy security fixtures, extension integration fakes, runner prompt fixtures, and existing offline package probes.

Acceptance requires:

- existing repository-relative callers remain valid and reach children unchanged except for canonical normalization;
- an absolute current-repository scope and a parent-traversing alias that physically returns to the repository are admitted as canonical repository-relative paths;
- missing internal scope with a physically contained nearest existing ancestor remains admissible, while non-Git, sibling, and symlink-escaping scope targets fail with the declared typed code and launch no child;
- existing create-file workers with an exact absent write target remain compatible;
- control-character or overlong model-visible path entries fail before prompt rendering or child launch;
- project trust fails before Git or filesystem probing;
- read-only children and worker snapshots use the same canonical Git toplevel basis;
- `externalReadRoots` is accepted only for explorer/reviewer, limited to eight, physically canonical, Git-contained, distinct, and external to the parent repository;
- declared external file and directory reads work through `read`, `grep`, `find`, and `ls` as applicable;
- undeclared absolute reads, relative traversal to an external root, external symlink escape, and every external write fail closed;
- worker manifests cannot contain external roots and worker snapshots never inventory them;
- manifest v2 is exact and unknown/v1 malformed variants fail closed;
- child prompts identify canonical external roots, while extension-authored progress, summary metadata, telemetry, evaluator output, probes, and debug rendering do not add them; a fake child may echo a root in its bounded untrusted output without the runtime rewriting evidence;
- the producer emits manifest v2, the guard safely normalizes exact v1 manifests with no external roots, and unknown or widened v1 manifests fail closed;
- no new telemetry field or schema version is introduced;
- `npm run check`, required offline plan-mode/subagent/herdr probes, and `git diff --check` pass.

Security-oracle weakening, broad acceptance of arbitrary absolute paths, replacing exact containment with string-prefix checks, or allowing external writes is a design breach rather than an implementation repair.

A live provider call is unnecessary because the changed boundary is deterministic filesystem admission and child tool authorization. Disposable repositories and fake child execution exercise the real owned boundary without credentials.

## Truth impact

Verified implementation must update:

- `AGENTS.md` to replace the blanket no-external-file boundary with exact explorer/reviewer external reads while retaining no external write;
- `README.md` to explain repository-aware scope correction and the read-only external-root field;
- `docs/architecture/subagents.md` to own the task contract, admission pipeline, manifest v2, redaction, failure semantics, and future multi-repository boundary;
- tool schema descriptions and stable error-code declarations in runtime source.

Historical artifacts that intentionally rejected absolute paths remain unchanged as stage history. This design supersedes that current-product decision after verified implementation and stable truth synchronization.

## Implementation surface

Expected runtime surfaces:

- `extensions/subagents/contracts.ts`
- a new repository-owned path module under `extensions/subagents/`
- `extensions/subagents/graph.ts`
- `extensions/subagents/workspace.ts`
- `extensions/subagents/index.ts`
- `extensions/subagents/path-policy.ts`
- `extensions/subagents/runner.ts`

Expected test surfaces:

- `tests/subagents-contract.test.ts`
- `tests/subagents-workspace.test.ts` or a focused repository-policy test file
- `tests/subagents-guard.test.ts`
- `tests/subagents-runner.test.ts`
- `tests/subagents-extension.test.ts`
- host-contract and probe assertions only where observable contracts change

Expected stable truth surfaces:

- `AGENTS.md`
- `README.md`
- `docs/architecture/subagents.md`

No sibling repository or Pi user-state file is an implementation target.

## Review decision

Independent design review was required because the design changes a public tool schema, physical path authority, a private capability manifest, path-security behavior, and stable product truth.

The reviewer returned `changes required` with four causal candidates. All four underlying defects were accepted and repaired in one focused edit:

- the design now limits its redaction guarantee to extension-authored surfaces and explicitly preserves bounded untrusted child evidence rather than silently rewriting it;
- missing internal scope remains admissible through nearest-existing-ancestor containment, preserving create-file worker compatibility;
- the v2 producer retains strict v1 reader compatibility for in-place source skew instead of assuming atomic producer/guard replacement;
- every model-visible path has an exact byte and control-character grammar before line-oriented prompt rendering.

The proposed longest-prefix rewrite of child output was rejected because it would mutate diagnostic evidence and path secrecy is not an owned product guarantee. Rechecking authority, compatibility, physical containment, manifest rollout, prompt integrity, redaction, acceptance evidence, and recovery yields `pass`. No material design finding remains.
