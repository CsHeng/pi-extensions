# Open Questions and Follow-ups

This list records deferred work, not changes to current runtime behavior.

## Remove plan-mode

- Status: deferred implementation; the removal direction is settled and does not need another usefulness discussion.
- Reason: the user does not use `plan-mode` and does not want it to remain a focus of maintenance.
- Follow-up: remove the extension and its package registration, dedicated documentation, tests, and probes in a separate change while preserving the other extensions.
- Boundary: recording this item does not remove the extension or change Pi settings. Its removal is not a prerequisite for the task/workflow extension design.

## Evaluate workflow cost and effectiveness

- Status: deferred evaluation capability; no telemetry implementation in the compact-receipt/batch change.
- Question: should a read-only evaluator plus a maintainer Skill analyze explicitly selected session histories to quantify workflow overhead and progress toward the real-task effectiveness goal?
- Candidate metrics: workflow call count, model-visible result size, failures/retries, additional reconciliation turns, and recorded usage/cost; separate task-list UI from ledger operations, characters from measured tokens, and nominal recorded cost from billing. Compare manual continue count, actual delivery, false completion/continuation, and repeated verification across comparable tasks with and without workflow before claiming causal savings.
- Boundary: prefer existing local session evidence over an always-on collector. Recording this question does not authorize access to real sessions or credentials, provider calls, external uploads, background collection, or changes to runtime triggers. Sample selection, attribution limits, privacy/redaction and the evaluation contract need a separate scoped decision.
