# Artifact Layout

A progressive-chain-validation run writes records under `scratch/chain-runs/<run-id>/`. This directory is temporary development evidence, not product runtime data.

## Run Directory

```text
scratch/chain-runs/<run-id>/
  report/
    plan.md
    nodes.json
    rounds/
      N0-data-location.md
      N1-entry.md
    patches.md
    commands.md
    final-report.md
    handoff.md
  evidence/
    N0-data-location.json
  logs/
  fixtures/
  temp-tests/
  command-output/
  snapshots/
```

## Rules

- `report/` contains human-readable state and handoff notes.
- `evidence/` contains structured facts and machine-checkable outputs.
- `command-output/` contains trimmed command output when it is too long for reports.
- `fixtures/` and `temp-tests/` are disposable and must not be imported by production code.
- Do not write run artifacts to `docs-dev/`.
- Do not write run artifacts to this internal Skill directory.
- Do not use `scratch/chain-runs/` as a user project runtime data root.

## Run ID

Use:

```text
pcv-YYYYMMDD-HHMM-<target-slug>
```

Example:

```text
pcv-20260506-1430-alembic-rescan
```
