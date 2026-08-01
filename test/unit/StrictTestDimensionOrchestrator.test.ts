import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildAnatomyLensCatalogSnapshot,
  buildDimensionCatalogSnapshot,
  buildFactQueryCatalogSnapshot,
  buildRequiredFactApplicabilityUniverseV1,
  type CompiledColdStartPlanV2,
  type FactQueryFamilyV1,
  type PlanCellV1,
  STRICT_TEST_DIMENSION_PROFILE_V1,
  type StrictTestPreflightBindingsV1,
} from '@alembic/core/plans';
import type {
  FinalCoverageBindingReceiptV1,
  ServingSnapshotManifestV1,
} from '@alembic/core/production';
import { hashCanonicalJson } from '@alembic/core/project-context-foundation';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { StrictTestDimensionOrchestrator } from '../../lib/recipe-pipeline/generate/strict/StrictTestDimensionOrchestrator.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true })));
});

describe('StrictTestDimensionOrchestrator', () => {
  test('auto-selects the backend recommendation and durably reopens the Core terminal/report', async () => {
    const fixture = await createFixture();
    const orchestrator = new StrictTestDimensionOrchestrator(fixture.dependencies);
    const preflight = await orchestrator.preflight(fixture.preflightRequest);
    expect(preflight.preflight.catalog.dimensions).toHaveLength(26);
    expect(preflight.preview.canAutoSelect).toBe(true);

    const started = await orchestrator.start({
      demandKey: fixture.preflightRequest.demandKey,
      runId: fixture.preflightRequest.runId,
      preflightHash: preflight.preflight.preflightHash,
    });
    expect(started.terminal?.terminalState).toBe('STRICT_TEST_COMPLETED_PRIVATE');
    expect(started.projection?.selectedDimensionId).toBe('architecture');
    expect(started.projection?.executionCellIds).toEqual(['core::architecture']);
    expect(started.projection?.dimensionStates).toHaveLength(26);
    expect(fixture.execute).toHaveBeenCalledTimes(1);

    const reopened = new StrictTestDimensionOrchestrator(fixture.dependencies);
    const status = await reopened.status(fixture.preflightRequest.runId);
    const report = await reopened.report(fixture.preflightRequest.runId);
    expect(status.terminal?.terminalHash).toBe(started.terminal?.terminalHash);
    expect(report.reportHash).toBe(started.report?.reportHash);
    expect(report.fullUniverse?.dimensionCount).toBe(26);
    expect(report.unexecutedDimensionIds).toHaveLength(25);
    expect(report.productionFinalized).toBe(false);
    expect(report.publicRouteChanged).toBe(false);
  });

  test('persists a canonical failed terminal when current bindings drift before Agent execution', async () => {
    const fixture = await createFixture();
    const drifted = { ...fixture.bindings, providerModelHash: sha('changed-provider') };
    fixture.dependencies.revalidate = vi.fn(async () => drifted);
    const orchestrator = new StrictTestDimensionOrchestrator(fixture.dependencies);
    const preflight = await orchestrator.preflight(fixture.preflightRequest);

    await expect(
      orchestrator.start({
        demandKey: fixture.preflightRequest.demandKey,
        runId: fixture.preflightRequest.runId,
        preflightHash: preflight.preflight.preflightHash,
      })
    ).rejects.toThrow('STRICT_TEST_PREFLIGHT_DRIFT');
    expect(fixture.execute).not.toHaveBeenCalled();

    const status = await orchestrator.status(fixture.preflightRequest.runId);
    const report = await orchestrator.report(fixture.preflightRequest.runId);
    expect(status.terminal).toMatchObject({
      terminalState: 'STRICT_TEST_FAILED',
      failedStage: 'AUTOMATIC_SELECTION_READY',
    });
    expect(report.failure?.failedStage).toBe('AUTOMATIC_SELECTION_READY');
  });

  test('coalesces concurrent exact starts into one private execution', async () => {
    const fixture = await createFixture();
    const orchestrator = new StrictTestDimensionOrchestrator(fixture.dependencies);
    const preflight = await orchestrator.preflight(fixture.preflightRequest);
    const input = {
      demandKey: fixture.preflightRequest.demandKey,
      runId: fixture.preflightRequest.runId,
      preflightHash: preflight.preflight.preflightHash,
    };

    const [first, second] = await Promise.all([
      orchestrator.start(input),
      orchestrator.start(input),
    ]);

    expect(first.terminal?.terminalHash).toBe(second.terminal?.terminalHash);
    expect(fixture.execute).toHaveBeenCalledTimes(1);
  });

  test('rejects a tampered durable terminal on fresh-process status/report reopen', async () => {
    const fixture = await createFixture();
    const orchestrator = new StrictTestDimensionOrchestrator(fixture.dependencies);
    const preflight = await orchestrator.preflight(fixture.preflightRequest);
    await orchestrator.start({
      demandKey: fixture.preflightRequest.demandKey,
      runId: fixture.preflightRequest.runId,
      preflightHash: preflight.preflight.preflightHash,
    });
    const checkpointPath = path.join(fixture.runRoot, 'strict-test-dimension.checkpoint.json');
    const checkpoint = JSON.parse(await fsp.readFile(checkpointPath, 'utf8')) as {
      terminal: { terminalHash: string };
    };
    checkpoint.terminal.terminalHash = sha('tampered-terminal');
    await fsp.writeFile(checkpointPath, `${JSON.stringify(checkpoint)}\n`);

    const reopened = new StrictTestDimensionOrchestrator(fixture.dependencies);
    await expect(reopened.status(fixture.preflightRequest.runId)).rejects.toThrow(
      'STRICT_TEST_CHECKPOINT_INVALID'
    );
    await expect(reopened.report(fixture.preflightRequest.runId)).rejects.toThrow(
      'STRICT_TEST_CHECKPOINT_INVALID'
    );
  });

  test('never returns a completed status/report after private owner or artifact integrity drift', async () => {
    const fixture = await createFixture();
    const orchestrator = new StrictTestDimensionOrchestrator(fixture.dependencies);
    const preflight = await orchestrator.preflight(fixture.preflightRequest);
    await orchestrator.start({
      demandKey: fixture.preflightRequest.demandKey,
      runId: fixture.preflightRequest.runId,
      preflightHash: preflight.preflight.preflightHash,
    });
    fixture.verifyCompletedRun.mockRejectedValue(
      new Error('STRICT_TEST_PRIVATE_EVIDENCE_INTEGRITY_FAILED:owner')
    );

    const reopened = new StrictTestDimensionOrchestrator(fixture.dependencies);
    await expect(reopened.status(fixture.preflightRequest.runId)).rejects.toThrow(
      'STRICT_TEST_PRIVATE_EVIDENCE_INTEGRITY_FAILED'
    );
    await expect(reopened.report(fixture.preflightRequest.runId)).rejects.toThrow(
      'STRICT_TEST_PRIVATE_EVIDENCE_INTEGRITY_FAILED'
    );
    expect(fixture.verifyCompletedRun).toHaveBeenCalledTimes(2);
  });
});

async function createFixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'strict-test-orchestrator-'));
  roots.push(root);
  const plan = compiledPlan();
  const bindings = preflightBindings();
  const preflightRequest = {
    demandKey: bindings.demandKey,
    projectRoot: '/workspace/project',
    runId: bindings.runId,
  };
  const runRoot = path.join(root, bindings.demandKey, bindings.runId);
  const execute = vi.fn(
    async (input: { readonly projection: { executionCellIds: readonly string[] } }) =>
      privateResult(input.projection.executionCellIds, bindings)
  );
  const verifyCompletedRun = vi.fn(async () => {});
  const timestamps = [
    '2026-07-30T06:01:00.000Z',
    '2026-07-30T06:02:00.000Z',
    '2026-07-30T06:30:00.000Z',
    '2026-07-30T06:31:00.000Z',
  ];
  return {
    bindings,
    execute,
    verifyCompletedRun,
    preflightRequest,
    runRoot,
    dependencies: {
      clock: () => timestamps.shift() ?? '2026-07-30T06:40:00.000Z',
      execute,
      findRunRoot: async (runId: string) => {
        if (runId !== bindings.runId) {
          throw new Error('STRICT_TEST_RUN_NOT_FOUND');
        }
        return runRoot;
      },
      observeNonMutation: async () => ({
        productionStateHash: bindings.productionBeforeStateHash,
        publicRouteStateHash: bindings.publicRouteBeforeStateHash,
      }),
      preparePreflight: async () => {
        await fsp.mkdir(runRoot, { recursive: true });
        return {
          compiledPlan: plan,
          currentBindings: bindings,
          privateEvidenceRefs: ['private:preflight'],
        };
      },
      revalidate: vi.fn(async () => bindings),
      resolveRunRoot: () => runRoot,
      verifyCompletedRun,
      verificationCommands: ['npm run probe:strict-test-main'],
    },
  };
}

function privateResult(
  executionCellIds: readonly string[],
  bindings: StrictTestPreflightBindingsV1
) {
  const privateG4ReceiptHash = sha('private-g4');
  const candidateDataManifestHash = sha('candidate-data');
  const finalSemantic = {
    schemaVersion: 1 as const,
    candidateCoverageReceiptHash: sha('candidate-coverage'),
    candidateCellSetHash: hashCanonicalJson(executionCellIds),
    g4ReceiptHash: privateG4ReceiptHash,
    candidateDataManifestHash,
    cells: executionCellIds.map((cellId) => ({
      cellId,
      finalDisposition: 'investigated-empty' as const,
      finalRecipeIds: [],
      finalRecipeFingerprints: [],
    })),
  };
  const finalCoverageBinding: FinalCoverageBindingReceiptV1 = {
    ...finalSemantic,
    receiptHash: hashCanonicalJson(finalSemantic),
  };
  const privateServingValidationHash = sha('private-serving-validation');
  const servingSemantic = {
    schemaVersion: 1 as const,
    sessionId: 'private-session',
    snapshotId: `snapshot-${candidateDataManifestHash.slice('sha256:'.length)}`,
    candidateDataManifestHash,
    finalCoverageBindingHash: finalCoverageBinding.receiptHash,
    servingSnapshotValidationHash: privateServingValidationHash,
    vectorGenerationId: 'private-vector',
    vectorManifestHash: sha('private-vector-manifest'),
    certifiedProjectFactsHash: bindings.certifiedProjectFactsContentHash,
    sourceRevisionVectorHash: bindings.sourceRevisionVectorHash,
    analysisFixpointHash: sha('analysis-fixpoint'),
  };
  const servingSnapshotManifest: ServingSnapshotManifestV1 = {
    ...servingSemantic,
    manifestHash: hashCanonicalJson(servingSemantic),
  };
  return {
    finalCoverageBinding,
    privateG4ReceiptHash,
    privateServingValidationHash,
    servingSnapshotManifest,
    privateEvidenceRefs: ['private:coverage', 'private:serving'],
  };
}

function compiledPlan(): CompiledColdStartPlanV2 {
  const catalog = buildDimensionCatalogSnapshot();
  const families = [
    family('syntax-idiom', 'tree-sitter-query'),
    family('architecture-dependency', 'certified-project-context'),
    family('api-protocol', 'accepted-semantic-relations'),
    family('lifecycle-error-invariant', 'accepted-static-invariants'),
    family('config-build-test-migration', 'frozen-config-parsers'),
    family('history-fix-pattern', 'accepted-frozen-history'),
    family('synthesis-cross-cutting', 'accepted-observation-aggregation'),
  ];
  const factQueryCatalog = buildFactQueryCatalogSnapshot(families);
  const module = {
    moduleId: 'core',
    scopeId: 'repo:core',
    relativePath: 'src',
    moduleClass: 'production-library',
    ownedProductionFileCount: 1,
    languages: ['typescript'],
    frameworks: [],
    roles: ['library'],
    entrypointRefs: ['ref:index'],
    publicSurfaceRefs: ['ref:export'],
    crossRepoEdgeRefs: [],
    boundaryRefs: ['ref:boundary'],
    ownership: { origin: 'fixture', confidence: 1, evidenceRefs: ['ref:core'] },
  };
  const anatomy = buildAnatomyLensCatalogSnapshot();
  const requiredFactApplicability = buildRequiredFactApplicabilityUniverseV1(
    [module],
    anatomy,
    factQueryCatalog
  );
  const cells: PlanCellV1[] = catalog.dimensions.map((dimension) => ({
    cellId: `core::${dimension.id}`,
    moduleId: 'core',
    scopeId: 'repo:core',
    dimensionId: dimension.id,
    criticality: 'standard',
    status: 'eligible',
    evidenceRefs: ['ref:core'],
    synthesisPrerequisiteCellIds: [],
  }));
  const universe = {
    cells,
    universeCount: cells.length,
    eligibleCount: cells.length,
    excludedCount: 0,
    cellUniverseHash: hashCanonicalJson(cells),
    eligibleCellsHash: hashCanonicalJson(cells),
    excludedCellsHash: hashCanonicalJson([]),
  };
  const schedule = {
    schemaVersion: 1 as const,
    factHarvestObligations: [],
    lensBindings: [],
    factHarvestScheduleHash: hashCanonicalJson([]),
    lensBindingsHash: hashCanonicalJson([]),
    baselineScheduleHash: hashCanonicalJson({
      factHarvestScheduleHash: hashCanonicalJson([]),
      lensBindingsHash: hashCanonicalJson([]),
    }),
  };
  const resourceCaps = {
    providerRequestCap: 100,
    detailRequestCap: 100,
    tokenCap: 1_000_000,
    timeMsCap: 300_000,
    costMicrousdCap: 2_000_000,
    factQueryObligationCap: 1_000,
  };
  const semantic = {
    schemaVersion: 2 as const,
    compilerVersion: 'cold-start-plan-compiler-v2' as const,
    catalog,
    anatomy,
    requiredFactApplicability,
    factQueryCatalog,
    universe,
    schedule,
    selection: {
      schemaVersion: 2 as const,
      kind: 'cold-start-upper-cap' as const,
      generationStage: 'coldStart' as const,
      moduleIds: ['core'],
      dimensionIds: catalog.dimensions.map((row) => row.id),
      eligibleCellIds: cells.map((row) => row.cellId),
      excludedCellIds: [],
      candidateAttemptCap: 0,
      maxAuthoredCandidatesPerCellPass: 0,
      semanticRepairLimit: 2 as const,
      batchBarrierVersion: 'candidate-batch-barrier-v1',
      policyVersion: 'fixture-v1',
      policyHash: sha('policy'),
      modulePlanningFactsHash: sha('module-facts'),
      sourceArtifactHash: sha('source-artifact'),
      strictConfigReceiptHash: sha('strict-config'),
      authoringPolicy: {
        policy: 'evidence-bounded-no-floor' as const,
        candidateAttempts: 'upper-bound-only' as const,
        authoredCandidates: 'zero-to-many' as const,
        quantityFloor: null,
        semanticRepairLimit: 2 as const,
        batchFailureMode: 'whole-batch' as const,
      },
      deferredCells: [],
      resourceCaps,
    },
    execution: {
      schemaVersion: 2 as const,
      factsBindingHash: sha('facts-content'),
      sourceRevisionVectorHash: sha('source-revision'),
      planCognitionHash: sha('plan-cognition'),
      orderedDimensionIds: catalog.dimensions.map((row) => row.id),
      orderedCells: cells.map((row) => row.cellId),
      orderedInvestigationActions: [],
      anatomyApplicabilityHash: requiredFactApplicability.universeHash,
      lensBindingsHash: schedule.lensBindingsHash,
      factHarvestScheduleHash: schedule.factHarvestScheduleHash,
      factQueryCatalogHash: factQueryCatalog.catalogHash,
      moduleScope: ['core'],
      synthesisPrerequisites: {},
      resourceCaps,
    },
  };
  return { ...semantic, canonicalPlanHash: hashCanonicalJson(semantic) };
}

function preflightBindings(): StrictTestPreflightBindingsV1 {
  return {
    schemaVersion: 1,
    profile: STRICT_TEST_DIMENSION_PROFILE_V1,
    demandKey: 'demand-1',
    runId: 'strict-run-1',
    projectRootIdentity: 'project-root',
    controlRootIdentity: 'control-root',
    sourceRootIdentity: 'source-root',
    canonicalProjectIdentityHash: sha('project'),
    sourceRevisionVectorHash: sha('source-revision'),
    sourceInventoryHash: sha('inventory'),
    sourceFileCount: 1,
    moduleCount: 1,
    languageCount: 1,
    parserCount: 1,
    backendCount: 7,
    certifiedProjectFactsArtifactHash: sha('facts-artifact'),
    certifiedProjectFactsContentHash: sha('facts-content'),
    certifiedProjectFactsSourceArtifactHash: sha('source-artifact'),
    certifiedProjectFactsSourceVectorHash: sha('source-revision'),
    certifiedProjectFactsConsumerReceiptHash: sha('facts-consumer'),
    strictConfigReceiptHash: sha('strict-config'),
    providerModelHash: sha('provider-model'),
    promptSopHash: sha('prompt'),
    factQueryBackendHash: sha('fact-backend'),
    parserBackendHash: sha('parser'),
    embeddingVectorHash: sha('embedding'),
    runtimeArtifactManifestHash: sha('runtime-manifest'),
    runtimeArtifactBindingHash: sha('runtime-binding'),
    productionBeforeStateHash: sha('production'),
    productionAfterReadStateHash: sha('production'),
    publicRouteBeforeStateHash: sha('public-route'),
    officialRecipeBeforeStateHash: sha('recipes'),
    privateWorkspacePolicyHash: sha('private-policy'),
    generatedAt: '2026-07-30T06:00:00.000Z',
    validUntil: '2026-07-30T07:00:00.000Z',
  };
}

function family(id: string, capabilityId: string): FactQueryFamilyV1 {
  return {
    id,
    capabilityId,
    supportedScales: [
      'source-range',
      'symbol',
      'file',
      'module',
      'package',
      'repository',
      'project',
    ],
    queryPackHash: sha(`${id}:query`),
    loadedProducer: `loaded:${id}`,
    producerManifestHash: sha(`${id}:producer`),
    loadReceiptHash: sha(`${id}:load`),
    positiveFixtureHash: sha(`${id}:positive`),
    negativeFixtureHash: sha(`${id}:negative`),
    edgeFixtureHash: sha(`${id}:edge`),
  };
}

function sha(value: string): `sha256:${string}` {
  return hashCanonicalJson(value);
}
