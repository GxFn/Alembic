import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProjectDescriptor } from '@alembic/core';
import { readAlembicMigrationBundleManifest } from '@alembic/core/database';
import { KnowledgeEntry } from '@alembic/core/knowledge';
import { hashCanonicalJson } from '@alembic/core/project-context-foundation';
import { createAlembicRepositories } from '@alembic/core/repositories';
import {
  initializePrivateCorpusRevisionV1,
  PrivateCorpusRevisionHandleV1,
  rehydratePrivateCorpusRevisionV1,
  WorkspaceResolver,
} from '@alembic/core/workspace';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

describe('strict private corpus semantic re-fixpoint isolation', () => {
  it('replays into a second blank root with migration 017 and permanently revokes the old root', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-main-semantic-refixpoint-'));
    roots.push(root);
    const base = privateScopeResolver(root);
    const acceptedMigrationBundleSemanticHash = hashCanonicalJson(
      readAlembicMigrationBundleManifest()
    );
    const common = {
      runId: 'strict-bilidili-017',
      configReceiptHash: `sha256:${'c'.repeat(64)}`,
      credentialLocationSymbol: 'env:STRICT_TEST_KEY',
      acceptedMigrationBundleSemanticHash,
    } as const;
    const first = await initializePrivateCorpusRevisionV1(base, {
      ...common,
      revisionId: 'revision-a',
      analysisFixpointHash: `sha256:${'a'.repeat(64)}`,
    });
    await createRecipe(first.runtime.connection, 'recipe-a', 'Row A before semantic repair');
    const firstReceipt = structuredClone(first.handle.initReceipt);
    const firstRoot = first.handle.resolver.dataRoot;
    first.runtime.sqlite.pragma('wal_checkpoint(TRUNCATE)');
    const firstDatabaseHash = hashFile(first.handle.resolver.databasePath);
    first.runtime.close();

    const freshOld = await rehydratePrivateCorpusRevisionV1(base, firstReceipt);
    const oldRows = await createAlembicRepositories(
      freshOld.runtime.connection
    ).knowledgeRepository.findByLifecycle('active', { page: 1, pageSize: 10 });
    expect(oldRows.data.flatMap((entry) => (entry ? [entry.id] : []))).toEqual(['recipe-a']);

    const second = await initializePrivateCorpusRevisionV1(base, {
      ...common,
      revisionId: 'revision-b',
      analysisFixpointHash: `sha256:${'b'.repeat(64)}`,
    });
    expect(second.handle.resolver.dataRoot).not.toBe(firstRoot);
    expect(second.handle.initReceipt.blankState.knowledgeEntries).toBe(0);
    expect(second.handle.initReceipt.migrationLedgerSemanticHash).toBe(
      firstReceipt.migrationLedgerSemanticHash
    );
    expect(second.handle.initReceipt.migrationVersions).toContain('017_recipe_retrieval_profile');

    // Full replay is authoritative: A is recreated once, then the BiliDili 017 row is added.
    await createRecipe(second.runtime.connection, 'recipe-a', 'Row A replayed from frozen lineage');
    await createRecipe(
      second.runtime.connection,
      'recipe-bilidili-017',
      'BiliDili semantic repair after migration 017'
    );
    const secondRepositories = createAlembicRepositories(second.runtime.connection);
    const secondRows = await secondRepositories.knowledgeRepository.findByLifecycle('active', {
      page: 1,
      pageSize: 10,
    });
    expect(secondRows.data.flatMap((entry) => (entry ? [entry.id] : [])).sort()).toEqual([
      'recipe-a',
      'recipe-bilidili-017',
    ]);
    second.runtime.sqlite.pragma('wal_checkpoint(TRUNCATE)');
    const secondDatabaseHash = hashFile(second.handle.resolver.databasePath);
    expect(secondDatabaseHash).not.toBe(firstDatabaseHash);

    PrivateCorpusRevisionHandleV1.replace(
      freshOld.handle,
      second.handle,
      `sha256:${firstDatabaseHash}`
    );
    expect(() => freshOld.runtime.sqlite.prepare('SELECT 1').get()).toThrow();
    await expect(rehydratePrivateCorpusRevisionV1(base, firstReceipt)).rejects.toThrow(
      'ALEMBIC_DATABASE_ROOT_REVOKED'
    );
    expect(
      second.runtime.sqlite.prepare('SELECT count(*) AS count FROM knowledge_entries').get()
    ).toEqual({ count: 2 });
    second.runtime.close();
  });
});

async function createRecipe(
  connection: Parameters<typeof createAlembicRepositories>[0],
  id: string,
  title: string
): Promise<void> {
  const repositories = createAlembicRepositories(connection);
  await repositories.knowledgeRepository.create(
    new KnowledgeEntry({
      id,
      title,
      description: title,
      lifecycle: 'active',
      category: 'architecture',
      dimensionId: 'architecture',
      knowledgeType: 'code-pattern',
      content: { pattern: title, rationale: 'strict semantic replay fixture' },
      reasoning: {
        confidence: 1,
        sources: ['Sources/BiliDiliApp/App.swift'],
        whyStandard: 'Frozen lineage is replayed without consulting the old revision.',
      },
    })
  );
}

function privateScopeResolver(root: string): WorkspaceResolver {
  const folderId = 'folder-bilidili';
  const projectScope = createProjectDescriptor({
    controlRoot: path.dirname(root),
    dataRoot: root,
    projectId: 'project-bilidili',
    projectScopeId: 'scope-bilidili',
    currentFolderId: folderId,
    folders: [{ id: folderId, path: root }],
  });
  return new WorkspaceResolver({ projectRoot: root, projectScope, currentFolderId: folderId });
}

function hashFile(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}
