import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openAlembicDatabase } from '@alembic/core/database';
import { SignalBus } from '@alembic/core/events';
import { pathGuard } from '@alembic/core/io';
import { KnowledgeEntry, KnowledgeFileWriter, KnowledgeSyncService } from '@alembic/core/knowledge';
import { createAlembicRepositories } from '@alembic/core/repositories';
import { WorkspaceResolver } from '@alembic/core/workspace';
import { expect, it } from 'vitest';
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
    const sync = new KnowledgeSyncService(projectRoot);
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
