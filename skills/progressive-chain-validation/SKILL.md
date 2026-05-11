---
name: progressive-chain-validation
description: "Use when: generating source-derived chain maps and long-chain execution plans, validating long-chain workflow behavior node by node, reviewing benchmark coverage, applying optional domain overlays, or repairing Alembic cold-start/rescan/bootstrap/delivery/skill-generation flows with explicit evidence and write boundaries."
argument-hint: "<workflow-or-feature> [target-project-root]"
---

# Progressive Chain Validation

Use this internal Alembic skill to turn a long workflow into a source-derived execution plan, then optionally validate and repair that plan node by node. It is intended for Alembic maintainers and development agents working in this repository.

Do not treat this as a product skill. It must not be injected into user projects, copied to `.cursor/skills`, or exposed through product builtin skill listing.

Core posture: plan-first, source-first, overlay-light, one-node-at-a-time, node-local isolation, and patient section-by-section execution. `report/plan.md` is the primary deliverable; domain overlays are coverage oracles, not replacement plans.

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
- Current execution node when resuming, plus whether the user explicitly allowed broad confirmation runs or target-project delivery writes.
- Per-node isolation constraints: simulated data, frozen upstream artifacts, downstream cut points, async controls, and reset requirements.
- The current section's task lifecycle state: intake, design, fixture, execute, diagnose, repair, rerun, harden, or handoff.
- Terminal stability constraints: timeout budget, sync versus async mode, output capture path, explicit exit marker, and hang recovery rule.

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
9. Use [Artifact Layout](./references/artifact-layout.md) to keep `report/plan.md` as the single required run artifact.
10. Initialize the run with [Plan](./templates/plan.md). Add extra files only when an artifact is too large, binary, or machine-generated and would make the plan unreadable.

## Primary Deliverable

The first required output is `report/plan.md`: a self-contained execution document that is at least as clear as `docs-dev/workflows-scan/bootstrap-rescan-chain-test-plan.md` for Alembic cold-start/rescan work, and equally explicit for other long chains.

When the user asks for a plan or a skill-generated plan, stop after producing and reviewing the plan unless they explicitly ask to execute it. Do not run broad workflow commands merely to make the plan look complete.

When the user asks for execution, treat `report/plan.md` as the state machine. Start at the first non-terminal node in the plan's node table; execute only that node's smallest safe action; update only that node's section and execution log; and advance only after that node passes. Do not optimize for finishing all nodes quickly; optimize for making the current section complete, repaired, rechecked, and easy to hand off.

The plan must contain expanded node sections, not only a node table or summary. Each node states target, chain position, execution scope, a benchmark-style operational guidance block, a node-specific design/test plan, stop condition, evidence, pass criteria, failure classes, first optimization action, recheck standard, and advance rule.

The operational guidance block is mandatory. It must be as actionable as the strongest section in the benchmark reference: goal, execution range, evidence checklist, pass standard, failure taxonomy, optimization actions, and recheck metrics. Generic words such as `success`, `works`, `valid`, or `no error` are not enough unless paired with the exact logs, fields, counts, artifacts, rejected reasons, tool calls, file references, or write-surface proofs that decide the node.

Use code and tests to derive accurate boundaries, but do not turn the plan into an implementation guide. Cite source files, symbols, reports, or artifact names only as provenance for the chain analysis.

After writing the plan, complete its Skill review section. Compare the generated plan with the benchmark reference and record any Skill, template, or overlay improvement found by the run inside `report/plan.md`.

## Source-Derived Planning

Generate the node plan from source boundaries before applying target documents or domain overlays. A supplied document can tighten coverage, naming, or pass criteria, but must not replace source analysis.

1. Locate entry points from code, tests, routes, CLI commands, MCP handlers, Dashboard actions, or failing outputs.
2. Follow the call path across layers until the first externally visible artifact, side effect, async boundary, persistence boundary, Agent/model boundary, or report boundary.
3. Record the chain model in the plan's Source Chain Map section: entry points, call path, state boundaries, side effects, artifacts, existing tests, observability gaps, and proposed nodes.
4. Record branch and degradation paths, including skip flags, async dispatch, unavailable external services, mock modes, cancellation paths, and alternate public/internal entry routes.
5. Derive nodes from real boundaries. Each node needs a stop condition, evidence surface, pass criteria, failure classes, first repair target, node-local fixture, and isolation cut plan.
6. Compare the derived nodes with target documents and selected domain overlays in the plan's Reference Alignment section. Record coverage as `covered`, `split`, `merged`, `missing`, `not-applicable`, or `conditional` before executing the chain.
7. Render a complete human-readable plan from the chain map, alignment, and selected overlay. The plan must be executable by another agent without loading the overlay separately.
8. For async workflows that return before background work completes, render scheduler, worker/start, producer, persistence, finalizer, delivery, and report/history as separately isolated nodes unless source evidence proves two boundaries cannot be cut apart.
9. Add expansion nodes when the chain grows from focused scope to full scope.
10. If the code path is unclear, block the plan or create an observability node; do not invent nodes from a reference document alone.

## Node Contract

Every node must have:

- A stable id such as `N0-data-location`, `N1-entry-model`, or `N2-focused-test`.
- A hypothesis that can be proven or falsified.
- A node-specific design/test plan that treats this section as its own mini-validation project.
- A benchmark-style operational guidance block with concrete goal, execution range, evidence checklist, pass criteria, failure taxonomy, optimization actions, and recheck metrics.
- A section task workflow that treats the node as a complete task: intake, design, fixture setup, isolated execution, diagnosis, repair, same-node rerun, hardening, and handoff.
- The subplan's setup, node-local simulated data or frozen upstream artifact, downstream cut point, allowed commands, observability hooks, expected artifacts, assertions, negative cases, repair target, and same-node rerun rule.
- An isolation design that says which upstream state is simulated or frozen, which downstream behavior is blocked or stubbed, how shared state is reset, and how the node proves it did not rely on a later node.
- For async nodes, a split design that controls scheduling, worker start, producer output, persistence, finalizer, delivery, and report/history independently.
- Planned commands and files to inspect before command execution.
- A terminal stability plan for every terminal command: timeout budget, expected duration, output volume, explicit exit-code marker, non-interactive mode, and recovery action if the command stalls.
- Pass criteria that can be checked from files, command output, or structured evidence.
- Evidence checklist items that name the exact fields, counts, artifacts, tool calls, source references, status rows, rejected reasons, duplicate keys, or write-surface hashes to inspect for this node.
- Optimization actions that name the first prompt, schema, dedup, routing, persistence, observability, or testability surface to improve when the node fails.
- Recheck metrics that compare the same fixture or frozen upstream artifact before and after repair.
- A status from `pending`, `running`, `pass`, `fail`, `blocked`, or `skipped`.
- A failure policy that says whether to retry, repair, split the node, or stop.
- A written node section in `report/plan.md` with the full fields required by [Plan quality standard](./references/plan-quality-standard.md).

## Granularity Gate

Before running any long workflow command, build a node plan that is small enough to debug. A long chain normally needs 10 or more nodes.

- Do not use one smoke command or one end-to-end command as the node plan.
- Do not mark a later node as passed because a broader command happened to return success.
- First derive nodes from the code chain map; then align them with target documents or selected overlays.
- Use [Domain overlays](./references/domain-overlays.md) only to check coverage, naming, domain-specific split points, and stricter pass criteria.
- If an overlay is selected, record every required coverage item in the plan's Reference Alignment section before execution.
- Split runtime writes, async dispatch, Agent/model calls, persistence, cleanup, delivery, and report/history boundaries unless source evidence proves they cannot fail independently.
- Split any node whose pass evidence requires executing another pending node. Replace live upstream dependency with a frozen artifact, fixture, stub, or harness before marking the node executable.
- A node can advance only after its own evidence satisfies its own pass criteria. If it fails, repair and rerun the same node before moving forward.
- Each scope expansion may change only one variable: dimensions, `maxFiles`, terminal toolset, provider mode, or wait/no-wait behavior.

## Node Isolation Contract

Every node must be independently verifiable. Treat the node as a small experiment with controlled inputs and an explicit cut before the next boundary.

For each node, the plan must name:

- Node-local input: simulated data, fixture state, a frozen upstream artifact, or a read-only source fact. Do not require a live run through earlier pending nodes when a fixture can express the same state.
- Upstream freeze rule: which upstream outputs are trusted prerequisites, how they are captured, and how they are kept stable during reruns.
- Downstream cut point: the first function, task, event, process, database write, file write, model call, delivery step, or report producer that must not execute for this node to pass.
- Isolation mechanism: mock, stub, fake service, injected dependency, temporary harness, feature flag, dry-run/no-delivery option, scheduler pause, transaction rollback, isolated data root, or read-only inspection.
- Reset rule: how database rows, files, caches, process state, queue state, timers, sessions, and environment variables are cleared or made unique between attempts.
- Isolation proof: evidence that downstream artifacts are absent, unchanged, skipped, or marked observation-only.

If a node cannot be isolated with the current code, do not substitute a full run. Create an observability or testability repair for that node, rerun the same node, and only then continue.

Async chains need stricter cuts. A single async flow can contain multiple nodes: enqueue/schedule, worker claim, preparation, producer/model/tool call, persistence consumer, finalizer, delivery, wiki/report/history, and semantic memory. Each async node needs its own fixture and stop condition; a full `--wait` command is allowed only as a confirmation after these component nodes pass or as observation-only evidence with downstream statuses unchanged.

## Section Task Workflow

Every expanded node section is a full task, not a checklist row. The executor should be willing to spend the whole turn on one section when that is what the evidence requires.

For the current section, complete these phases in order:

1. Intake: restate the node target, prerequisites, blocked downstream behavior, and write boundary.
2. Design: decide the fixture, upstream freeze, downstream cut, observability, assertions, negative case, and repair target before running commands.
3. Execute: run the smallest action that can prove or falsify this node; if that action crosses downstream boundaries, mark downstream output observation-only.
4. Diagnose: compare evidence against the node's pass criteria and isolation criteria; identify the earliest failing invariant.
5. Repair: fix or improve only the current section's behavior, fixture, observability, or testability.
6. Rerun: repeat the same node subplan with the same input and record before/after evidence.
7. Harden: add or update focused tests or guards when the repaired behavior is reusable.
8. Handoff: update the node section with decision, remaining risk, and the exact advance rule for the next node.

Patience rule: it is acceptable and often correct to finish a turn with only one node improved. It is not acceptable to rush through pending nodes, write a final outcome while the current section is weak, or skip repair because a later full run looks successful.

## Execution Control Protocol

Execution is a current-node driver, not a smoke test and not a post-hoc classification exercise.

Before every command or repair action, record in the current node's Execution Log subsection inside `report/plan.md`:

- Current node id and expected status transition.
- Current section phase and the specific completion criteria for that phase.
- The node-specific design/test plan that will be completed as a whole before the node can pass.
- The node-local fixture, upstream freeze rule, downstream cut point, reset rule, and isolation proof.
- The smallest command, test, harness, or read-only inspection that reaches this node's stop condition.
- The command shapes that are forbidden because they cross downstream nodes, write outside the declared boundary, or hide async/finalizer behavior.
- Whether the action can physically run past the current node. If it can, explain why no safer stop point exists and treat any downstream output as pre-observation only.
- The write surfaces that may be touched and the proof that they are inside the approved boundary.
- Terminal stability: bounded timeout, sync/async mode, expected output shape, explicit exit marker, attachment path for long output, and hang recovery action.

Hard gates:

- Only the current node may change from `pending` or `running` to `pass`, `fail`, `blocked`, or `skipped` in a single execution round.
- A node cannot pass if its evidence depends on live execution of a later pending node. Downstream output from an accidental broad command is observation-only until that downstream node becomes current and is independently verified.
- A broad command that crosses several pending nodes cannot pass those later nodes. It may only create observation evidence to be rechecked when the cursor reaches those nodes.
- If a command reveals the first failed invariant or unexpected side effect, stop immediately, record the failure, repair that node if the scope allows, rerun the same node, and do not continue to a later node in the same turn.
- If no command can stop at the current boundary, create or repair observability before running the full chain. Mark the node `blocked` rather than using a full run as the first diagnostic.
- A command that can perform delivery, wiki, agent-instruction, candidate, database, or source-root writes is blocked until the relevant node proves either no-target-write/dry-run behavior, isolated output routing, or explicit user approval for those paths.
- For async workflows, do not use `wait` or equivalent broad completion as the first proof for scheduler, worker, producer, persistence, finalizer, delivery, or report nodes. Design the cut first.
- Full end-to-end runs are confirmation runs only after all prerequisite component nodes for that variant have passed. They are not the default way to discover which node is broken.
- Do not run unbounded synchronous terminal commands. Avoid `timeout=0` or equivalent no-limit execution for tests, builds, CLI confirmation, model-backed workflows, watchers, or commands that can wait for external services. If the command may be long-running, run it asynchronously with a clear readiness or finish signal, redirect bulky output to an attachment, and keep the current node pending until a bounded result is read.
- Every terminal command used as evidence must be non-interactive and must produce either a normal test summary or an explicit exit marker. If it stalls, kill or stop the terminal, record the partial output as the node's evidence, mark the node `blocked` or `fail`, then design a smaller harness before rerunning.
- Do not write a final outcome section as a substitute for repair when a node fails and the repair scope is available.
- Do not start a later node merely to show progress. Visible progress is the current node becoming better isolated, better observed, repaired, rerun, or clearly blocked.

## Work Loop

1. Build a read-only source model of the workflow, entry points, state transitions, and expected artifacts.
2. Create a source-derived node plan small enough to isolate failures.
3. Select optional overlays only after the source map exists.
4. Align against target documents and overlays, then fill gaps without losing source-derived stop conditions.
5. Render `report/plan.md` with source chain map, reference alignment, expanded node sections, variant order, benchmark review, node-to-test coverage, expansion strategy, execution log, and full-run readiness gate.
6. Keep benchmark comparison and Skill feedback inside the plan; do not create a separate review file unless the user asks.
7. Start with `N0-data-location` when Alembic runtime data, Ghost mode, database, knowledge base, candidates, wiki, or project skills may be involved.
8. Before executing each node, write or update that node's design/test plan, isolation design, and section task workflow; then run the current-node loop against the subplan as a whole: execute only the next pending node, collect evidence, decide, repair that node if needed, rerun the same node, harden the evidence if useful, and only then advance.
9. Record commands, outputs, changed files, evidence paths, and remaining risk.

## Failure Handling

- If a node fails before code changes, improve observability or split the node smaller.
- If a node fails after a fix, revert only your own failed attempt or apply a narrower fix; do not revert unrelated user changes.
- If the failure needs broader refactoring, record the reason in the node round before expanding scope.
- If a command would cross the declared write boundary, stop and ask for approval with the exact path facts.
- After any repair, rerun the same node and update its status before starting another node.
- Do not advance to a later node, expansion, or final report while the current node is failed and a focused repair is within the requested scope.
- If the current node is vague, under-tested, or poorly isolated, improve that section first even when the broad chain appears healthy.

## Evidence Contract

Record enough evidence for another maintainer to replay the decision while keeping file count low:

- `report/plan.md`: the primary and only required artifact. It contains run metadata, safety boundary, source chain map, reference alignment, node state, per-node design/test plans, execution log, benchmark review, final outcome, and residual risk.
- Inline evidence in the plan whenever it is short enough to read.
- Optional attachments only when needed: large command output, binary snapshots, generated JSON reports, or machine-produced data that would make the plan hard to scan.
- Every optional attachment must be linked from the relevant plan section with a short summary and decision.
- Do not create separate manifest, nodes, chain-map, alignment, skill-review, command-log, round, or final-report files by default.

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
