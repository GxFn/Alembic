# Alembic Cold-start and Rescan Overlay

Use this overlay for Alembic cold-start, bootstrap, rescan, Agent fill, persistence, finalizer, snapshot, report, or history validation after `evidence/chain-map.json` exists.

This overlay is a coverage oracle, not a ready-made plan. The generated `report/plan.md` must still derive node cuts from source and must meet or exceed `docs-dev/bootstrap-rescan-chain-test-plan.md`.

## Applicability Rules

- Declare executor scope before choosing commands. Public MCP `alembic_bootstrap` follows the external-agent path; CLI cold-start, Dashboard bootstrap operations, and `bootstrap-internal` validate internal auto-fill behavior.
- Treat `skipAsyncFill=true` as skeleton-only evidence. It can prove cleanup, scan, snapshot, dimension planning, session, and task creation, but not async dispatch, stage factory, analyze, produce, persistence consumers, finalizer, or report-history nodes.
- For pure full-reset cold-start plans, mark N5 rescan preservation as `not-applicable` and N10 evolve/prescreen as `conditional` unless the source path introduces existing recipe truth, decay, or prescreen input.
- A broad smoke command or full run can provide observation evidence, but it cannot mark multiple nodes as passed.

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

Use N10 in cold-start only when existing recipe truth, decay, or prescreen/evolution behavior is in scope.

Internal rescan:
N0 Ghost workspace -> N1 Bootstrap -> N2 rescan intent -> N5 existing recipe snapshot and cleanup -> N3 rediscovery -> N4 rematerialization -> N6 rescan dimension plan -> N7 gap session tasks -> N8 stage factory/tool policy -> N10 evolve/prescreen -> N9 single gap-dimension analyze -> N11 produce -> N12 no duplicate healthy recipe -> N13 finalizer isolation -> N14 report/history/snapshot -> EXP-two-dimensions -> EXP-full-dimensions.

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
- Prefer observability as the first optimization action when a failing invariant is ambiguous.
- Each expansion node changes only one variable: dimensions, `maxFiles`, terminal toolset, provider mode, or wait/no-wait behavior.
