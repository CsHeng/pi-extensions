# Parent And Child Overlap Research Request

Date: 2026-09-17

Status: external research request; not current architecture; not an implementation plan; does not authorize a product change.

Use: paste this file to GPT Pro as the research brief. Return the report as evidence only. Do not implement.

This is a stage artifact. Default docs search excludes `docs/plans/`. It does not change runtime behavior.

## Why this research exists

Two public repositories define the local product:

1. Pi extensions (runtime): https://github.com/CsHeng/pi-extensions
2. Portable agent skills (semantics, no runtime): https://github.com/CsHeng/agent-skills

Read first from the extensions repository:

- https://github.com/CsHeng/pi-extensions/blob/main/README.md
- https://github.com/CsHeng/pi-extensions/blob/main/AGENTS.md
- https://github.com/CsHeng/pi-extensions/blob/main/docs/architecture/subagents.md
- https://github.com/CsHeng/pi-extensions/blob/main/docs/architecture/subagent-execution.md
- https://github.com/CsHeng/pi-extensions/blob/main/docs/architecture/herdr-handoff.md

Host loop reference (Pi 0.85.x):

- https://github.com/earendil-works/pi-mono/blob/v0.85.1/packages/coding-agent/docs/extensions.md
- also check https://github.com/mariozechner/pi-mono if that is the canonical public mirror; say which tree you used

Read first from the skills repository:

- https://github.com/CsHeng/agent-skills/blob/main/README.md
- https://github.com/CsHeng/agent-skills/blob/main/docs/architecture/skill-composition.md
- https://github.com/CsHeng/agent-skills/blob/main/skills/implement-change/references/delegated-execution.md
- https://github.com/CsHeng/agent-skills/blob/main/skills/plan-change/references/delivery-and-delegation.md

## Local unpublished context

Treat the following as intent, not shipped public behavior, unless you find it on GitHub `main`:

- A task-workflow extension is being designed to own a semantic workset/DAG, acceptance, and settlement reminders for the *main* agent.
- It reuses the existing managed subagent executor. It must not become a second child runner.
- It still does not make a parent tool call non-blocking.

## Incident

The parent said WF-05 was independent, dispatched a managed worker, and planned to implement WF-02 locally afterwards.

It then called `csheng_subagent_sessions` and sat in `Pending...` / `Working...` with the tool clock running.

The main agent did not start WF-02 until the child tool returned.

User judgment: if dispatch blocks the parent, a singleton worker is often strictly worse than doing the work in the parent.

## Local facts to take as given

Verify against the repositories. Do not “correct” them without citation.

- `csheng_subagent_sessions` is a *foreground* tool. One mutating managed batch per extension session. The parent tool call waits for the batch.
- Children in one batch may run concurrently with each other. The parent loop does not continue implementation during that wait.
- Explicit exclusions: no background execution, no durable orchestration graph, no semantic resume, no auto-apply, no auto-adjudication.
- File-dependent successors require explicit parent apply between dispatches. Edges pass reports, not files.
- Skills tell the parent to prefer independent parallel slices and keep apply/acceptance. They do not claim parent+child wall-clock overlap. They say foreground round-trips are not steering while a child runs.
- `herdr_handoff` is a different product: explicit-user-only, one blocking wait (`delegate-return`) or ownership transfer. Not a subagent fallback.

Three layers must not be collapsed:

| Layer | Owns | Does not own |
| --- | --- | --- |
| Skills | When to delegate, slice boundaries, parent-owned apply/acceptance | Scheduling, background, notifications |
| Subagents | Roles, isolation, candidates, foreground batch | Task-completion semantics, parent-loop overlap |
| Workflow (unpublished local design) | Obligations, dependency readiness, settlement reminders | A second child runner; currently also no non-blocking dispatch |

## Hypotheses to test, not to assume

H1. The expensive part is the *host tool protocol*, not DAG quality. A perfect task DAG still serializes behind a blocking `create`.

H2. Codex CLI and Claude Code CLI each have some “start work, let the main agent continue, notify later” mechanism. It may be background shell/bash jobs, background subagents/agent teams, async user questions (“ask user, keep working”), or session-level notifications/re-entry. These are different planes. Do not collapse them.

H3. Codex’s recent mainline (treat “latest main / latest public CLI” as the moving target) lets the main agent keep progressing while collecting user answers asynchronously, and may also have async task execution. Verify what actually exists in current public docs and source.

H4. Parent+child overlap is only profitable when writes/isolation/apply are safe. Auto-apply or shared dirty trees would make overlap actively harmful.

H5. A semantic workflow ledger can *expose* other ready work to the parent, but cannot create overlap unless the host returns from `create` before the child finishes, then re-enters the parent on child completion without starting a second lifecycle engine.

H6. Skills should stay host-agnostic: they may say “do not idle-wait on a singleton unless isolation is the point”, but must not prescribe Codex/Claude APIs.

## Research questions

### A. Host mechanics (Codex CLI and Claude Code CLI, current public main / latest release)

For each product, answer with code or docs citations:

- A1. Can the main agent continue a turn, start other tools, or keep editing while a child/subagent/task is running?
- A2. Is “background” implemented as fire-and-forget tool result (immediate handle, later notification), parallel tool calls in one assistant message (still one turn barrier), a scheduler outside the model turn, or a user-visible background job UI?
- A3. How does completion re-enter the main agent? Interrupt current turn? Queue until idle? Require a user ack? Drop events?
- A4. Async user questions: can the main agent keep working while waiting for a human? What is blocked vs not blocked? Is this the same mechanism as background tasks?
- A5. Concurrency caps, cancellation, who owns the working tree, and whether child writes land in the parent tree immediately.
- A6. Does the parent wait at an explicit join point (apply, review, merge) even if execution was async?
- A7. What happens on session compact, restart, or user interrupt while background work is live?
- A8. Exact current version/commit inspected, and the date.

Primary sources to start from (expand as needed; prefer official source over blogs):

Codex:

- https://github.com/openai/codex
- CLI/app-server docs in that repo, any “collaboration”, “background”, “exec”, “ask”, “thread/turn” docs
- Changelog / release notes for the latest CLI

Claude Code:

- https://github.com/anthropics/claude-code if public; otherwise official Claude Code docs
- Task / Agent / Bash tools, `run_in_background`, agent teams, notifications
- Anthropic engineering posts only as leads, then verify in current product docs/source

Also note any other widely used harness with a *parent-continues* model (for example Cursor background agents, Devin, Aider) only if it illuminates a mechanism we lack. Keep that section short.

### B. Mapping onto our three layers

Map each foreign mechanism onto:

1. Skills / parent policy (when to dispatch, when to keep local, when waiting is rational)
2. Subagent transport (blocking vs submit/notify, candidates, apply)
3. Workflow ledger (ready work, join points, settlement)
4. Host loop (Pi tool execution, settlement, sendMessage re-entry)

Say which layer would have to change for parent+child overlap on Pi, and which layers must stay unchanged given our constraints:

- Pi remains the parent loop
- no second lifecycle engine in an extension
- no auto-apply / auto-adjudication
- candidates are not files passed down DAG edges
- Skills stay portable and must not encode a vendor scheduler

### C. Economic test: when is dispatch worth it?

Give a decision table for coding agents:

- singleton worker, parent blocked
- N independent workers, parent blocked, children overlap
- singleton worker, parent continues other ready work
- worker running, parent blocked only at apply/review join
- isolation/safety is the goal even if wall-clock is worse

Include failure modes: parent and child write the same files; parent applies a stale candidate; completion notification arrives mid-parent-edit; workflow marks a task running while the host tool has already returned.

### D. What we should *not* copy

Call out designs that would violate our published exclusions (background missions, durable orchestration as a second agent, auto-convergence, Skill-loaded children, recursive subagents).

## Required report shape

1. Executive answer (≤20 lines): do Codex and Claude actually let the main agent keep implementing while delegated work runs? What is the smallest host primitive that enables that?

2. Comparison table with columns: Product | version/date | parent continues during child? | parent continues during user question? | completion re-entry | working-tree isolation | join/apply point | cancellation | source URL

3. Mechanism sketches (control/data path, not marketing): Codex; Claude Code; our current Pi + subagents + skills; optional unpublished workflow layer as a semantic overlay only.

4. Layered recommendation for *research conclusions only* (not an implementation plan): keep as-is; Skill-only policy change (“don’t singleton-block”); subagent transport change (submit/inspect/notify) that would require a Pi host capability; workflow join-point change; do nothing until Pi grows a non-blocking tool or notification API. Rank by fit to our constraints, not by vendor popularity.

5. Open questions that cannot be answered from public sources.

6. Source appendix: every URL relied on, with retrieved date.

## Constraints for the researcher

- Do not propose replacing Pi with Codex or Claude.
- Do not invent APIs for Pi. If Pi 0.85.x cannot express non-blocking tools, say the missing host contract.
- Do not treat blog posts, tweets, or leaked prompts as equal to source.
- If a feature is experimental/undocumented, label it.
- Chinese or English is fine; keep terms in their canonical English identifiers (`csheng_subagent_sessions`, `agent_settled`, `create`/`apply`/`close`).
- Mark each material claim as observed / inferred / uncertain. If docs and source disagree, prefer source and say so.
