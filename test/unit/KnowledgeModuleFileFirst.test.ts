import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openAlembicDatabase } from '@alembic/core/database';
import { EventBus, SignalBus } from '@alembic/core/events';
import { pathGuard } from '@alembic/core/io';
import { KnowledgeEntry, KnowledgeFileWriter, KnowledgeSyncService } from '@alembic/core/knowledge';
import { createAlembicRepositories } from '@alembic/core/repositories';
import { QualityScorer } from '@alembic/core/service/quality';
import { WorkspaceResolver } from '@alembic/core/workspace';
import { expect, it, vi } from 'vitest';
import * as KnowledgeModule from '../../lib/injection/modules/KnowledgeModule.js';
import { ServiceContainer } from '../../lib/injection/ServiceContainer.js';

it('registered evolution factories preserve promotion and patch truth through file sync', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-evolution-wiring-'));
  const workspaceResolver = WorkspaceResolver.fromProject(projectRoot);
  pathGuard.configure({ projectRoot, knowledgeBaseDir: 'Alembic' });
  const runtime = await openAlembicDatabase(
    { path: path.join(projectRoot, '.asd', 'alembic.db') },
    { workspaceResolver }
  );
  try {
    const repositories = createAlembicRepositories(runtime.connection);
    const fileStore = new KnowledgeFileWriter(projectRoot);
    const signalBus = new SignalBus();
    const container = new ServiceContainer();
    container.singletons._projectRoot = projectRoot;
    container.singletons._workspaceResolver = workspaceResolver;
    container.singletons.signalBus = signalBus;
    KnowledgeModule.register(container);
    for (const [name, instance] of Object.entries({
      ...repositories,
      knowledgeFileWriter: fileStore,
      signalBus,
    })) {
      container.register(name, () => instance);
    }

    // 经真实注册入口装配知识用例；只替换宿主通知端口，文件和 SQLite 使用真实实现。
    const hook = vi.fn(async (): Promise<unknown> => undefined);
    const changed: unknown[] = [];
    const eventBus = new EventBus();
    eventBus.on('knowledge:changed', (event) => changed.push(event));
    container.register('auditLogger', () => ({ log: async () => {} }));
    container.register('gateway', () => null);
    container.register('qualityScorer', () => new QualityScorer());
    container.register('skillHooks', () => ({ run: hook }));
    container.register('eventBus', () => eventBus);
    const knowledge = container.get('knowledgeService');
    const created = await knowledge.create(
      {
        title: 'Registered knowledge service',
        content: { markdown: 'Original registered body' },
      },
      { userId: 'wiring-test' }
    );
    const updated = await knowledge.update(
      created.id,
      {
        content: { markdown: 'Updated through declared ports' },
      },
      { userId: 'wiring-test' }
    );
    expect(updated?.content.markdown).toBe('Updated through declared ports');
    const sync = new KnowledgeSyncService(projectRoot);
    await sync.syncAll(runtime.connection.getDb());
    expect((await repositories.knowledgeRepository.findById(created.id))?.content.markdown).toBe(
      'Updated through declared ports'
    );
    expect(hook.mock.calls.map(([name]) => name)).toEqual([
      'onKnowledgeSubmit',
      'onKnowledgeCreated',
    ]);
    expect(changed).toEqual([
      expect.objectContaining({ action: 'create', entryId: created.id }),
      expect.objectContaining({ action: 'update', entryId: created.id }),
    ]);

    // 使用 Guard 的正式 active 准入分支，不替换检索就绪判定或持久化实现。
    const entry = new KnowledgeEntry({
      title: 'Factory persistence contract',
      lifecycle: 'pending',
      category: 'guard',
      knowledgeType: 'boundary-constraint',
      autoApprovable: true,
      content: { markdown: 'Original content' },
    });
    expect(fileStore.persist(entry)).not.toBeNull();
    await repositories.knowledgeRepository.create(entry);
    const staging = container.get('stagingManager');
    await staging.enterStaging(entry.id, -1000, 0.9);
    await sync.syncAll(runtime.connection.getDb());
    expect((await repositories.knowledgeRepository.findById(entry.id))?.lifecycle).toBe('staging');
    expect((await staging.checkAndPromote()).promoted).toHaveLength(1);
    await sync.syncAll(runtime.connection.getDb());
    expect(await repositories.knowledgeRepository.findById(entry.id)).toMatchObject({
      lifecycle: 'active',
      publishedBy: 'StagingManager',
      stagingDeadline: null,
    });

    const result = await container.get('contentPatcher').applyProposal({
      id: 'factory-patch',
      type: 'update',
      targetRecipeId: entry.id,
      evidence: [
        {
          suggestedChanges: JSON.stringify({
            patchVersion: 1,
            changes: [
              { field: 'content.markdown', action: 'replace', newValue: 'Durable factory patch' },
            ],
          }),
        },
      ],
    });
    expect(result.success).toBe(true);
    await sync.syncAll(runtime.connection.getDb());
    expect((await repositories.knowledgeRepository.findById(entry.id))?.content.markdown).toBe(
      'Durable factory patch'
    );
  } finally {
    runtime.close();
    pathGuard._reset();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});
