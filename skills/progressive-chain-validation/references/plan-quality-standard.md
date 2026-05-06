# Plan Quality Standard

The primary product of this skill is a self-contained long-chain execution plan. The plan must be clear enough for another agent to execute node by node without rereading this skill.

For Alembic cold-start and rescan work, `docs-dev/bootstrap-rescan-chain-test-plan.md` is the minimum quality floor. A generated plan should improve it by combining source-derived boundaries, target-document requirements, branch impacts, and execution handoff instructions in one place.

## Plan-First Contract

- Generate the plan before broad workflow execution.
- Treat code, tests, logs, and target documents as evidence sources for the plan, not as the plan itself.
- Do not include implementation snippets or repair code unless a symbol name is needed to identify a boundary.
- Cite source files, symbols, commands, reports, database tables, and artifact names only as provenance.
- A future executor should know exactly where to start, where to stop, what to inspect, how to decide pass/fail, and when to advance.

## Required Reader Outcomes

After reading the plan, an execution agent must know:

- What chain is being validated and which executor path is in scope.
- Which source-derived boundaries define the node cuts.
- Which reference documents or overlays were used as coverage oracles.
- Which branches, skip flags, degradation paths, async paths, and persistence boundaries can make later nodes inapplicable.
- The exact order for each workflow variant, such as cold-start order, rescan order, delivery order, or any other domain-specific branch.
- For every node: target, execution scope, stop condition, evidence, pass criteria, failure classes, first optimization action, recheck standard, and advance rule.
- Which facts are source-derived, which are reference-derived, which are assumptions, and which remain open questions.
- Which benchmark requirements are covered, split, missing, conditional, or not applicable.
- Which focused tests or observation hooks already exist for each node, and which are missing.

## Information Accuracy Rules

Label important claims with one of these evidence classes:

- `source`: confirmed by code, tests, routes, handlers, commands, or observed artifacts.
- `reference`: required by target documents, bug reports, overlays, or user instructions.
- `observed`: confirmed by a previous real run, harness, log, DB snapshot, report, or command output.
- `assumption`: reasonable but not yet proven; must have a validation step.
- `open`: missing fact that blocks execution or requires a separate observation node.

Do not let a reference claim pass a node. References can raise the bar, reveal missing coverage, or name the node; source or observed evidence proves behavior.

## Node Cut Algorithm

Use this sequence when turning a workflow into plan sections:

1. Name the workflow variants and executor scope.
2. Identify the earliest safe entry point for each variant.
3. Follow the chain until the first visible artifact, side effect, async boundary, persistence boundary, model/agent boundary, delivery boundary, or report/history boundary.
4. Create a node when the boundary can fail, skip, degrade, write, dispatch, persist, or produce a dependent artifact independently.
5. Split branches where a successful command can hide skipped downstream behavior.
6. Align the node list against target documents and overlays.
7. Render every selected node as a full node section, not just a table row.
8. Mark reference nodes that are source-excluded as `not-applicable`, and source-dependent nodes as `conditional`.
9. Add variant-specific execution orders and full-run readiness gates.
10. Add expansion nodes when the plan must grow from focused scope to full scope.

## Required Node Section

Every generated node section must include these fields. Use the user's language for headings when possible.

```markdown
## Node Nx: <name>

Target:
This round validates the chain only from entry to Nx.

Chain position:
Upstream prerequisites, downstream nodes intentionally not evaluated, and variant applicability.

Execution scope:
Entry, input shape, dimensions, limits, provider mode, wait mode, and branches to force or forbid.

Existing tests or observation gap:
Focused tests, harnesses, report fields, logs, or the first observation hook needed before repair.

Stop condition:
The exact observable point where the executor must stop judging this round.

Evidence:
Logs, reports, DB tables, JSON files, snapshots, task status, generated artifacts, or command output to inspect.

Pass criteria:
Concrete invariants that must hold.

Failure classes:
Input, state, algorithm, async, concurrency, persistence, external service, model/agent, delivery, report/history, or observability.

First optimization action:
The smallest observability or behavior change to try first when the node fails.

Recheck standard:
Same entry, same data, same target node; compare before/after evidence and metric changes.

Advance rule:
What allows the next node to start, and what blocks it.
```

## Completeness Gate

A plan is incomplete when any of these are true:

- It contains only a node table and no expanded per-node sections.
- It uses one smoke or end-to-end command as the execution plan.
- It has fewer than 10 nodes for a multi-boundary long chain without explaining why boundaries cannot be split.
- It omits branch or degradation impacts for skip flags, async dispatch, unavailable services, mock mode, cancellation, or alternate executor routes.
- It lacks variant orders for workflows that differ by mode, such as cold-start versus rescan.
- It has an async workflow but does not distinguish skeleton-only observation from full async execution.
- It omits expansion nodes for moving from focused validation to full scope.
- It omits node-to-test or node-to-observation coverage.
- It does not state full-run readiness criteria.
- It leaves pass criteria as vague phrases like "works", "success", or "no error" without concrete evidence.

## Better-Than-Reference Requirement

When a target document already has a useful plan, the generated plan must preserve that structure and add:

- Source-derived provenance for each node cut.
- Branch and degradation impact for each node.
- Evidence class labels for important claims.
- Stop condition and intentionally not evaluated downstream behavior for each node.
- First optimization action and recheck standard for each node.
- Variant-specific order and expansion strategy.
- Full-run readiness gate and residual-risk list.
- Explicit `not-applicable` and `conditional` decisions for reference nodes outside the selected source path.
- A benchmark review artifact recording any Skill/template/overlay changes discovered by the run.

## Benchmark Review Requirement

After writing `report/plan.md`, create `report/skill-review.md`. The review must compare the generated plan with the strongest target reference, preserve the reference's useful structure, explain where the generated plan improves it, list any benchmark gaps still missing, and name any Skill, template, or overlay changes discovered by the run.
