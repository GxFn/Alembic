# Progressive Chain Validation Plan

Run ID: `<pcv-YYYYMMDD-HHMM-target-slug>`
Target: `<workflow-or-feature>`
Target project root: `<absolute-path-or-n/a>`
Data root: `<absolute-path-or-n/a>`
Owner: `<agent-or-person>`
Started at: `<iso-time>`

Status values: `pending`, `running`, `pass`, `fail`, `blocked`, `skipped`

## Scope

Describe the workflow boundary, entry points, expected outputs, and what is intentionally out of scope.

## Safety Boundary

- Repository under edit:
- External test project:
- Runtime data location:
- Commands allowed:
- Commands requiring approval:
- Destructive operations allowed: no, unless explicitly approved

## Evidence Schema

- Structured evidence: `evidence/<node-id>.json`
- Node round note: `report/rounds/<node-id>.md`
- Long command output: `command-output/<node-id>-<short-name>.txt`
- Source changes: list exact files in the final report

## Node Plan

| Node | Purpose | Evidence | Pass Criteria | Status |
|------|---------|----------|---------------|--------|
| N0-data-location | Confirm project/data paths | `evidence/N0-data-location.json` | Paths are explicit and safe | pending |

## Repair Policy

- Fix only the current failing node.
- Re-run the same node before advancing.
- Split the node if the failure mixes unrelated modules.
- Record why if the repair scope expands.

## Risks

- `<risk>`

## Open Questions

- `<question>`
