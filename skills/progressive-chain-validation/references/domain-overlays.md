# Domain Overlays

Domain overlays are optional coverage oracles. They refine a source-derived plan with domain vocabulary, known split points, stricter pass criteria, and recommended expansion order.

Do not load an overlay before the source chain map exists. Do not let an overlay replace source analysis.

## Load Criteria

Load this reference when at least one is true:

- The user names a workflow with an existing protocol, such as cold-start, rescan, delivery, or report history.
- A target document contains a node taxonomy, phase list, acceptance checklist, or known defect chain.
- Source analysis finds domain-specific boundaries that need shared vocabulary for review.
- A previous round marked a reference requirement as `missing`, `split`, or `merged` and needs alignment rules.

## Overlay Contract

An overlay may define:

- Domain taxonomy and recommended node order.
- Mandatory split points found from real source chains.
- Domain-specific evidence surfaces and pass criteria.
- Branch, degradation, and executor-scope warnings.
- Priority order for repair when multiple nodes fail.

An overlay must not:

- Pass a node without source evidence.
- Force one canonical order when source boundaries differ.
- Hide branch, mock, skip, async, or degradation paths.
- Expand write permissions beyond the active run boundary.

## Selection Procedure

1. Complete `evidence/chain-map.json` with source entry points, call path, side effects, branches, and proposed nodes.
2. List candidate overlays in `report/plan.md` with `selected`, `not-selected`, or `blocked` status.
3. Load only selected overlays.
4. Compare every overlay requirement in `report/plan-alignment.md` using `covered`, `split`, `merged`, `missing`, `not-applicable`, or `conditional`.
5. Render selected overlay requirements into expanded `report/plan.md` node sections; do not leave them only inside the overlay file.
6. Add source-derived nodes, focused tests, or observability work for missing coverage before broad execution.
7. Record why any overlay item is not applicable.

## Available Overlays

- [Alembic cold-start/rescan overlay](./overlays/alembic-coldstart-rescan.md): use only for Alembic cold-start, bootstrap, rescan, Agent pipeline, delivery, finalizer, report, snapshot, or history validation.

## Maintenance Rules

- Keep overlays short and domain-specific; move long examples into separate reference files if needed.
- Put the trigger use case near the top so agents can decide whether to load the overlay.
- Prefer concrete evidence and stop conditions over abstract phase names.
- Keep overlays compact, but make each requirement renderable into full plan sections.
- State when a reference node is not applicable or conditional for a selected source path, such as rescan-only preservation in a pure cold-start chain.
- When a real validation plan finds missing source split points, update the overlay after the plan review.
