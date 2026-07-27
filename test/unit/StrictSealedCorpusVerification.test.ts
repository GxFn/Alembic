import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createProjectDescriptor } from '@alembic/core';
import { readAlembicMigrationBundleManifest } from '@alembic/core/database';
import { WriteZone } from '@alembic/core/io';
import { KnowledgeEntry, KnowledgeFileWriter } from '@alembic/core/knowledge';
import { hashCanonicalJson } from '@alembic/core/project-context-foundation';
import { createAlembicRepositories } from '@alembic/core/repositories';
import { initializePrivateCorpusRevisionV1, WorkspaceResolver } from '@alembic/core/workspace';
import { afterEach, describe, expect, it } from 'vitest';

import { verifyStrictSealedCorpus } from '../../lib/recipe-pipeline/generate/strict/StrictPrivateCorpusRuntime.js';

const fixtureRoots: string[] = [];
const fixtureCleanups: Array<() => void> = [];
const acceptedMigrationBundleSemanticHash = hashCanonicalJson(readAlembicMigrationBundleManifest());
type FixtureRepositories = ReturnType<typeof createAlembicRepositories>;

afterEach(async () => {
  for (const cleanup of fixtureCleanups.splice(0)) {
    cleanup();
  }
  await Promise.all(
    fixtureRoots.splice(0).map((root) => fsp.rm(root, { force: true, recursive: true }))
  );
});

describe('strict sealed corpus verification', () => {
  it('binds the exact active members, durable refs, sparse evidence, and healthy vector manifest', async () => {
    const { input } = await fixture();
    const verification = await verifyStrictSealedCorpus(input);

    expect(verification).toMatchObject({
      schemaVersion: 1,
      activeRecipeIds: ['recipe-a', 'recipe-b'],
      vectorGenerationId: 'generation-a',
      vectorManifestHash: sha('vector-manifest'),
      verdict: 'pass',
      failedPredicate: null,
    });
    expect(verification.durableReadbackHash).toMatch(/^sha256:/u);
    expect(verification.refReadbackHash).toMatch(/^sha256:/u);
    expect(verification.sparseEvidenceHash).toMatch(/^sha256:/u);
    expect(verification.vectorInspectionHash).toMatch(/^sha256:/u);
    expect(verification.verificationHash).toMatch(/^sha256:/u);
    expect(Object.isFrozen(verification)).toBe(true);
  });

  it('fails closed when sealed database content drifts without changing identity or lifecycle', async () => {
    const { input, tamperDatabase } = await fixture();
    await tamperDatabase();

    await expect(verifyStrictSealedCorpus(input)).rejects.toThrow(
      'STRICT_SEALED_CORPUS_VERIFICATION_FAILED:database-readback-conservation'
    );
  });

  it('fails closed when sealed Recipe file bytes drift', async () => {
    const { input, tamperFile } = await fixture();
    await tamperFile();

    await expect(verifyStrictSealedCorpus(input)).rejects.toThrow(
      'STRICT_SEALED_CORPUS_VERIFICATION_FAILED:file-readback-conservation'
    );
  });

  it('fails closed when a sealed source-ref row drifts', async () => {
    const { input, tamperRef } = await fixture();
    tamperRef();

    await expect(verifyStrictSealedCorpus(input)).rejects.toThrow(
      'STRICT_SEALED_CORPUS_VERIFICATION_FAILED:ref-readback-conservation'
    );
  });

  it('fails closed when sparse evidence does not conserve every ready member', async () => {
    const { input } = await fixture();
    input.repository.search = async () => ({ data: [] });
    await expect(verifyStrictSealedCorpus(input)).rejects.toThrow(
      'STRICT_SEALED_CORPUS_VERIFICATION_FAILED:sparse-member-conservation'
    );
  });

  it('fails closed when the vector generation is not exact and healthy', async () => {
    const { input } = await fixture();
    input.vectorInspection.healthy = false;
    await expect(verifyStrictSealedCorpus(input)).rejects.toThrow(
      'STRICT_SEALED_CORPUS_VERIFICATION_FAILED:vector-generation-conservation'
    );
  });
});

async function fixture(): Promise<{
  input: Parameters<typeof verifyStrictSealedCorpus>[0];
  tamperDatabase: () => Promise<void>;
  tamperFile: () => Promise<void>;
  tamperRef: () => void;
}> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'alembic-strict-sealed-'));
  fixtureRoots.push(root);
  const initialized = await initializePrivateCorpusRevisionV1(privateScopeResolver(root), {
    runId: 'run-sealed-store-fixture',
    revisionId: 'revision-sealed-store-fixture',
    analysisFixpointHash: sha('fixpoint'),
    configReceiptHash: sha('config'),
    runtimeReceiptHash: sha('runtime'),
    credentialLocationSymbol: 'env:STRICT_TEST_KEY',
    acceptedMigrationBundleSemanticHash,
  });
  fixtureCleanups.push(() => initialized.runtime.close());
  const repositories = createAlembicRepositories(initialized.runtime.connection);
  const fileWriter = new KnowledgeFileWriter(
    initialized.handle.resolver.dataRoot,
    new WriteZone(initialized.handle.resolver)
  );
  const filePaths = await seedFixtureStores(repositories, fileWriter);
  const active = await repositories.knowledgeRepository.findByLifecycle('active', {
    page: 1,
    pageSize: 10,
  });
  const entries = active.data
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    .sort((left, right) => left.id.localeCompare(right.id));
  const readyMembers = await createReadyMembers(repositories, entries, filePaths);
  const input: Parameters<typeof verifyStrictSealedCorpus>[0] = {
    activeRecipes: entries.map(({ id, title }) => ({ id, title, lifecycle: 'active' })),
    readyMembers,
    repository: repositories.knowledgeRepository,
    fileWriter,
    refRepository: repositories.recipeSourceRefRepository,
    vectorGenerationId: 'generation-a',
    vectorManifest: {
      generationId: 'generation-a',
      manifestHash: sha('vector-manifest'),
      status: 'ready',
      recipeCount: 2,
      expectedIds: ['vector-a', 'vector-b'],
      expectedIdsByRecipe: { 'recipe-a': ['vector-a'], 'recipe-b': ['vector-b'] },
    },
    vectorInspection: {
      healthy: true,
      expectedCount: 2,
      presentCount: 2,
      missingIds: [],
      orphanIds: [],
      staleIds: [],
      staleGenerationIds: [],
      duplicateIds: [],
      partialIds: [],
      hashMismatchIds: [],
      dimensionMismatchIds: [],
    },
  };
  return {
    input,
    async tamperDatabase() {
      await repositories.knowledgeRepository.update('recipe-a', {
        content: { markdown: 'tampered database content' },
      });
    },
    async tamperFile() {
      await fsp.writeFile(requiredFilePath(filePaths, 'recipe-a'), 'tampered recipe file bytes');
    },
    tamperRef() {
      repositories.recipeSourceRefRepository.upsert({
        recipeId: 'recipe-a',
        sourcePath: 'src/recipe-a.ts:1-4',
        status: 'stale',
        newPath: null,
        verifiedAt: 1_784_205_001,
        contentFp: sha('recipe-a:source-content'),
      });
    },
  };
}

async function seedFixtureStores(
  repositories: FixtureRepositories,
  fileWriter: KnowledgeFileWriter
): Promise<Map<string, string>> {
  const filePaths = new Map<string, string>();
  for (const entry of [
    createEntry('recipe-a', 'Strict recovery A'),
    createEntry('recipe-b', 'Strict recovery B'),
  ]) {
    const filePath = fileWriter.persist(entry);
    if (!filePath) {
      throw new Error('STRICT_SEALED_FIXTURE_FILE_PERSIST_FAILED');
    }
    filePaths.set(entry.id, filePath);
    await repositories.knowledgeRepository.create(entry);
    repositories.recipeSourceRefRepository.upsert({
      recipeId: entry.id,
      sourcePath: `src/${entry.id}.ts:1-4`,
      status: 'active',
      newPath: null,
      verifiedAt: 1_784_205_000,
      contentFp: sha(`${entry.id}:source-content`),
    });
  }
  return filePaths;
}

async function createReadyMembers(
  repositories: FixtureRepositories,
  entries: readonly KnowledgeEntry[],
  filePaths: ReadonlyMap<string, string>
) {
  return Promise.all(
    entries.map(async (entry) => {
      const fileBytes = await fsp.readFile(requiredFilePath(filePaths, entry.id));
      const semantic = {
        schemaVersion: 1 as const,
        recipeId: entry.id,
        title: entry.title,
        runId: 'run-a',
        privateCorpusRevision: 'revision-a',
        analysisFixpointHash: sha('fixpoint'),
        authoredFingerprint: sha(`${entry.id}:fingerprint`),
        bindingHash: sha(`${entry.id}:binding`),
        persistenceReceiptHash: sha(`${entry.id}:persistence`),
        databaseRowHash: sha(`${entry.id}:database`),
        databaseReadbackHash: hashDatabaseReadback(entry),
        fileHash: sha(`${entry.id}:file`),
        fileReadbackHash: hashFileReadback(entry.id, fileBytes),
        refReconciliationReceiptHash: sha(`${entry.id}:refs`),
        refReadbackHash: hashRefReadback(
          entry.id,
          repositories.recipeSourceRefRepository.findByRecipeId(entry.id)
        ),
        lifecycle: 'active' as const,
      };
      return { ...semantic, proofHash: hashCanonicalJson(semantic) };
    })
  );
}

function requiredFilePath(paths: ReadonlyMap<string, string>, recipeId: string): string {
  const filePath = paths.get(recipeId);
  if (!filePath) {
    throw new Error(`STRICT_SEALED_FIXTURE_FILE_MISSING:${recipeId}`);
  }
  return filePath;
}

function createEntry(id: string, title: string): KnowledgeEntry {
  return new KnowledgeEntry({
    id,
    title,
    description: `Description for ${title}`,
    lifecycle: 'active',
    category: 'architecture',
    dimensionId: 'architecture',
    knowledgeType: 'code-pattern',
    kind: 'pattern',
    doClause: `Do ${id}`,
    dontClause: `Do not ${id}`,
    usageGuide: `Use ${id}`,
    content: { markdown: `Canonical content for ${id}` },
    retrievalProfile: {
      summary: { primary: `Retrieve ${id}`, technicalEnglish: `Retrieve ${id}` },
      exclusions: [],
      provenance: { evidenceRefs: [`src/${id}.ts:1-4`] },
    },
    reasoning: {
      confidence: 1,
      sources: [`src/${id}.ts:1-4`],
      whyStandard: `Strict fixture for ${id}`,
    },
  });
}

function privateScopeResolver(root: string): WorkspaceResolver {
  const folderId = 'folder-strict-sealed';
  const projectScope = createProjectDescriptor({
    controlRoot: path.dirname(root),
    dataRoot: root,
    projectId: 'project-strict-sealed',
    projectScopeId: 'scope-strict-sealed',
    currentFolderId: folderId,
    folders: [{ id: folderId, path: root }],
  });
  return new WorkspaceResolver({
    projectRoot: root,
    projectScope,
    currentFolderId: folderId,
  });
}

function hashDatabaseReadback(entry: KnowledgeEntry): string {
  return hashCanonicalJson({
    kind: 'strict-ready-database-readback-v1',
    recipeId: entry.id,
    row: entry.toJSON(),
  });
}

function hashFileReadback(recipeId: string, fileBytes: Buffer): string {
  return hashCanonicalJson({
    kind: 'strict-ready-file-readback-v1',
    recipeId,
    fileBytesBase64: fileBytes.toString('base64'),
  });
}

function hashRefReadback(
  recipeId: string,
  rows: ReturnType<
    ReturnType<typeof createAlembicRepositories>['recipeSourceRefRepository']['findByRecipeId']
  >
): string {
  return hashCanonicalJson({
    kind: 'strict-ready-ref-readback-v1',
    recipeId,
    rows: rows
      .map((row) => ({
        recipeId: row.recipeId,
        sourcePath: row.sourcePath,
        status: row.status,
        newPath: row.newPath,
        verifiedAt: row.verifiedAt,
        contentFp: row.contentFp,
      }))
      .sort((left, right) => left.sourcePath.localeCompare(right.sourcePath)),
  });
}

function sha(value: string): `sha256:${string}` {
  return `sha256:${Buffer.from(value).toString('hex').padEnd(64, '0').slice(0, 64)}`;
}
