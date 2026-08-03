import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
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
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpServer } from '../../lib/http/HttpServer.js';
import {
  getServiceContainer,
  type ServiceContainer,
} from '../../lib/injection/ServiceContainer.js';
import {
  type MainCertifiedProjectFactsCarrier,
  type MainCertifiedProjectionPayload,
  openMainCertifiedProjectFactsArtifact,
} from '../../lib/project-facts/CertifiedProjectFactsRuntime.js';
import * as PublicRouteCas from '../../lib/recipe-pipeline/generate/strict/PublicRouteCas.js';
import {
  createMainStrictFactQueryFamiliesV1,
  executeMainStrictFactScheduleV1,
} from '../../lib/recipe-pipeline/generate/strict/StrictFactExecutionRuntime.js';
import * as StrictFinalizationRuntime from '../../lib/recipe-pipeline/generate/strict/StrictFinalizationRuntime.js';
import { createStrictTestDimensionOrchestrator } from '../../lib/recipe-pipeline/generate/strict/StrictTestDimensionRuntime.js';
import { CleanupService } from '../../lib/service/cleanup/CleanupService.js';
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
  | 'missing-cell'
  | 'partial'
  | 'reordered-cells'
  | 'selected-set-hash'
  | 'review-stage';

afterEach(async () => {
  vi.restoreAllMocks();
  restoreEnv();
  await Promise.all(roots.splice(0).map((root) => fsp.rm(root, { force: true, recursive: true })));
});

describe('strict-test-dimension real Main private pipeline', () => {
  it('consumes one real AgentService/PipelineStrategy receipt and reopens the private terminal', async () => {
    const fixture = await createFixture({ multiModule: true });
    const forbiddenSpies = createForbiddenProductionSpies();
    const service = createStrictTestDimensionOrchestrator(fixture.container);
    const before = await treeHash(fixture.dataRoot);
    const namedProductionBefore = await snapshotNamedProductionSurface(fixture.dataRoot);
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
    expect(completed.projection?.executionCellIds).toHaveLength(2);
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
      attemptedCount: 2,
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
    expect(await snapshotNamedProductionSurface(fixture.dataRoot)).toEqual(namedProductionBefore);
    assertForbiddenProductionSpiesUntouched(forbiddenSpies);

    const reopened = createStrictTestDimensionOrchestrator(fixture.container);
    expect((await reopened.status('strict-test-pipeline-run')).terminal).toEqual(
      completed.terminal
    );
    expect((await reopened.report('strict-test-pipeline-run')).reportHash).toBe(
      completed.report?.reportHash
    );

    const ownerPath = path.join(runRoot, 'strict-test-workspace-owner.json');
    const ownerSource = await fsp.readFile(ownerPath, 'utf8');
    const owner = JSON.parse(ownerSource) as Record<string, unknown>;
    try {
      await fsp.writeFile(
        ownerPath,
        `${JSON.stringify({ ...owner, policyHash: sha('tampered-owner-policy') })}\n`
      );
      await expect(reopened.status('strict-test-pipeline-run')).rejects.toThrow(
        /STRICT_TEST_PRIVATE_EVIDENCE_INTEGRITY_FAILED/u
      );
    } finally {
      await fsp.writeFile(ownerPath, ownerSource);
    }

    const privateDataRoot = path.join(runRoot, 'private-data');
    const privateDataBackup = path.join(runRoot, 'private-data.fixture-backup');
    try {
      await fsp.rename(privateDataRoot, privateDataBackup);
      await fsp.symlink(fixture.dataRoot, privateDataRoot, 'dir');
      await expect(reopened.report('strict-test-pipeline-run')).rejects.toThrow(
        /STRICT_TEST_PRIVATE_EVIDENCE_INTEGRITY_FAILED/u
      );
    } finally {
      await fsp.unlink(privateDataRoot);
      await fsp.rename(privateDataBackup, privateDataRoot);
    }

    const privateChainPath = path.join(runRoot, 'strict-test-private-chain.json');
    const privateChainBackup = path.join(runRoot, 'strict-test-private-chain.fixture-backup');
    try {
      await fsp.rename(privateChainPath, privateChainBackup);
      await expect(reopened.status('strict-test-pipeline-run')).rejects.toThrow(
        /STRICT_TEST_PRIVATE_EVIDENCE_INTEGRITY_FAILED/u
      );
    } finally {
      await fsp.rename(privateChainBackup, privateChainPath);
    }

    const alteredArtifactPath = path.join(privateDataRoot, 'strict-test-altered-artifact');
    try {
      await fsp.writeFile(alteredArtifactPath, 'tampered-after-completion\n');
      await expect(reopened.status('strict-test-pipeline-run')).rejects.toThrow(
        /STRICT_TEST_PRIVATE_EVIDENCE_INTEGRITY_FAILED/u
      );
    } finally {
      await fsp.unlink(alteredArtifactPath);
    }
    expect((await reopened.status('strict-test-pipeline-run')).terminal).toEqual(
      completed.terminal
    );
  }, 120_000);

  it.each<ReceiptMutation>([
    'missing',
    'partial',
    'cross-run',
    'authority',
    'extra-cell',
    'missing-cell',
    'reordered-cells',
    'selected-set-hash',
    'analysis-stage',
    'review-stage',
  ])('rejects %s receipt drift before private corpus persistence', async (receiptMutation) => {
    const fixture = await createFixture({ multiModule: true, receiptMutation });
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

  it.each([
    'EXPRESSION_SETS_REVIEWED',
    'PRIVATE_INDEXES_VERIFIED',
    'PRIVATE_SERVING_VALIDATED',
  ] as const)('records the exact %s failure boundary and never emits a private completion chain', async (failedStage) => {
    const fixture = await createFixture();
    const service = createStrictTestDimensionOrchestrator(fixture.container, {
      failAtStage: failedStage,
    });
    const demandKey = `strict-test-failure-${failedStage.toLowerCase()}`;
    const runId = `${demandKey}-run`;
    const productionBefore = await treeHash(fixture.dataRoot);
    const preflight = await service.preflight({
      demandKey,
      projectRoot: fixture.projectRoot,
      runId,
    });

    await expect(
      service.start({
        demandKey,
        preflightHash: preflight.preflight.preflightHash,
        runId,
      })
    ).rejects.toThrow(`STRICT_TEST_INJECTED_${failedStage}`);

    expect(await service.status(runId)).toMatchObject({
      phase: 'STRICT_TEST_FAILED',
      terminal: { terminalState: 'STRICT_TEST_FAILED', failedStage },
      report: { failure: { failedStage } },
    });
    await expect(
      fsp.lstat(
        path.join(
          fixture.root,
          'strict-test-runs',
          demandKey,
          runId,
          'strict-test-private-chain.json'
        )
      )
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await treeHash(fixture.dataRoot)).toBe(productionBefore);
  }, 120_000);

  it('preserves a sealed integrity violation instead of an ordinary private failure on production mutation', async () => {
    const fixture = await createFixture();
    let mutationInjected = false;
    const service = createStrictTestDimensionOrchestrator(fixture.container, {
      onStage(stage) {
        if (stage === 'EXPRESSION_SETS_REVIEWED' && !mutationInjected) {
          mutationInjected = true;
          writeFileSync(
            path.join(fixture.dataRoot, '.asd/strict-test-forbidden-mutation'),
            'forbidden production mutation\n'
          );
        }
      },
    });
    const demandKey = 'strict-test-production-mutation';
    const runId = `${demandKey}-run`;
    const preflight = await service.preflight({
      demandKey,
      projectRoot: fixture.projectRoot,
      runId,
    });

    await expect(
      service.start({
        demandKey,
        preflightHash: preflight.preflight.preflightHash,
        runId,
      })
    ).rejects.toThrow('STRICT_TEST_PRODUCTION_MUTATION_DETECTED');

    const runRoot = path.join(fixture.root, 'strict-test-runs', demandKey, runId);
    expect(await service.status(runId)).toMatchObject({
      phase: 'PRIVATE_WORKSPACE_READY',
      terminal: null,
      report: null,
    });
    const violation = JSON.parse(
      await fsp.readFile(path.join(runRoot, 'strict-test-nonmutation-violation.json'), 'utf8')
    ) as Record<string, unknown>;
    expect(violation).toMatchObject({
      profile: 'strict-test-dimension',
      demandKey,
      runId,
      failedStage: 'PRIVATE_SERVING_VALIDATED',
      violationHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
  }, 120_000);

  it('serves real DI preflight/start/status/report shapes and rejects legacy activation before DaemonJob access', async () => {
    const fixture = await createFixture({ multiModule: true });
    const forbiddenSpies = createForbiddenProductionSpies();
    const productionBefore = await treeHash(fixture.dataRoot);
    const namedProductionBefore = await snapshotNamedProductionSurface(fixture.dataRoot);
    const globalContainer = getServiceContainer();
    const previousSingletons = globalContainer.singletons;
    const previousServices = globalContainer.services;
    let jobStoreAccessCount = 0;
    let server: HttpServer | null = null;
    try {
      globalContainer.singletons = {
        ...(fixture.container as unknown as { singletons: Record<string, unknown> }).singletons,
      };
      globalContainer.services = {};
      globalContainer.register('agentService', () => fixture.agent.service);
      globalContainer.register('strictTestDimensionOrchestrator', () =>
        createStrictTestDimensionOrchestrator(globalContainer)
      );
      globalContainer.register('jobStore', () => {
        jobStoreAccessCount += 1;
        throw new Error('STRICT_TEST_LEGACY_DAEMON_JOB_ACCESSED');
      });

      server = new HttpServer({ host: '127.0.0.1', port: 0 });
      server.setupMiddleware();
      server.setupRoutes();
      server.setupErrorHandling();
      const listener = await server.start();
      const port = (listener.address() as AddressInfo).port;
      const base = `http://127.0.0.1:${port}/api/v1/strict-test-dimension`;
      const demandKey = 'strict-test-real-http';
      const runId = `${demandKey}-run`;

      const preflightResponse = await fetch(`${base}/preflight`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ demandKey, projectRoot: fixture.projectRoot, runId }),
      });
      const preflightBody = (await preflightResponse.json()) as Record<string, unknown>;
      const preflightData = readRecord(preflightBody.data);
      expect(preflightResponse.status).toBe(200);
      expect(preflightData).toMatchObject({
        profile: 'strict-test-dimension',
        phase: 'AUTOMATIC_SELECTION_READY',
        fullUniverse: { dimensionCount: 26, cellCount: 52 },
      });

      const notReadyResponse = await fetch(`${base}/runs/${runId}/report`);
      expect(notReadyResponse.status).toBe(409);
      expect(await notReadyResponse.json()).toMatchObject({
        success: false,
        error: { code: 'STRICT_TEST_REPORT_NOT_READY' },
      });

      const wrongAuthorityResponse = await fetch(`${base}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          demandKey,
          preflightHash: sha('wrong-http-preflight'),
          runId,
        }),
      });
      expect(wrongAuthorityResponse.status).toBe(422);
      expect(await wrongAuthorityResponse.json()).toMatchObject({
        success: false,
        error: { code: 'STRICT_TEST_START_AUTHORITY_MISMATCH' },
      });

      const startResponse = await fetch(`${base}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          demandKey,
          preflightHash: preflightData.preflightHash,
          runId,
        }),
      });
      const startBody = (await startResponse.json()) as Record<string, unknown>;
      expect(startResponse.status).toBe(202);
      expect(readRecord(startBody.data)).toMatchObject({
        profile: 'strict-test-dimension',
        phase: 'STRICT_TEST_COMPLETED_PRIVATE',
        terminal: { terminalState: 'STRICT_TEST_COMPLETED_PRIVATE' },
      });
      expect(
        readRecord(readRecord(startBody.data).automaticSelection).selectedCellIds
      ).toHaveLength(2);

      const statusResponse = await fetch(`${base}/runs/${runId}`);
      const statusBody = (await statusResponse.json()) as Record<string, unknown>;
      const reportResponse = await fetch(`${base}/runs/${runId}/report`);
      const reportBody = (await reportResponse.json()) as Record<string, unknown>;
      expect(statusResponse.status).toBe(200);
      expect(reportResponse.status).toBe(200);
      for (const body of [preflightBody, startBody, statusBody, reportBody]) {
        expect(findForbiddenPublicFields(body)).toEqual([]);
      }

      const legacyResponse = await fetch(`http://127.0.0.1:${port}/api/v1/jobs/bootstrap`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          demandKey,
          profile: 'strict-test-dimension',
          runId,
        }),
      });
      expect(legacyResponse.status).toBe(400);
      expect(await legacyResponse.json()).toMatchObject({
        success: false,
        error: { code: 'STRICT_TEST_LEGACY_ACTIVATION_FORBIDDEN' },
      });
      expect(jobStoreAccessCount).toBe(0);
      expect(await treeHash(fixture.dataRoot)).toBe(productionBefore);
      expect(await snapshotNamedProductionSurface(fixture.dataRoot)).toEqual(namedProductionBefore);
      assertForbiddenProductionSpiesUntouched(forbiddenSpies);

      const startData = readRecord(startBody.data);
      const terminal = readRecord(startData.terminal);
      const reportData = readRecord(reportBody.data);
      const probeOutputPath = process.env.ALEMBIC_STRICT_TEST_MAIN_PROBE_OUTPUT;
      if (probeOutputPath) {
        await fsp.writeFile(
          probeOutputPath,
          `${JSON.stringify({
            schemaVersion: 2,
            profile: 'strict-test-dimension',
            http: {
              preflightStatus: preflightResponse.status,
              startStatus: startResponse.status,
              statusStatus: statusResponse.status,
              reportStatus: reportResponse.status,
              reportBeforeStartStatus: notReadyResponse.status,
              wrongAuthorityStatus: wrongAuthorityResponse.status,
              legacyActivationStatus: legacyResponse.status,
            },
            fullUniverse: preflightData.fullUniverse,
            automaticSelection: startData.automaticSelection,
            sameRunAgentReceipt: {
              pipelineExecutionCount: fixture.agent.strictPipelineCount,
              modelCallCount: fixture.agent.strictModelCallCount,
              runId,
            },
            terminal: {
              terminalState: terminal.terminalState,
              terminalHash: terminal.terminalHash,
              reportHash: reportData.reportHash,
              productionStateUnchanged: true,
              publicRouteUnchanged: true,
              productionFinalized: terminal.productionFinalized,
              publicRouteChanged: terminal.publicRouteChanged,
            },
            productionSurface: namedProductionBefore,
            publicLeakFindings: [preflightBody, startBody, statusBody, reportBody].flatMap((body) =>
              findForbiddenPublicFields(body)
            ),
            forbiddenPathObservations: {
              legacyActivationRejectedBeforeDispatch: legacyResponse.status === 400,
              daemonJobServiceAccessCount: jobStoreAccessCount,
              fullResetCallCount: forbiddenSpies.fullReset.mock.calls.length,
              publicationLockCallCount: forbiddenSpies.publicationLock.mock.calls.length,
              publicCasCallCount: forbiddenSpies.publicCas.mock.calls.length,
            },
          })}\n`
        );
      }
    } finally {
      await server?.stop();
      globalContainer.singletons = previousSingletons;
      globalContainer.services = previousServices;
    }
  }, 120_000);

  it.each([
    'provider',
    'manifest',
    'source',
    'private-policy',
  ] as const)('revalidates fresh %s authority before automatic selection and every Agent call', async (drift) => {
    const fixture = await createFixture();
    const service = createStrictTestDimensionOrchestrator(fixture.container);
    const demandKey = `strict-test-${drift}-drift`;
    const runId = `${demandKey}-run`;
    const preflight = await service.preflight({
      demandKey,
      projectRoot: fixture.projectRoot,
      runId,
    });
    const planSelectionCount = fixture.agent.planSelectionCount;
    if (drift === 'provider') {
      fixture.provider.model = 'fixture-reviewer-drifted';
    } else if (drift === 'manifest') {
      await fsp.appendFile(process.env.ALEMBIC_RUNTIME_ARTIFACT_MANIFEST_PATH as string, ' ');
    } else if (drift === 'source') {
      await fsp.appendFile(
        path.join(fixture.projectRoot, 'src/index.ts'),
        '\nexport const drift = true;'
      );
    } else {
      const ownerPath = path.join(
        fixture.root,
        'strict-test-runs',
        demandKey,
        runId,
        'strict-test-workspace-owner.json'
      );
      const owner = JSON.parse(await fsp.readFile(ownerPath, 'utf8')) as {
        policyHash: string;
      };
      owner.policyHash = sha('private-policy-drift');
      await fsp.writeFile(ownerPath, `${JSON.stringify(owner)}\n`);
    }

    await expect(
      service.start({
        demandKey,
        preflightHash: preflight.preflight.preflightHash,
        runId,
      })
    ).rejects.toThrow(/STRICT_TEST/u);
    expect(fixture.agent.planSelectionCount).toBe(planSelectionCount);
    expect(fixture.agent.strictPipelineCount).toBe(0);
    expect(fixture.agent.strictModelCallCount).toBe(0);
  }, 120_000);
});

interface FixtureOptions {
  readonly multiModule?: boolean;
  readonly receiptMutation?: ReceiptMutation;
}

async function createFixture(options: FixtureOptions = {}) {
  const createdRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'alembic-strict-test-main-'));
  // macOS 的 /var 是 /private/var 的符号链接；生产门禁比较物理项目根，因此夹具也先冻结 realpath。
  const root = await fsp.realpath(createdRoot);
  roots.push(root);
  const projectRoot = path.join(root, 'project');
  const secondProjectRoot = path.join(root, 'second-project');
  const dataRoot = path.join(root, 'data');
  await fsp.mkdir(path.join(projectRoot, 'src'), { recursive: true });
  await fsp.mkdir(path.join(dataRoot, '.asd'), { recursive: true });
  await seedProductionSurface(dataRoot);
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
  if (options.multiModule) {
    await fsp.mkdir(path.join(secondProjectRoot, 'lib'), { recursive: true });
    await fsp.writeFile(
      path.join(secondProjectRoot, 'lib/second.ts'),
      [
        'export interface SecondResult<T> { readonly value: T; }',
        'export function loadSecond(): SecondResult<number> { return { value: 2 }; }',
      ].join('\n')
    );
  }
  const folderId = 'strict-test-folder';
  const secondFolderId = 'strict-test-folder-second';
  const projectScope = createProjectDescriptor({
    controlRoot: root,
    dataRoot,
    projectId: 'strict-test-project',
    projectScopeId: 'strict-test-scope',
    currentFolderId: folderId,
    folders: [
      { id: folderId, path: projectRoot },
      ...(options.multiModule ? [{ id: secondFolderId, path: secondProjectRoot }] : []),
    ],
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
  const agent = createRealAgentService(provider, options);
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
  return { root, projectRoot, dataRoot, container, agent, provider };
}

function createRealAgentService(provider: ControlledProvider, options: FixtureOptions) {
  const counters = { planSelectionCount: 0, strictPipelineCount: 0, strictModelCallCount: 0 };
  const service = new AgentService({
    runtimeBuilder: {
      build(profile, buildOptions) {
        const compiled = profile as CompiledAgentProfile;
        const runtimeId = buildOptions?.runId ?? `fixture-${compiled.id}`;
        if (compiled.id === 'plan-selection') {
          return {
            id: runtimeId,
            execute: async (message, runOptions) => {
              counters.planSelectionCount += 1;
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
            if (!options.receiptMutation || !result.strictTestExecutionReceipt) {
              return result;
            }
            const mutated = mutateStrictTestReceipt(
              result.strictTestExecutionReceipt,
              options.receiptMutation
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
    get planSelectionCount() {
      return counters.planSelectionCount;
    },
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
  if (mutation === 'missing-cell') {
    return { ...receipt, selectedCellIds: receipt.selectedCellIds.slice(1) };
  }
  if (mutation === 'reordered-cells') {
    return { ...receipt, selectedCellIds: [...receipt.selectedCellIds].reverse() };
  }
  if (mutation === 'selected-set-hash') {
    return { ...receipt, selectedCellSetHash: sha('tampered-selected-cell-set') };
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
    readonly evidence: {
      readonly entries: readonly {
        readonly evidenceEntryId: string;
        readonly relativePath: string;
      }[];
    };
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
  if (!lineage || port.eligibleCells.length === 0 || producer.evidence.entries.length === 0) {
    throw new Error('STRICT_TEST_FIXTURE_PRODUCER_AUTHORITY_REQUIRED');
  }
  const exclusion = 'Do not bypass the strict result boundary.';
  return {
    expressionSets: [
      {
        hypothesisId: lineage.hypothesis.hypothesisId,
        proposals: port.eligibleCells.map((cell) => {
          return {
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
              evidenceEntryIds: producer.evidence.entries.map((entry) => entry.evidenceEntryId),
            },
          };
        }),
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
  model = 'fixture-reviewer';

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

async function seedProductionSurface(dataRoot: string): Promise<void> {
  const files = new Map<string, string>([
    ['.asd/alembic.db', 'seeded-production-sqlite-bytes\n'],
    ['.asd/alembic.db-wal', 'seeded-production-wal-bytes\n'],
    ['.asd/alembic.db-shm', 'seeded-production-shm-bytes\n'],
    ['.asd/config.json', '{"profile":"production-seed"}\n'],
    ['.asd/context/recipe-publications/active.json', '{"snapshotId":"seed-public"}\n'],
    ['.asd/context/recipe-publications/marker.json', '{"status":"seeded"}\n'],
    [
      '.asd/context/recipe-publications/snapshots/seed-public/manifest.json',
      '{"schemaVersion":1,"snapshotId":"seed-public"}\n',
    ],
    [
      '.asd/context/recipe-publications/snapshots/seed-public/public-bundle.json',
      '{"recipes":["seed-recipe"]}\n',
    ],
    ['.asd/vector-index/current.json', '{"generationId":"seed-index"}\n'],
    ['.asd/sessions/seed-session.json', '{"sessionId":"seed-session"}\n'],
    ['Alembic/Recipe/seed-recipe.md', '# Seed production recipe\n'],
    ['Alembic/ref/seed-recipe.json', '{"recipeId":"seed-recipe"}\n'],
  ]);
  for (const [relativePath, bytes] of files) {
    const target = path.join(dataRoot, relativePath);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, bytes);
  }
}

const NAMED_PRODUCTION_PATHS = [
  '.asd/alembic.db',
  '.asd/alembic.db-wal',
  '.asd/alembic.db-shm',
  '.asd/config.json',
  '.asd/context/recipe-publications/active.json',
  '.asd/context/recipe-publications/marker.json',
  '.asd/context/recipe-publications/snapshots/seed-public/manifest.json',
  '.asd/context/recipe-publications/snapshots/seed-public/public-bundle.json',
  '.asd/vector-index/current.json',
  '.asd/sessions/seed-session.json',
  'Alembic/Recipe/seed-recipe.md',
  'Alembic/ref/seed-recipe.json',
] as const;

async function snapshotNamedProductionSurface(dataRoot: string) {
  return Promise.all(
    NAMED_PRODUCTION_PATHS.map(async (relativePath) => ({
      relativePath,
      byteHash: createHash('sha256')
        .update(await fsp.readFile(path.join(dataRoot, relativePath)))
        .digest('hex'),
    }))
  );
}

function createForbiddenProductionSpies() {
  return {
    fullReset: vi.spyOn(CleanupService.prototype, 'fullReset'),
    publicationLock: vi.spyOn(StrictFinalizationRuntime, 'acquireStrictPublicationOperationLock'),
    publicCas: vi.spyOn(PublicRouteCas, 'commitPreparedPublicRoute'),
  };
}

function assertForbiddenProductionSpiesUntouched(
  spies: ReturnType<typeof createForbiddenProductionSpies>
): void {
  expect(spies.fullReset).not.toHaveBeenCalled();
  expect(spies.publicationLock).not.toHaveBeenCalled();
  expect(spies.publicCas).not.toHaveBeenCalled();
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

function findForbiddenPublicFields(value: unknown, location = '$'): string[] {
  const forbidden: string[] = [];
  if (typeof value === 'string') {
    if (value.startsWith('/Users/') || value.startsWith('/private/') || value.startsWith('/tmp/')) {
      forbidden.push(location);
    }
    return forbidden;
  }
  if (Array.isArray(value)) {
    return value.flatMap((row, index) => findForbiddenPublicFields(row, `${location}[${index}]`));
  }
  if (!value || typeof value !== 'object') {
    return forbidden;
  }
  const forbiddenKeys = new Set([
    'contentBase64',
    'credentialLocationSymbol',
    'executionContext',
    'privateDataRoot',
    'projectRoot',
    'runRoot',
    'semanticReviewTrust',
    'trustPolicy',
  ]);
  for (const [key, nested] of Object.entries(value)) {
    const next = `${location}.${key}`;
    if (forbiddenKeys.has(key)) {
      forbidden.push(next);
    }
    forbidden.push(...findForbiddenPublicFields(nested, next));
  }
  return forbidden;
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
