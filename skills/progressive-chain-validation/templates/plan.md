# Progressive Chain Execution Plan

Run ID: `<pcv-YYYYMMDD-HHMM-target-slug>`
Target: `<workflow-or-feature>`
Target project root: `<absolute-path-or-n/a>`
Data root: `<absolute-path-or-n/a>`
Owner: `<agent-or-person>`
Started at: `<iso-time>`

Status values: `pending`, `running`, `pass`, `fail`, `blocked`, `skipped`

Primary deliverable: this document is the execution guide for a later agent. It must be self-contained, more explicit than the target reference document, and complete before broad workflow execution.

Minimum reference standard: `docs-dev/bootstrap-rescan-chain-test-plan.md` for Alembic cold-start/rescan work. For other workflows, use the same clarity bar: clear method, node overview, per-node sections, variant orders, round protocol, and full-run readiness gate.

## Scope

Describe the workflow boundary, entry points, expected outputs, and what is intentionally out of scope.

Executor scope: `<internal-agent|external-agent|dashboard|cli|mcp-public|mcp-internal|mixed|unknown>`
Plan mode: `<plan-only|plan-then-execute>`
Output language: `<user-language-or-project-default>`

## Plan Quality Standard

- A future agent can execute the chain from this document without rereading the skill.
- Code and tests are evidence sources, not implementation instructions.
- Every important claim is labeled as `source`, `reference`, `observed`, `assumption`, or `open`.
- Every selected node has an expanded node section, not only a row in a table.
- The plan names what each node intentionally does not evaluate.
- Branches, degraded paths, skip flags, async dispatch, cancellation, and alternate executor routes declare downstream impact.
- Workflow variants have explicit execution orders.
- The full-run readiness gate explains when a broad run is allowed.
- The plan includes a benchmark review and node-to-test coverage map before execution.

## Safety Boundary

- Repository under edit:
- External test project:
- Runtime data location:
- Commands allowed:
- Commands requiring approval:
- Destructive operations allowed: no, unless explicitly approved

## Evidence Schema

- Source chain map: `evidence/chain-map.json`
- Reference alignment: `report/plan-alignment.md`
- Skill review: `report/skill-review.md`
- Structured evidence: `evidence/<node-id>.json`
- Node round note: `report/rounds/<node-id>.md`
- Long command output: `command-output/<node-id>-<short-name>.txt`
- Source changes: list exact files in the final report

## Source-First Chain Analysis

Complete this section from code before executing a broad workflow command.

- Entry points: `<source|reference|observed|assumption|open>`
- Call path: `<source|reference|observed|assumption|open>`
- State boundaries: `<source|reference|observed|assumption|open>`
- Async/external/persistence boundaries: `<source|reference|observed|assumption|open>`
- Branches and degradation paths: `<source|reference|observed|assumption|open>`
- Side effects and write surfaces: `<source|reference|observed|assumption|open>`
- Artifact producers and consumers: `<source|reference|observed|assumption|open>`
- Existing focused tests: `<source|observed|open>`
- Observability gaps: `<source|observed|open>`
- Proposed stop conditions: `<source|reference|observed|assumption|open>`

## Analysis Chain Narrative

Write the chain as a readable sequence before the node table. Explain how data, state, artifacts, and decisions move from entry to output. Keep this section free of repair code; cite files, symbols, reports, or artifact names only as provenance.

1. `<entry-or-trigger>` -> `<normalized-intent-or-input>`
2. `<state-or-materialization-boundary>` -> `<artifact-or-decision>`
3. `<async-agent-persistence-delivery-report-boundary>` -> `<visible-output>`

## Node Cut Strategy

Explain why each cut exists. A cut is valid when the boundary can stop, fail, skip, degrade, write, dispatch asynchronously, persist, call a model/agent, deliver output, or produce a dependent artifact independently.

| Cut | Evidence Class | Boundary | Why It Is A Separate Node | Merge/Split Decision |
|-----|----------------|----------|---------------------------|----------------------|
| `<cut-id>` | `<source|reference|observed|assumption|open>` | `<boundary>` | `<reason>` | `<keep|split|merge|blocked>` |

## Granularity Gate

- Long-chain target: `<yes-or-no>`
- Source-first plan complete: `<yes-or-no>`
- Minimum nodes required: `10` when the chain crosses multiple independent runtime, async, persistence, Agent/model, delivery, or report boundaries
- Reference documents and selected domain overlays are coverage oracles, not substitutes for source analysis
- Domain overlay selected: `<none|overlay-id>`
- Overlay source: `<skill-reference|target-doc|bug-report|n/a>`
- Overlay alignment required before execution: `<yes-or-no>`
- Broad smoke/end-to-end command allowed before node plan: `no`
- Scope expansion rule: change only one variable at a time

## Branch And Degradation Paths

| Branch | Boundary | Trigger | Effect | Evidence | Decision |
|--------|----------|---------|--------|----------|----------|
| `<branch-id>` | `<boundary-id>` | `<flag-route-state-or-condition>` | `<continue-skip-block-or-degrade>` | `<log-status-artifact-or-test>` | `<pass-current-node|block-later-nodes|separate-plan|required-observation>` |

Skipped, mocked, degraded, or alternate-route branches cannot pass downstream nodes unless that branch is the explicit target of the node plan.

## Workflow Variant Orders

Define every execution order that a future agent may follow. Do not assume one canonical order when modes differ.

For async workflows that return before background work completes, include at least:

- Skeleton-only observation variant.
- Full async execution variant.
- Expansion variant from focused scope to full scope.

### Variant A: `<variant-name>`

1. `<node-id>`: `<why-this-node-is-first>`
2. `<node-id>`: `<advance-condition>`

### Variant B: `<variant-name-or-n/a>`

1. `<node-id>`: `<why-this-node-is-first>`
2. `<node-id>`: `<advance-condition>`

## Reference Alignment

Compare the source-derived plan with target documents and domain overlays before executing the chain.

| Reference | Requirement | Derived Node | Status | Action |
|-----------|-------------|--------------|--------|--------|
| `<doc-or-protocol>` | `<node-or-requirement>` | `<node-id-or-n/a>` | `<covered|split|merged|missing|not-applicable|conditional>` | `<action>` |

## Reference Benchmark Review

Compare this generated plan with the strongest target reference before handing it to an execution agent.

- Benchmark reference:
- Meets or exceeds benchmark clarity: `<yes|no|partial>`
- Improvements over benchmark:
- Benchmark gaps still missing:
- Skill/template/overlay improvements discovered:

Write the detailed review to `report/skill-review.md`.

## Node-To-Test Coverage Map

Before repair execution, map every node to existing focused tests or observation hooks.

| Node | Existing Test Or Observation | Missing Coverage | First Coverage Action |
|------|------------------------------|------------------|-----------------------|
| `<node-id>` | `<test-file-or-artifact-or-none>` | `<gap>` | `<test-or-observation-action>` |

## Node Plan

| Node | Source Boundary | Purpose | Stop Condition | Evidence | Pass Criteria | Status |
|------|-----------------|---------|----------------|----------|---------------|--------|
| N0-data-location | write boundary | Confirm project/data paths | no runtime command has run | `evidence/N0-data-location.json` | Paths are explicit and safe | pending |

Derive this table from source first, then align it to any selected overlay before running the chain. Do not leave the plan at N0/N1 plus one broad smoke node. After filling the table, render every selected node again as a full section below.

## Expanded Node Sections

Every long-chain node must use this expanded structure. Keep the wording concrete enough that another agent can execute the node without asking what to inspect.

### Node `<Nx-node-id>`: `<node-name>`

Target:
This round validates the chain only from entry to `<Nx-node-id>`.

Chain position:
- Upstream prerequisites:
- Downstream behavior intentionally not evaluated:
- Workflow variants where this node applies:
- Evidence class for this node cut: `<source|reference|observed|assumption|open>`

Execution scope:
- Entry:
- Input shape:
- Limits and dimensions:
- Provider/tool/wait mode:
- Branches to force or forbid:
- Safe write boundary:

Existing tests or observation gap:
- Focused tests:
- Missing tests:
- First observation hook:

Stop condition:
- `<exact observable stop point>`

Evidence:
- `<log-report-db-json-snapshot-task-artifact-or-command-output>`

Pass criteria:
- `<concrete invariant>`

Failure classes:
- `<input|state|algorithm|async|concurrency|persistence|external-service|model-agent|delivery|report-history|observability>`

First optimization action:
- `<smallest observation or behavior change to try first>`

Recheck standard:
- Same entry, same data, same target node.
- Compare before/after evidence.
- Record whether the next node may start.

Advance rule:
- Advance when:
- Block when:
- Split when:

## Repair Policy

- Fix only the current failing node.
- Re-run the same node before advancing.
- Split the node if the failure mixes unrelated modules.
- Record why if the repair scope expands.

## Risks

- `<risk>`

## Full-Run Readiness Gate

A broad workflow run is allowed only after these conditions are true:

- All prerequisite nodes for the selected variant are `pass` or explicitly `skipped` with downstream impact explained.
- No important claim remains `open` for the selected variant.
- Branch and degradation impacts are recorded.
- Persistence, async, Agent/model, delivery, and report/history boundaries have their own evidence.
- The planned expansion changes only one variable at a time.
- Focused validation has passed before any expansion node.
- Node-to-test or node-to-observation gaps are accepted explicitly or closed.

## Expansion Strategy

Define expansion nodes after the focused chain passes.

| Expansion Node | Variable Changed | Starting Scope | Target Scope | Pass Criteria |
|----------------|------------------|----------------|--------------|---------------|
| `<EXP-node>` | `<dimensions|maxFiles|toolset|provider|wait-mode>` | `<focused-scope>` | `<expanded-scope>` | `<invariant>` |

## Execution Handoff

- Next node to execute:
- Commands or actions allowed:
- Evidence files to create:
- Stop condition for the next executor:
- Facts the executor must not assume:

## Open Questions

- `<question>`
