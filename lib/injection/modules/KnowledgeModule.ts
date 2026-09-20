/** 知识用例装配入口：基础服务 → 检索 → 共享服务 → 演化；初始化订阅保持独立。 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DimensionCopy } from '@alembic/core/dimensions';
import { getFrameworkEnhancements } from '@alembic/core/enhancement';
import {
  ConfidenceRouter,
  computeSourceRegionFingerprint,
  createFsSourceRefResolver,
  KnowledgeGraphService,
  KnowledgeService,
  type KnowledgeServiceOptions,
  parseSourceLineRange,
  resolveGroundedSourcePaths,
  stripSourceRangeSuffix,
} from '@alembic/core/knowledge';
import { LanguageService } from '@alembic/core/shared';
import { resolveProjectRoot } from '@alembic/core/workspace';
import {
  normalizeProjectScopeSourceRefsForRuntime,
  resolveProjectScopeSourceIdentitiesFromContainer,
} from '../../project-scope/ProjectScopeAnalysis.js';
import type { ServiceContainer } from '../ServiceContainer.js';
import { registerKnowledgeEvolution } from './KnowledgeEvolutionModule.js';
import { registerKnowledgeRetrieval } from './KnowledgeRetrievalModule.js';

export function register(c: ServiceContainer) {
  // ═══ Knowledge ═══

  c.singleton(
    'confidenceRouter',
    (ct: ServiceContainer) => new ConfidenceRouter({}, ct.get('qualityScorer'))
  );

  c.singleton(
    'knowledgeService',
    (ct: ServiceContainer) =>
      new KnowledgeService(
        ct.get('knowledgeRepository'),
        ct.get('auditLogger'),
        ct.get('gateway'),
        ct.get('knowledgeGraphService'),
        {
          fileWriter: ct.get('knowledgeFileWriter'),
          skillHooks: ct.get('skillHooks'),
          confidenceRouter: ct.get('confidenceRouter'),
          qualityScorer: ct.get('qualityScorer'),
          eventBus: ct.services.eventBus ? ct.get('eventBus') : null,
          edgeRepo: ct.get('knowledgeEdgeRepository'),
          proposalRepo: ct.get('proposalRepository'),
          // P5/C8: 注入深度接地 port，激活主体 in-process AI 的深度加权评分(未注入时退化为 legacy)。
          // 与 AlembicPlugin 共用 Core createFsSourceRefResolver 保证双宿主接地判定 parity(P6 门)。
          groundedSourcePaths: (item: Record<string, unknown>) =>
            resolveGroundedSourcePaths(item, {
              sourceRefResolver: createFsSourceRefResolver(),
              projectRoot: resolveProjectRoot(ct),
            }),
        } satisfies KnowledgeServiceOptions
      )
  );

  c.singleton(
    'knowledgeGraphService',
    (ct: ServiceContainer) => new KnowledgeGraphService(ct.get('knowledgeEdgeRepository'))
  );

  registerKnowledgeRetrieval(c);

  // ═══ Shared ═══

  c.register('enhancementRegistry', () => getFrameworkEnhancements());
  c.register('languageService', () => LanguageService);
  c.register('dimensionCopy', () => DimensionCopy);
  c.register('aiProvider', () => c.singletons.aiProvider || null);

  registerKnowledgeEvolution(c);
}

/**
 * 初始化知识服务（在容器初始化后调用）
 * 绑定 EventBus → SearchEngine.refreshIndex() + recipe_source_refs 填充
 */
export function initializeKnowledgeServices(c: ServiceContainer): void {
  if (!c.services.eventBus || !c.services.searchEngine) {
    return;
  }

  try {
    const eventBus = c.get('eventBus');
    const searchEngine = c.get('searchEngine');

    // Bug 修复: BM25 索引与 Vector 索引一致性 — 将 knowledge:changed 事件绑定到 refreshIndex
    eventBus.on('knowledge:changed', () => {
      try {
        searchEngine.refreshIndex();
      } catch {
        /* refreshIndex failure is non-fatal */
      }
    });

    // recipe_source_refs 填充：MCP 内提交新知识后同步更新桥接表
    eventBus.on('knowledge:changed', (data: unknown) => {
      try {
        const d = data as { action?: string; entryId?: string };
        if (d.action === 'create' && d.entryId) {
          void _populateSourceRefsForEntry(c, d.entryId);
        }
      } catch {
        /* sourceRef population failure is non-fatal */
      }
    });
  } catch {
    /* EventBus/SearchEngine not available — skip binding */
  }
}

/**
 * 从 knowledge_entries.reasoning 中提取 sources 并填充 recipe_source_refs 桥接表
 * 使用 KnowledgeRepository + RecipeSourceRefRepository 类型安全 API
 */
async function _populateSourceRefsForEntry(c: ServiceContainer, entryId: string): Promise<void> {
  try {
    const knowledgeRepo = c.get('knowledgeRepository');
    const sourceRefRepo = c.get('recipeSourceRefRepository');

    const row = await knowledgeRepo.findSourceFileAndReasoning(entryId);
    if (!row?.reasoning) {
      return;
    }

    let sources: string[] = [];
    try {
      const reasoning = JSON.parse(row.reasoning);
      sources = Array.isArray(reasoning.sources)
        ? reasoning.sources.filter(
            (s: unknown) => typeof s === 'string' && (s as string).length > 0
          )
        : [];
    } catch {
      return;
    }

    const sourceIdentities = resolveProjectScopeSourceIdentitiesFromContainer(c);
    if (sourceIdentities.length > 0) {
      sources = normalizeProjectScopeSourceRefsForRuntime(
        sources,
        sourceIdentities
      ).activeSourceRefs;
    }

    if (sources.length === 0) {
      return;
    }

    const now = Date.now();
    // P-B(2026-07-11 落锚 parity):主体挖掘链新建 refs 此前无 contentFp,
    // 漂移检测对新知识失明直到下次 reconcile(BiliDili 真机 16 条 NULL 实证)。
    // 插入时同步算 region 指纹(512KB 护栏);失败留空由 reconcile 兜底,不阻断。
    const projectRoot = resolveProjectRoot(c);
    for (const sourcePath of sources) {
      let contentFp: string | undefined;
      try {
        const relFile = stripSourceRangeSuffix(sourcePath);
        const absolute = path.isAbsolute(relFile) ? relFile : path.join(projectRoot, relFile);
        const stat = await fsp.stat(absolute);
        if (stat.isFile() && stat.size <= 512 * 1024) {
          const content = await fsp.readFile(absolute, 'utf8');
          contentFp = computeSourceRegionFingerprint(content, parseSourceLineRange(sourcePath));
        }
      } catch {
        /* 文件不可读——留空,reconcile 兜底补锚 */
      }
      try {
        sourceRefRepo.upsert({
          recipeId: entryId,
          sourcePath,
          status: 'active',
          verifiedAt: now,
          ...(contentFp ? { contentFp } : {}),
        });
      } catch {
        /* table may not exist yet */
      }
    }
  } catch {
    /* repos may not be registered yet */
  }
}
