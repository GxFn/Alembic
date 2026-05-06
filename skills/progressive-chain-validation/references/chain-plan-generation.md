# Chain Plan Generation

Use this reference before writing the node plan. The plan must come from the code path first and must render as a self-contained execution document. Target documents, bug reports, and selected domain overlays are coverage references, not replacements for source analysis.

## Source-First Rule

Generate a chain map before running a broad workflow command. A valid plan records what the code actually does, where it can stop, what proves each stop, and which repair target owns the first failing invariant.

If the source path is unclear, do one of these before executing a broad command:

- Add a read-only exploration node that identifies the missing entry, state transition, or artifact producer.
- Add observability to the current boundary, such as a focused test hook, report field, debug summary, or structured evidence artifact.
- Mark the node blocked with the missing fact and do not invent a later node from a reference document alone.

## Analysis Passes

1. Entry pass: identify CLI commands, HTTP routes, MCP handlers, Dashboard actions, service methods, scheduled tasks, test harnesses, or agent tool entry points.
2. Call-path pass: follow imports, method calls, dependency injection, task scheduling, and event dispatch until the chain reaches visible outputs.
3. State pass: list input normalization, intent construction, config/default resolution, registry reads, cache reads, task/session state, and cancellation state.
4. Side-effect pass: list filesystem writes, database writes, external model calls, terminal/tool calls, network/service calls, and process lifecycle operations.
5. Executor pass: distinguish public tools from internal handlers and internal-agent from external-agent execution. Do not validate one executor by accidentally running another.
6. Branch pass: list skip flags, async dispatch branches, cancellation paths, unavailable external services, mock modes, retries, and graceful degradation paths.
7. Artifact pass: list logs, JSON reports, DB rows, snapshots, task status, candidate files, wiki/delivery output, and terminal artifacts.
8. Test pass: list existing tests and the exact boundary they prove. If no focused test exists, record the gap before long-chain execution.
9. Observability pass: identify boundaries where failure would be ambiguous and plan the first evidence hook.

## Node Derivation Rules

Create a node when a boundary has at least one of these properties:

- It changes the semantic input model, such as parsing request options into an intent.
- It changes durable or cross-stage state, such as DB records, task/session state, snapshots, or caches.
- It changes the execution surface, such as selecting dimensions, stages, tools, providers, or concurrency.
- It performs a side effect, such as file writes, database writes, terminal usage, model calls, delivery output, or cleanup.
- It creates an artifact that later stages depend on, such as analysis output, quality-gate artifacts, candidates, reports, or history.
- It crosses an async, cancellation, transaction, process, or external-service boundary.
- It is a known defect boundary from a bug report, failing output, or previous round.
- It has a branch or degradation path where the workflow can return success, skip work, or degrade while later nodes would not actually run.

A node must not be only a filename or phase label. It needs a stop condition, evidence surface, pass criteria, likely failure classes, first repair target, recheck standard, and advance rule.

## Granularity Rules

- Split before and after irreversible writes, cleanup, delivery, or destructive operations.
- Split before and after model/agent execution when the producer of structured evidence differs from the consumer.
- Split before and after async scheduling when status, cancellation, or retry behavior can diverge from execution.
- Split executor-scope changes, such as public MCP tools versus internal handlers, when they route to different workflow implementations.
- Split branch and degradation paths when a skip, mock, unavailable service, or fire-and-forget dispatch can make later nodes inapplicable.
- Split broad phases when one command success could hide multiple independent invariants.
- Merge only when two adjacent boundaries always fail and repair together, share evidence, and cannot be stopped independently.
- Long chains normally need 10 or more nodes before any full run.

## Reference Alignment

After deriving nodes from code, compare them with target documents and selected domain overlays.

For each reference node or requirement, record one status:

- `covered`: one derived node directly proves it.
- `split`: several smaller derived nodes prove it.
- `merged`: the source code has a combined boundary; explain why it cannot be split yet.
- `missing`: the code-derived plan lacks coverage and must add a node, test, or observability step.
- `not-applicable`: the reference requirement does not apply to this target chain; record the reason.
- `conditional`: the requirement applies only under a branch, executor, fixture state, provider mode, or expansion step; record the condition.

Use reference alignment to fill gaps in the plan. Do not mark a derived node as passed until its own source evidence satisfies its pass criteria.

## Repair Loop Standard

Every node follows the same repair loop:

1. Run or inspect only enough to reach the target node.
2. Collect the node evidence.
3. Decide pass/fail using explicit invariants.
4. If the reason is unclear, improve observability before changing behavior.
5. If behavior is wrong, repair the current node only.
6. Add or update a focused lower-level test when the behavior is reusable.
7. Rerun the same node with the same input and compare before/after evidence.
8. Advance only when the current node passes.

## Required Outputs

Write these artifacts before executing a broad workflow command:

- `evidence/chain-map.json`: structured source-derived chain analysis.
- `report/plan.md`: primary self-contained execution plan with source narrative, node cut strategy, variant orders, expanded node sections, branch impacts, repair policy, and full-run readiness gate.
- `report/plan-alignment.md`: comparison against target documents and selected domain overlays.
- `report/skill-review.md`: benchmark review and feedback on Skill/template/overlay gaps discovered by the generated plan.
- `report/nodes.json`: machine-checkable node status and transition rules.

Do not execute a broad workflow command while `report/plan.md` is still only a table or outline.

## Branch and Degradation Contract

For each branch or degradation path, record:

- Trigger: the flag, missing service, route, or runtime condition.
- Effect: which downstream nodes are skipped, blocked, degraded, or still valid.
- Evidence: the log, status, return field, or artifact that proves the branch taken.
- Decision: whether the branch can pass the current node, block later nodes, or requires a separate plan.

Examples include `skipAsyncFill`, fire-and-forget dispatch, cancellation, AI provider unavailable, mock provider mode, terminal toolset fallback, and public/internal handler route differences.
