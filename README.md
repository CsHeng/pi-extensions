# Pi Extensions

This repository contains locally maintained Pi extensions. It currently exports one
extension, `workflow-harness`, which provides deterministic mechanical control for
managed agent work while leaving ordinary Pi behavior unchanged outside a managed run.

The harness is independent of every Skill collection. It discovers the Skills currently
reported by Pi and may use a compatible Skill as an optional semantic worker. It assumes
no public ID, repository, metadata extension, artifact format, or lifecycle contract, and
it has built-in generic workers for roles that need a safe fallback.

## Workflow Harness

The extension owns:

- pass-through versus managed activation
- proposal freezing and typed task-graph admission
- separately approved task dependencies, readiness, scopes, locks, attempts, and evidence
- pre-effect tool authority and protected-path policy
- optional semantic worker discovery and bounded child dispatch
- conditional review reasons, adjudication, and one focused repair budget
- verification, replay, resume, terminal settlement, and redacted status

Formal design, planning, and implementation roots each receive one implicit bounded
review. A non-formal task with no other review reason proceeds directly to verification.
Standalone review is independent. Stage and standalone targets are frozen from exact
workspace artifacts. If a semantic worker requests review for the same formal-stage
target, the harness coalesces both reasons into one review dispatch. Review evidence and
controller adjudication run in separate actor turns.

## Package

The private package exposes exactly:

```text
extensions/workflow-harness/index.ts
```

The repository may gain another extension only when the new capability has independent
installation, configuration, state, tests, and removal behavior.

## Local Development

```bash
npm ci --ignore-scripts
npm run check
```

Temporary loading, live RPC scenarios, standalone copies, settings conformance, and
installed-package probes live under `scripts/`. Global installation and settings cutover
remain explicit gates and are never performed by `npm test`.

## Safety

Managed mutation is denied until a typed task is admitted. Known path-bearing write tools
are checked before execution. Unknown or mixed tools fail closed. Shell remains denied
without an observable isolation provider. One exact direct-user operation may instead
run with an explicit record that path containment was suspended. Lexically in-scope
writes are still rejected when an existing path component is a symbolic link.

The package does not create remotes, commit, push, publish, deploy, modify provider/model
configuration, or read Skill repository paths.
