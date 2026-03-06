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

export function register(c) {
  c.singleton('guardService', (ct) => {
    let guardCheckEngine = null;
    try {
      guardCheckEngine = ct.get('guardCheckEngine');
    } catch {
      /* not yet available */
    }
    return new GuardService(
      ct.get('knowledgeRepository'),
      ct.get('auditLogger'),
      ct.get('gateway'),
      {
        guardCheckEngine,
      }
    );
  });

  c.singleton('guardCheckEngine', (ct) => {
    const config = ct.singletons._config || {};
    return new GuardCheckEngine(ct.get('database'), { guardConfig: config.guard || {} });
  });

  c.singleton('exclusionManager', (ct) => {
    const projectRoot = ct.singletons._projectRoot || process.cwd();
    return new ExclusionManager(projectRoot);
  });

  c.singleton('ruleLearner', (ct) => {
    const projectRoot = ct.singletons._projectRoot || process.cwd();
    return new RuleLearner(projectRoot);
  });

  c.singleton('violationsStore', (ct) => new ViolationsStore(ct.get('database').getDb()));

  c.singleton('complianceReporter', (ct) => {
    const config = ct.singletons._config || {};
    return new ComplianceReporter(
      ct.get('guardCheckEngine'),
      ct.get('violationsStore'),
      ct.get('ruleLearner'),
      ct.get('exclusionManager'),
      config.qualityGate || {}
    );
  });

  c.singleton(
    'guardFeedbackLoop',
    (ct) =>
      new GuardFeedbackLoop(ct.get('violationsStore'), ct.get('feedbackCollector'), {
        guardCheckEngine: ct.get('guardCheckEngine'),
      })
  );
}
