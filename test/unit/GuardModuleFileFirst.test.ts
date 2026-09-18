import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openAlembicDatabase } from '@alembic/core/database';
import { pathGuard } from '@alembic/core/io';
import { KnowledgeSyncService } from '@alembic/core/knowledge';
import { WorkspaceResolver } from '@alembic/core/workspace';
import { expect, it } from 'vitest';
import * as GuardModule from '../../lib/injection/modules/GuardModule.js';
import * as InfraModule from '../../lib/injection/modules/InfraModule.js';
import { ServiceContainer } from '../../lib/injection/ServiceContainer.js';

it('registered Guard and Infra factories persist rule create/disable/enable through sync', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-guard-wiring-'));
  const workspaceResolver = WorkspaceResolver.fromProject(projectRoot);
  pathGuard.configure({ projectRoot, knowledgeBaseDir: 'Alembic' });
  const runtime = await openAlembicDatabase(
    { path: path.join(projectRoot, '.asd', 'alembic.db') },
    { workspaceResolver }
  );
  try {
    const container = new ServiceContainer();
    container.singletons._projectRoot = projectRoot;
    container.singletons._workspaceResolver = workspaceResolver;
    container.singletons.database = runtime.connection;
    InfraModule.register(container);
    GuardModule.register(container);
    // 真实注册同时解析 repository、writer、Guard 引擎和审计记录器，覆盖惰性 DI 链。
    const service = container.get('guardService');
    const repo = container.get('knowledgeRepository');
    const sync = new KnowledgeSyncService(projectRoot);
    const context = { userId: 'reviewer' };
    await service.checkCode('BAD', { language: 'typescript' });
    const created = await service.createRule(
      {
        name: 'Factory Guard rule',
        description: 'Do not use BAD.',
        pattern: 'BAD',
        languages: ['typescript'],
      },
      context
    );
    await sync.syncAll(runtime.sqlite);
    expect((await repo.findById(created.id))?.lifecycle).toBe('active');
    const sourceFile = (await repo.findById(created.id))?.sourceFile;
    expect(sourceFile).toEqual(expect.any(String));
    expect(sourceFile).not.toBe('');
    if (!sourceFile) {
      throw new Error('Registered Guard creation did not persist a source file');
    }
    expect(fs.existsSync(path.resolve(projectRoot, sourceFile))).toBe(true);
    expect(
      (await service.checkCode('BAD', { language: 'typescript' })).some(
        (v) => v.ruleId === created.id
      )
    ).toBe(true);
    await service.disableRule(created.id, 'Factory review', context);
    await sync.syncAll(runtime.sqlite);
    expect((await repo.findById(created.id))?.lifecycle).toBe('deprecated');
    expect(
      (await service.checkCode('BAD', { language: 'typescript' })).some(
        (v) => v.ruleId === created.id
      )
    ).toBe(false);
    await service.enableRule(created.id, context);
    await sync.syncAll(runtime.sqlite);
    expect((await repo.findById(created.id))?.lifecycle).toBe('active');
    expect(
      (await service.checkCode('BAD', { language: 'typescript' })).some(
        (v) => v.ruleId === created.id
      )
    ).toBe(true);
  } finally {
    runtime.close();
    pathGuard._reset();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});
