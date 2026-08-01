import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PipelineStrategy } from '@alembic/agent';
import type { StrictTestDimensionAgentExecutionReceiptV1 } from '@alembic/agent/production';
import type { CompiledAgentProfile } from '@alembic/agent/service';
import { AgentService } from '@alembic/agent/service';
import { createProjectDescriptor } from '@alembic/core';
import {
  ANATOMY_LENS_IDS,
  type CertifiedPlanningFactsV1,
  type CompiledColdStartPlanV2,
} from '@alembic/core/plans';
import {
  canonicalizeKnowledgeClustersV1,
  createAnalysisReviewContextHashV1,
  createFinalExpandedMiningScheduleReceiptV1,
  createKnowledgeDispositionReviewV1,
  createProductionActorIdentityV1,
  hashKnowledgeClusterV1,
  hashKnowledgeDispositionProposalV1,
  type ObservationPopulationV1,
} from '@alembic/core/production';
import { hashCanonicalJson } from '@alembic/core/project-context-foundation';
import { WorkspaceResolver } from '@alembic/core/workspace';
import { afterEach, describe, expect, it } from 'vitest';
import type { ServiceContainer } from '../../lib/injection/ServiceContainer.js';
import {
  type MainCertifiedProjectFactsCarrier,
  type MainCertifiedProjectionPayload,
  openMainCertifiedProjectFactsArtifact,
} from '../../lib/project-facts/CertifiedProjectFactsRuntime.js';
import {
  createMainStrictFactQueryFamiliesV1,
  executeMainStrictFactScheduleV1,
} from '../../lib/recipe-pipeline/generate/strict/StrictFactExecutionRuntime.js';
import { createStrictTestDimensionOrchestrator } from '../../lib/recipe-pipeline/generate/strict/StrictTestDimensionRuntime.js';
import { StrictSemanticReviewRuntimeFactory } from '../../lib/service/semantic-review/StrictSemanticReviewRuntimeFactory.js';
import { PACKAGE_ROOT } from '../../lib/shared/package-assets.js';
import { createRuntimeArtifactManifestFixture } from '../helpers/RuntimeArtifactManifestFixture.js';

const roots: string[] = [];
const originalEnv = {
  provider: process.env.ALEMBIC_AI_PROVIDER,
  model: process.env.ALEMBIC_AI_MODEL,
  manifest: process.env.ALEMBIC_RUNTIME_ARTIFACT_MANIFEST_PATH,
};

type ReceiptMutation =
  | 'analysis-stage'
  | 'authority'
  | 'cross-run'
  | 'extra-cell'
  | 'missing'
  | 'partial'
  | 'review-stage';

afterEach(async () => {
  restoreEnv();
  await Promise.all(roots.splice(0).map((root) => fsp.rm(root, { force: true, recursive: true })));
});

describe('strict-test-dimension real Main private pipeline', () => {
  it('consumes one real AgentService/PipelineStrategy receipt and reopens the private terminal', async () => {
    const fixture = await createFixture();
    const service = createStrictTestDimensionOrchestrator(fixture.container);
    const before = await treeHash(fixture.dataRoot);
    const preflight = await service.preflight({
      demandKey: 'strict-test-pipeline',
      projectRoot: fixture.projectRoot,
      runId: 'strict-test-pipeline-run',
    });

    expect(preflight.preflight.dimensionResults).toHaveLength(26);
    const recommendedDimensionId = preflight.preflight.recommendation.dimensionId;
    expect(recommendedDimensionId).toBeTruthy();
    const completed = await service.start({
      demandKey: 'strict-test-pipeline',
      preflightHash: preflight.preflight.preflightHash,
      runId: 'strict-test-pipeline-run',
    });

    expect(completed.phase).toBe('STRICT_TEST_COMPLETED_PRIVATE');
    expect(completed.automaticSelection?.selectedDimensionId).toBe(recommendedDimensionId);
    expect(completed.projection?.dimensionStates).toHaveLength(26);
    expect(completed.projection?.executionCellIds).toHaveLength(1);
    if (
      !completed.automaticSelection ||
      !completed.projection ||
      !completed.terminal ||
      !completed.report
    ) {
      throw new Error('STRICT_TEST_FIXTURE_COMPLETION_AUTHORITY_REQUIRED');
    }
    expect(completed.terminal).toMatchObject({
      terminalState: 'STRICT_TEST_COMPLETED_PRIVATE',
      productionFinalized: false,
      publicRouteChanged: false,
    });
    expect(fixture.agent.strictPipelineCount).toBe(1);
    expect(fixture.agent.strictModelCallCount).toBe(2);

    const runRoot = path.join(
      fixture.root,
      'strict-test-runs/strict-test-pipeline/strict-test-pipeline-run'
    );
    const privateChain = JSON.parse(
      await fsp.readFile(path.join(runRoot, 'strict-test-private-chain.json'), 'utf8')
    ) as Record<string, unknown>;
    const receipt = privateChain.agentReceipt as Record<string, unknown>;
    const pipelineExecution = receipt.pipelineExecution as Record<string, unknown>;
    expect(receipt).toMatchObject({
      runId: 'strict-test-pipeline-run',
      segmentStatus: 'completed',
      attemptedCount: 1,
      productionFinalized: false,
      publicRouteChanged: false,
    });
    expect(pipelineExecution).toMatchObject({
      analysisStageEvidence: {
        analysisStageEvidenceHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      },
      reviewStageEvidence: {
        reviewStageEvidenceHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      },
    });
    expect(await treeHash(fixture.dataRoot)).toBe(before);

    const reopened = createStrictTestDimensionOrchestrator(fixture.container);
    expect((await reopened.status('strict-test-pipeline-run')).terminal).toEqual(
      completed.terminal
    );
    expect((await reopened.report('strict-test-pipeline-run')).reportHash).toBe(
      completed.report?.reportHash
    );
    const probeOutputPath = process.env.ALEMBIC_STRICT_TEST_MAIN_PROBE_OUTPUT;
    if (probeOutputPath) {
      const analysisStageEvidence = readRecord(pipelineExecution.analysisStageEvidence);
      const reviewStageEvidence = readRecord(pipelineExecution.reviewStageEvidence);
      await fsp.writeFile(
        probeOutputPath,
        `${JSON.stringify({
          schemaVersion: 1,
          profile: 'strict-test-dimension',
          phase: completed.phase,
          fullUniverse: {
            dimensionCount: completed.preflight.dimensionResults.length,
            cellCount: completed.preflight.cellUniverse.universeCount,
            fullCellUniverseHash: completed.preflight.fullCellUniverseHash,
          },
          automaticSelection: {
            selectedDimensionId: completed.automaticSelection.selectedDimensionId,
            selectedCellIds: completed.projection.executionCellIds,
            automaticSelectionHash: completed.automaticSelection.automaticSelectionHash,
            projectionHash: completed.projection.projectionHash,
          },
          sameRunAgentReceipt: {
            pipelineExecutionCount: fixture.agent.strictPipelineCount,
            modelCallCount: fixture.agent.strictModelCallCount,
            runId: receipt.runId,
            receiptHash: receipt.receiptHash,
            analysisStageEvidenceHash: analysisStageEvidence.analysisStageEvidenceHash,
            reviewStageEvidenceHash: reviewStageEvidence.reviewStageEvidenceHash,
          },
          privateChain: {
            checkpoint: 'strict-test-private-chain.json',
            finalCoverageReceiptHash: readRecord(privateChain.candidateCoverage).receiptHash,
            servingManifestHash: readRecord(readRecord(privateChain.finalization).servingManifest)
              .manifestHash,
          },
          terminal: {
            terminalState: completed.terminal.terminalState,
            terminalHash: completed.terminal.terminalHash,
            reportHash: completed.report.reportHash,
            productionStateUnchanged:
              completed.terminal.productionBeforeStateHash ===
              completed.terminal.productionAfterStateHash,
            publicRouteUnchanged:
              completed.terminal.publicRouteBeforeStateHash ===
              completed.terminal.publicRouteAfterStateHash,
            productionFinalized: completed.terminal.productionFinalized,
            publicRouteChanged: completed.terminal.publicRouteChanged,
          },
          forbiddenPathInvocations: {
            legacyBootstrap: 0,
            daemonJob: 0,
            fullReset: 0,
            publicationLock: 0,
            publicCas: 0,
          },
        })}\n`
      );
    }
  }, 120_000);

  it.each<ReceiptMutation>([
    'missing',
    'partial',
    'cross-run',
    'authority',
    'extra-cell',
    'analysis-stage',
    'review-stage',
  ])('rejects %s receipt drift before private corpus persistence', async (receiptMutation) => {
    const fixture = await createFixture({ receiptMutation });
    const service = createStrictTestDimensionOrchestrator(fixture.container);
    const productionBefore = await treeHash(fixture.dataRoot);
    const preflight = await service.preflight({
      demandKey: `strict-test-${receiptMutation}`,
      projectRoot: fixture.projectRoot,
      runId: `strict-test-${receiptMutation}-run`,
    });

    await expect(
      service.start({
        demandKey: `strict-test-${receiptMutation}`,
        preflightHash: preflight.preflight.preflightHash,
        runId: `strict-test-${receiptMutation}-run`,
      })
    ).rejects.toThrow(/STRICT_TEST/u);

    const runRoot = path.join(
      fixture.root,
      `strict-test-runs/strict-test-${receiptMutation}/strict-test-${receiptMutation}-run`
    );
    await expect(fsp.lstat(path.join(runRoot, 'private-chain-journal'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await service.status(`strict-test-${receiptMutation}-run`)).toMatchObject({
      phase: 'STRICT_TEST_FAILED',
      terminal: {
        terminalState: 'STRICT_TEST_FAILED',
        failedStage: 'ANALYSIS_FIXPOINT_CLOSED',
        productionFinalized: false,
        publicRouteChanged: false,
      },
      report: {
        terminalState: 'STRICT_TEST_FAILED',
        failure: { failedStage: 'ANALYSIS_FIXPOINT_CLOSED' },
      },
    });
    expect(await treeHash(fixture.dataRoot)).toBe(productionBefore);
  }, 120_000);
});

async function createFixture(options: { receiptMutation?: ReceiptMutation } = {}) {
  const createdRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'alembic-strict-test-main-'));
  // macOS 的 /var 是 /private/var 的符号链接；生产门禁比较物理项目根，因此夹具也先冻结 realpath。
  const root = await fsp.realpath(createdRoot);
  roots.push(root);
  const projectRoot = path.join(root, 'project');
  const dataRoot = path.join(root, 'data');
  await fsp.mkdir(path.join(projectRoot, 'src'), { recursive: true });
  await fsp.mkdir(path.join(dataRoot, '.asd'), { recursive: true });
  await fsp.writeFile(
    path.join(projectRoot, 'src/index.ts'),
    [
      'export interface Result<T> { value: T; }',
      'export function load(): Result<string> { return { value: "strict" }; }',
    ].join('\n')
  );
  await fsp.writeFile(
    path.join(projectRoot, 'src/adapter.ts'),
    [
      "import type { Result } from './index.js';",
      'export class StrictTestAdapter {',
      '  convert(value: string): Result<string> { return { value }; }',
      '}',
    ].join('\n')
  );
  const folderId = 'strict-test-folder';
  const projectScope = createProjectDescriptor({
    controlRoot: root,
    dataRoot,
    projectId: 'strict-test-project',
    projectScopeId: 'strict-test-scope',
    currentFolderId: folderId,
    folders: [{ id: folderId, path: projectRoot }],
  });
  const resolver = new WorkspaceResolver({ projectRoot, projectScope, currentFolderId: folderId });
  const runtimeArtifacts = await createRuntimeArtifactManifestFixture({
    root,
    loadedPackageRoots: {
      main: await fsp.realpath(PACKAGE_ROOT),
      core: await fsp.realpath(path.join(PACKAGE_ROOT, 'node_modules/@alembic/core')),
      agent: await fsp.realpath(path.join(PACKAGE_ROOT, 'node_modules/@alembic/agent')),
    },
  });
  const provider = new ControlledProvider();
  const agent = createRealAgentService(provider, options.receiptMutation);
  const embedProvider = createEmbedProvider();
  const services = new Map<string, unknown>([['agentService', agent.service]]);
  const container = {
    singletons: {
      _projectRoot: projectRoot,
      _workspaceResolver: resolver,
      _embedProvider: embedProvider,
      aiProvider: provider,
    },
    get(name: string) {
      if (!services.has(name)) {
        throw new Error(`strict-test fixture service missing:${name}`);
      }
      return services.get(name);
    },
  } as unknown as ServiceContainer;
  process.env.ALEMBIC_AI_PROVIDER = provider.name;
  process.env.ALEMBIC_AI_MODEL = provider.model;
  process.env.ALEMBIC_RUNTIME_ARTIFACT_MANIFEST_PATH = runtimeArtifacts.manifestPath;
  return { root, projectRoot, dataRoot, container, agent };
}

function createRealAgentService(provider: ControlledProvider, receiptMutation?: ReceiptMutation) {
  const counters = { strictPipelineCount: 0, strictModelCallCount: 0 };
  const service = new AgentService({
    runtimeBuilder: {
      build(profile, buildOptions) {
        const compiled = profile as CompiledAgentProfile;
        const runtimeId = buildOptions?.runId ?? `fixture-${compiled.id}`;
        if (compiled.id === 'plan-selection') {
          return {
            id: runtimeId,
            execute: async (message, runOptions) => {
              const metadata = readRecord(message.metadata);
              const reply =
                metadata.task === 'strict-independent-value-review'
                  ? independentReview(String(message.content ?? ''))
                  : planIntent(readRecord(readRecord(runOptions.context).strictPlanContext));
              return {
                reply: JSON.stringify(reply),
                toolCalls: [],
                tokenUsage: { input: 1, output: 1 },
                iterations: 1,
              };
            },
          };
        }
        const strategy = readRecord(compiled.runtimeOverrides.strategy);
        const stages = Array.isArray(strategy.stages) ? strategy.stages : [];
        if (!stages.some((stage) => readRecord(stage).name === 'produce')) {
          throw new Error(
            `STRICT_TEST_FIXTURE_PROFILE_STAGES:${stages
              .map((stage) => String(readRecord(stage).name))
              .join(',')}`
          );
        }
        const pipeline = new PipelineStrategy({ stages: stages as Record<string, unknown>[] });
        return {
          id: runtimeId,
          execute: async (message, runOptions) => {
            counters.strictPipelineCount += 1;
            let stageIndex = 0;
            let result: Awaited<ReturnType<PipelineStrategy['execute']>>;
            try {
              result = await pipeline.execute(
                {
                  id: runtimeId,
                  reactLoop: async () => {
                    counters.strictModelCallCount += 1;
                    const strictPort = readRecord(runOptions.strategyContext)
                      .strictProduction as StrictPort;
                    let reply: string;
                    try {
                      reply =
                        stageIndex++ === 0
                          ? JSON.stringify(
                              buildFixtureAnalystEpoch(
                                strictPort.readAnalysisEpoch(),
                                await loadFixtureAnalystAuthority(strictPort, provider)
                              )
                            )
                          : JSON.stringify(buildFixtureProducerOutput(strictPort));
                    } catch (error: unknown) {
                      throw new Error(
                        `STRICT_TEST_FIXTURE_STAGE_BUILD_FAILED:${
                          error instanceof Error ? error.stack : String(error)
                        }`,
                        { cause: error }
                      );
                    }
                    return {
                      reply,
                      toolCalls: [],
                      tokenUsage: { input: 1, output: 1 },
                      iterations: 1,
                    };
                  },
                },
                message,
                runOptions
              );
            } catch (error: unknown) {
              throw new Error(
                `${error instanceof Error ? error.message : String(error)}:stages=${stages
                  .map((stage) => String(readRecord(stage).name))
                  .join(',')}`,
                { cause: error }
              );
            }
            if (!receiptMutation || !result.strictTestExecutionReceipt) {
              return result;
            }
            const mutated = mutateStrictTestReceipt(
              result.strictTestExecutionReceipt,
              receiptMutation
            );
            if (!mutated) {
              const { strictTestExecutionReceipt: _receipt, ...withoutReceipt } = result;
              return withoutReceipt;
            }
            return {
              ...result,
              strictTestExecutionReceipt: mutated,
            };
          },
        };
      },
    },
  });
  return {
    service,
    get strictPipelineCount() {
      return counters.strictPipelineCount;
    },
    get strictModelCallCount() {
      return counters.strictModelCallCount;
    },
  };
}

function mutateStrictTestReceipt(
  receipt: StrictTestDimensionAgentExecutionReceiptV1,
  mutation: ReceiptMutation
): StrictTestDimensionAgentExecutionReceiptV1 | undefined {
  if (mutation === 'missing') {
    return undefined;
  }
  if (mutation === 'partial') {
    return { ...receipt, segmentStatus: 'partial' };
  }
  if (mutation === 'cross-run') {
    return { ...receipt, runId: 'cross-run-tamper' };
  }
  if (mutation === 'authority') {
    return { ...receipt, authorityHash: sha('tampered-authority') };
  }
  if (mutation === 'extra-cell') {
    return { ...receipt, selectedCellIds: [...receipt.selectedCellIds, 'module:extra::extra'] };
  }
  const pipelineExecution = receipt.pipelineExecution;
  if (!pipelineExecution) {
    throw new Error('STRICT_TEST_FIXTURE_PIPELINE_EXECUTION_REQUIRED');
  }
  if (mutation === 'analysis-stage') {
    return {
      ...receipt,
      pipelineExecution: {
        ...pipelineExecution,
        analysisStageEvidence: {
          ...pipelineExecution.analysisStageEvidence,
          analysisStageEvidenceHash: sha('tampered-analysis-stage'),
        },
      },
    };
  }
  return {
    ...receipt,
    pipelineExecution: {
      ...pipelineExecution,
      reviewStageEvidence: {
        ...pipelineExecution.reviewStageEvidence,
        producerStageResultHash: sha('tampered-review-stage'),
      },
    },
  };
}

interface StrictPort {
  readAnalysisEpoch(): StrictSnapshot;
  buildProducerInput(): {
    readonly evidence: { readonly entries: readonly { readonly evidenceEntryId: string }[] };
    readonly lineages: readonly { readonly hypothesis: { readonly hypothesisId: string } }[];
  };
  readonly eligibleCells: readonly {
    readonly cellId: string;
    readonly moduleId: string;
    readonly dimensionId: string;
  }[];
  readonly strictTestAuthority: {
    readonly demandKey: string;
    readonly runId: string;
    readonly currentBindings: {
      readonly controlRootIdentity: string;
      readonly projectRootIdentity: string;
    };
    readonly compiledPlan: CompiledColdStartPlanV2;
  };
}

interface StrictSnapshot {
  readonly context: {
    readonly runId: string;
    readonly baselineScheduleHash: string;
    readonly factQueryObligationIds: readonly string[];
  };
  readonly populations: readonly ObservationPopulationV1[];
}

interface FixtureAnalystAuthority {
  readonly executionReceipts: Parameters<
    typeof createKnowledgeDispositionReviewV1
  >[0]['executionReceipts'];
  readonly finalExpandedSchedule: ReturnType<typeof createFinalExpandedMiningScheduleReceiptV1>;
  readonly terminalObligations: Parameters<
    typeof createKnowledgeDispositionReviewV1
  >[0]['terminalObligations'];
}

async function loadFixtureAnalystAuthority(
  port: StrictPort,
  provider: ControlledProvider
): Promise<FixtureAnalystAuthority> {
  const authority = port.strictTestAuthority;
  const runRoot = path.join(
    authority.currentBindings.controlRootIdentity,
    'strict-test-runs',
    authority.demandKey,
    authority.runId
  );
  const checkpoint = JSON.parse(
    await fsp.readFile(path.join(runRoot, 'strict-test-dimension.checkpoint.json'), 'utf8')
  ) as Record<string, unknown>;
  const context = readRecord(checkpoint.executionContext);
  const carrier = context.carrier as MainCertifiedProjectFactsCarrier;
  const projection = context.projection as MainCertifiedProjectionPayload;
  const artifact = await openMainCertifiedProjectFactsArtifact({
    carrier,
    dataRoot: path.join(runRoot, 'private-data'),
  });
  const reviewer = readRecord(context.reviewer) as unknown as {
    readonly calibrationReceiptHash: string;
    readonly identity: {
      readonly provider: string;
      readonly model: string;
      readonly method: string;
    };
  };
  const runtimeConfigReceipt = readRecord(context.runtimeConfigReceipt);
  const session = await new StrictSemanticReviewRuntimeFactory({
    dataRoot: path.join(runRoot, 'private-data'),
    provider,
  }).openSession({
    artifact,
    credentialLocationSymbol: String(context.credentialLocationSymbol),
    modelVersion: String(context.modelHash),
    projection,
    projectRoot: authority.currentBindings.projectRootIdentity,
    reviewer,
    runId: authority.runId,
    runtimeConfigHash: String(runtimeConfigReceipt.configHash),
    sourceRevisionVectorHash: authority.compiledPlan.execution.sourceRevisionVectorHash,
  });
  const execution = await executeMainStrictFactScheduleV1({
    artifact,
    certifiedPlanningFacts: context.certifiedPlanningFacts as CertifiedPlanningFactsV1,
    projection,
    schedule: authority.compiledPlan.schedule,
    catalog: authority.compiledPlan.factQueryCatalog,
    factEvidence: session.factEvidence,
  });
  return {
    executionReceipts: execution.receipts,
    finalExpandedSchedule: createFinalExpandedMiningScheduleReceiptV1({
      baselineScheduleHash: authority.compiledPlan.schedule.baselineScheduleHash,
      baselineObligationIds: authority.compiledPlan.schedule.factHarvestObligations.map(
        (row) => row.obligationId
      ),
      expansionReceipts: [],
    }),
    terminalObligations: execution.terminalObligations,
  };
}

function buildFixtureAnalystEpoch(snapshot: StrictSnapshot, authority: FixtureAnalystAuthority) {
  const population = snapshot.populations.at(-1);
  if (!population) {
    throw new Error('STRICT_TEST_FIXTURE_POPULATION_REQUIRED');
  }
  const grouped = new Map<string, ObservationPopulationV1['observations'][number][]>();
  for (const observation of population.observations) {
    const rows = grouped.get(observation.mechanismKey) ?? [];
    rows.push(observation);
    grouped.set(observation.mechanismKey, rows);
  }
  const clusterInputs = [...grouped.entries()].map(([mechanismKey, rows]) => ({
    mechanismKey,
    mechanism: { invariant: mechanismKey },
    observationIds: rows.map((row) => row.observationId),
    mechanismEvidenceFactIds: rows.flatMap((row) => row.factIds),
    anatomyLensIds: ['error-recovery-concurrency'],
  }));
  const clusterSet = canonicalizeKnowledgeClustersV1(population, {
    clusters: clusterInputs,
    nonClusteredDispositions: [],
  });
  const currentAnalysisFixpointHash = createAnalysisReviewContextHashV1({
    finalExpandedScheduleHash: authority.finalExpandedSchedule.finalExpandedScheduleHash,
    terminalObligations: authority.terminalObligations,
    populationHashes: [population.populationHash],
    clusterSetHashes: [clusterSet.clusterSetHash],
  });
  const clusterByMechanism = new Map(
    clusterSet.clusters.map((cluster) => [cluster.mechanismKey, cluster] as const)
  );
  const groupedEntries = [...grouped.entries()];
  const firstFactId = groupedEntries[0]?.[1][0]?.factIds[0];
  if (!firstFactId) {
    throw new Error('STRICT_TEST_FIXTURE_FACT_REQUIRED');
  }
  const dispositionReviews = groupedEntries.slice(1).map(([mechanismKey, rows], index) => {
    const cluster = clusterByMechanism.get(mechanismKey);
    if (!cluster) {
      throw new Error('STRICT_TEST_FIXTURE_CLUSTER_REQUIRED');
    }
    const zeroHypothesisReason = 'insufficient-evidence' as const;
    return createKnowledgeDispositionReviewV1({
      reviewKind: 'zero-hypothesis',
      currentAnalysisFixpointHash,
      populationHash: population.populationHash,
      proposedDispositionHash: hashKnowledgeDispositionProposalV1({
        reviewKind: 'zero-hypothesis',
        populationHash: population.populationHash,
        clusterHash: hashKnowledgeClusterV1(cluster),
        clusterId: cluster.clusterId,
        observationIds: cluster.observationIds,
        mode: rows.length === 1 ? 'bounded-singleton' : 'recurring',
        zeroHypothesisReason,
      }),
      executionReceipts: authority.executionReceipts,
      finalExpandedSchedule: authority.finalExpandedSchedule,
      terminalObligations: authority.terminalObligations,
      producer: actor(snapshot.context.runId, `producer-zero-${index}`),
      reviewer: actor(snapshot.context.runId, `reviewer-zero-${index}`),
      calibrationReceiptHash: sha('fixture-calibration'),
      verdict: 'pass',
      reasonCode: `fixture-zero-hypothesis-${index}`,
    });
  });
  const counterqueryApplicability = {
    status: 'not-required' as const,
    reasonCode: 'bounded-project-contract',
  };
  const falsificationReview = createKnowledgeDispositionReviewV1({
    reviewKind: 'falsification',
    currentAnalysisFixpointHash,
    populationHash: population.populationHash,
    proposedDispositionHash: hashKnowledgeDispositionProposalV1({
      reviewKind: 'falsification',
      populationHash: population.populationHash,
      hypothesisId: 'hypothesis-strict-test-main',
      enrolledCounterqueryIds: [],
      executions: [],
      counterqueryApplicability,
    }),
    executionReceipts: authority.executionReceipts,
    finalExpandedSchedule: authority.finalExpandedSchedule,
    terminalObligations: authority.terminalObligations,
    producer: actor(snapshot.context.runId, 'producer-falsification'),
    reviewer: actor(snapshot.context.runId, 'reviewer-falsification'),
    calibrationReceiptHash: sha('fixture-calibration'),
    verdict: 'pass',
    reasonCode: 'fixture-falsification-pass',
  });
  return {
    epoch: {
      currentAnalysisFixpointHash,
      population,
      clusterInputs,
      nonClusteredDispositions: [],
      inductionInputs: groupedEntries.map(([mechanismKey, rows], index) =>
        index === 0
          ? {
              mechanismKey,
              mode: rows.length === 1 ? ('bounded-singleton' as const) : ('recurring' as const),
              hypotheses: [
                {
                  hypothesisId: 'hypothesis-strict-test-main',
                  statement: 'The project preserves a typed result boundary.',
                  premiseFactIds: [firstFactId],
                },
              ],
            }
          : {
              mechanismKey,
              mode: rows.length === 1 ? ('bounded-singleton' as const) : ('recurring' as const),
              hypotheses: [],
              zeroHypothesisReason: 'insufficient-evidence' as const,
              zeroHypothesisDispositionReview: dispositionReviews[index - 1],
            }
      ),
      falsificationInputs: [
        {
          hypothesisId: 'hypothesis-strict-test-main',
          enrolledCounterqueryIds: [],
          executions: [],
          counterqueryApplicability,
          dispositionReview: falsificationReview,
        },
      ],
      hypothesisDispositions: [
        { hypothesisId: 'hypothesis-strict-test-main', status: 'survived' as const },
      ],
      dispositionReviews: [...dispositionReviews, falsificationReview],
    },
  };
}

function buildFixtureProducerOutput(port: StrictPort) {
  const producer = port.buildProducerInput();
  const lineage = producer.lineages[0];
  const cell = port.eligibleCells[0];
  const evidenceEntryId = producer.evidence.entries[0]?.evidenceEntryId;
  if (!lineage || !cell || !evidenceEntryId) {
    throw new Error('STRICT_TEST_FIXTURE_PRODUCER_AUTHORITY_REQUIRED');
  }
  const exclusion = 'Do not bypass the strict result boundary.';
  return {
    expressionSets: [
      {
        hypothesisId: lineage.hypothesis.hypothesisId,
        proposals: [
          {
            expressionId: `expression-${cell.moduleId}-${cell.dimensionId}`,
            kind: 'draft',
            authored: {
              title: `Strict ${cell.dimensionId} result boundary`,
              kind: 'rule',
              doClause: 'Preserve the typed Result boundary and frozen evidence lineage.',
              dontClause: exclusion,
              markdown: [
                `The ${cell.dimensionId} path preserves the typed Result boundary.`,
                'Use the returned discriminant before reading success data.',
                '',
                '```ts',
                'export function unwrap<T>(result: { value: T }): T {',
                '  const value = result.value;',
                '  return value;',
                '}',
                '```',
              ].join('\n'),
              usageGuide: `Apply this rule to ${cell.dimensionId} changes.`,
              retrievalProfile: {
                intents: [`strict ${cell.dimensionId} result boundary`],
                exclusions: [{ text: exclusion }],
              },
              negativeIntent: [exclusion],
              scope: { moduleIds: [cell.moduleId], dimensionIds: [cell.dimensionId] },
              evidenceEntryIds: [evidenceEntryId],
            },
          },
        ],
        zeroDisposition: null,
      },
    ],
  };
}

function actor(runId: string, suffix: string) {
  return createProductionActorIdentityV1({
    providerId: 'fixture',
    modelId: 'fixture-reviewer',
    modelVersion: 'strict-test-v1',
    promptHash: sha(`prompt:${suffix}`),
    runId,
    invocationId: `fixture:${suffix}`,
    loadReceiptHash: sha('fixture-load'),
    outputHash: sha(`output:${suffix}`),
  });
}

function independentReview(prompt: string) {
  const slice = /--- (E-\d+) (.+?):(\d+)-(\d+) blob=/u.exec(prompt);
  if (!slice) {
    throw new Error('STRICT_TEST_FIXTURE_REVIEW_SOURCE_SLICE_REQUIRED');
  }
  return {
    axes: [
      'entailment',
      'contradiction-free',
      'project-specificity',
      'actionability',
      'scope-correctness',
      'retrieval-fitness',
    ].map((axis) => ({
      axis,
      verdict: 'pass',
      score: 2,
      reasonCode: 'frozen-source-entails-projection',
      evidenceEntryIds: [slice[1]],
    })),
    noveltyDecision: 'novel-project-specific',
    duplicateDecision: 'no-match',
    citedLines: [`${slice[2]}:${slice[3]}`],
  };
}

class ControlledProvider {
  readonly name = 'fixture';
  readonly model = 'fixture-reviewer';

  async chatWithTools(prompt: string) {
    const parsed = JSON.parse(prompt) as {
      payload: {
        schemaVersion: number;
        semanticRequest: Record<string, unknown> & {
          requestHash: string;
          contextHash: string;
          reviewKind: string;
          proposedDispositionHash: string;
          calibration: { axes: Array<{ axisId: string }> };
          evidence: Array<{ evidenceEntryId: string }>;
        };
      };
    };
    const compiledPromptHash = `sha256:${createHash('sha256').update(prompt).digest('hex')}`;
    const requestHash = hashCanonicalJson({
      ...parsed.payload,
      compiledPrompt: prompt,
      compiledPromptHash,
    });
    const semanticRequest = parsed.payload.semanticRequest;
    const evidenceEntryIds = semanticRequest.evidence.map((row) => row.evidenceEntryId);
    const axisIds = semanticRequest.calibration.axes.map((axis) => axis.axisId);
    return {
      text: JSON.stringify({
        schemaVersion: parsed.payload.schemaVersion,
        requestHash,
        compiledPromptHash,
        semanticRequestHash: semanticRequest.requestHash,
        contextHash: semanticRequest.contextHash,
        reviewKind: semanticRequest.reviewKind,
        proposedDispositionHash: semanticRequest.proposedDispositionHash,
        verdict: 'pass',
        reasonCode: 'STRICT_TEST_FIXTURE_REVIEW_PASSED',
        axisDecisions: axisIds.map((axisId) => ({
          axisId,
          verdict: 'pass',
          score: 0.95,
          reasonCode: `PASS:${axisId}`,
          evidenceEntryIds,
        })),
        evidenceFindings: evidenceEntryIds.map((evidenceEntryId) => ({
          evidenceEntryId,
          axisIds,
          finding: 'The frozen strict-test denominator was completely inspected.',
          supportsVerdict: true,
        })),
      }),
      functionCalls: [],
    };
  }
}

function planIntent(context: Record<string, unknown>) {
  const projection = readRecord(context.projectContextFacts);
  const modules = Array.isArray(projection.modules)
    ? projection.modules.map((module) => readRecord(module))
    : [];
  const subjectRefs = modules.map(
    (module) => `repo:${String(module.repoId)}:module:${String(module.moduleId)}`
  );
  const families = createMainStrictFactQueryFamiliesV1().filter(
    (family) => family.id !== 'strict-counterexample'
  );
  const question = {
    questionId: 'q-strict-test-main',
    subquestionIds: [],
    anatomyLensIds: [...ANATOMY_LENS_IDS],
    subjectRefs,
    analysisScales: [
      'source-range',
      'symbol',
      'file',
      'module',
      'package',
      'repository',
      'project',
    ],
    capabilityIds: [...new Set(families.map((family) => family.capabilityId))],
    queryFamilyIds: families.map((family) => family.id),
    expectedSupport: ['frozen complete denominator'],
    expectedCounterevidence: ['negative frozen fixture'],
    synthesisTarget: 'strict project patterns',
    uncertainty: 'none outside frozen evidence',
    stopCondition: 'every obligation terminal',
    escalationCondition: 'backend unavailable',
    priority: 'critical',
    budget: {
      initialBreadth: 100,
      expansionReserve: 20,
      counterqueryReserve: 20,
      starvationGuard: 1,
    },
  };
  return {
    generationStage: 'coldStart',
    projectProfile: { primaryLanguage: 'typescript', frameworks: [], moduleCount: modules.length },
    dimensions: [],
    scale: { totalRecipeBudget: 0, depthLevels: ['evidence-bounded-no-floor'] },
    moduleBindings: [],
    plannedNextActions: families.map((family, index) => ({
      tool: family.capabilityId,
      reason: 'execute accepted frozen backend',
      order: index + 1,
      questionId: question.questionId,
      anatomyLensIds: question.anatomyLensIds,
      subjectRefs: question.subjectRefs,
      analysisScales: question.analysisScales,
      capabilityId: family.capabilityId,
      queryFamilyId: family.id,
      expectedSupport: question.expectedSupport,
      expectedCounterevidence: question.expectedCounterevidence,
      synthesisTarget: question.synthesisTarget,
      uncertainty: question.uncertainty,
      priority: question.priority,
      stopCondition: question.stopCondition,
      escalationCondition: question.escalationCondition,
      budget: question.budget,
    })),
    evidenceRefs: [{ kind: 'project-context', ref: String(context.factsHash) }],
    investigationDecomposition: { schemaVersion: 1, questions: [question] },
    budgetStrategy: {
      schemaVersion: 1,
      providerRequests: 100,
      detailRequests: 140,
      tokens: 1_000_000,
      timeMs: 300_000,
      costMicrousd: 0,
    },
    synthesisPrerequisiteCellIds: Object.fromEntries(
      modules.map((module) => {
        const moduleId = String(module.moduleId);
        return [
          `${moduleId}::cross-dimension-synthesis`,
          [`${moduleId}::coding-standards`, `${moduleId}::design-patterns`],
        ];
      })
    ),
  };
}

function createEmbedProvider() {
  const vector = (value: string) => [Math.max(1, value.length), 1, 0];
  return {
    describeCapabilities: () => ({
      provider: 'fixture',
      model: 'fixture-embedding-v1',
      dimension: 3,
      inputKinds: ['query', 'document'] as const,
      batchSupported: true,
      normalization: 'not-normalized' as const,
      formatProfile: 'symmetric' as const,
    }),
    embedQuery: async (value: string) => vector(value),
    embedDocuments: async (values: readonly string[]) => values.map(vector),
    embed: async (value: string | string[]) =>
      Array.isArray(value) ? value.map(vector) : vector(value),
  };
}

async function treeHash(root: string) {
  const rows: Array<{ path: string; hash: string }> = [];
  async function visit(relativePath: string): Promise<void> {
    const target = path.join(root, relativePath);
    const stat = await fsp.lstat(target);
    if (stat.isDirectory()) {
      for (const child of (await fsp.readdir(target)).sort()) {
        await visit(path.join(relativePath, child));
      }
      return;
    }
    if (stat.isFile()) {
      rows.push({
        path: relativePath,
        hash: createHash('sha256')
          .update(await fsp.readFile(target))
          .digest('hex'),
      });
    }
  }
  await visit('');
  return hashCanonicalJson(rows);
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function sha(value: string): `sha256:${string}` {
  return `sha256:${Buffer.from(value).toString('hex').padEnd(64, '0').slice(0, 64)}`;
}

function restoreEnv() {
  for (const [key, value] of [
    ['ALEMBIC_AI_PROVIDER', originalEnv.provider],
    ['ALEMBIC_AI_MODEL', originalEnv.model],
    ['ALEMBIC_RUNTIME_ARTIFACT_MANIFEST_PATH', originalEnv.manifest],
  ] as const) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}
