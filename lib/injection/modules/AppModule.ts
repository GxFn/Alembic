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

import { resolveProjectRoot } from '#shared/resolveProjectRoot.js';
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

import type { ServiceContainer } from '../ServiceContainer.js';

export function register(c: ServiceContainer) {
  // ═══ Quality + Recipe ═══

  c.singleton('qualityScorer', () => new QualityScorer());
  c.singleton('recipeParser', () => new RecipeParser());
  c.singleton('recipeCandidateValidator', () => new RecipeCandidateValidator());
  c.register('recipeExtractor', () => c.singletons._recipeExtractor || null);

  c.singleton('feedbackCollector', (ct: ServiceContainer) => {
    const projectRoot = resolveProjectRoot(ct);
    return new FeedbackCollector(projectRoot as ConstructorParameters<typeof FeedbackCollector>[0]);
  });

  c.singleton('tokenUsageStore', (ct: ServiceContainer) => {
    const db = ct.get('database') as { getDb: () => unknown; getDrizzle: () => unknown };
    return new TokenUsageStore(
      db.getDb() as ConstructorParameters<typeof TokenUsageStore>[0],
      db.getDrizzle() as ConstructorParameters<typeof TokenUsageStore>[1]
    );
  });

  // ═══ Snippet ═══

  c.singleton('snippetFactory', (ct: ServiceContainer) => {
    const factory = new SnippetFactory(
      ct.get('knowledgeRepository') as unknown as ConstructorParameters<typeof SnippetFactory>[0]
    );
    factory.registerCodec(new XcodeCodec());
    factory.registerCodec(new VSCodeCodec());
    return factory;
  });

  c.singleton('snippetInstaller', (ct: ServiceContainer) => {
    const factory = ct.get('snippetFactory') as SnippetFactory;
    return new SnippetInstaller({ codec: factory.getCodec('xcode'), snippetFactory: factory });
  });

  c.singleton('vscodeSnippetInstaller', (ct: ServiceContainer) => {
    const factory = ct.get('snippetFactory') as SnippetFactory;
    return new SnippetInstaller({ codec: factory.getCodec('vscode'), snippetFactory: factory });
  });

  // ═══ Platform + Automation ═══

  c.singleton('spmService', (ct: ServiceContainer) => {
    const projectRoot = resolveProjectRoot(ct);
    return new SpmHelper(projectRoot);
  });

  c.singleton('automationOrchestrator', () => new AutomationOrchestrator());

  c.singleton('moduleService', (ct: ServiceContainer) => {
    const projectRoot = resolveProjectRoot(ct);
    return new ModuleService(
      projectRoot as ConstructorParameters<typeof ModuleService>[0],
      {
        agentFactory: ct.get('agentFactory'),
        container: ct,
        qualityScorer: ct.get('qualityScorer'),
        recipeExtractor: ct.singletons._recipeExtractor || null,
        guardCheckEngine: ct.get('guardCheckEngine'),
        violationsStore: ct.get('violationsStore'),
      } as unknown as ConstructorParameters<typeof ModuleService>[1]
    );
  });

  c.singleton(
    'cursorDeliveryPipeline',
    (ct: ServiceContainer) =>
      new CursorDeliveryPipeline({
        knowledgeService: ct.get('knowledgeService'),
        projectRoot: resolveProjectRoot(ct),
        database: ct.get('database'),
        logger: ct.logger,
      } as unknown as ConstructorParameters<typeof CursorDeliveryPipeline>[0])
  );

  // ═══ TaskGraph ═══

  c.singleton('taskIdGenerator', (ct: ServiceContainer) => {
    const db = ct.get('database') as { getDb: () => unknown; getDrizzle: () => unknown };
    return new TaskIdGenerator(
      db.getDb() as ConstructorParameters<typeof TaskIdGenerator>[0],
      db.getDrizzle() as ConstructorParameters<typeof TaskIdGenerator>[1]
    );
  });
  c.singleton(
    'taskReadyEngine',
    (ct: ServiceContainer) =>
      new TaskReadyEngine(
        (ct.get('database') as { getDb: () => unknown }).getDb() as ConstructorParameters<
          typeof TaskReadyEngine
        >[0]
      )
  );
  c.singleton(
    'taskKnowledgeBridge',
    (ct: ServiceContainer) =>
      new TaskKnowledgeBridge(
        ct.get('searchEngine') as unknown as ConstructorParameters<typeof TaskKnowledgeBridge>[0]
      )
  );
  c.singleton(
    'taskGraphService',
    (ct: ServiceContainer) =>
      new TaskGraphService(
        ct.get('taskRepository') as ConstructorParameters<typeof TaskGraphService>[0],
        ct.get('taskReadyEngine') as ConstructorParameters<typeof TaskGraphService>[1],
        ct.get('taskKnowledgeBridge') as ConstructorParameters<typeof TaskGraphService>[2],
        ct.get('auditLogger') as unknown as ConstructorParameters<typeof TaskGraphService>[3],
        ct.get('taskIdGenerator') as ConstructorParameters<typeof TaskGraphService>[4]
      )
  );
}

/**
 * 初始化 RecipeExtractor 实例 (在 initialize 期间调用)
 * @param {import('../ServiceContainer.js').ServiceContainer} c
 */
export function initRecipeExtractor(c: ServiceContainer) {
  c.singletons._recipeExtractor = new RecipeExtractor();
}
