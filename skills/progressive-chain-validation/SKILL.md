---
name: progressive-chain-validation
description: "Use when: validating long-chain workflow behavior, progressive node-by-node repair, Alembic cold-start/rescan/bootstrap/delivery/skill-generation flows, or any complex agent harness where evidence and safe write boundaries must be recorded."
argument-hint: "<workflow-or-feature> [target-project-root]"
---

# Progressive Chain Validation

Use this internal Alembic skill for long workflow validation work where a single end-to-end test is too large to debug directly. It is intended for Alembic maintainers and development agents working in this repository.

Do not treat this as a product skill. It must not be injected into user projects, copied to `.cursor/skills`, or exposed through product builtin skill listing.

## Required Inputs

Before acting, identify:

- Target workflow or feature chain.
- Target project root for any user-project validation.
- Whether the target is the Alembic source repository or an external test project.
- Existing test plan, design note, bug report, or failing output.
- Allowed command scope and destructive-operation boundary.

If any command would write Alembic runtime data, first complete `N0-data-location` and get an explicit path fact table.

## Startup Checklist

1. Load [Safety Boundaries](./references/safety-boundaries.md) before planning commands.
2. Load [Alembic Adapter](./references/alembic-adapter.md) when working in this repository.
3. Load [Data Location Preflight](./references/data-location-preflight.md) before any runtime, knowledge, database, candidate, wiki, or project-skill writes.
4. Create a run id with the `pcv-YYYYMMDD-HHMM-<target-slug>` pattern.
5. Use [Artifact Layout](./references/artifact-layout.md) to decide where evidence and reports should live.
6. Initialize the run with [Manifest](./templates/manifest.json), [Nodes JSON](./templates/nodes.json), [Plan](./templates/plan.md), [Commands](./templates/commands.md), and [N0 data-location evidence](./templates/N0-data-location.json).

## Node Contract

Every node must have:

- A stable id such as `N0-data-location`, `N1-entry-model`, or `N2-focused-test`.
- A hypothesis that can be proven or falsified.
- Planned commands and files to inspect before command execution.
- Pass criteria that can be checked from files, command output, or structured evidence.
- A status from `pending`, `running`, `pass`, `fail`, `blocked`, or `skipped`.
- A failure policy that says whether to retry, repair, split the node, or stop.

## Execution Loop

1. Build a read-only model of the workflow, entry points, state transitions, and expected artifacts.
2. Create a node plan with small validation units and clear pass/fail evidence.
3. Start with `N0-data-location` when Alembic project data, Ghost mode, database, knowledge base, candidates, wiki, or runtime files may be involved.
4. For each node, prefer observability and focused tests before changing code.
5. Apply the smallest fix that addresses the current node failure.
6. Re-run the same node before moving forward.
7. Record commands, outputs, files changed, evidence paths, and remaining risk.
8. Finish with a concise handoff report.

## Failure Handling

- If a node fails before code changes, improve observability or split the node smaller.
- If a node fails after a fix, revert only your own failed attempt or apply a narrower fix; do not revert unrelated user changes.
- If the failure needs broader refactoring, record the reason in the node round before expanding scope.
- If a command would cross the declared write boundary, stop and ask for approval with the exact path facts.
- After any repair, rerun the same node and update its status before starting another node.

## Evidence Contract

Record enough evidence for another maintainer to replay the decision:

- `report/plan.md`: workflow boundary, node list, safety boundary, allowed commands.
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
- [Data location preflight](./references/data-location-preflight.md)
- [Safety boundaries](./references/safety-boundaries.md)

## Templates

- [Plan](./templates/plan.md)
- [Round](./templates/round.md)
- [Final report](./templates/final-report.md)
- [Commands](./templates/commands.md)
- [Manifest](./templates/manifest.json)
- [Nodes JSON](./templates/nodes.json)
- [N0 data-location evidence](./templates/N0-data-location.json)
