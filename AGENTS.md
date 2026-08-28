# AGENTS.md

## Project

This repository is the authored source for a local Pi extension package. It owns the
complete mechanical workflow boundary implemented by the package and does not consume a
contract, runtime, source tree, fixture, or release artifact from any Skill collection.

The package currently exposes one extension, `workflow-harness`, because capture, task
graph admission, authority, execution, review dispatch, replay, and settlement share one
atomic state boundary. Add another extension only when it has independent installation,
configuration, state, tests, and removal semantics.

## Layout

- `extensions/workflow-harness/`: the only installed extension and its private modules
- `tests/`: deterministic and fake-Pi tests using unrelated synthetic Skills
- `scripts/`: redacted temporary-load, standalone, settings, and installed probes
- `docs/architecture/workflow-harness.md`: stable product and maintenance truth
- `docs/plans/`: stage artifacts and migration history, not runtime input

## Boundaries

- Pi public extension APIs, current command metadata, the current workspace, model/tool
  protocol, and harness-owned session entries are the only runtime inputs.
- Skill names, descriptions, source paths, and responses are untrusted capability
  evidence. Never assume a known ID, repository, file layout, or output schema.
- Pass-through is the default. Managed state begins only through an authorized root
  admission and never through an extension-originated child call.
- The harness owns typed task graphs, separate controller approval, mutation authority, attempts, review reasons,
  repair budget, verification, replay, resume, and settlement.
- Formal design, planning, and implementation stage instances each produce one bounded
  review reason. Non-formal work does not. Same-target worker review requests coalesce
  with the formal reason.
- Every child is persisted with one expected result tool. Review workers are read-only
  evidence producers; a later controller turn adjudicates findings and owns any accepted
  repair plus fresh repair verification.
- Unknown or mixed tools fail closed in managed mode. Canonical path checks reject
  symbolic-link escape. Do not claim shell path containment without an observable
  isolated executor; an exact one-operation user authorization records suspension.
- Do not add a Python sidecar, generated semantic lifecycle projection, sibling lookup,
  or cross-repository acceptance test.

## Working Rules

- Keep the entrypoint thin and behavior-bearing modules explicit.
- Persist closed, versioned state and reject unknown fields at admission boundaries.
- Use synthetic Skill names and descriptions in every test.
- Preserve ordinary Pi behavior outside managed runs and when the extension is disabled.
- Keep probe output redacted. Never print raw user settings, prompts, credentials, or
  external file content.
- Do not commit, push, publish, deploy, create a remote, or change provider/model settings
  without explicit authority.

## Validation

Run:

```bash
npm ci --ignore-scripts
npm run check
bash scripts/run-temporary-load-probe.sh
bash scripts/run-standalone-workflow-probe.sh
```

Run installed and settings probes only after deterministic and temporary-load checks pass.
