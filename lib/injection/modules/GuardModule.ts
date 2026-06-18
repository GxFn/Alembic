/**
 * GuardModule — Guard 服务注册
 *
 * 负责注册:
 *   - guardService, guardCheckEngine
 *   - exclusionManager, ruleLearner, violationsStore
 *   - guardFeedbackLoop
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  ExclusionManager,
  GuardCheckEngine,
  GuardFeedbackLoop,
  GuardService,
  RuleLearner,
  ViolationsStore,
} from '@alembic/core/guard';
import type { KnowledgeRepository } from '@alembic/core/repositories';
import { unwrapRawDb } from '@alembic/core/search';
import { resolveDataRoot } from '@alembic/core/workspace';
import type { ServiceContainer } from '../ServiceContainer.js';

export function register(c: ServiceContainer) {
  c.singleton('guardService', (ct: ServiceContainer) => {
    let guardCheckEngine: unknown = null;
    try {
      guardCheckEngine = ct.get('guardCheckEngine');
    } catch {
      /* not yet available */
    }
    return new GuardService(
      ct.get('knowledgeRepository') as unknown as ConstructorParameters<typeof GuardService>[0],
      ct.get('auditLogger') as ConstructorParameters<typeof GuardService>[1],
      ct.get('gateway') as ConstructorParameters<typeof GuardService>[2],
      {
        guardCheckEngine,
      } as ConstructorParameters<typeof GuardService>[3]
    );
  });

  c.singleton('guardCheckEngine', (ct: ServiceContainer) => {
    const config = (ct.singletons._config as Record<string, unknown> | undefined) || {};
    // 基础配置（Alembic 自身 config/default.json）
    const baseGuard = (config.guard as Record<string, unknown>) || {};
    // 项目级覆盖（.asd/config.json 的 guard 段）
    let projectGuard: Record<string, unknown> = {};
    try {
      const dataRoot = resolveDataRoot(ct);
      const projConfigPath = path.join(dataRoot, '.asd', 'config.json');
      if (fs.existsSync(projConfigPath)) {
        const raw = JSON.parse(fs.readFileSync(projConfigPath, 'utf-8'));
        if (raw.guard && typeof raw.guard === 'object') {
          projectGuard = raw.guard as Record<string, unknown>;
        }
      }
    } catch {
      /* 项目配置读取失败不阻塞 */
    }
    // 合并：项目级覆盖基础配置
    const merged = { ...baseGuard, ...projectGuard };
    if (baseGuard.codeLevelThresholds || projectGuard.codeLevelThresholds) {
      merged.codeLevelThresholds = {
        ...((baseGuard.codeLevelThresholds as Record<string, unknown>) || {}),
        ...((projectGuard.codeLevelThresholds as Record<string, unknown>) || {}),
      };
    }
    if (baseGuard.disabledRules || projectGuard.disabledRules) {
      const base = Array.isArray(baseGuard.disabledRules) ? baseGuard.disabledRules : [];
      const proj = Array.isArray(projectGuard.disabledRules) ? projectGuard.disabledRules : [];
      merged.disabledRules = [...new Set([...base, ...proj])];
    }
    return new GuardCheckEngine(
      ct.get('database') as ConstructorParameters<typeof GuardCheckEngine>[0],
      {
        guardConfig: merged,
        signalBus: ct.singletons.signalBus || undefined,
        knowledgeRepo: ct.get('knowledgeRepository') as KnowledgeRepository,
      } as ConstructorParameters<typeof GuardCheckEngine>[1]
    );
  });

  c.singleton('exclusionManager', (ct: ServiceContainer) => {
    const dataRoot = resolveDataRoot(ct);
    const wz = ct.singletons.writeZone as import('@alembic/core/io').WriteZone | undefined;
    return new ExclusionManager(dataRoot, { wz });
  });

  c.singleton('ruleLearner', (ct: ServiceContainer) => {
    const dataRoot = resolveDataRoot(ct);
    const wz = ct.singletons.writeZone as import('@alembic/core/io').WriteZone | undefined;
    return new RuleLearner(dataRoot, {
      signalBus: ct.singletons.signalBus || undefined,
      wz,
    } as ConstructorParameters<typeof RuleLearner>[1]);
  });

  c.singleton('violationsStore', (ct: ServiceContainer) => {
    const db = ct.get('database') as { getDrizzle: () => unknown };
    return new ViolationsStore(
      unwrapRawDb(db as unknown) as ConstructorParameters<typeof ViolationsStore>[0],
      db.getDrizzle() as ConstructorParameters<typeof ViolationsStore>[1]
    );
  });

  c.singleton(
    'guardFeedbackLoop',
    (ct: ServiceContainer) =>
      new GuardFeedbackLoop(
        ct.get('violationsStore') as ConstructorParameters<typeof GuardFeedbackLoop>[0],
        ct.get('feedbackCollector') as ConstructorParameters<typeof GuardFeedbackLoop>[1],
        {
          guardCheckEngine: ct.get('guardCheckEngine'),
          signalBus: ct.singletons.signalBus || undefined,
        } as ConstructorParameters<typeof GuardFeedbackLoop>[2]
      )
  );
}
