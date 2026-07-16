import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProjectDescriptor } from '@alembic/core';
import { readAlembicMigrationBundleManifest } from '@alembic/core/database';
import { ANATOMY_LENS_IDS, type FactQueryFamilyV1 } from '@alembic/core/plans';
import { hashCanonicalJson } from '@alembic/core/project-context-foundation';
import { WorkspaceResolver } from '@alembic/core/workspace';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServiceContainer } from '../../lib/injection/ServiceContainer.js';
import { resolveMainCertifiedProjectScopeHash } from '../../lib/project-facts/CertifiedProjectFactsRuntime.js';
import { resolveProjectScopeAnalysisContext } from '../../lib/project-scope/ProjectScopeAnalysis.js';
import {
  STRICT_PRODUCTION_STATES_V1,
  StrictProductionJournal,
} from '../../lib/recipe-pipeline/generate/strict/StrictProductionJournal.js';
import { executeRecipePipelineJob } from '../../lib/recipe-pipeline/RecipePipelineFacade.js';
import { PACKAGE_ROOT } from '../../lib/shared/package-assets.js';
import { createRuntimeArtifactManifestFixture } from '../helpers/RuntimeArtifactManifestFixture.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await makeTreeWritable(root);
      await fsp.rm(root, { force: true, recursive: true });
    })
  );
});

async function makeTreeWritable(root: string): Promise<void> {
  let stat: Awaited<ReturnType<typeof fsp.lstat>>;
  try {
    stat = await fsp.lstat(root);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    return;
  }
  await fsp.chmod(root, 0o700);
  for (const entry of await fsp.readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      await makeTreeWritable(path.join(root, entry.name));
    }
  }
}

describe('RecipePipelineFacade strict production integration', () => {
  it('runs the real Facade/Generate/ColdStart chain through one public CAS without network access', async () => {
    const fixture = await createFixture();
    try {
      const result = await executeFixture(fixture);

      expect(result).toMatchObject({
        mode: 'strict-production',
        status: 'FINALIZED',
        runtimeLoad: {
          artifactReceipt: {
            kind: 'RuntimeArtifactLoadReceiptV1',
            manifestHash: fixture.runtimeArtifactManifestHash,
            receiptHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
          },
          configReceipt: {
            kind: 'RuntimeConfigLoadReceiptV1',
            receiptHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
          },
        },
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
      expect(JSON.stringify(report)).not.toContain(fixture.runtimeArtifactManifestPath);
      const journalBytes = await fsp.readFile(
        path.join(operationRoot, 'strict-production.journal.jsonl'),
        'utf8'
      );
      expect(journalBytes).not.toContain(fixture.runtimeArtifactManifestPath);
      const journalEntries = journalBytes
        .trim()
        .split('\n')
        .map(
          (row) =>
            JSON.parse(row) as {
              state: string;
              payload: Record<string, unknown>;
            }
        );
      const journal = journalEntries.map((entry) => entry.state);
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
      const runtimeLoad = report.runtimeLoad as {
        artifactReceipt: { receiptHash: string };
        configReceipt: { configHash: string; receiptHash: string };
      };
      expect(
        journalEntries.find((entry) => entry.state === 'PC_F_ACCEPTED')?.payload
      ).toMatchObject({
        runtimeArtifactManifestHash: fixture.runtimeArtifactManifestHash,
        runtimeArtifactReceiptHash: runtimeLoad.artifactReceipt.receiptHash,
      });
      expect(journalEntries.find((entry) => entry.state === 'AUTHORIZED')?.payload).toMatchObject({
        runtimeConfigHash: runtimeLoad.configReceipt.configHash,
        runtimeConfigReceiptHash: runtimeLoad.configReceipt.receiptHash,
      });
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
      const publicationRoot = path.join(fixture.dataRoot, '.asd/context/recipe-publications');
      await expect(fsp.stat(path.join(publicationRoot, 'marker.json'))).resolves.toMatchObject({
        isFile: expect.any(Function),
      });
      const marker = JSON.parse(
        await fsp.readFile(path.join(publicationRoot, 'marker.json'), 'utf8')
      ) as Record<string, unknown>;
      expect(marker).toMatchObject({
        schemaVersion: 1,
        mode: 'strict-v1',
        routeSchemaVersion: 1,
        projectIdentityHash: fixture.projectIdentityHash,
        migrationBundleHash: hashCanonicalJson(readAlembicMigrationBundleManifest()),
      });
      const publicRoute = JSON.parse(
        await fsp.readFile(path.join(publicationRoot, 'active.json'), 'utf8')
      ) as {
        snapshotId: string;
        servingSnapshotManifestHash: string;
        vectorGenerationId: string;
        vectorManifestHash: string;
        servingSnapshotValidationHash?: unknown;
      };
      expect(publicRoute.snapshotId).toMatch(/^snapshot-[a-f0-9]{64}(?:-[a-f0-9-]{36})?$/u);
      await expect(
        fsp.stat(path.join(fixture.dataRoot, 'public/active.json'))
      ).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(publicRoute).not.toHaveProperty('servingSnapshotValidationHash');
      expect(publicRoute).not.toHaveProperty('path');
      expect(publicRoute).not.toHaveProperty('dataRoot');
      expect(publicRoute).not.toHaveProperty('privateCorpusRevision');
      const snapshotRoot = path.join(publicationRoot, 'snapshots', publicRoute.snapshotId);
      const servingManifest = await readJson(path.join(snapshotRoot, 'manifest.json'));
      expect(servingManifest.manifestHash).toBe(publicRoute.servingSnapshotManifestHash);
      expect(hashCanonicalJson(withoutKey(servingManifest, 'manifestHash'))).toBe(
        servingManifest.manifestHash
      );
      const dataManifest = await readJson(
        path.join(snapshotRoot, 'data/candidate-data-manifest.json')
      );
      expect(hashCanonicalJson(withoutKey(dataManifest, 'manifestHash'))).toBe(
        dataManifest.manifestHash
      );
      expect(servingManifest.candidateDataManifestHash).toBe(dataManifest.manifestHash);
      const physicalFiles = (dataManifest.files as Array<{ relativePath: string }>).map(
        (row) => row.relativePath
      );
      expect(physicalFiles).toEqual(
        expect.arrayContaining([
          '.asd/alembic.db',
          '.asd/config.json',
          '.asd/context/recipe-vector-active.json',
          'serving-coverage.json',
          `.asd/context/recipe-vector-generations/${publicRoute.vectorGenerationId}/manifest.json`,
        ])
      );
      expect(physicalFiles.some((file) => file.startsWith('Alembic/recipes/'))).toBe(true);
      expect(
        physicalFiles.some((file) =>
          file.startsWith(
            `.asd/context/recipe-vector-generations/${publicRoute.vectorGenerationId}/store/`
          )
        )
      ).toBe(true);
      const publicVectorActive = await readJson(
        path.join(snapshotRoot, 'data/.asd/context/recipe-vector-active.json')
      );
      expect(publicVectorActive).toMatchObject({
        generationId: publicRoute.vectorGenerationId,
        manifestHash: publicRoute.vectorManifestHash,
      });
      const publicVectorManifest = await readJson(
        path.join(
          snapshotRoot,
          'data/.asd/context/recipe-vector-generations',
          publicRoute.vectorGenerationId,
          'manifest.json'
        )
      );
      expect(publicVectorManifest).toMatchObject({
        generationId: publicRoute.vectorGenerationId,
        manifestHash: publicRoute.vectorManifestHash,
        status: 'ready',
      });
      for (const fileName of [
        'candidate-coverage.json',
        'g4-receipt.json',
        'final-coverage.json',
        'serving-snapshot-validation.json',
        'lineage.json',
      ]) {
        await expect(fsp.stat(path.join(snapshotRoot, fileName))).resolves.toBeDefined();
      }
      const finalCoverage = await readJson(path.join(snapshotRoot, 'final-coverage.json'));
      const candidateCoverage = await readJson(path.join(snapshotRoot, 'candidate-coverage.json'));
      const servingCoverage = await readJson(path.join(snapshotRoot, 'data/serving-coverage.json'));
      const servingValidation = await readJson(
        path.join(snapshotRoot, 'serving-snapshot-validation.json')
      );
      expect(servingManifest.finalCoverageBindingHash).toBe(finalCoverage.receiptHash);
      expect(servingCoverage).toEqual(candidateCoverage);
      expect(dataManifest.candidateCoverageReceiptHash).toBe(candidateCoverage.receiptHash);
      expect(finalCoverage.candidateCoverageReceiptHash).toBe(candidateCoverage.receiptHash);
      expect(servingManifest.servingSnapshotValidationHash).toBe(servingValidation.receiptHash);
      expect(servingValidation).toMatchObject({
        snapshotId: publicRoute.snapshotId,
        candidateDataManifestHash: dataManifest.manifestHash,
        vectorGenerationId: publicRoute.vectorGenerationId,
        vectorManifestHash: publicRoute.vectorManifestHash,
        verdict: 'pass',
      });
      const publicDatabasePath = path.join(snapshotRoot, 'data/.asd/alembic.db');
      const publicDatabase = new Database(publicDatabasePath, {
        readonly: true,
        fileMustExist: true,
      });
      try {
        expect(publicDatabase.pragma('integrity_check', { simple: true })).toBe('ok');
        expect((publicDatabase.pragma('foreign_key_check') as unknown[]).length).toBe(0);
        const activeRecipeIds = publicDatabase
          .prepare("SELECT id FROM knowledge_entries WHERE lifecycle = 'active' ORDER BY id")
          .all()
          .map((row) => String((row as { id: unknown }).id));
        expect(activeRecipeIds).toEqual(dataManifest.activeRecipeIds);
        const refRecipeIds = publicDatabase
          .prepare('SELECT DISTINCT recipe_id FROM recipe_source_refs ORDER BY recipe_id')
          .all()
          .map((row) => String((row as { recipe_id: unknown }).recipe_id));
        expect(refRecipeIds).toEqual(activeRecipeIds);
      } finally {
        publicDatabase.close();
      }
      await expect(fsp.stat(`${publicDatabasePath}-wal`)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fsp.stat(`${publicDatabasePath}-shm`)).rejects.toMatchObject({ code: 'ENOENT' });
      const servingConfig = await readJson(path.join(snapshotRoot, 'data/.asd/config.json'));
      expect(servingConfig).toMatchObject({ kind: 'strict-public-serving-config' });
      expect(JSON.stringify(servingConfig)).not.toContain('credentialLocationSymbol');
      expect(await fsp.readFile(path.join(fixture.dataRoot, '.asd/config.json'), 'utf8')).toBe(
        fixture.sourceConfigBytes
      );
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
      const activePath = path.join(publicationRoot, 'active.json');
      const canonicalRouteBytes = await fsp.readFile(activePath, 'utf8');
      await fsp.writeFile(activePath, `${JSON.stringify(publicRoute, null, 2)}\n`);
      const unhandledRejections: unknown[] = [];
      const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
      const originalClose = StrictProductionJournal.prototype.close;
      const closeSpy = vi
        .spyOn(StrictProductionJournal.prototype, 'close')
        .mockImplementation(async function (this: StrictProductionJournal) {
          await new Promise<void>((resolve) => setTimeout(resolve, 20));
          return originalClose.call(this);
        });
      process.prependListener('unhandledRejection', onUnhandledRejection);
      try {
        await expect(executeFixture(fixture)).rejects.toThrow(
          'STRICT_FINALIZED_PUBLIC_ROUTE_DIVERGENCE'
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(unhandledRejections).toEqual([]);
      } finally {
        process.removeListener('unhandledRejection', onUnhandledRejection);
        closeSpy.mockRestore();
      }
      await fsp.writeFile(activePath, canonicalRouteBytes);
      await persistRequestedEvidence(operationRoot, fixture.dataRoot);
      await fsp.rm(operationRoot, { recursive: true });
      await fsp.rm(path.join(fixture.dataRoot, '.asd/context/recipe-runs'), { recursive: true });
      const detachedPublicationRoot = path.join(
        fixture.dataRoot,
        '.asd/context/recipe-publications'
      );
      const detachedMarker = await readJson(path.join(detachedPublicationRoot, 'marker.json'));
      const detachedRoute = await readJson(path.join(detachedPublicationRoot, 'active.json'));
      const detachedSnapshotRoot = path.join(
        detachedPublicationRoot,
        'snapshots',
        String(detachedRoute.snapshotId)
      );
      const detachedDataManifest = await readJson(
        path.join(detachedSnapshotRoot, 'data/candidate-data-manifest.json')
      );
      expect(detachedMarker.projectIdentityHash).toBe(fixture.projectIdentityHash);
      expect(detachedDataManifest.manifestHash).toBe(servingManifest.candidateDataManifestHash);
      for (const row of detachedDataManifest.files as Array<{
        relativePath: string;
        byteHash: string;
      }>) {
        expect(
          `sha256:${createHash('sha256')
            .update(await fsp.readFile(path.join(detachedSnapshotRoot, 'data', row.relativePath)))
            .digest('hex')}`
        ).toBe(row.byteHash);
      }
      const detachedDatabase = new Database(
        path.join(detachedSnapshotRoot, 'data/.asd/alembic.db'),
        {
          readonly: true,
          fileMustExist: true,
        }
      );
      try {
        expect(detachedDatabase.pragma('integrity_check', { simple: true })).toBe('ok');
        expect(await readJson(path.join(detachedSnapshotRoot, 'manifest.json'))).toMatchObject({
          manifestHash: detachedRoute.servingSnapshotManifestHash,
        });
        expect(
          await readJson(path.join(detachedSnapshotRoot, 'data/serving-coverage.json'))
        ).toEqual(await readJson(path.join(detachedSnapshotRoot, 'candidate-coverage.json')));
        expect(
          await readJson(
            path.join(detachedSnapshotRoot, 'data/.asd/context/recipe-vector-active.json')
          )
        ).toMatchObject({ generationId: detachedRoute.vectorGenerationId });
      } finally {
        detachedDatabase.close();
      }
    } finally {
      fixture.database.close();
    }
  }, 30_000);

  it('keeps route null across sealed bundle tamper classes and allocates a new snapshot', async () => {
    const fixture = await createFixture();
    try {
      await executeFixture(fixture);
      const publicationRoot = path.join(fixture.dataRoot, '.asd/context/recipe-publications');
      const activePath = path.join(publicationRoot, 'active.json');
      const originalRoute = await readJson(activePath);
      const originalSnapshotId = String(originalRoute.snapshotId);
      const originalSnapshotRoot = path.join(publicationRoot, 'snapshots', originalSnapshotId);
      const candidateManifestPath = path.join(
        originalSnapshotRoot,
        'data/candidate-data-manifest.json'
      );
      const candidateManifest = await readJson(candidateManifestPath);
      const recipeFile = (candidateManifest.files as Array<{ relativePath: string }>).find((row) =>
        row.relativePath.startsWith('Alembic/recipes/')
      )?.relativePath;
      const vectorFile = (candidateManifest.files as Array<{ relativePath: string }>).find(
        (row) =>
          row.relativePath.includes('/recipe-vector-generations/') &&
          row.relativePath.includes('/store/')
      )?.relativePath;
      if (!recipeFile || !vectorFile) {
        throw new Error('fixture public Recipe/vector file missing');
      }
      await makeTreeWritable(originalSnapshotRoot);
      const operationRoot = path.join(
        fixture.dataRoot,
        'strict-production/operations/strict-integration-run'
      );
      const checkpointPath = path.join(operationRoot, 'strict-production.checkpoint.json');
      const checkpointBytes = await fsp.readFile(checkpointPath);
      const journalPath = path.join(operationRoot, 'strict-production.journal.jsonl');
      const rows = (await fsp.readFile(journalPath, 'utf8'))
        .trim()
        .split('\n')
        .map((row) => JSON.parse(row) as { state: string });
      const sealedIndex = rows.findIndex((row) => row.state === 'CANDIDATE_DATA_SEALED');
      expect(sealedIndex).toBeGreaterThan(0);
      await fsp.writeFile(
        journalPath,
        `${rows
          .slice(0, sealedIndex + 1)
          .map((row) => JSON.stringify(row))
          .join('\n')}\n`
      );
      const tamperPaths = [
        path.join(originalSnapshotRoot, 'data', recipeFile),
        candidateManifestPath,
        path.join(originalSnapshotRoot, 'final-coverage.json'),
        path.join(originalSnapshotRoot, 'serving-snapshot-validation.json'),
        path.join(originalSnapshotRoot, 'data', vectorFile),
      ];
      const originalBytes = new Map(
        await Promise.all(
          tamperPaths.map(async (filePath) => [filePath, await fsp.readFile(filePath)] as const)
        )
      );
      for (const tamperPath of tamperPaths) {
        await fsp.writeFile(checkpointPath, checkpointBytes);
        for (const [filePath, bytes] of originalBytes) {
          await fsp.chmod(filePath, 0o600);
          await fsp.writeFile(filePath, bytes);
        }
        await fsp.rm(activePath, { force: true });
        await fsp.appendFile(tamperPath, '\nTAMPERED\n');
        await expect(executeFixture(fixture), tamperPath).rejects.toThrow(
          'STRICT_PUBLIC_SNAPSHOT_INVALIDATED'
        );
        await expect(fsp.stat(activePath)).rejects.toMatchObject({ code: 'ENOENT' });
      }

      const repaired = await executeFixture(fixture);
      expect(repaired).toMatchObject({ status: 'FINALIZED' });
      const repairedRoute = await readJson(activePath);
      expect(repairedRoute.snapshotId).not.toBe(originalSnapshotId);
      expect(repairedRoute.snapshotId).toMatch(/^snapshot-[a-f0-9]{64}-[a-f0-9-]{36}$/u);
      await expect(
        fsp.stat(path.join(publicationRoot, 'snapshots', originalSnapshotId))
      ).resolves.toBeDefined();
    } finally {
      fixture.database.close();
    }
  }, 30_000);

  it('rejects a wrong project binding before marker installation or destructive reset', async () => {
    const fixture = await createFixture({ authorizationProjectIdentityHash: sha('wrong-project') });
    try {
      const resetSentinel = path.join(fixture.dataRoot, 'candidate-cache/sentinel.json');
      await fsp.mkdir(path.dirname(resetSentinel), { recursive: true });
      await fsp.writeFile(resetSentinel, '{}\n');
      await expect(executeFixture(fixture)).rejects.toThrow(
        'STRICT_AUTHORIZATION_PROJECT_IDENTITY_MISMATCH'
      );
      await expect(fsp.stat(resetSentinel)).resolves.toBeDefined();
      await expect(
        fsp.stat(path.join(fixture.dataRoot, '.asd/context/recipe-publications/marker.json'))
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      fixture.database.close();
    }
  });

  it('fails on artifact drift before creating an operation root or touching the reset target', async () => {
    const fixture = await createFixture();
    const sentinel = path.join(fixture.dataRoot, 'candidate-cache/sentinel.json');
    const operationRoot = path.join(
      fixture.dataRoot,
      'strict-production/operations/strict-integration-run'
    );
    try {
      await fsp.mkdir(path.dirname(sentinel), { recursive: true });
      await fsp.writeFile(sentinel, '{}\n');
      await fsp.appendFile(fixture.runtimeArtifactCorePath, Buffer.from('tamper'));

      await expect(executeFixture(fixture)).rejects.toThrow(
        'STRICT_RUNTIME_ARTIFACT_HASH_MISMATCH'
      );
      await expect(fsp.readFile(sentinel, 'utf8')).resolves.toBe('{}\n');
      await expect(fsp.stat(operationRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      fixture.database.close();
    }
  });

  it('rejects a changed sanitized config receipt on persisted finalized replay', async () => {
    const fixture = await createFixture();
    try {
      await executeFixture(fixture);
      process.env.ALEMBIC_AI_PROXY = 'http://runtime-proxy.invalid';
      await expect(executeFixture(fixture)).rejects.toThrow(
        'STRICT_RUNTIME_LOAD_RECEIPT_RESUME_MISMATCH'
      );
    } finally {
      delete process.env.ALEMBIC_AI_PROXY;
      fixture.database.close();
    }
  });
});

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fsp.readFile(filePath, 'utf8')) as Record<string, unknown>;
}

function withoutKey(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const { [key]: _omitted, ...rest } = value;
  return rest;
}

async function executeFixture(fixture: Awaited<ReturnType<typeof createFixture>>) {
  const previous = {
    ALEMBIC_AI_MODEL: process.env.ALEMBIC_AI_MODEL,
    ALEMBIC_AI_PROVIDER: process.env.ALEMBIC_AI_PROVIDER,
    ALEMBIC_RUNTIME_ARTIFACT_MANIFEST_PATH: process.env.ALEMBIC_RUNTIME_ARTIFACT_MANIFEST_PATH,
  };
  process.env.ALEMBIC_AI_PROVIDER = 'fixture';
  process.env.ALEMBIC_AI_MODEL = 'fixture-reviewer';
  process.env.ALEMBIC_RUNTIME_ARTIFACT_MANIFEST_PATH = fixture.runtimeArtifactManifestPath;
  try {
    return await executeRecipePipelineJob({
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
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function persistRequestedEvidence(operationRoot: string, dataRoot: string): Promise<void> {
  const evidenceRoot = process.env.STRICT_EVIDENCE_DIR?.trim();
  if (!evidenceRoot) {
    return;
  }
  await removeEvidenceRoot(evidenceRoot);
  await fsp.mkdir(evidenceRoot, { recursive: true });
  const publicationRoot = path.join(dataRoot, '.asd/context/recipe-publications');
  const route = await readJson(path.join(publicationRoot, 'active.json'));
  const snapshotRoot = path.join(publicationRoot, 'snapshots', String(route.snapshotId));
  const candidateDataManifest = await readJson(
    path.join(snapshotRoot, 'data/candidate-data-manifest.json')
  );
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
      path.join(publicationRoot, 'active.json'),
      path.join(evidenceRoot, 'public-route.json')
    ),
    fsp.copyFile(path.join(publicationRoot, 'marker.json'), path.join(evidenceRoot, 'marker.json')),
    fsp.cp(publicationRoot, path.join(evidenceRoot, 'recipe-publications'), { recursive: true }),
  ]);
  const metadataFiles = [
    'candidate-coverage.json',
    'g4-receipt.json',
    'final-coverage.json',
    'serving-snapshot-validation.json',
    'lineage.json',
    'manifest.json',
  ];
  const probe = {
    schemaVersion: 1,
    snapshotId: route.snapshotId,
    routeHash: hashCanonicalJson(route),
    candidateDataManifestHash: candidateDataManifest.manifestHash,
    dataFiles: candidateDataManifest.files,
    metadataFiles: await Promise.all(
      metadataFiles.map(async (relativePath) => ({
        relativePath,
        byteHash: `sha256:${createHash('sha256')
          .update(await fsp.readFile(path.join(snapshotRoot, relativePath)))
          .digest('hex')}`,
      }))
    ),
  };
  await fsp.writeFile(
    path.join(evidenceRoot, 'public-bundle-probe.json'),
    `${JSON.stringify(probe, null, 2)}\n`
  );
}

async function removeEvidenceRoot(evidenceRoot: string): Promise<void> {
  const pendingDirectories = [evidenceRoot];
  while (pendingDirectories.length > 0) {
    const currentDirectory = pendingDirectories.pop();
    if (!currentDirectory) {
      continue;
    }
    try {
      await fsp.chmod(currentDirectory, 0o755);
      const entries = await fsp.readdir(currentDirectory, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          pendingDirectories.push(path.join(currentDirectory, entry.name));
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue;
      }
      throw error;
    }
  }
  await fsp.rm(evidenceRoot, { force: true, recursive: true });
}

async function createFixture(options: { authorizationProjectIdentityHash?: string } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'alembic-strict-facade-'));
  roots.push(root);
  const projectRoot = path.join(root, 'project');
  const dataRoot = path.join(root, 'data');
  await fsp.mkdir(path.join(projectRoot, 'src'), { recursive: true });
  await fsp.mkdir(path.join(dataRoot, '.asd'), { recursive: true });
  const sourceConfigBytes = `${JSON.stringify({
    provider: 'fixture',
    model: 'fixture-embedding-v1',
    credentialLocationSymbol: 'env:STRICT_FIXTURE_ONLY',
  })}\n`;
  await fsp.writeFile(path.join(dataRoot, '.asd/config.json'), sourceConfigBytes);
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
  const runtimeArtifactFixture = await createRuntimeArtifactManifestFixture({
    root,
    loadedPackageRoots: {
      main: await fsp.realpath(PACKAGE_ROOT),
      core: await fsp.realpath(path.join(PACKAGE_ROOT, 'node_modules/@alembic/core')),
      agent: await fsp.realpath(path.join(PACKAGE_ROOT, 'node_modules/@alembic/agent')),
    },
  });
  const database = new Database(path.join(dataRoot, 'main.sqlite'));
  const agentService = new DeterministicStrictAgentService();
  const embedProvider = createFixtureEmbedProvider();
  const services = new Map<string, unknown>([
    ['database', database],
    ['agentService', agentService],
  ]);
  const container = {
    singletons: {
      _projectRoot: projectRoot,
      _workspaceResolver: resolver,
      _embedProvider: embedProvider,
      aiProvider: { name: 'fixture', model: 'fixture-reviewer' },
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
  const projectIdentityHash = resolveMainCertifiedProjectScopeHash({
    analysisScope: resolveProjectScopeAnalysisContext(container),
    projectRoot,
  });
  const semantic = {
    schemaVersion: 1 as const,
    runId,
    projectRoot,
    dataRoot,
    operationRoot: `strict-production/operations/${runId}`,
    publicRoutePath: 'public/active.json',
    expectedPublicRouteHash: null,
    pcfBaselineReceiptHash: sha('pcf-baseline'),
    runtimeArtifacts: {
      manifestContentHash: runtimeArtifactFixture.manifestContentHash,
      manifestHash: runtimeArtifactFixture.manifest.manifestHash,
      manifestSymbol: 'controller:runtime-artifact-manifest' as const,
    },
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
      projectIdentityHash: options.authorizationProjectIdentityHash ?? projectIdentityHash,
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
    projectIdentityHash,
    runId,
    runtimeArtifactCorePath: runtimeArtifactFixture.coreArtifactPath,
    runtimeArtifactManifestHash: runtimeArtifactFixture.manifest.manifestHash,
    runtimeArtifactManifestPath: runtimeArtifactFixture.manifestPath,
    sourceConfigBytes,
  };
}

function createFixtureEmbedProvider() {
  return {
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
