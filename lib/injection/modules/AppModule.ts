/**
 * AppModule — 应用层杂项服务注册
 *
 * 负责注册:
 *   - recipeParser, recipeCandidateValidator, snippetFactory, snippetInstaller
 *   - qualityScorer, feedbackCollector, tokenUsageStore, recipeExtractor
 *   - spmService, automationOrchestrator, moduleService
 *   - cursorDeliveryPipeline
 *   - taskIdGenerator, taskReadyEngine, taskKnowledgeBridge, taskGraphService
 *
 * @param {import('../ServiceContainer.js').ServiceContainer} c
 */

import { TaskIdGenerator } from '../../domain/task/TaskIdGenerator.js';
import { XcodeCodec } from '../../platform/ios/snippet/XcodeCodec.js';
import { SpmHelper } from '../../platform/ios/spm/SpmHelper.js';
import { TokenUsageStore } from '../../repository/token/TokenUsageStore.js';
import { AutomationOrchestrator } from '../../service/automation/AutomationOrchestrator.js';
import { RecipeExtractor } from '../../service/context/RecipeExtractor.js';
import { CursorDeliveryPipeline } from '../../service/cursor/CursorDeliveryPipeline.js';
import { ModuleService } from '../../service/module/ModuleService.js';
import { FeedbackCollector } from '../../service/quality/FeedbackCollector.js';
import { QualityScorer } from '../../service/quality/QualityScorer.js';
import { RecipeCandidateValidator } from '../../service/recipe/RecipeCandidateValidator.js';
import { RecipeParser } from '../../service/recipe/RecipeParser.js';
import { VSCodeCodec } from '../../service/snippet/codecs/VSCodeCodec.js';
import { SnippetFactory } from '../../service/snippet/SnippetFactory.js';
import { SnippetInstaller } from '../../service/snippet/SnippetInstaller.js';
import { TaskGraphService } from '../../service/task/TaskGraphService.js';
import { TaskKnowledgeBridge } from '../../service/task/TaskKnowledgeBridge.js';
import { TaskReadyEngine } from '../../service/task/TaskReadyEngine.js';

export function register(c) {
  // ═══ Quality + Recipe ═══

  c.singleton('qualityScorer', () => new QualityScorer());
  c.singleton('recipeParser', () => new RecipeParser());
  c.singleton('recipeCandidateValidator', () => new RecipeCandidateValidator());
  c.register('recipeExtractor', () => c.singletons._recipeExtractor || null);

  c.singleton('feedbackCollector', (ct) => {
    const projectRoot = ct.singletons._projectRoot || process.cwd();
    return new FeedbackCollector(projectRoot);
  });

  c.singleton('tokenUsageStore', (ct) => new TokenUsageStore(ct.get('database').getDb()));

  // ═══ Snippet ═══

  c.singleton('snippetFactory', (ct) => {
    const factory = new SnippetFactory(ct.get('knowledgeRepository'));
    factory.registerCodec(new XcodeCodec());
    factory.registerCodec(new VSCodeCodec());
    return factory;
  });

  c.singleton('snippetInstaller', (ct) => {
    const factory = ct.get('snippetFactory');
    return new SnippetInstaller({ codec: factory.getCodec('xcode'), snippetFactory: factory });
  });

  c.singleton('vscodeSnippetInstaller', (ct) => {
    const factory = ct.get('snippetFactory');
    return new SnippetInstaller({ codec: factory.getCodec('vscode'), snippetFactory: factory });
  });

  // ═══ Platform + Automation ═══

  c.singleton('spmService', (ct) => {
    const projectRoot = ct.singletons._projectRoot || process.cwd();
    return new SpmHelper(projectRoot);
  });

  c.singleton('automationOrchestrator', () => new AutomationOrchestrator());

  c.singleton('moduleService', (ct) => {
    const projectRoot = ct.singletons._projectRoot || process.cwd();
    return new ModuleService(projectRoot, {
      agentFactory: ct.get('agentFactory'),
      container: ct,
      qualityScorer: ct.get('qualityScorer'),
      recipeExtractor: ct.singletons._recipeExtractor || null,
      guardCheckEngine: ct.get('guardCheckEngine'),
      violationsStore: ct.get('violationsStore'),
    });
  });

  c.singleton(
    'cursorDeliveryPipeline',
    (ct) =>
      new CursorDeliveryPipeline({
        knowledgeService: ct.get('knowledgeService'),
        projectRoot: ct.singletons._projectRoot || process.cwd(),
        database: ct.get('database'),
        logger: ct.logger,
      } as any)
  );

  // ═══ TaskGraph ═══

  c.singleton('taskIdGenerator', (ct) => new TaskIdGenerator(ct.get('database').getDb()));
  c.singleton('taskReadyEngine', (ct) => new TaskReadyEngine(ct.get('database').getDb()));
  c.singleton('taskKnowledgeBridge', (ct) => new TaskKnowledgeBridge(ct.get('searchEngine')));
  c.singleton(
    'taskGraphService',
    (ct) =>
      new TaskGraphService(
        ct.get('taskRepository'),
        ct.get('taskReadyEngine'),
        ct.get('taskKnowledgeBridge'),
        ct.get('auditLogger'),
        ct.get('taskIdGenerator')
      )
  );
}

/**
 * 初始化 RecipeExtractor 实例 (在 initialize 期间调用)
 * @param {import('../ServiceContainer.js').ServiceContainer} c
 */
export function initRecipeExtractor(c) {
  c.singletons._recipeExtractor = new RecipeExtractor();
}
