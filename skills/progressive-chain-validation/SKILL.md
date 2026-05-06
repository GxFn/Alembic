---
name: progressive-chain-validation
description: "Use when: generating source-derived chain maps and long-chain execution plans, validating long-chain workflow behavior node by node, reviewing benchmark coverage, applying optional domain overlays, or repairing Alembic cold-start/rescan/bootstrap/delivery/skill-generation flows with explicit evidence and write boundaries."
argument-hint: "<workflow-or-feature> [target-project-root]"
---

# Progressive Chain Validation

Use this internal Alembic skill to turn a long workflow into a source-derived execution plan, then optionally validate and repair that plan node by node. It is intended for Alembic maintainers and development agents working in this repository.

Do not treat this as a product skill. It must not be injected into user projects, copied to `.cursor/skills`, or exposed through product builtin skill listing.

Core posture: plan-first, source-first, and overlay-light. `report/plan.md` is the primary deliverable; domain overlays are coverage oracles, not replacement plans.

## Required Inputs

Before acting, identify:

- Target workflow or feature chain.
- Target project root for any user-project validation.
- Whether the target is the Alembic source repository or an external test project.
- Existing test plan, design note, bug report, or failing output.
- Allowed command scope and destructive-operation boundary.
- Source entry hints, target documents, benchmark references, and existing tests.
- Candidate domain overlays, when the workflow has a known protocol or taxonomy.
- Executor scope, such as `internal-agent`, `external-agent`, Dashboard adapter, CLI command, MCP public tool, or MCP internal handler.
- Desired output language and whether the user wants plan generation only or plan generation plus execution.

If any command would write Alembic runtime data, first complete `N0-data-location` and get an explicit path fact table.

## Startup

1. Load [Safety Boundaries](./references/safety-boundaries.md) before planning commands.
2. Load [Alembic Adapter](./references/alembic-adapter.md) when working in this repository.
3. Load [Data Location Preflight](./references/data-location-preflight.md) before any runtime, knowledge, database, candidate, wiki, or project-skill writes.
4. Load [Plan quality standard](./references/plan-quality-standard.md) before writing `report/plan.md`.
5. Load [Chain plan generation](./references/chain-plan-generation.md) before creating the node list.
6. Build a source chain map before selecting any domain overlay.
7. Load [Domain overlays](./references/domain-overlays.md) only after the source map exists and a domain coverage oracle is useful. For Alembic cold-start or rescan work, then load [Alembic cold-start/rescan overlay](./references/overlays/alembic-coldstart-rescan.md).
8. Create a run id with the `pcv-YYYYMMDD-HHMM-<target-slug>` pattern.
9. Use [Artifact Layout](./references/artifact-layout.md) to decide where evidence and reports should live.
10. Initialize the run with [Manifest](./templates/manifest.json), [Nodes JSON](./templates/nodes.json), [Chain map](./templates/chain-map.json), [Plan](./templates/plan.md), [Plan alignment](./templates/plan-alignment.md), [Skill review](./templates/skill-review.md), [Commands](./templates/commands.md), and [N0 data-location evidence](./templates/N0-data-location.json).

## Primary Deliverable

The first required output is `report/plan.md`: a self-contained execution document that is at least as clear as `docs-dev/bootstrap-rescan-chain-test-plan.md` for Alembic cold-start/rescan work, and equally explicit for other long chains.

When the user asks for a plan or a skill-generated plan, stop after producing and reviewing the plan unless they explicitly ask to execute it. Do not run broad workflow commands merely to make the plan look complete.

The plan must contain expanded node sections, not only `nodes.json` or a summary table. Each node states target, chain position, execution scope, stop condition, evidence, pass criteria, failure classes, first optimization action, recheck standard, and advance rule.

Use code and tests to derive accurate boundaries, but do not turn the plan into an implementation guide. Cite source files, symbols, reports, or artifact names only as provenance for the chain analysis.

After writing the plan, create `report/skill-review.md` from [Skill review](./templates/skill-review.md). Compare the generated plan with the benchmark reference and record any Skill, template, or overlay improvement found by the run.

## Source-Derived Planning

Generate the node plan from source boundaries before applying target documents or domain overlays. A supplied document can tighten coverage, naming, or pass criteria, but must not replace source analysis.

1. Locate entry points from code, tests, routes, CLI commands, MCP handlers, Dashboard actions, or failing outputs.
2. Follow the call path across layers until the first externally visible artifact, side effect, async boundary, persistence boundary, Agent/model boundary, or report boundary.
3. Record the chain model in [Chain map](./templates/chain-map.json): entry points, call path, state boundaries, side effects, artifacts, existing tests, observability gaps, and proposed nodes.
4. Record branch and degradation paths, including skip flags, async dispatch, unavailable external services, mock modes, cancellation paths, and alternate public/internal entry routes.
5. Derive nodes from real boundaries. Each node needs a stop condition, evidence surface, pass criteria, failure classes, and first repair target.
6. Compare the derived nodes with target documents and selected domain overlays. Record coverage as `covered`, `split`, `merged`, `missing`, `not-applicable`, or `conditional` before executing the chain.
7. Render a complete human-readable plan from the chain map, alignment, and selected overlay. The plan must be executable by another agent without loading the overlay separately.
8. For async workflows that return before background work completes, render skeleton-only observation and full async execution variants. Add expansion nodes when the chain grows from focused scope to full scope.
9. If the code path is unclear, block the plan or create an observability node; do not invent nodes from a reference document alone.

## Node Contract

Every node must have:

- A stable id such as `N0-data-location`, `N1-entry-model`, or `N2-focused-test`.
- A hypothesis that can be proven or falsified.
- Planned commands and files to inspect before command execution.
- Pass criteria that can be checked from files, command output, or structured evidence.
- A status from `pending`, `running`, `pass`, `fail`, `blocked`, or `skipped`.
- A failure policy that says whether to retry, repair, split the node, or stop.
- A written node section in `report/plan.md` with the full fields required by [Plan quality standard](./references/plan-quality-standard.md).

## Granularity Gate

Before running any long workflow command, build a node plan that is small enough to debug. A long chain normally needs 10 or more nodes.

- Do not use one smoke command or one end-to-end command as the node plan.
- Do not mark a later node as passed because a broader command happened to return success.
- First derive nodes from the code chain map; then align them with target documents or selected overlays.
- Use [Domain overlays](./references/domain-overlays.md) only to check coverage, naming, domain-specific split points, and stricter pass criteria.
- If an overlay is selected, record every required coverage item in `report/plan-alignment.md` before execution.
- Split runtime writes, async dispatch, Agent/model calls, persistence, cleanup, delivery, and report/history boundaries unless source evidence proves they cannot fail independently.
- A node can advance only after its own evidence satisfies its own pass criteria. If it fails, repair and rerun the same node before moving forward.
- Each scope expansion may change only one variable: dimensions, `maxFiles`, terminal toolset, provider mode, or wait/no-wait behavior.

## Work Loop

1. Build a read-only source model of the workflow, entry points, state transitions, and expected artifacts.
2. Create a source-derived node plan small enough to isolate failures.
3. Select optional overlays only after the source map exists.
4. Align against target documents and overlays, then fill gaps without losing source-derived stop conditions.
5. Render `report/plan.md` with expanded node sections, variant order, benchmark review, node-to-test coverage, expansion strategy, and full-run readiness gate.
6. Write `report/skill-review.md` with benchmark comparison and Skill feedback.
7. Start with `N0-data-location` when Alembic runtime data, Ghost mode, database, knowledge base, candidates, wiki, or project skills may be involved.
8. If execution is requested, prefer observability and focused tests before changing behavior, repair only the current node, rerun that node, then advance.
9. Record commands, outputs, changed files, evidence paths, and remaining risk.

## Failure Handling

- If a node fails before code changes, improve observability or split the node smaller.
- If a node fails after a fix, revert only your own failed attempt or apply a narrower fix; do not revert unrelated user changes.
- If the failure needs broader refactoring, record the reason in the node round before expanding scope.
- If a command would cross the declared write boundary, stop and ask for approval with the exact path facts.
- After any repair, rerun the same node and update its status before starting another node.

## Evidence Contract

Record enough evidence for another maintainer to replay the decision:

- `report/plan.md`: primary self-contained execution plan, workflow boundary, source-derived node cuts, expanded node sections, variant orders, safety boundary, allowed commands, and full-run readiness gate.
- `evidence/chain-map.json`: source-derived entry points, call path, state boundaries, side effects, artifacts, and proposed nodes.
- `report/plan-alignment.md`: comparison between source-derived nodes, target documents, and selected domain overlays.
- `report/skill-review.md`: benchmark comparison and feedback for improving this Skill after plan generation.
- `report/rounds/<node-id>.md`: per-node hypothesis, actions, output refs, decision.
- `evidence/*.json`: structured path facts, parsed outputs, fixture metadata, or validation facts.
- `command-output/*`: trimmed command output when too long for the round note.
- `report/final-report.md`: pass/partial/blocked outcome, changes made, verification, residual risk.

## Safety Rules

- Do not run user-facing Alembic commands inside the Alembic source repository.
- Do not create `.asd/`, `Alembic/candidates/`, `Alembic/wiki/`, or other user runtime directories in this repository.
- Write run records under `scratch/chain-runs/<run-id>/` only.
- Use external test projects or Ghost `dataRoot` for user-project runtime data.
- Do not modify unrelated code while repairing a node.
- Ask for approval before destructive file operations or production data access.

## References

- [Artifact layout](./references/artifact-layout.md)
- [Alembic adapter](./references/alembic-adapter.md)
- [Chain plan generation](./references/chain-plan-generation.md)
- [Data location preflight](./references/data-location-preflight.md)
- [Domain overlays](./references/domain-overlays.md)
- [Plan quality standard](./references/plan-quality-standard.md)
- [Safety boundaries](./references/safety-boundaries.md)
- [Alembic cold-start/rescan overlay](./references/overlays/alembic-coldstart-rescan.md)

## Templates

- [Plan](./templates/plan.md)
- [Round](./templates/round.md)
- [Final report](./templates/final-report.md)
- [Commands](./templates/commands.md)
- [Manifest](./templates/manifest.json)
- [Nodes JSON](./templates/nodes.json)
- [Chain map](./templates/chain-map.json)
- [Plan alignment](./templates/plan-alignment.md)
- [Skill review](./templates/skill-review.md)
- [N0 data-location evidence](./templates/N0-data-location.json)
