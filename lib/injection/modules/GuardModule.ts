/**
 * GuardModule — Guard 服务注册
 *
 * 负责注册:
 *   - guardService, guardCheckEngine
 *   - exclusionManager, ruleLearner, violationsStore
 *   - complianceReporter, guardFeedbackLoop
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveDataRoot, resolveProjectRoot } from '#shared/resolveProjectRoot.js';
import type { SignalBus } from '../../infrastructure/signal/SignalBus.js';
import type { CodeEntityRepositoryImpl } from '../../repository/code/CodeEntityRepository.js';
import type { GuardViolationRepositoryImpl } from '../../repository/guard/GuardViolationRepository.js';
import type { KnowledgeRepositoryImpl } from '../../repository/knowledge/KnowledgeRepository.impl.js';
import { unwrapRawDb } from '../../repository/search/SearchRepoAdapter.js';
import type { RecipeSourceRefRepositoryImpl } from '../../repository/sourceref/RecipeSourceRefRepository.js';
import { ComplianceReporter } from '../../service/guard/ComplianceReporter.js';
import { CoverageAnalyzer } from '../../service/guard/CoverageAnalyzer.js';
import { ExclusionManager } from '../../service/guard/ExclusionManager.js';
import { GuardCheckEngine } from '../../service/guard/GuardCheckEngine.js';
import { GuardFeedbackLoop } from '../../service/guard/GuardFeedbackLoop.js';
import { GuardService } from '../../service/guard/GuardService.js';
import { ReverseGuard } from '../../service/guard/ReverseGuard.js';
import { RuleLearner } from '../../service/guard/RuleLearner.js';
import { ViolationsStore } from '../../service/guard/ViolationsStore.js';
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
        signalBus: (ct.singletons.signalBus as SignalBus | undefined) || undefined,
        knowledgeRepo: ct.get('knowledgeRepository') as KnowledgeRepositoryImpl,
      }
    );
  });

  c.singleton('exclusionManager', (ct: ServiceContainer) => {
    const dataRoot = resolveDataRoot(ct);
    return new ExclusionManager(dataRoot);
  });

  c.singleton('ruleLearner', (ct: ServiceContainer) => {
    const dataRoot = resolveDataRoot(ct);
    return new RuleLearner(dataRoot, {
      signalBus: (ct.singletons.signalBus as SignalBus | undefined) || undefined,
    });
  });

  c.singleton('violationsStore', (ct: ServiceContainer) => {
    const db = ct.get('database') as { getDrizzle: () => unknown };
    return new ViolationsStore(
      unwrapRawDb(db as unknown) as ConstructorParameters<typeof ViolationsStore>[0],
      db.getDrizzle() as ConstructorParameters<typeof ViolationsStore>[1]
    );
  });

  c.singleton('complianceReporter', (ct: ServiceContainer) => {
    const config = (ct.singletons._config as Record<string, unknown> | undefined) || {};
    return new ComplianceReporter(
      ct.get('guardCheckEngine') as ConstructorParameters<typeof ComplianceReporter>[0],
      ct.get('violationsStore') as ConstructorParameters<typeof ComplianceReporter>[1],
      ct.get('ruleLearner') as ConstructorParameters<typeof ComplianceReporter>[2],
      ct.get('exclusionManager') as ConstructorParameters<typeof ComplianceReporter>[3],
      (config.qualityGate as Record<string, unknown>) || {}
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
          signalBus: (ct.singletons.signalBus as SignalBus | undefined) || undefined,
        } as ConstructorParameters<typeof GuardFeedbackLoop>[2]
      )
  );

  c.singleton('reverseGuard', (ct: ServiceContainer) => {
    return new ReverseGuard(
      ct.get('knowledgeRepository') as KnowledgeRepositoryImpl,
      ct.get('codeEntityRepository') as CodeEntityRepositoryImpl,
      ct.get('recipeSourceRefRepository') as RecipeSourceRefRepositoryImpl,
      {
        signalBus: (ct.singletons.signalBus as SignalBus | undefined) || undefined,
      }
    );
  });

  c.singleton('coverageAnalyzer', (ct: ServiceContainer) => {
    let ruleLearner:
      | {
          ruleLearner?: ConstructorParameters<typeof CoverageAnalyzer>[2] extends {
            ruleLearner?: infer R;
          }
            ? R
            : never;
        }
      | undefined;
    try {
      ruleLearner = { ruleLearner: ct.get('ruleLearner') as never };
    } catch {
      /* ruleLearner not yet available */
    }
    return new CoverageAnalyzer(
      ct.get('knowledgeRepository') as KnowledgeRepositoryImpl,
      ct.get('guardViolationRepository') as GuardViolationRepositoryImpl,
      ruleLearner as ConstructorParameters<typeof CoverageAnalyzer>[2]
    );
  });
}
