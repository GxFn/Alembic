/**
 * AppModule — 应用层杂项服务注册
 *
 * 负责注册:
 *   - recipeParser, recipeCandidateValidator
 *   - qualityScorer, feedbackCollector, tokenUsageStore, recipeExtractor
 *   - moduleService
 *   - primeSearchPipeline (for prime multi-query search — no DB dependency)
 */

import { RecipeExtractor } from '@alembic/core/knowledge';
import { TokenUsageStore } from '@alembic/core/repositories';
import { unwrapRawDb } from '@alembic/core/search';
import { FeedbackCollector, QualityScorer } from '@alembic/core/service/quality';
import { RecipeCandidateValidator, RecipeParser } from '@alembic/core/service/recipe';
import { resolveDataRoot, resolveProjectRoot } from '@alembic/core/workspace';
import { ModuleService } from '../../service/module/ModuleService.js';
import { PrimeSearchPipeline } from '../../service/task/PrimeSearchPipeline.js';
import type { ServiceContainer } from '../ServiceContainer.js';

export function register(c: ServiceContainer) {
  // ═══ Quality + Recipe ═══

  c.singleton('qualityScorer', () => new QualityScorer());
  c.singleton('recipeParser', () => new RecipeParser());
  c.singleton('recipeCandidateValidator', () => new RecipeCandidateValidator());
  c.register('recipeExtractor', () => c.singletons._recipeExtractor || null);

  c.singleton('feedbackCollector', (ct: ServiceContainer) => {
    const dataRoot = resolveDataRoot(ct);
    const wz = ct.singletons.writeZone as import('@alembic/core/io').WriteZone | undefined;
    return new FeedbackCollector(dataRoot as ConstructorParameters<typeof FeedbackCollector>[0], {
      wz,
    });
  });

  c.singleton('tokenUsageStore', (ct: ServiceContainer) => {
    const db = ct.get('database') as { getDrizzle: () => unknown };
    return new TokenUsageStore(
      unwrapRawDb(db as unknown) as ConstructorParameters<typeof TokenUsageStore>[0],
      db.getDrizzle() as ConstructorParameters<typeof TokenUsageStore>[1]
    );
  });

  // ═══ Module ═══

  c.singleton('moduleService', (ct: ServiceContainer) => {
    const projectRoot = resolveProjectRoot(ct);
    return new ModuleService(
      projectRoot as ConstructorParameters<typeof ModuleService>[0],
      {
        agentService: ct.get('agentService'),
        systemRunContextFactory: ct.get('systemRunContextFactory'),
        container: ct,
        qualityScorer: ct.get('qualityScorer'),
        recipeExtractor: ct.singletons._recipeExtractor || null,
        guardCheckEngine: ct.get('guardCheckEngine'),
        violationsStore: ct.get('violationsStore'),
      } as unknown as ConstructorParameters<typeof ModuleService>[1]
    );
  });

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
