/**
 * @module recipe-pipeline/generate/dedup/GenerateDedupSeeder
 *
 * 查重视野单源（结构清洗 W1，2026-07-04）——此前"同一职责三入口分散"：
 * rescan 播种在 RescanContext、bootstrap KB 播种内联在 AiDimensionSessionRunner（M1b）、
 * per-dim 标题投影在 Runner 的 Map 访问。本模块三合一：
 * - `prepareGenerateRescanState`：会话级去重状态构造 + rescan 已有 recipe 播种（原样迁自
 *   RescanContext.ts，行为与日志逐字不变）；
 * - `seedGenerateDedupFromKnowledgeBase`：bootstrap（无 rescan 上下文）时从知识库播种
 *   （原样迁自 AiDimensionSessionRunner 的 M1b 内联块，三态留痕不变：成功/容器无键/库空）；
 * - `projectGenerateDimensionSeedTitles`：per-dim 查重视野投影（producer §9c 消费）。
 * 优先序不变：rescan 上下文在场即不查库。
 */

import type { KnowledgeRescanExecutionDecision } from '@alembic/core/host-agent-workflows';
import Logger from '@alembic/core/logging';
import { GenerateDedup } from '@alembic/core/service/bootstrap';
import {
  buildBootstrapRescanContext,
  type GenerateExistingRecipe,
  type GenerateRescanContext,
} from '../execution/RescanContext.js';

const logger = Logger.getInstance();

export interface GenerateDedupState {
  globalSubmittedTitles: Set<string>;
  globalSubmittedPatterns: Set<string>;
  globalSubmittedTriggers: Set<string>;
  bootstrapDedup: GenerateDedup;
  existingRecipesList: GenerateExistingRecipe[] | null;
  rescanContext: GenerateRescanContext | null;
}

export function prepareGenerateRescanState({
  existingRecipes,
  evolutionPrescreen,
  executionDecisions,
}: {
  existingRecipes: unknown;
  evolutionPrescreen: unknown;
  executionDecisions?: readonly KnowledgeRescanExecutionDecision[];
}): GenerateDedupState {
  const globalSubmittedTitles = new Set<string>();
  const globalSubmittedPatterns = new Set<string>();
  const globalSubmittedTriggers = new Set<string>();
  const bootstrapDedup = new GenerateDedup();
  const existingRecipesList = Array.isArray(existingRecipes)
    ? (existingRecipes as GenerateExistingRecipe[])
    : null;

  if (existingRecipesList && existingRecipesList.length > 0) {
    for (const recipe of existingRecipesList) {
      if (recipe.title && recipe.status !== 'decaying') {
        globalSubmittedTitles.add(recipe.title.toLowerCase().trim());
      }
      if (recipe.trigger) {
        globalSubmittedTriggers.add(recipe.trigger.toLowerCase().trim());
      }
    }
    logger.info(
      `[generate] Rescan mode: seeded ${globalSubmittedTitles.size} titles + ${globalSubmittedTriggers.size} triggers into dedup set`
    );
  }

  return {
    globalSubmittedTitles,
    globalSubmittedPatterns,
    globalSubmittedTriggers,
    bootstrapDedup,
    existingRecipesList,
    rescanContext: buildBootstrapRescanContext({
      existingRecipesList,
      evolutionPrescreen,
      executionDecisions,
    }),
  };
}

/** per-dim 查重视野条目（producer §9c 渲染面消费） */
export interface GenerateDedupSeedTitle {
  id: string;
  title: string;
  trigger?: string;
}

export type GenerateDedupSeedByDim = Map<string, GenerateDedupSeedTitle[]>;

/**
 * M1b（挖掘产出升级 P5a）：bootstrap（无 rescan 上下文）时从知识库播种查重视野——
 * ①gateway 级 dedup 预装（globalSubmittedTitles/Triggers，此前仅 rescan 播种，bootstrap
 * 在饱和库上盲写→gateway 静默拒重烧整回合）；②per-dim 标题注入 producer 提示（§9c）。
 * 不合成 rescanContext——避免把 bootstrap 隐式转成 rescan 预算/准入语义。查询失败静默
 * 降级（冷启动首跑库空/表未建是正常路径）；undefined-repo/库空双留痕（run-10 复盘）。
 */
export async function seedGenerateDedupFromKnowledgeBase(
  state: Pick<GenerateDedupState, 'globalSubmittedTitles' | 'globalSubmittedTriggers'>,
  container: { get(name: string): unknown } | undefined
): Promise<GenerateDedupSeedByDim | null> {
  let dedupSeedByDim: GenerateDedupSeedByDim | null = null;
  try {
    const knowledgeRepo = container?.get('knowledgeRepository') as
      | {
          findAllByLifecycles(
            lifecycles: readonly string[],
            limit?: number
          ): Promise<Array<{ id: string; title?: string; trigger?: string; dimensionId?: string }>>;
        }
      | undefined;
    const existing = knowledgeRepo
      ? await knowledgeRepo.findAllByLifecycles(['active', 'staging', 'pending', 'evolving'])
      : [];
    if (!knowledgeRepo) {
      // run-10 静默复盘：undefined-repo 此前走无日志空路径——留痕以区分"容器无键"与"库空"
      logger.info(
        '[generate] bootstrap dedup seed: knowledgeRepository unavailable in workflow container'
      );
    } else if (existing.length === 0) {
      logger.info('[generate] bootstrap dedup seed: knowledge base empty, no visibility to inject');
    }
    if (existing.length > 0) {
      dedupSeedByDim = new Map();
      for (const entry of existing) {
        if (entry.title) {
          state.globalSubmittedTitles.add(entry.title.toLowerCase().trim());
        }
        if (entry.trigger) {
          state.globalSubmittedTriggers.add(entry.trigger.toLowerCase().trim());
        }
        if (entry.title) {
          const dim = entry.dimensionId || 'unknown';
          const bucket = dedupSeedByDim.get(dim) ?? [];
          bucket.push({ id: entry.id, title: entry.title, trigger: entry.trigger });
          dedupSeedByDim.set(dim, bucket);
        }
      }
      logger.info(
        `[generate] bootstrap dedup seed: ${state.globalSubmittedTitles.size} titles / ${state.globalSubmittedTriggers.size} triggers from knowledge base (${existing.length} entries)`
      );
    }
  } catch (err: unknown) {
    logger.warn(
      `[generate] bootstrap dedup seed unavailable (continuing without KB visibility): ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return dedupSeedByDim;
}

/** per-dim 查重视野投影（top-15，producer §9c；rescan 模式该视野由 §9a 承担故传 null） */
export function projectGenerateDimensionSeedTitles(
  dedupSeedByDim: GenerateDedupSeedByDim | null,
  dimId: string,
  limit = 15
): GenerateDedupSeedTitle[] | null {
  return dedupSeedByDim?.get(dimId)?.slice(0, limit) ?? null;
}
