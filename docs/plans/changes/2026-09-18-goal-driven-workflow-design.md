# Goal-Driven Workflow Design

## Decision and approval status

Design depth: `design-full`. State: `approved_for_E1` following the user's explicit approval of the companion [plan](2026-09-18-goal-driven-workflow-plan.md) and implementation request. GC-01 through GC-07 source implementation, offline verification and truth synchronization are authorized. The user's subsequent `publish , commit and push` authorizes local snapshot publication and commit/push of this change. Daily-process restart/load and live provider evaluation (E3) remain outside the requested delivery. The original baseline and design review below are historical; current source-delivery evidence is recorded in the plan.

The [target architecture](2026-09-18-goal-driven-workflow-architecture.md) owns the proposed responsibility split and diagrams. [Current workflow architecture](../../architecture/workflow.md) owns implemented behavior. This design selects the smallest sufficient structural change: an explicitly enrolled generic completion contract with semantic model operations and an optional read-only task projection. It neither replaces Pi nor imports `agent-skills`.

## Baseline evidence and problem

The authorized diagnostic sample's first completed workset contained 50 tool results, including 21 workflow calls and 9 workflow rejections. Its input generation and automatic-review usage both remained zero. This demonstrates protocol friction; it does not attribute later provider errors to workflow or establish cross-model cost effectiveness.

Current code makes all roughly three-step work use the same ledger, exposes internal attempt/evidence/acceptance transactions, captures a default whole-cwd fingerprint at task start, and caps automatic reconciliation at zero or one per input epoch. Missing fingerprints can be reported as successful starts and discovered only during acceptance. The task graph is acyclic, but attempts, repair, acceptance invalidation and continuation already form stateful behavior. The redesign must not mistake DAG readiness for the semantic implementation lifecycle.

The current portable Skills already preserve goals, conditional review, same-task repair and actual authority. Ambiguous plan/file wording and the host-tool section still encourage treating planning observations as hard gates or performing internal bookkeeping. The authorized wording changes below remove that ambiguity without adding a Pi dependency.

## Goals, non-goals and authority

Required outcomes:

- Enrolled implementation obligations remain open until supported fulfillment, grounded cancellation/replacement, or an explicit incomplete waiting/suspension state.
- Normal successful settlement with a runnable authorized remainder can continue repeatedly; no default repair-count or one-reminder-per-goal limit substitutes for a blocker.
- Ordinary conversation tasks and task visibility do not create a completion contract.
- Models report applicability, milestones, evidence interpretation and remaining obligations, not internal revision/attempt/evidence transaction choreography.
- Safe same-goal drift reconciliation and relevant re-verification proceed without renewed permission; actual authority restrictions and execution guards remain effective.
- Main-agent judgment, Pi lifecycle/queue ownership, project trust, branch isolation, bounded persistence and explicit resumption survive the redesign.

Non-goals: a Skill compiler, method-specific runtime phases, autonomous scheduling or worker dispatch, general todo replacement, automatic review/adjudication, model/provider changes, credential access, background recovery, unlimited blind retry, or a guarantee that declared requirements exhaust natural-language intent. No new daemon, project config, approval service or second durable truth store is introduced.

This change does not loosen exact worker candidate paths, force stale applies, grant Git operations, or promote a plan's predicted file list into write authority. Reconciliation stays inside the authorized repository/module and side effects. A user-reserved exact boundary remains binding.

## D1. Semantic agreement without direct Skill coupling

The main agent selects a method and projects its applicable obligations into a generic contract. For implementation, this normally includes the authorized result, required verification, a review applicability decision, disposition of material findings when review applies, and the authorized delivery endpoint. Different methods can project different obligations; the runtime must not require these example phase names or a Skill version.

A method reference is optional provenance. There is no code import, schema generator, hash gate or file-path dependency between repositories. Portable guidance describes use of host completion-contract capabilities without prescribing the Pi schema. In the absence of that capability, the main agent retains the same goals, verification and continuation duties using ordinary project records.

Runtime conformance protects declared-contract completeness, not arbitrary business truth. A successful tool exit is a fact; a main-agent judgment states how that fact supports a requirement. Honest unknown or failed evidence cannot be rendered as mechanically verified success. Required oracle failure or absence must remain visibly unresolved unless later evidence or a grounded correction of the oracle resolves it. Manual/read-only judgments remain possible and retain their provenance rather than pretending to be host tests.

## D2. Contract and task ownership

A contract owns required obligations, their applicability and support, the effective goal/authority references, delivery and unresolved blockers. A task is a cohesive execution slice that can support one or more obligations. Its dependency graph remains acyclic, while its work can revisit implementation, diagnosis and verification without growing a new task on every failure.

Requiredness is explicit. The main agent cannot remove a required obligation, classify it as optional, mark it inapplicable, or cancel the contract merely to stop reminders. Semantic amendments identify the existing user/project basis and preserve the reason. The extension checks references and structural consistency; it does not invent authority or claim to certify the meaning of the cited user decision.

The optional task view reads the canonical committed projection. It may show ordinary tasks from a separate future adapter, clearly distinguished from required contract nodes, but it never mutates either owner. This milestone implements no second ordinary-task store and requires no rpiv installation. A disabled, failing or absent view does not change contract transitions or settlement behavior.

## D3. Low-burden model protocol

Keep the model-callable `csheng_workflow` identity, but replace its default v2 usage surface with semantic commands. The implementation may choose precise field names within these semantics; it must not expose the old multi-object transaction ceremony as the normal path.

| Operation family | Model responsibility | Runtime responsibility |
| --- | --- | --- |
| Enroll | State the approved goal, required obligations, applicability and delivery; name cohesive task keys. | Create one branch-owned contract, normalize identities and establish source/authority references. |
| Begin a slice | Select a stable task key and relevant execution/check scope when needed. | Open/correlate an internal execution attempt and provide bounded available fact references. |
| Report a milestone | State supported result, acceptance interpretation, remaining work or concrete blocker; reference relevant real facts. | Correlate and deduplicate facts, bind the checked candidate, update support and task state atomically. |
| Revise | Explain a genuine requirement/representation change and its authority basis. | Preserve lineage; invalidate only affected obligations and evidence. |
| Inspect | Ask for the needed current contract, task or fact summary. | Return a bounded semantic view, not force an inspect after every success. |
| Finish / suspend / resume | Make an explicit completion or incomplete-disposition judgment under existing authority. | Check completion, preserve remaining obligations, enforce owner/input fences and explicit recovery. |

Stable task/obligation keys remain visible for unambiguous meaning. Internal attempt, evidence and decision IDs, revision arithmetic and generated allocation references do not belong in ordinary model reports. A single real fact can support several explicitly named obligations without duplicated evidence declarations. Additive reports are serialized and replay-safe; state-sensitive amendments must still use an internally captured owner/generation fence or one returned view token when the public host cannot establish that basis. Removing model revision arithmetic must not make stale semantic writes silently overwrite newer intent.

The implementation must expose usable bounded fact references or a deterministic current-slice association; a model must never guess a hidden tool-call ID. Ambiguous parallel observations require explicit disambiguation. Observation alone does not accept a task, select an oracle, or declare a blocker. The main agent can choose supported compound milestone updates without a separate `record`, `assess task`, `assess criterion`, and `record delivery` chain.

Normal-path protocol oracle: after enrollment, a cohesive unchanged slice needs at most one begin and one milestone report; final completion can be included in the last report or one finish call. No mandatory extra inspect, public attempt restart or duplicate-subject evidence call is needed. This is a protocol test target, not a promise about arbitrary model behavior.

## D4. Evidence freshness is not an authority gate

Capture verification provenance for the actual candidate when the relevant check executes, not by universally treating the whole directory at implementation start as the immutable proof basis. Changes made by the task are expected. Non-repository work can use explicitly scoped artifacts or external observations; an unavailable repository fingerprint must not prevent performing the business task.

An unavailable required verification binding remains an explicit verification gap, never a fabricated pass. Surface the reason and the supported next action immediately. Do not report a fully usable start and then surprise the model with an unexplained unavailable acceptance basis. Byte equality is only freshness evidence, not correctness or permission.

After parallel drift, preserve unaffected support, reconcile current contents and rerun checks whose claims no longer cover the integrated result. Update the execution basis without changing the approved goal. A stale child apply remains refused; the parent prepares a reconciled candidate through supported operations instead of overriding the guard. Conflicting requirements, unresolved ownership or newly exceeded authority require a specific decision, not a global refusal caused solely by a new SHA.

## D5. Productive continuation and honest stop states

Use the existing public early-armed command waiter, not a timer, polling loop or private idle API. After every successful settlement and after all settlement consumers finish, recheck the current branch/session owner, project trust, cancellation, pending input and contract state. Send at most one main-agent continuation for that settled run. Never launch another model directly or replay interrupted work automatically.

Decision order:

1. New real input, cancellation, branch/session replacement or host error invalidates the old continuation request. Reconcile only through a supported subsequent foreground run.
2. No enrolled contract means no workflow continuation. A fulfilled or grounded-cancelled/superseded contract does not continue.
3. Required obligations with supported results can fulfill the contract. A final text claim alone cannot.
4. A runnable authorized remainder continues, including independent nodes while another node waits. A reminder names the smallest business gap, not missing internal ledger records.
5. With no runnable remainder, a supported missing prerequisite, authority gap, invalid premise or evidence-backed lack of an in-scope path is reported with its exact cause and next condition. The main agent owns this semantic judgment; a bare `blocked` label is insufficient.
6. Actual user/host resource limits and a missing/unusable host contract produce visible suspension with remaining work, not success or semantic impossibility.

Replace the zero-or-one per-input allowance for productive execution. Keep each dispatch bounded and use finite anti-spin protection for repeated unchanged settlements. A new substantive candidate/check/diagnostic fact can support further continuation; timestamps, record IDs, wording changes, repeated equivalent reports and pending/running toggles do not count. The runtime may request one diagnostic reconciliation for an unchanged remaining contract. If that returns without new relevant facts, a supported blocker or a genuinely executable next step with its factual basis, suspend visibly instead of continuing the same reminder indefinitely. An asserted new step alone does not refill progress credit; actual execution and its support must be observable. The implementation must test duplicate/wrapped fact submissions and repeated proposed next steps, not only happy-path progress.

This anti-spin state is operational `suspended/incomplete`, not an automatically certified `non-convergent` business outcome. The default has no total repair-count cap. An explicit user/host time, invocation or resource budget still bounds execution; the model's speculation about context cost is not such a budget. Runtime/provider errors remain interruptions, not automatic provider retries. Resumption after suspension or restart is explicit and uses recovered authority, not a new generic permission request for unchanged goals.

## D6. Input, durability and legacy compatibility

Retain public prepared-input participation tracking and immediate invalidation of obsolete pending continuations. The main agent interprets whether a new input changes the contract, answers a blocker or is independent conversation; the runtime does not guess from text. Repeated receipts, extension-generated reminders, history replay and ordinary context refreshes do not create authority or artificial progress.

Keep one bounded branch-local persisted contract state, commit before installing the projection, and retain replay/idempotency, cancellation and ownership checks. The new contract schema is versioned. Latest corrupt/unsupported state remains visibly unavailable; do not silently fall back to an older accepted state.

Read legacy v1 worksets as labeled legacy records with their original meaning. Do not automatically turn every old task into a strict v2 requirement, import acceptance as fresh verification, or spend new continuation credit on replay. An explicit main-agent migration/re-enrollment reconciles the actual goal and authority, preserves historical references, and selects applicable obligations; unchanged authority does not require the user to approve it again. Legacy sessions remain inspectable and can be explicitly suspended/closed or replaced through supported migration. The exact compatibility adapter must be exercised against real v1 fixtures before changing the default schema. Older binaries must refuse an unsupported newest snapshot rather than auto-resume it.

## D7. Portable Skill adjustment delivered with this package

Authorized changes are confined to four authored files under `agent-skills/src/skills/workflows/`, plus generated mirrors:

- `implement-change/SKILL.md`: distinguish completion-contract capability from todo display, keep milestone/acceptance ownership in the main agent, reject invented stopping budgets, and reconcile planning drift without automatic reapproval.
- `implement-change/references/delegated-execution.md`: preserve exact host capabilities and safe candidate refusal while letting the parent reconcile same-goal drift inside existing authority.
- `plan-change/SKILL.md`: distinguish binding goals/explicit restrictions from likely touch files, SHAs and exploratory context.
- `plan-change/references/delivery-and-delegation.md`: classify goal/authority, planning context, execution preconditions and verification bindings; preserve scoped convergence and explicit Git authority.

No schema, extension identifier, fixed phase compiler, provider configuration, public Skill ID or semantic dependency is added. Generated files are refreshed by repository scripts, never edited by hand. The installed Skill path resolves to the generated tree in this environment, so these wording changes can affect later Skill loads without a separate install; no global instructions or settings are edited. Structural checks do not prove long-task behavioral effectiveness.

## Verification architecture

| Boundary | Primary oracle and earliest lane | Required scenarios |
| --- | --- | --- |
| Semantic protocol | Deterministic reducer/tool tests | Enrollment required; two-call normal slice; compound report; corrected report; duplicate fact; stale semantic mutation. |
| Completion integrity | Requirement-driven contract fixtures | Missing verification; failed oracle; conditional review; accepted repair remains; missing delivery; unsupported manual judgment does not become a host pass. |
| Goal/context separation | Disposable source and candidate fixtures | Parallel same-file compatible edit; real conflict; explicit exclusive write restriction; stale apply refusal plus supported reconciliation; only affected evidence invalidated. |
| Continuation | Fake-Pi and real installed-host synthetic-provider lane | At least three productive premature settlements followed by fulfillment; unchanged reminder pauses; one blocked and one runnable node; actual cancellation/budget/error. |
| Input and persistence | Existing co-load/replay harnesses | Queued/mixed input; new input before/after final await; corrupt newest snapshot; legacy v1 import; branch fork; restart with no automatic resume. |
| Optional projection | UI-off/on and failing-renderer fixtures | Hiding/unloading UI does not affect contract state; plain todos cannot trigger continuation or satisfy required work. |
| Portable guidance | Agent-skills generated parity and existing check suite; read-only semantic scenario review | Planning SHA/touch drift versus explicit scope restriction; reconciled parallel changes; actual versus invented budget. Do not freeze exact prose as behavioral proof. |
| Effectiveness | Separately authorized paired real-model tasks | False completion and abandonment, repeated checks, workflow calls/rejections, additional turns and observed usage. Compare matched work and report attribution limits. |

No credentials, live provider calls, user settings, external deployment or package snapshot publication belong to the deterministic lanes. Existing subagent candidate/source/trust tests remain protection owners; this change must not weaken them to make drift scenarios pass. Visual rendering and semantic correctness of diagrams are checked separately from Markdown formatting.

## Truth impact, delivery and recovery

Current architecture and runtime guidance stay truthful until implementation is verified. Target decisions and approval choreography stay in these stage artifacts; after source completion, update stable docs and generated tool guidance together, retaining these files as history. Do not change the current package `AGENTS.md` to claim a new runtime before the implementation exists.

The proposed first delivery is source implementation plus deterministic/installed-host evidence. Local snapshot publication and restart/load confirmation are a separate operator step, and live effectiveness is a separate authorized lane. There is no implied commit, push, npm release or settings mutation. Fix-forward is the default. A failure keeps obligations and candidate evidence, disables unsafe continuation and reports a visible incomplete state; no automatic rollback, deletion of history or fallback to a different agent is authorized.

## Review record

Independent review was required because the change alters stopping behavior, evidence interpretation, legacy recovery and two repositories' ownership boundaries. On 2026-09-18 the bounded design/architecture/Skill consistency review returned `pass`, with no material candidate finding. The separate plan review found one authority ambiguity: its read-only E1 Skill conformance step appeared to reuse write-generating S0 commands. The parent accepted the finding, labeled those commands as completed S0 evidence and restricted E1 to `check.sh` with `--check` generators. A targeted follow-up returned `pass`; no finding remains open. Neither verdict authorizes runtime implementation.

Observed verification for this package:

- `agent-skills`: the three prescribed generators completed, followed by `bash scripts/check.sh`; contracts, generated parity, install surface, index, diagrams, ruff, ty, 111 tests and Markdown checks passed. A later read-only `check.sh` rerun also passed all 111 tests.
- `pi-extensions`: documentation boundary/Markdown checks passed; the bounded check found no missing relative targets or unbalanced fences across five affected documents, including seven Mermaid diagrams. Both repositories passed `git diff --check`.
- Diagrams received parent and independent manual review. Mermaid grammar/rendering was not executed because no local Mermaid parser was installed; link/fence checks are not a rendering claim.
- At this design-review checkpoint no Pi runtime code had changed. Subsequent E1 implementation approval and evidence are recorded in the companion plan; publication/load (E2) and live-model effectiveness (E3) remain separate.
