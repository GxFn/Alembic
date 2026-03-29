/**
 * AppModule — 应用层杂项服务注册
 *
 * 负责注册:
 *   - recipeParser, recipeCandidateValidator
 *   - qualityScorer, feedbackCollector, tokenUsageStore, recipeExtractor
 *   - moduleService, cursorDeliveryPipeline
 *   - primeSearchPipeline (for prime multi-query search — no DB dependency)
 */

import { resolveProjectRoot } from '#shared/resolveProjectRoot.js';
import { TokenUsageStore } from '../../repository/token/TokenUsageStore.js';
import { CursorDeliveryPipeline } from '../../service/delivery/CursorDeliveryPipeline.js';
import { RecipeExtractor } from '../../service/knowledge/RecipeExtractor.js';
import { ModuleService } from '../../service/module/ModuleService.js';
import { FeedbackCollector } from '../../service/quality/FeedbackCollector.js';
import { QualityScorer } from '../../service/quality/QualityScorer.js';
import { RecipeCandidateValidator } from '../../service/recipe/RecipeCandidateValidator.js';
import { RecipeParser } from '../../service/recipe/RecipeParser.js';
import { PrimeSearchPipeline } from '../../service/task/PrimeSearchPipeline.js';

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

  // ═══ Module ═══

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

  // ═══ PrimeSearchPipeline (for prime multi-query search) ═══

  c.singleton(
    'primeSearchPipeline',
    (ct: ServiceContainer) =>
      new PrimeSearchPipeline(
        ct.get('searchEngine') as unknown as ConstructorParameters<typeof PrimeSearchPipeline>[0]
      )
  );
}

/** 初始化 RecipeExtractor 实例 (在 initialize 期间调用) */
export function initRecipeExtractor(c: ServiceContainer) {
  c.singletons._recipeExtractor = new RecipeExtractor();
}
