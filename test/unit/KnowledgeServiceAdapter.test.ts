import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolRouterAdapter } from '@alembic/agent/tools/runtime';
import { openAlembicDatabase } from '@alembic/core/database';
import { StagingManager } from '@alembic/core/evolution';
import { pathGuard } from '@alembic/core/io';
import { KnowledgeEntry, KnowledgeFileWriter, KnowledgeService } from '@alembic/core/knowledge';
import { createAlembicRepositories } from '@alembic/core/repositories';
import { ConflictError, NotFoundError, ValidationError } from '@alembic/core/shared';
import { WorkspaceResolver } from '@alembic/core/workspace';
import { expect, test } from 'vitest';
import { createKnowledgeServiceAdapter } from '../../lib/tools/KnowledgeServiceAdapter.js';
import { ToolContextFactory } from '../../lib/tools/ToolContextFactory.js';

interface Fixture {
  adapter: ReturnType<typeof createKnowledgeServiceAdapter>;
  audits: Record<string, unknown>[];
  entry: KnowledgeEntry;
  projectRoot: string;
  router: ToolRouterAdapter;
  runtime: Awaited<ReturnType<typeof openAlembicDatabase>>;
  service: KnowledgeService;
  stagingManager: StagingManager;
}

async function withService(run: (fixture: Fixture) => Promise<void>) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-knowledge-adapter-'));
  const workspaceResolver = WorkspaceResolver.fromProject(projectRoot);
  pathGuard.configure({ projectRoot, knowledgeBaseDir: 'Alembic' });
  const runtime = await openAlembicDatabase(
    { path: path.join(projectRoot, '.asd', 'alembic.db') },
    { workspaceResolver }
  );
  try {
    const repositories = createAlembicRepositories(runtime.connection);
    const fileWriter = new KnowledgeFileWriter(projectRoot);
    const audits: Record<string, unknown>[] = [];
    const service = new KnowledgeService(
      repositories.knowledgeRepository,
      {
        log: async (entry) => {
          audits.push(entry);
        },
      },
      null,
      null,
      { fileWriter }
    );
    const entry = new KnowledgeEntry({
      title: 'Knowledge adapter fixture',
      lifecycle: 'pending',
      category: 'guard',
      knowledgeType: 'boundary-constraint',
      tags: ['original-user-tag', 'system:owned', 'dimension:fixture'],
      createdBy: 'original-author',
      stagingDeadline: 1234,
      stats: { stagingReview: { outcome: 'fail', reviewer: 'reviewer', reviewedAt: 1000 } },
      content: { markdown: 'Original content' },
    });
    expect(fileWriter.persist(entry)).not.toBeNull();
    await repositories.knowledgeRepository.create(entry);
    const stagingManager = new StagingManager(repositories.knowledgeRepository, {
      fileStore: fileWriter,
    });
    const services: Record<string, unknown> = {
      knowledgeService: service,
      knowledgeRepository: repositories.knowledgeRepository,
      stagingManager,
    };
    const router = new ToolRouterAdapter({
      contextFactory: new ToolContextFactory({
        container: { get: (name) => services[name] },
        projectRoot,
      }),
    });
    await run({
      adapter: createKnowledgeServiceAdapter(service, 'trusted-reviewer'),
      audits,
      entry,
      projectRoot,
      router,
      runtime,
      service,
      stagingManager,
    });
  } finally {
    runtime.close();
    pathGuard._reset();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

function executeKnowledge(
  router: ToolRouterAdapter,
  action: 'detail' | 'manage',
  params: Record<string, unknown>,
  abortSignal?: AbortSignal
) {
  return router.execute({
    actor: { role: 'runtime', user: 'trusted-host-user' },
    args: { action, params },
    source: { kind: 'runtime', name: 'knowledge-adapter-test' },
    surface: 'runtime',
    toolId: 'knowledge',
    abortSignal,
  });
}

test('reads Core entities as wire records and maps only a missing knowledge entry to null', async () => {
  await withService(async ({ adapter, entry, service }) => {
    const result = await adapter.getById(entry.id);
    expect(result).toEqual((await service.get(entry.id)).toJSON());
    expect(result).not.toBeInstanceOf(KnowledgeEntry);
    expect(result).not.toHaveProperty('toJSON');
    expect(result).not.toHaveProperty('publish');
    expect(await adapter.getById('missing-entry')).toBeNull();
  });
});

test('updates through Core rules while preserving system tags, readonly state, and trusted audit identity', async () => {
  await withService(async ({ adapter, audits, entry, service }) => {
    const before = (await service.get(entry.id)).toJSON();
    const data = {
      title: 'Edited content title',
      tags: ['new-user-tag', 'system:forged'],
      stats: {},
      stagingDeadline: 0,
      createdBy: 'forged-author',
      userId: 'forged-user',
    };
    const originalInput = structuredClone(data);
    const result = await adapter.update(entry.id, data);
    expect(result).not.toBeInstanceOf(KnowledgeEntry);
    expect(result).not.toHaveProperty('toJSON');
    expect(result).toMatchObject({
      title: data.title,
      tags: ['new-user-tag', 'system:owned', 'dimension:fixture'],
    });
    expect((await service.get(entry.id)).toJSON()).toMatchObject({
      createdBy: before.createdBy,
      lifecycle: before.lifecycle,
      lifecycleHistory: before.lifecycleHistory,
      stagingDeadline: before.stagingDeadline,
      stats: before.stats,
    });
    expect(audits.at(-1)).toMatchObject({ actor: 'trusted-reviewer', action: 'update_knowledge' });
    expect(data).toEqual(originalInput);
  });
});

test('preserves Core retrieval-profile validation details without changing stored content', async () => {
  await withService(async ({ adapter, entry }) => {
    const before = await adapter.getById(entry.id);
    const error = await adapter
      .update(entry.id, {
        title: 'Must not persist',
        retrievalProfile: { schemaVersion: 'invalid' },
      })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: {
        reason: 'retrieval-profile-invalid',
        issues: expect.arrayContaining([
          expect.objectContaining({ field: 'retrievalProfile.schemaVersion' }),
        ]),
      },
    });
    expect(await adapter.getById(entry.id)).toEqual(before);
  });
});

test('preserves Core lifecycle-field rejection instead of bypassing it through the repository', async () => {
  await withService(async ({ adapter, entry }) => {
    const before = await adapter.getById(entry.id);
    const error = await adapter
      .update(entry.id, { lifecycle: 'active' })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { reason: 'lifecycle-transition-bypass', fields: ['lifecycle'] },
    });
    expect(await adapter.getById(entry.id)).toEqual(before);
  });
});

test('rejects through the Core transition and preserves its conflict details on a repeated rejection', async () => {
  await withService(async ({ adapter, audits, entry, service }) => {
    const result = await adapter.reject(entry.id, 'Manual review declined');
    expect(result).not.toBeInstanceOf(KnowledgeEntry);
    expect(result).not.toHaveProperty('toJSON');
    expect(result).toMatchObject({
      lifecycle: 'deprecated',
      rejectionReason: 'Manual review declined',
    });
    const stored = await service.get(entry.id);
    expect(stored.lifecycleHistory.at(-1)).toMatchObject({
      from: 'pending',
      to: 'deprecated',
      by: 'trusted-reviewer',
    });
    expect(audits.at(-1)).toMatchObject({
      actor: 'trusted-reviewer',
      action: 'deprecate_knowledge',
    });
    const error = await adapter.reject(entry.id, 'Repeat').catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ConflictError);
    expect(error).toMatchObject({
      code: 'CONFLICT',
      details: { detail: `Lifecycle deprecate failed for ${entry.id}` },
    });
    expect((await service.get(entry.id)).rejectionReason).toBe('Manual review declined');
    expect(adapter).not.toHaveProperty('score');
    expect(adapter).not.toHaveProperty('validate');
  });
});

test.each([
  'update',
  'reject',
] as const)('keeps a missing %s target as a Core error', async (method) => {
  await withService(async ({ adapter }) => {
    const operation =
      method === 'update'
        ? adapter.update('missing-entry', { title: 'Missing' })
        : adapter.reject('missing-entry', 'Review declined');
    const error = await operation.catch((err: unknown) => err);
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error).toMatchObject({
      code: 'NOT_FOUND',
      resource: 'knowledge',
      resourceId: 'missing-entry',
    });
  });
});

test('propagates a real database read failure instead of reporting a missing entry', async () => {
  await withService(async ({ adapter, entry, runtime }) => {
    // 故障只作用于本测试的一次性 SQLite；保留真实 Core get/repository 错误路径。
    runtime.connection.getDb().exec('DROP TABLE knowledge_entries');
    const error = await adapter.getById(entry.id).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(NotFoundError);
    expect(error).toMatchObject({ message: expect.stringContaining('no such table') });
  });
});

test('factory/router/Core preserves file-first divergence in the final tool envelope', async () => {
  await withService(async ({ entry, projectRoot, router, runtime, service }) => {
    // SQLite trigger 注入真实 DB 提交失败，不替换 KnowledgeService 或文件写入事实。
    runtime.connection.getDb().exec(`
      CREATE TRIGGER fail_knowledge_adapter_update BEFORE UPDATE ON knowledge_entries
      BEGIN SELECT RAISE(ABORT, 'adapter_database_fault'); END;
    `);
    const result = await executeKnowledge(router, 'manage', {
      operation: 'update',
      id: entry.id,
      data: { content: { markdown: 'File advanced before failed DB commit' } },
    });
    expect(result.ok).toBe(false);
    expect(result.structuredContent).toMatchObject({
      code: 'STATE_DIVERGENCE',
      writeState: 'partial',
      requiresReadback: true,
      details: {
        entryIds: [entry.id],
        fileOpsCompleted: 1,
        operation: 'knowledge.update',
        reconcileVia: 'KnowledgeSyncService.sync',
      },
    });
    expect(result.diagnostics.degraded).toBe(true);
    expect(result.diagnostics.warnings).toContainEqual(
      expect.objectContaining({ code: 'STATE_DIVERGENCE' })
    );
    expect((await service.get(entry.id)).content.markdown).toBe('Original content');
    if (typeof entry.sourceFile !== 'string') {
      throw new Error('Real file writer did not provide a source file');
    }
    expect(fs.readFileSync(path.resolve(projectRoot, entry.sourceFile), 'utf8')).toContain(
      'File advanced before failed DB commit'
    );
  });
});

test('factory/router/Core reads knowledge detail as a DTO and reports a genuine missing record', async () => {
  await withService(async ({ entry, router, service }) => {
    const result = await executeKnowledge(router, 'detail', { id: entry.id });
    expect(result.ok).toBe(true);
    expect(result.structuredContent).toEqual((await service.get(entry.id)).toJSON());
    expect(result.structuredContent).not.toHaveProperty('toJSON');
    const missing = await executeKnowledge(router, 'detail', { id: 'missing-entry' });
    expect(missing.ok).toBe(false);
    expect(missing.text).toContain('Recipe not found: missing-entry');
  });
});

test('factory/router/Core updates through service rules and retains profile-validation details', async () => {
  await withService(async ({ audits, entry, router, service }) => {
    const update = await executeKnowledge(router, 'manage', {
      operation: 'update',
      id: entry.id,
      data: { title: 'Host edited title', tags: ['host-user-tag', 'system:forged'] },
    });
    expect(update.ok).toBe(true);
    expect(update.structuredContent).toMatchObject({ operation: 'update', status: 'updated' });
    expect((await service.get(entry.id)).tags).toEqual([
      'host-user-tag',
      'system:owned',
      'dimension:fixture',
    ]);
    expect(audits.at(-1)).toMatchObject({ actor: 'trusted-host-user', action: 'update_knowledge' });
    const beforeInvalid = (await service.get(entry.id)).toJSON();
    const invalid = await executeKnowledge(router, 'manage', {
      operation: 'update',
      id: entry.id,
      data: { title: 'Must not persist', retrievalProfile: { schemaVersion: 'invalid' } },
    });
    expect(invalid.ok).toBe(false);
    expect(invalid.structuredContent).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: {
        reason: 'retrieval-profile-invalid',
        issues: expect.arrayContaining([
          expect.objectContaining({ field: 'retrievalProfile.schemaVersion' }),
        ]),
      },
    });
    expect((await service.get(entry.id)).toJSON()).toEqual(beforeInvalid);
  });
});

test('factory/router/Core rejection persists the transition with the trusted host actor', async () => {
  await withService(async ({ audits, entry, router, service }) => {
    const result = await executeKnowledge(router, 'manage', {
      operation: 'reject',
      id: entry.id,
      reason: 'Host reviewer declined',
    });
    expect(result.ok).toBe(true);
    expect(result.structuredContent).toMatchObject({ operation: 'reject', status: 'rejected' });
    const stored = await service.get(entry.id);
    expect(stored.lifecycle).toBe('deprecated');
    expect(stored.rejectionReason).toBe('Host reviewer declined');
    expect(stored.lifecycleHistory.at(-1)?.by).toBe('trusted-host-user');
    expect(audits.at(-1)).toMatchObject({
      actor: 'trusted-host-user',
      action: 'deprecate_knowledge',
    });
  });
});

test('factory/router/Core review records the real staging verdict', async () => {
  await withService(async ({ entry, router, service, stagingManager }) => {
    expect(await stagingManager.enterStaging(entry.id, 60_000, 0.9)).toBe(true);
    const result = await executeKnowledge(router, 'manage', {
      operation: 'review',
      id: entry.id,
      outcome: 'pass',
      reviewer: 'source-reviewer',
      reason: 'Verified against source',
    });
    expect(result.ok).toBe(true);
    expect(result.structuredContent).toMatchObject({
      id: entry.id,
      outcome: 'pass',
      recorded: true,
    });
    const stored = await service.get(entry.id);
    expect(stored.lifecycle).toBe('staging');
    expect(stored.stats.stagingReview).toMatchObject({
      outcome: 'pass',
      reviewer: 'source-reviewer',
      notes: 'Verified against source',
    });
  });
});

test('factory/router/Core refuses invalid-only updates, missing scoring, and pre-cancelled writes', async () => {
  await withService(async ({ audits, entry, router, runtime, service }) => {
    const db = runtime.connection.getDb();
    db.exec(`
      CREATE TEMP TABLE adapter_observed_updates (entry_id TEXT);
      CREATE TEMP TRIGGER observe_adapter_updates AFTER UPDATE ON knowledge_entries
      BEGIN INSERT INTO adapter_observed_updates VALUES (NEW.id); END;
    `);
    const before = (await service.get(entry.id)).toJSON();
    const invalid = await executeKnowledge(router, 'manage', {
      operation: 'update',
      id: entry.id,
      data: { stats: {} },
    });
    expect(invalid.ok).toBe(false);
    expect(invalid.text).toContain('not editable');
    const score = await executeKnowledge(router, 'manage', {
      operation: 'score',
      id: entry.id,
      data: { score: 0.8 },
    });
    expect(score.ok).toBe(false);
    expect(score.structuredContent).toMatchObject({
      code: 'KNOWLEDGE_MANAGEMENT_PORT_UNAVAILABLE',
      port: 'knowledgeManagement',
      method: 'score',
    });
    const controller = new AbortController();
    controller.abort();
    const cancelled = await executeKnowledge(
      router,
      'manage',
      { operation: 'update', id: entry.id, data: { title: 'Must not persist' } },
      controller.signal
    );
    expect(cancelled).toMatchObject({ ok: false, status: 'aborted' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM adapter_observed_updates').get()).toEqual({
      count: 0,
    });
    expect(audits).toEqual([]);
    expect((await service.get(entry.id)).toJSON()).toEqual(before);
  });
});
