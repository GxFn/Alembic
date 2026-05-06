---
name: progressive-chain-validation
description: Use when validating or repairing a complex long-running workflow by decomposing it into small nodes, preparing evidence, running checks node by node, applying minimal fixes, and producing a handoff report.
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

## Execution Loop

1. Build a read-only model of the workflow, entry points, state transitions, and expected artifacts.
2. Create a node plan with small validation units and clear pass/fail evidence.
3. Start with `N0-data-location` when Alembic project data, Ghost mode, database, knowledge base, candidates, wiki, or runtime files may be involved.
4. For each node, prefer observability and focused tests before changing code.
5. Apply the smallest fix that addresses the current node failure.
6. Re-run the same node before moving forward.
7. Record commands, outputs, files changed, evidence paths, and remaining risk.
8. Finish with a concise handoff report.

## Safety Rules

- Do not run user-facing Alembic commands inside the Alembic source repository.
- Do not create `.asd/`, `Alembic/candidates/`, `Alembic/wiki/`, or other user runtime directories in this repository.
- Write run records under `scratch/chain-runs/<run-id>/` only.
- Use external test projects or Ghost `dataRoot` for user-project runtime data.
- Do not modify unrelated code while repairing a node.
- Ask for approval before destructive file operations or production data access.

## References

- `references/artifact-layout.md`
- `references/alembic-adapter.md`
- `references/data-location-preflight.md`
- `references/safety-boundaries.md`

## Templates

- `templates/plan.md`
- `templates/round.md`
- `templates/final-report.md`
- `templates/commands.md`
- `templates/nodes.json`
