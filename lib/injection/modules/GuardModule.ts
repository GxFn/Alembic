/**
 * GuardModule — Guard 服务注册
 *
 * 负责注册:
 *   - guardService, guardCheckEngine
 *   - exclusionManager, ruleLearner, violationsStore
 *   - complianceReporter, guardFeedbackLoop
 *
 * @param {import('../ServiceContainer.js').ServiceContainer} c
 */

import { ComplianceReporter } from '../../service/guard/ComplianceReporter.js';
import { ExclusionManager } from '../../service/guard/ExclusionManager.js';
import { GuardCheckEngine } from '../../service/guard/GuardCheckEngine.js';
import { GuardFeedbackLoop } from '../../service/guard/GuardFeedbackLoop.js';
import { GuardService } from '../../service/guard/GuardService.js';
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
      ct.get('knowledgeRepository') as ConstructorParameters<typeof GuardService>[0],
      ct.get('auditLogger') as ConstructorParameters<typeof GuardService>[1],
      ct.get('gateway') as ConstructorParameters<typeof GuardService>[2],
      {
        guardCheckEngine,
      } as ConstructorParameters<typeof GuardService>[3]
    );
  });

  c.singleton('guardCheckEngine', (ct: ServiceContainer) => {
    const config = (ct.singletons._config as Record<string, unknown> | undefined) || {};
    return new GuardCheckEngine(
      ct.get('database') as ConstructorParameters<typeof GuardCheckEngine>[0],
      { guardConfig: (config.guard as Record<string, unknown>) || {} }
    );
  });

  c.singleton('exclusionManager', (ct: ServiceContainer) => {
    const projectRoot = (ct.singletons._projectRoot as string | undefined) || process.cwd();
    return new ExclusionManager(projectRoot);
  });

  c.singleton('ruleLearner', (ct: ServiceContainer) => {
    const projectRoot = (ct.singletons._projectRoot as string | undefined) || process.cwd();
    return new RuleLearner(projectRoot);
  });

  c.singleton(
    'violationsStore',
    (ct: ServiceContainer) =>
      new ViolationsStore(
        (ct.get('database') as { getDb: () => unknown }).getDb() as ConstructorParameters<
          typeof ViolationsStore
        >[0]
      )
  );

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
        } as ConstructorParameters<typeof GuardFeedbackLoop>[2]
      )
  );
}
