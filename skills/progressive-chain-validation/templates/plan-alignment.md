# Progressive Chain Reference Alignment

Run ID: `<pcv-YYYYMMDD-HHMM-target-slug>`
Target: `<workflow-or-feature>`
Source chain map: `evidence/chain-map.json`

## Alignment Rule

Compare source-derived nodes against target documents and domain overlays. Reference material can add missing coverage or stricter criteria, but it cannot pass a node without source evidence.

## Source Summary

- Entry points:
- Call path boundaries:
- Side-effect boundaries:
- Artifact boundaries:
- Observability gaps:

## Coverage Table

| Reference | Requirement | Derived Node | Status | Action |
|-----------|-------------|--------------|--------|--------|
| `<doc-or-protocol>` | `<node-or-requirement>` | `<node-id-or-n/a>` | `<covered|split|merged|missing|not-applicable|conditional>` | `<keep-add-split-merge-block-or-explain>` |

## Missing Coverage

- `<missing-reference-requirement>` -> `<node-test-or-observability-action>`

## Plan Changes After Alignment

- Added nodes:
- Split nodes:
- Merged nodes:
- Marked not applicable:
- Marked conditional:

## Decision

- Ready to execute node plan: `<yes-or-no>`
- Blocking facts:
- Next node:
