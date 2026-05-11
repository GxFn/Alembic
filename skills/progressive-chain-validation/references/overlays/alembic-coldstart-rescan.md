# Alembic Cold-start and Rescan Overlay

Use this overlay for Alembic cold-start, bootstrap, rescan, Agent fill, persistence, finalizer, snapshot, report, or history validation after the plan's Source Chain Map section exists.

This overlay is a coverage oracle, not a ready-made plan. The generated `report/plan.md` must still derive node cuts from source and must meet or exceed `docs-dev/workflows-scan/bootstrap-rescan-chain-test-plan.md`.

## Applicability Rules

- Declare executor scope before choosing commands. Public MCP `alembic_bootstrap` follows the external-agent path; CLI cold-start, Dashboard bootstrap operations, and `bootstrap-internal` validate internal auto-fill behavior.
- Treat `skipAsyncFill=true` as skeleton-only evidence. It can prove cleanup, scan, snapshot, dimension planning, session, and task creation, but not async dispatch, stage factory, analyze, produce, persistence consumers, finalizer, or report-history nodes.
- For pure full-reset cold-start plans, mark N5 rescan preservation as `not-applicable` and N10 evolve/prescreen as `conditional` unless the source path introduces existing recipe truth, decay, or prescreen input.
- A broad smoke command or full run can provide observation evidence, but it cannot mark multiple nodes as passed and must not replace current-node repair.
- For external real-project validation, do not run a full `--wait` command that can reach delivery/wiki/agent-instruction writes until the plan has either proven no-target-write/dry-run routing, isolated delivery routing, or explicit approval for the exact target paths.

## Canonical Coverage Nodes

| Node | Coverage Target | Evidence Surface | Pass Signal |
|------|-----------------|------------------|-------------|
| N0 | Environment, Ghost workspace, write boundary | `WorkspaceResolver.toFacts()`, `ProjectRegistry.inspect()`, source-root pollution check | Writes target the approved dataRoot; Alembic source repo is not used as runtime data root |
| N1 | Bootstrap and ServiceContainer lifecycle | DB migration/WAL state, logger/gateway/toolRegistry/taskManager resolution, repeated init/shutdown | Core services initialize and shut down without dirty state |
| N2 | Entry parameters and semantic intent | `maxFiles`, `contentMaxLines`, dimensions, `skipAsyncFill`, cleanup/rescan policy, legacy terminal fields | Equivalent entries produce equivalent intent; terminal capability is decided later |
| N3 | Discovery and file collection | discoverer id, targets, allFiles, skipped dirs, read failures, truncation | Project files are selected under projectRoot; generated/Alembic runtime output is excluded |
| N4 | Non-AI materialization | language stats, AST/dependency graph, enhancement packs, Guard audit, project snapshot | Snapshot is sufficient for prompts; degraded analyzers record reasons |
| N5 | Rescan existing recipe snapshot and cleanup | preserved recipe count, lifecycle distribution, source refs, cleanup report | Active/staging/evolving recipes are preserved; derived cache cleanup is separated |
| N6 | Dimension plan | requested/skipped dimensions, coverageByDimension, gap dimensions, execution reasons | Cold-start includes expected dimensions; rescan explains healthy skips and gap/decay runs |
| N7 | Session and TaskManager | session id, dimension tasks, status API, cancel and abort wiring | Task count matches execution dimensions; cancellation prevents new starts |
| N8 | Stage factory and tool policy | stage order, additionalTools, terminal capability hints, producer tool restrictions | Analyze/evolve/produce policies differ correctly; producer has no terminal tools |
| N9 | Agent analyze quality | provider/runtime, tool calls, memory calls, ExplorationTracker, QualityGate artifact | Findings have file-level evidence; quality gate is not stuck at fallback |
| N10 | Evolve and prescreen | existingRecipes, decay reasons, skipped/evolved/deprecated counts, duplicate trigger blocks | Healthy recipes do not duplicate; decay and severe cases are not silently lost |
| N11 | Produce | submitted/accepted/rejected counts, sourceRefs, gap limits, producer tool calls | Accepted candidates have real source refs; rejected items have actionable reasons |
| N12 | Consumers, dedup, persistence | CandidateResults, SkillResults, SessionStore reports, DB/file records | Accepted candidates are findable; failures are persisted with details |
| N13 | Finalizer policy | delivery/wiki/semantic/vector refresh, rescan isolation, finalizer step result | Cold-start finalizes fully; rescan skips non-rescan side effects explicitly |
| N14 | Report, snapshot, history | latest report, history index, session report, artifacts, snapshots, tool usage | Reports are valid and comparable; session ids and snapshot records align |

## Recommended Variant Orders

Cold-start full reset:
N0 Ghost workspace -> N1 Bootstrap -> N2 cold-start intent -> N3 discovery -> N4 materialization -> N6 dimension plan -> N7 session/tasks -> N8 stage factory/tool policy -> N9 single-dimension analyze -> N11 single-dimension produce -> N12 persistence -> N13 finalizer -> N14 report/history/snapshot -> EXP-two-dimensions -> EXP-full-dimensions.

Execute this order as a cursor, one node at a time. The order is not permission to run one `--wait` command through N14. If the only available command crosses N8-N14, first add a no-delivery/dry-run harness or mark the current node blocked with the missing stop point.

Use N10 in cold-start only when existing recipe truth, decay, or prescreen/evolution behavior is in scope.

Internal rescan:
N0 Ghost workspace -> N1 Bootstrap -> N2 rescan intent -> N5 existing recipe snapshot and cleanup -> N3 rediscovery -> N4 rematerialization -> N6 rescan dimension plan -> N7 gap session tasks -> N8 stage factory/tool policy -> N10 evolve/prescreen -> N9 single gap-dimension analyze -> N11 produce -> N12 no duplicate healthy recipe -> N13 finalizer isolation -> N14 report/history/snapshot -> EXP-two-dimensions -> EXP-full-dimensions.

Execute this order as a cursor, one node at a time. Existing-recipe fixture state and finalizer isolation must be proven before broad rescan confirmation.

## Mandatory Internal Source Splits

For internal auto-fill cold-start, add these source-derived split points when present:

| Split | Source Boundary | Evidence Requirement |
|-------|-----------------|----------------------|
| Full-reset cleanup between N2 and N3 | `runFullResetPolicy()` before `ProjectIntelligenceCapability.run()` | Cleanup target paths, cleared tables/files, errors, and proof writes stay inside approved dataRoot |
| Snapshot/report/target-map after N4 and before N6 | `buildProjectSnapshot()`, `buildInternalColdStartReport()`, `buildInternalColdStartTargetFileMap()` | Snapshot fields, report phase totals, filesByTarget keys, `contentMaxLines` truncation |
| Skeleton response and async dispatch after N7 | `startInternalDimensionExecutionSession()`, `dispatchInternalDimensionExecution()`, response presenter | `skipAsyncFill` branch, dispatch log, task count, response framework/status fields |
| Runtime preparation before N8/N9 | `prepareInternalDimensionFillRun()`, `initializeBootstrapRuntime()` | dataRoot/projectRoot, session id, abort signal, AI-unavailable branch, mock branch, runtime services |

For internal rescan, add these split points when present:

| Split | Source Boundary | Evidence Requirement |
|-------|-----------------|----------------------|
| Fixture state before N5 | `snapshotRecipes()` before `runRescanCleanPolicy()` | Fixture mode `empty`, `seeded`, or `copied-live`; preserved recipe count; lifecycle distribution; sourceRefs |
| Knowledge sync and SourceRef reconciliation after N5 | `syncKnowledgeStoreForRescan()`, `SourceRefReconciler.reconcile()` | Sync summary, inserted/active/stale/cleaned counts, warnings, degraded/blocked decision |
| Incremental diff mode before N4/N6 planning | `FileDiffPlanner` in `ProjectIntelligenceCapability.run()` | Previous snapshot id, fallback reason, changed files, affected dimensions |
| Rescan skeleton response and async dispatch after N7 | `startInternalDimensionExecutionSession()`, `dispatchInternalDimensionExecution()`, rescan response presenter | session superseding or abort logs, task count, response `asyncFill` and `status` |

If any applicable source split is missing from the generated plan, mark the plan incomplete even when N0-N14 labels are present.

## Rendering Hints

- Render every applicable canonical node and source split as an expanded `report/plan.md` section.
- Keep node evidence concrete: logs, reports, DB rows, snapshots, task status, candidate files, or structured JSON.
- Render benchmark-style operational guidance for every node. Preserve useful target-document checklists and source-align them to the real boundary before execution.
- Prefer observability as the first optimization action when a failing invariant is ambiguous.
- Give every node a smallest allowed command or harness and a list of forbidden broad commands.
- Treat full `--wait` runs as final confirmation only after current-node validation has passed through delivery safety gates.
- Each expansion node changes only one variable: dimensions, `maxFiles`, terminal toolset, provider mode, or wait/no-wait behavior.

## Detailed Guidance Floors

These floors are minimum guidance for generated Alembic cold-start/rescan plans. A source-derived plan may split or rename nodes, but it must preserve the concrete diagnostic power of the applicable floor.

### N11 Produce Guidance Floor

Goal: prove that Producer turns an analysis artifact into candidate output while respecting gap limits, dedup, schema, and tool boundaries.

Execution range: advance only until Producer finishes and submits candidate digest; do not run final delivery, wiki, semantic memory, or report/history as proof for this node.

Evidence checklist:

- submitted, accepted, and rejected counts.
- rejected reason for each rejected item.
- candidate title, trigger, kind, and sourceRefs.
- gap limit and remaining gap budget, especially in rescan mode.
- duplicate title and duplicate trigger decisions.
- Producer toolCalls and allowed tool ids.

Pass standard:

- Producer does not use terminal tools.
- Rescan mode submits no more candidates than the gap permits.
- Accepted candidates have sourceRefs that point to real target-project files.
- Rejected candidates have actionable field-level reasons rather than vague schema failure.

Failure taxonomy:

- Submit schema is unclear or hidden from the Producer.
- Analyst artifact cannot be produced into candidates.
- Dedup set is too strict or too loose.
- Producer continues exploration and wastes budget instead of producing.

Optimization actions:

- Tighten Producer prompt and submit schema guidance.
- Expose concrete rejected field errors in Producer or consumer output.
- Adjust dedup rules so only true title/trigger/content duplicates are blocked.

Recheck metrics:

- Reuse the same analysis artifact and compare accepted ratio before and after repair.
- Confirm rejected reasons move from unknown or vague schema errors to actionable field-level reasons and decrease when the fix is correct.
