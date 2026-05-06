# Artifact Layout

A progressive-chain-validation run writes records under `scratch/chain-runs/<run-id>/`. This directory is temporary development evidence, not product runtime data.

## Run Directory

```text
scratch/chain-runs/<run-id>/
  manifest.json
  report/
    plan.md
    plan-alignment.md
    skill-review.md
    nodes.json
    rounds/
      N0-data-location.md
      N1-entry.md
    patches.md
    commands.md
    final-report.md
    handoff.md
  evidence/
    chain-map.json
    N0-data-location.json
  logs/
  fixtures/
  temp-tests/
  command-output/
  snapshots/
```

## Rules

- `manifest.json` contains run id, target, owner, startedAt, status, and the safe write boundary.
- `report/plan.md` is the primary self-contained execution plan: source narrative, node cuts, variants, expanded node sections, branch impacts, and full-run readiness.
- `report/skill-review.md` records benchmark fit and any Skill/template/overlay changes discovered by plan generation.
- `report/` contains human-readable state and handoff notes.
- `evidence/` contains structured facts and machine-checkable outputs.
- `command-output/` contains trimmed command output when it is too long for reports.
- `fixtures/` and `temp-tests/` are disposable and must not be imported by production code.
- Do not write run artifacts to `docs-dev/`.
- Do not write run artifacts to this internal Skill directory.
- Do not use `scratch/chain-runs/` as a user project runtime data root.
- `report/plan-alignment.md` records target documents and any selected domain overlays using `covered`, `split`, `merged`, `missing`, `not-applicable`, and `conditional` statuses.
- For startup, copy or render the manifest, node state, chain map, plan, alignment, skill review, command log, and N0 evidence templates before marking `N0-data-location` complete. Fill `report/plan.md` to the plan-quality standard before broad workflow execution.

## Run ID

Use:

```text
pcv-YYYYMMDD-HHMM-<target-slug>
```

Example:

```text
pcv-20260506-1430-alembic-rescan
```

## Manifest Shape

```json
{
  "schemaVersion": 1,
  "runId": "pcv-YYYYMMDD-HHMM-target-slug",
  "target": "workflow-or-feature",
  "status": "running",
  "owner": "agent-or-person",
  "startedAt": "iso-time",
  "writeBoundary": {
    "targetProjectRoot": "/absolute/path-or-n/a",
    "dataRoot": "/absolute/path-or-n/a",
    "allowedWriteRoots": ["scratch/chain-runs/<run-id>"],
    "requiresApproval": []
  }
}
```
