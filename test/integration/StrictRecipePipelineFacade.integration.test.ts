import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProjectDescriptor } from '@alembic/core';
import { readAlembicMigrationBundleManifest } from '@alembic/core/database';
import { ANATOMY_LENS_IDS, type FactQueryFamilyV1 } from '@alembic/core/plans';
import { hashCanonicalJson } from '@alembic/core/project-context-foundation';
import { WorkspaceResolver } from '@alembic/core/workspace';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { ServiceContainer } from '../../lib/injection/ServiceContainer.js';
import { STRICT_PRODUCTION_STATES_V1 } from '../../lib/recipe-pipeline/generate/strict/StrictProductionJournal.js';
import { executeRecipePipelineJob } from '../../lib/recipe-pipeline/RecipePipelineFacade.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fsp.rm(root, { force: true, recursive: true })));
});

describe('RecipePipelineFacade strict production integration', () => {
  it('runs the real Facade/Generate/ColdStart chain through one public CAS without network access', async () => {
    const fixture = await createFixture();
    try {
      const result = await executeFixture(fixture);

      expect(result).toMatchObject({
        mode: 'strict-production',
        status: 'FINALIZED',
        asyncFill: false,
      });
      const operationRoot = path.join(
        fixture.dataRoot,
        'strict-production/operations/strict-integration-run'
      );
      const report = JSON.parse(
        await fsp.readFile(
          path.join(operationRoot, 'strict-production.runtime-report.json'),
          'utf8'
        )
      ) as Record<string, unknown>;
      expect(report).toMatchObject({
        mode: 'strict-production',
        status: 'FINALIZED',
        analysisHandle: {
          directFactCount: expect.any(Number),
          derivedFactCount: 1,
          expressionSetCount: 1,
        },
        compatibility: {
          legacyColdStartChanged: false,
          incrementalRescan: 'typed-unreachable-from-strict-cold-start',
          legacyReaders: 'unchanged-not-consumed-by-strict-route',
          privateHooks: 'not-installed',
        },
      });
      expect(report).not.toHaveProperty('candidateHandle');
      expect(report).toHaveProperty('privateCorpusEvidence.servingSnapshotValidationHash');
      const journal = (
        await fsp.readFile(path.join(operationRoot, 'strict-production.journal.jsonl'), 'utf8')
      )
        .trim()
        .split('\n')
        .map((row) => (JSON.parse(row) as { state: string }).state);
      expect(journal.slice(-8)).toEqual([
        'G4_READY',
        'SERVING_RECONCILED',
        'FINAL_COVERAGE_BOUND',
        'SERVING_SNAPSHOT_VALIDATED',
        'SERVING_MANIFEST_READY',
        'PUBLIC_CAS_PREPARED',
        'PUBLIC_CAS_COMMITTED',
        'FINALIZED',
      ]);
      expect(journal).not.toContain('CANDIDATE_ORACLE_PASSED');
      expect(journal).toEqual(
        STRICT_PRODUCTION_STATES_V1.filter((state) => state !== 'PRISTINE_ABSENT')
      );
      const checkpoint = JSON.parse(
        await fsp.readFile(path.join(operationRoot, 'strict-production.checkpoint.json'), 'utf8')
      ) as {
        schemaVersion?: number;
        finalization?: {
          servingSnapshotValidation?: { receiptHash?: string };
          servingManifest?: { servingSnapshotValidationHash?: string };
        };
      };
      expect(checkpoint.schemaVersion).toBe(2);
      expect(checkpoint.finalization?.servingManifest?.servingSnapshotValidationHash).toBe(
        checkpoint.finalization?.servingSnapshotValidation?.receiptHash
      );
      const publicRoute = JSON.parse(
        await fsp.readFile(path.join(fixture.dataRoot, 'public/active.json'), 'utf8')
      ) as { snapshotId?: string; servingSnapshotValidationHash?: unknown };
      expect(publicRoute.snapshotId).toMatch(/^snapshot:/u);
      expect(publicRoute).not.toHaveProperty('servingSnapshotValidationHash');
      for (const serialized of [JSON.stringify(checkpoint), JSON.stringify(report)]) {
        expect(serialized).not.toContain('candidateOracle');
        expect(serialized).not.toContain('candidateHandle');
      }
      expect(fixture.agentService.networkRequestCount).toBe(0);
      const journalPath = path.join(operationRoot, 'strict-production.journal.jsonl');
      const durableRows = (await fsp.readFile(journalPath, 'utf8'))
        .trim()
        .split('\n')
        .map((row) => JSON.parse(row) as { state: string; payload?: Record<string, unknown> });
      const preparedIndex = durableRows.findIndex((row) => row.state === 'PUBLIC_CAS_PREPARED');
      expect(preparedIndex).toBeGreaterThan(0);
      await fsp.writeFile(
        journalPath,
        `${durableRows
          .slice(0, preparedIndex + 1)
          .map((row) => JSON.stringify(row))
          .join('\n')}\n`
      );
      await fsp.rm(path.join(operationRoot, 'strict-production.runtime-report.json'));
      const recovered = await executeFixture(fixture);
      expect(recovered).toMatchObject({ mode: 'strict-production', status: 'FINALIZED' });
      const recoveredRows = (await fsp.readFile(journalPath, 'utf8'))
        .trim()
        .split('\n')
        .map((row) => JSON.parse(row) as { state: string; payload?: Record<string, unknown> });
      expect(
        recoveredRows.find((row) => row.state === 'PUBLIC_CAS_COMMITTED')?.payload?.status
      ).toBe('recovered');
      const replay = await executeFixture(fixture);
      expect(replay).toMatchObject({ mode: 'strict-production', status: 'FINALIZED' });
      const replayJournal = (await fsp.readFile(journalPath, 'utf8')).trim().split('\n');
      expect(replayJournal).toHaveLength(journal.length);
      await persistRequestedEvidence(operationRoot, fixture.dataRoot);
    } finally {
      fixture.database.close();
    }
  }, 30_000);
});

function executeFixture(fixture: Awaited<ReturnType<typeof createFixture>>) {
  return executeRecipePipelineJob({
    args: {
      strictProduction: {
        schemaVersion: 1,
        authorizationReceiptHash: fixture.authorizationHash,
        authorizationReceiptPath: fixture.authorizationReceiptPath,
        runId: fixture.runId,
      },
    },
    container: fixture.container,
    jobId: 'strict-integration-job',
    kind: 'bootstrap',
    logger: fixture.logger,
    source: 'api',
  });
}

async function persistRequestedEvidence(operationRoot: string, dataRoot: string): Promise<void> {
  const evidenceRoot = process.env.STRICT_EVIDENCE_DIR?.trim();
  if (!evidenceRoot) {
    return;
  }
  await fsp.mkdir(evidenceRoot, { recursive: true });
  await Promise.all([
    fsp.copyFile(
      path.join(operationRoot, 'strict-production.runtime-report.json'),
      path.join(evidenceRoot, 'runtime-report.json')
    ),
    fsp.copyFile(
      path.join(operationRoot, 'strict-production.journal.jsonl'),
      path.join(evidenceRoot, 'journal.jsonl')
    ),
    fsp.copyFile(
      path.join(operationRoot, 'strict-production.checkpoint.json'),
      path.join(evidenceRoot, 'checkpoint.json')
    ),
    fsp.copyFile(
      path.join(dataRoot, 'public/active.json'),
      path.join(evidenceRoot, 'public-route.json')
    ),
  ]);
}

async function createFixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'alembic-strict-facade-'));
  roots.push(root);
  const projectRoot = path.join(root, 'project');
  const dataRoot = path.join(root, 'data');
  await fsp.mkdir(path.join(projectRoot, 'src'), { recursive: true });
  await fsp.mkdir(dataRoot, { recursive: true });
  await fsp.writeFile(
    path.join(projectRoot, 'src/index.ts'),
    [
      'export interface Result<T> { value: T; }',
      'export async function load(): Promise<Result<string>> {',
      "  try { return { value: 'strict' }; } catch (error) { throw error; }",
      '}',
    ].join('\n')
  );
  const folderId = 'folder-strict-main';
  const projectScope = createProjectDescriptor({
    controlRoot: root,
    dataRoot,
    projectId: 'project-strict-main',
    projectScopeId: 'scope-strict-main',
    currentFolderId: folderId,
    folders: [{ id: folderId, path: projectRoot }],
  });
  const resolver = new WorkspaceResolver({
    projectRoot,
    projectScope,
    currentFolderId: folderId,
  });
  const database = new Database(path.join(dataRoot, 'main.sqlite'));
  const agentService = new DeterministicStrictAgentService();
  const embedProvider = {
    describeCapabilities() {
      return {
        provider: 'fixture',
        model: 'fixture-embedding-v1',
        dimension: 3,
        inputKinds: ['query', 'document'] as const,
        batchSupported: true,
        normalization: 'not-normalized' as const,
        formatProfile: 'symmetric' as const,
      };
    },
    async embedQuery(value: string) {
      return [Math.max(1, value.length), 1, 0];
    },
    async embedDocuments(values: readonly string[]) {
      return values.map((value) => [Math.max(1, value.length), 1, 0]);
    },
    async embed(value: string | string[]) {
      const vector = (text: string) => [Math.max(1, text.length), 1, 0];
      return Array.isArray(value) ? value.map(vector) : vector(value);
    },
  };
  const services = new Map<string, unknown>([
    ['database', database],
    ['agentService', agentService],
  ]);
  const container = {
    singletons: {
      _projectRoot: projectRoot,
      _workspaceResolver: resolver,
      _embedProvider: embedProvider,
    },
    get(name: string) {
      if (!services.has(name)) {
        throw new Error(`fixture service missing:${name}`);
      }
      return services.get(name);
    },
  } as unknown as ServiceContainer;
  const runId = 'strict-integration-run';
  const authorizationReceiptPath = `strict-production/authorizations/${runId}.json`;
  const semantic = {
    schemaVersion: 1 as const,
    runId,
    projectRoot,
    dataRoot,
    operationRoot: `strict-production/operations/${runId}`,
    publicRoutePath: 'public/active.json',
    expectedPublicRouteHash: null,
    pcfBaselineReceiptHash: sha('pcf-baseline'),
    reset: { relativePaths: ['candidate-cache'], tables: [] },
    planning: {
      factQueryFamilies: factFamilies(),
      modelHash: sha('strict-model'),
      promptHash: sha('strict-prompt'),
      strictConfig: strictConfig(),
      reviewer: {
        calibrationReceiptHash: sha('calibration'),
        identity: { provider: 'fixture', model: 'fixture-reviewer', method: 'frozen-evidence' },
      },
    },
    privateCorpus: {
      acceptedMigrationBundleSemanticHash: hashCanonicalJson(readAlembicMigrationBundleManifest()),
      credentialLocationSymbol: 'env:STRICT_FIXTURE_ONLY',
    },
  };
  const authorizationHash = hashCanonicalJson(semantic);
  await fsp.mkdir(path.dirname(path.join(dataRoot, authorizationReceiptPath)), {
    recursive: true,
  });
  await fsp.writeFile(
    path.join(dataRoot, authorizationReceiptPath),
    `${JSON.stringify({ ...semantic, authorizationHash })}\n`
  );
  return {
    agentService,
    authorizationHash,
    authorizationReceiptPath,
    container,
    dataRoot,
    database,
    logger: { info() {}, warn() {}, error() {} },
    runId,
  };
}

class DeterministicStrictAgentService {
  networkRequestCount = 0;

  async run(input: Record<string, unknown>) {
    const metadata = readRecord(readRecord(input.message).metadata);
    if (metadata.task === 'strict-plan-cognition') {
      return this.runPlanCognition(input);
    }
    if (metadata.task === 'strict-independent-value-review') {
      return this.runIndependentValueReview(input);
    }
    if (metadata.task === 'strict-production') {
      return this.runStrictProduction(input);
    }
    throw new Error(`fixture unexpected Agent task:${String(metadata.task)}`);
  }

  private runPlanCognition(input: Record<string, unknown>) {
    const strictContext = readRecord(
      readRecord(readRecord(input.context).promptContext).strictPlanContext
    );
    return agentResult(JSON.stringify(planIntent(strictContext)), 'plan-selection');
  }

  private runIndependentValueReview(input: Record<string, unknown>) {
    const prompt = String(readRecord(input.message).content ?? '');
    const slice = /--- (E-\d+) (.+?):(\d+)-(\d+) blob=/u.exec(prompt);
    if (!slice) {
      throw new Error('fixture reviewer source slice missing');
    }
    return agentResult(
      JSON.stringify({
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
      }),
      'plan-selection'
    );
  }

  private async runStrictProduction(input: Record<string, unknown>) {
    const port = readRecord(readRecord(input.context).strategyContext)
      .strictProduction as StrictRuntimeFixturePort;
    const population = port.populations[0];
    if (!population) {
      throw new Error('fixture strict population missing');
    }
    const observations = population.observations;
    const first = observations[0];
    if (!first) {
      throw new Error('fixture strict observation missing');
    }
    const clusters = new Map<string, Array<(typeof observations)[number]>>();
    for (const observation of observations) {
      const rows = clusters.get(observation.mechanismKey) ?? [];
      rows.push(observation);
      clusters.set(observation.mechanismKey, rows);
    }
    port.validateAnalystResult({
      epoch: {
        population,
        clusterInputs: [...clusters.entries()].map(([mechanismKey, rows]) => ({
          mechanismKey,
          observationIds: rows.map((observation) => observation.observationId),
          anatomyLensIds: ['error-recovery-concurrency'],
        })),
        nonClusteredDispositions: [],
        inductionInputs: [...clusters.entries()].map(([mechanismKey, rows], index) => ({
          mechanismKey,
          mode: rows.length === 1 ? 'bounded-singleton' : 'recurring',
          hypotheses:
            index === 0
              ? [
                  {
                    hypothesisId: 'hypothesis-strict-main',
                    statement: 'The project preserves a typed result boundary.',
                    premiseFactIds: [first.factIds[0]],
                  },
                ]
              : [],
          ...(index === 0
            ? {}
            : {
                zeroHypothesisReason: 'insufficient-evidence',
                zeroHypothesisReviewReceiptId: `zero-review-${index}`,
              }),
        })),
        falsificationInputs: [
          {
            hypothesisId: 'hypothesis-strict-main',
            enrolledCounterqueryIds: [],
            executions: [],
            counterqueryApplicability: {
              status: 'not-required',
              reasonCode: 'bounded-project-contract',
              reviewerReceiptId: 'counterquery-review',
            },
          },
        ],
        hypothesisDispositions: [
          {
            hypothesisId: 'hypothesis-strict-main',
            status: 'survived',
            reviewerReceiptId: 'hypothesis-review',
          },
        ],
      },
    });
    const producer = port.buildProducerInput();
    const evidenceEntryId = producer.evidence.entries[0]?.evidenceEntryId;
    if (!evidenceEntryId) {
      throw new Error('fixture producer evidence missing');
    }
    await port.reviewProducerResult({
      expressionSets: [
        {
          hypothesisId: 'hypothesis-strict-main',
          proposals: port.eligibleCells.map((cell) => ({
            expressionId: `expression-${cell.moduleId}-${cell.dimensionId}`,
            kind: 'draft',
            authored: authoredProjection(cell.moduleId, cell.dimensionId, evidenceEntryId),
          })),
          zeroDisposition: null,
        },
      ],
    });
    return agentResult('{"strictProduction":"completed"}', 'generate-dimension');
  }
}

interface StrictRuntimeFixturePort {
  eligibleCells: Array<{ cellId: string; moduleId: string; dimensionId: string }>;
  populations: Array<{
    observations: Array<{
      observationId: string;
      factIds: string[];
      mechanismKey: string;
      canonicalSubjectRefs: string[];
    }>;
  }>;
  validateAnalystResult(source: unknown): unknown;
  buildProducerInput(): {
    evidence: { entries: Array<{ evidenceEntryId: string }> };
    lineages: Array<{ hypothesis: { hypothesisId: string } }>;
  };
  reviewProducerResult(source: unknown): Promise<unknown>;
}

function planIntent(context: Record<string, unknown>) {
  const projection = readRecord(context.projectContextFacts);
  const modules = Array.isArray(projection.modules)
    ? projection.modules.map((module) => readRecord(module))
    : [];
  const subjectRefs = modules.map(
    (module) => `repo:${String(module.repoId)}:module:${String(module.moduleId)}`
  );
  const families = factFamilies();
  const question = {
    questionId: 'q-strict-main',
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

function authoredProjection(moduleId: string, dimensionId: string, evidenceEntryId: string) {
  const exclusion = 'Do not bypass the strict result boundary.';
  return {
    title: `Strict ${dimensionId} result boundary`,
    kind: 'rule',
    doClause: 'Preserve the typed Result boundary and frozen evidence lineage.',
    dontClause: exclusion,
    markdown: `The ${dimensionId} path preserves the typed Result boundary.`,
    usageGuide: `Apply this rule to ${dimensionId} changes in the owned module.`,
    retrievalProfile: {
      intents: [`strict ${dimensionId} result boundary`],
      exclusions: [{ text: exclusion }],
    },
    negativeIntent: [exclusion],
    scope: { moduleIds: [moduleId], dimensionIds: [dimensionId] },
    evidenceEntryIds: [evidenceEntryId],
  };
}

function agentResult(reply: string, profileId: string) {
  return {
    runId: `fixture-${profileId}`,
    profileId,
    reply,
    status: 'success' as const,
    toolCalls: [],
    usage: { inputTokens: 1, outputTokens: 1, iterations: 1, durationMs: 1 },
    diagnostics: null,
  };
}

function strictConfig() {
  const strictColdStart = {
    candidateAttemptCap: 100,
    maxAuthoredCandidatesPerCellPass: 1,
    providerRequestCap: 200,
    detailRequestCap: 200,
    tokenCap: 2_000_000,
    timeMsCap: 600_000,
    costMicrousdCap: 5_000_000,
    factQueryObligationCap: 10_000,
    moduleWireBound: 5_000,
    cellWireBound: 100_000,
  };
  return {
    sourceArtifactHash: sha('strict-config'),
    strictColdStart,
    fieldSources: Object.fromEntries(
      Object.keys(strictColdStart).map((field) => [field, `fixture:${field}`])
    ),
  };
}

function factFamilies(): FactQueryFamilyV1[] {
  return [
    family('syntax-idiom', 'tree-sitter-query', ['source-range', 'symbol', 'file']),
    family('architecture-dependency', 'certified-project-context', [
      'module',
      'package',
      'repository',
      'project',
    ]),
    family('api-protocol', 'accepted-semantic-relations', [
      'source-range',
      'symbol',
      'module',
      'repository',
    ]),
    family('lifecycle-error-invariant', 'accepted-static-invariants', [
      'source-range',
      'symbol',
      'module',
      'project',
    ]),
    family('config-build-test-migration', 'frozen-config-parsers', ['file', 'module', 'project']),
    family('history-fix-pattern', 'accepted-frozen-history', ['symbol', 'repository']),
    family('synthesis-cross-cutting', 'accepted-observation-aggregation', [
      'module',
      'repository',
      'project',
    ]),
  ];
}

function family(
  id: string,
  capabilityId: string,
  supportedScales: FactQueryFamilyV1['supportedScales']
): FactQueryFamilyV1 {
  return {
    id,
    capabilityId,
    supportedScales,
    loadedProducer: `loaded:fixture:${id}`,
    producerManifestHash: sha(`${id}:manifest`),
    loadReceiptHash: sha(`${id}:load`),
    positiveFixtureHash: sha(`${id}:positive`),
    negativeFixtureHash: sha(`${id}:negative`),
    edgeFixtureHash: sha(`${id}:edge`),
  };
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function sha(value: string): `sha256:${string}` {
  return `sha256:${Buffer.from(value).toString('hex').padEnd(64, '0').slice(0, 64)}`;
}
