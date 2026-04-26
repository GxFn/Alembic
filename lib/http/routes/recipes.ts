/**
 * Recipes API 路由
 * 提供 Recipe 知识图谱关系发现等操作
 *
 * 说明: Recipe 的 CRUD 已由 knowledge.js 统一提供，
 * 此路由仅处理 Recipe 特有的批量 AI 操作。
 */

import express, { type Request, type Response } from 'express';
import { type AgentService, runRelationDiscovery } from '../../agent/service/index.js';
import { COUNTABLE_LIFECYCLES } from '../../domain/knowledge/Lifecycle.js';
import Logger from '../../infrastructure/logging/Logger.js';
import { getServiceContainer } from '../../injection/ServiceContainer.js';

const router = express.Router();
const logger = Logger.getInstance();

/* ═══ 进程内任务状态（单实例足够） ═══════════════════════ */

let discoverTask: Record<string, any> = {
  status: 'idle', // idle | running | done | error
  startedAt: null,
  finishedAt: null,
  discovered: 0,
  totalPairs: 0,
  batchErrors: 0,
  error: null,
  elapsed: 0,
  message: null,
};

function resetTask() {
  discoverTask = {
    status: 'idle',
    startedAt: null,
    finishedAt: null,
    discovered: 0,
    totalPairs: 0,
    batchErrors: 0,
    error: null,
    elapsed: 0,
    message: null,
  };
}

/* ═══ POST /api/v1/recipes/discover-relations ═══════════ */

/**
 * 异步启动 AI 批量发现 Recipe 知识图谱关系
 * Body: { batchSize?: number }
 *
 * 立即返回 { status: 'started' }，后台执行。
 * Dashboard 通过 GET /discover-relations/status 轮询进度。
 */
router.post('/discover-relations', async (req: Request, res: Response): Promise<void> => {
  const { batchSize: _batchSize = 20 } = req.body;

  // 如果已有任务在运行，返回当前状态
  if (discoverTask.status === 'running') {
    const elapsed = Math.round((Date.now() - new Date(discoverTask.startedAt).getTime()) / 1000);
    return void res.json({
      success: true,
      data: {
        status: 'running',
        startedAt: discoverTask.startedAt,
        elapsed,
        message: 'AI 分析仍在进行中',
      },
    });
  }

  // 检查统一 AgentService 是否可用
  const container = getServiceContainer();
  let agentService: AgentService;
  try {
    agentService = container.get('agentService') as AgentService;
  } catch {
    return void res.json({
      success: true,
      data: { status: 'error', error: 'AgentService 不可用，请检查 AI Provider 配置' },
    });
  }

  // Mock 模式下跳过 AI 关系发现
  const aiManager = container.singletons?._aiProviderManager as { isMock?: boolean } | undefined;
  if (aiManager?.isMock) {
    return void res.json({
      success: true,
      data: { status: 'error', error: 'AI Provider 未配置，当前为 Mock 模式。请先配置 API Key。' },
    });
  }

  // 快速检查：至少需要 2 条可消费 Recipe（active/staging/pending/evolving）
  try {
    const knowledgeRepo = container.get('knowledgeRepository') as {
      countByLifecycles(lifecycles: readonly string[]): Promise<number>;
    };
    const count = await knowledgeRepo.countByLifecycles(COUNTABLE_LIFECYCLES);
    if (count < 2) {
      return void res.json({
        success: true,
        data: {
          status: 'empty',
          message: `只有 ${count} 条活跃 Recipe，至少需要 2 条才能分析关系`,
        },
      });
    }
  } catch {
    // 如果查询失败，继续尝试（让 runTask 给出具体错误）
  }

  // 重置并启动后台任务
  resetTask();
  discoverTask.status = 'running';
  discoverTask.startedAt = new Date().toISOString();

  // 异步执行，不 await
  (async () => {
    try {
      const result = await runRelationDiscovery({ agentService, batchSize: _batchSize });
      const relations =
        (result.relations as { from: string; to: string; type: string; evidence?: string }[]) || [];
      const analyzed = (result.analyzed as number) || 0;

      logger.info('AI discover-relations result', {
        analyzed,
        relationsCount: relations.length,
        sample: relations.slice(0, 3).map((r) => `${r.from} → ${r.to} (${r.type})`),
      });

      // 将 AI 发现的关系写入知识图谱
      // AI 返回的 from/to 可能是 Recipe ID（UUID）、标题、trigger 或被改写的标题
      // 预加载全部 Recipe，通过 token 相似度做最佳匹配
      let written = 0;
      if (relations.length > 0) {
        try {
          const graphService = container.get(
            'knowledgeGraphService'
          ) as import('../../service/knowledge/KnowledgeGraphService.js').KnowledgeGraphService;
          const knowledgeRepo = container.get('knowledgeRepository') as {
            findAllByLifecycles(
              lifecycles: readonly string[]
            ): Promise<Array<{ id: string; title: string; trigger: string }>>;
          };

          // 预加载全部活跃 Recipe
          const allRecipes = await knowledgeRepo.findAllByLifecycles(COUNTABLE_LIFECYCLES);
          const idSet = new Set(allRecipes.map((r) => r.id));

          // 构建查找索引
          const byTitle = new Map<string, string>(); // lower(title) → id
          const byTrigger = new Map<string, string>(); // lower(trigger) → id
          for (const r of allRecipes) {
            if (r.title) {
              byTitle.set(r.title.toLowerCase(), r.id);
            }
            if (r.trigger) {
              byTrigger.set(r.trigger.toLowerCase(), r.id);
            }
          }

          /** 将字符串拆分为 token 集合（中文按字符、英文按单词） */
          const tokenize = (s: string): Set<string> => {
            const lower = s.toLowerCase();
            const tokens = new Set<string>();
            // 英文/数字单词
            for (const m of lower.matchAll(/[a-z0-9_]+/g)) {
              tokens.add(m[0]);
            }
            // 中文字符（每个字作为 token）
            for (const ch of lower) {
              if (ch.charCodeAt(0) > 0x4e00) {
                tokens.add(ch);
              }
            }
            return tokens;
          };

          /** Jaccard 相似度 */
          const similarity = (a: Set<string>, b: Set<string>): number => {
            if (a.size === 0 || b.size === 0) {
              return 0;
            }
            let intersection = 0;
            for (const t of a) {
              if (b.has(t)) {
                intersection++;
              }
            }
            return intersection / (a.size + b.size - intersection);
          };

          // 预计算 Recipe token
          const recipeTokens = allRecipes.map((r) => ({
            id: r.id,
            tokens: tokenize(`${r.title} ${r.trigger}`),
          }));

          const cache = new Map<string, string | null>();
          const resolveId = (nameOrId: string): string | null => {
            const key = nameOrId.trim();
            if (!key) {
              return null;
            }
            if (cache.has(key)) {
              return cache.get(key)!;
            }

            let id: string | null = null;
            const keyLower = key.toLowerCase();

            // 1) 直接 UUID
            if (idSet.has(key)) {
              id = key;
            }

            // 2) 精确标题匹配
            if (!id) {
              id = byTitle.get(keyLower) ?? null;
            }

            // 3) 精确 trigger 匹配
            if (!id) {
              id = byTrigger.get(keyLower) ?? null;
            }

            // 4) 标题包含/被包含
            if (!id) {
              for (const [title, rid] of byTitle) {
                if (title.includes(keyLower) || keyLower.includes(title)) {
                  id = rid;
                  break;
                }
              }
            }

            // 5) Token 相似度匹配（阈值 0.3）
            if (!id) {
              const inputTokens = tokenize(key);
              let bestScore = 0;
              let bestId: string | null = null;
              for (const rt of recipeTokens) {
                const score = similarity(inputTokens, rt.tokens);
                if (score > bestScore) {
                  bestScore = score;
                  bestId = rt.id;
                }
              }
              if (bestScore >= 0.3 && bestId) {
                id = bestId;
                logger.info('resolveId fuzzy match', {
                  input: key,
                  matchedId: id,
                  score: bestScore.toFixed(2),
                });
              }
            }

            cache.set(key, id);
            if (!id) {
              logger.warn('resolveId failed', { input: key });
            }
            return id;
          };

          for (const rel of relations) {
            if (!rel.from || !rel.to || !rel.type) {
              continue;
            }
            const fromId = resolveId(rel.from);
            const toId = resolveId(rel.to);
            if (!fromId || !toId) {
              continue;
            }
            const res = await graphService.addEdge(fromId, 'recipe', toId, 'recipe', rel.type, {
              weight: 0.7,
              source: 'ai-discovery',
              evidence: rel.evidence || '',
            });
            if (res.success) {
              written++;
            }
          }
        } catch (graphErr: unknown) {
          logger.warn('Failed to write some discovered edges', {
            error: (graphErr as Error).message,
          });
        }
      }

      discoverTask.status = 'done';
      discoverTask.finishedAt = new Date().toISOString();
      discoverTask.discovered = written;
      discoverTask.totalPairs = analyzed;
      discoverTask.batchErrors = relations.length - written;
      discoverTask.elapsed = Math.round(
        (new Date(discoverTask.finishedAt).getTime() - new Date(discoverTask.startedAt).getTime()) /
          1000
      );
      logger.info('Discover relations completed', {
        discovered: discoverTask.discovered,
        totalPairs: discoverTask.totalPairs,
        batchErrors: discoverTask.batchErrors,
        elapsed: discoverTask.elapsed,
      });
    } catch (err: unknown) {
      discoverTask.status = 'error';
      discoverTask.finishedAt = new Date().toISOString();
      discoverTask.error = (err as Error).message;
      discoverTask.elapsed = Math.round(
        (new Date(discoverTask.finishedAt).getTime() - new Date(discoverTask.startedAt).getTime()) /
          1000
      );
      logger.error('Discover relations failed', { error: (err as Error).message });
    }
  })();

  res.json({
    success: true,
    data: {
      status: 'started',
      startedAt: discoverTask.startedAt,
      message: 'AI 分析已启动，正在后台运行',
    },
  });
});

/* ═══ GET /api/v1/recipes/discover-relations/status ═════ */

/** 查询关系发现任务状态 */
router.get('/discover-relations/status', async (req: Request, res: Response) => {
  const data = { ...discoverTask };

  // 计算实时 elapsed
  if (data.status === 'running' && data.startedAt) {
    data.elapsed = Math.round((Date.now() - new Date(data.startedAt).getTime()) / 1000);
  }

  res.json({ success: true, data });
});

export default router;
