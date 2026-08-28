# Workflow Harness Architecture

## Product Boundary

`workflow-harness` is a Pi-native mechanical controller. Its public dependencies are Pi's
extension API, current command metadata, current workspace, model/tool protocol, and
versioned session entries. A discovered Skill is optional untrusted semantic evidence,
not a runtime dependency or protocol producer.

The initial package exposes one extension because activation, graph admission, authority,
execution, review, repair, replay, and settlement share one atomic state transition. A
future extension split requires independent installation and state ownership, not merely
another source module.

## Lifecycle

```text
pass-through
    |
    v
capture -> normalize -> approval -> execute -> assess -> verify -> settle
                                      |          ^
                                      +-> repair-+
```

Pass-through preserves ordinary Pi behavior. Managed activation requires an explicit
harness root, an approved typed graph, or observable root selection of a discovered
design, planning, or implementation capability. Extension-originated child markers
cannot activate a root.

## Formal Stages And Review

Formality is a root admission property. Authorized sources are an explicit typed role, an
approved graph root declaration, or an observable root Skill selection resolved through
current public description metadata. Skill identity, task size, output, and child calls
cannot assign formality.

Each formal stage has a stable instance ID and one review reason. Retry, replay, resume,
fork, and compaction reuse the same ID. A worker-requested review for the same frozen
target coalesces with that reason. A different bounded target remains separate or is
rejected as scope expansion. Standalone review creates no upstream phase.

## Task Graph

Only a graph submitted through the harness-owned typed tool and then approved through a
separate direct controller transition becomes executable. The graph
records IDs, dependencies, read/write scopes, locks, isolation, executable verification,
completion evidence, review policy, attempt ceiling, and recovery. Admission rejects
duplicates, missing dependencies, cycles, unreachable work, unsafe paths, conflicting
locks or writes, invalid parallel shape, missing oracles, and unbounded attempts.

Execution is serial in the initial version. Parallel and delegated writers are rejected
until an independently designed isolation provider can enforce them.

## Authority

Known read-only tools remain available during managed read-only states. Known path-aware
write tools are checked before execution against the active task and canonical workspace;
existing symbolic-link components are rejected. Unknown or mixed tools are mutating by
default. Shell is denied unless an observable isolated executor is bound; an exact
one-operation user authorization may instead record explicit suspension of containment.

Workers cannot grant authority, advance the graph, accept review findings, repair, or
settle. Each persisted child may call only its exact typed result tool. A reviewer submits
candidate evidence in one turn; a later controller turn adjudicates it. An accepted
repair receives its own attempt authority and must repeat the admitted verification.

## State And Replay

Closed versioned session entries persist request and workspace identity, admission
provenance, selected capability snapshots, frozen proposal digests, graph and task state,
attempts, observed operations, frozen stage targets, review reasons and findings, repair
consumption, verification, pending child dispatch, and terminal outcome. Replay consumes
only the active branch, fails closed on the newest invalid owned entry, and schedules each
child once.

Assistant prose never changes state. Settlement requires a completed frozen target and
matching consumed reason for every formal stage, terminal approved graph state, passed
verification, and no pending child, adjudication, or repair.

## Verification

Fast tests own state transitions, graph and authority properties, and fake-Pi adapter
behavior. Runtime probes use unrelated synthetic Skills and disposable repositories.
Forbidden-dependency scans reject known Skill IDs, sibling layouts, generated semantic
contracts, and sidecar runtimes outside inert stage history.

Settings cutover is a separate guarded task after the complete repository diff passes
standalone verification and one formal implementation review.
