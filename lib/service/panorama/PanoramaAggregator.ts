/**
 * PanoramaAggregator — 全景数据汇总
 *
 * 编排 RoleRefiner → CouplingAnalyzer → LayerInferrer，
 * 汇总为统一的 PanoramaResult，附加知识覆盖率和空白区检测。
 *
 * @module PanoramaAggregator
 */

import type { CouplingAnalyzer } from './CouplingAnalyzer.js';
import type { LayerInferrer } from './LayerInferrer.js';
import type {
  CallFlowSummary,
  CeDbLike,
  KnowledgeGap,
  PanoramaModule,
  PanoramaResult,
} from './PanoramaTypes.js';
import type { ModuleCandidate, RoleRefiner } from './RoleRefiner.js';

/* ═══ Options ═════════════════════════════════════════════ */

export interface PanoramaAggregatorOptions {
  roleRefiner: RoleRefiner;
  couplingAnalyzer: CouplingAnalyzer;
  layerInferrer: LayerInferrer;
  db: CeDbLike;
  projectRoot: string;
}

/* ═══ PanoramaAggregator Class ════════════════════════════ */

export class PanoramaAggregator {
  readonly #roleRefiner: RoleRefiner;
  readonly #couplingAnalyzer: CouplingAnalyzer;
  readonly #layerInferrer: LayerInferrer;
  readonly #db: CeDbLike;
  readonly #projectRoot: string;

  constructor(opts: PanoramaAggregatorOptions) {
    this.#roleRefiner = opts.roleRefiner;
    this.#couplingAnalyzer = opts.couplingAnalyzer;
    this.#layerInferrer = opts.layerInferrer;
    this.#db = opts.db;
    this.#projectRoot = opts.projectRoot;
  }

  /**
   * 计算完整全景数据
   */
  compute(moduleCandidates: ModuleCandidate[]): PanoramaResult {
    // 1. RoleRefiner: 精化角色
    const refinedRoles = this.#roleRefiner.refineAll(moduleCandidates);

    // 2. 构建模块-文件映射
    const moduleFiles = new Map<string, string[]>();
    for (const mc of moduleCandidates) {
      moduleFiles.set(mc.name, mc.files);
    }

    // 3. CouplingAnalyzer: 耦合分析
    const coupling = this.#couplingAnalyzer.analyze(moduleFiles);

    // 4. LayerInferrer: 层级推断
    const modules = moduleCandidates.map((m) => m.name);
    const layers = this.#layerInferrer.infer(coupling.edges, modules, coupling.cycles);

    // 5. 构建层级映射 (模块名 → 层级号)
    const moduleLayerMap = new Map<string, number>();
    for (const level of layers.levels) {
      for (const mod of level.modules) {
        moduleLayerMap.set(mod, level.level);
      }
    }

    // 6. 知识覆盖率
    const recipeCounts = this.#getRecipeCounts(moduleCandidates);

    // 7. 汇总 PanoramaModule
    const panoramaModules = new Map<string, PanoramaModule>();
    for (const mc of moduleCandidates) {
      const refined = refinedRoles.get(mc.name);
      const metrics = coupling.metrics.get(mc.name);
      const recipeCount = recipeCounts.get(mc.name) ?? 0;

      panoramaModules.set(mc.name, {
        name: mc.name,
        inferredRole: mc.inferredRole,
        refinedRole: refined?.refinedRole ?? mc.inferredRole,
        roleConfidence: refined?.confidence ?? 0,
        layer: moduleLayerMap.get(mc.name) ?? 0,
        fanIn: metrics?.fanIn ?? 0,
        fanOut: metrics?.fanOut ?? 0,
        files: mc.files,
        fileCount: mc.files.length,
        recipeCount,
        coverageRatio: mc.files.length > 0 ? recipeCount / mc.files.length : 0,
      });
    }

    // 8. 知识空白区检测
    const gaps = this.#detectGaps(panoramaModules);

    // 9. 调用流概要
    const callFlowSummary = this.#computeCallFlowSummary();

    return {
      modules: panoramaModules,
      layers,
      cycles: coupling.cycles,
      gaps,
      callFlowSummary,
      computedAt: Date.now(),
    };
  }

  /* ─── Recipe Coverage ───────────────────────────── */

  #getRecipeCounts(modules: ModuleCandidate[]): Map<string, number> {
    const counts = new Map<string, number>();

    for (const mc of modules) {
      if (mc.files.length === 0) {
        counts.set(mc.name, 0);
        continue;
      }

      // 查该模块文件关联的 recipe 数
      // Recipe 通过 knowledge_entries 中 scope/language 字段关联，
      // 但更直接的方式是查 bootstrap_dim_files + knowledge_entries
      const placeholders = mc.files.map(() => '?').join(',');
      const row = this.#db
        .prepare(
          `SELECT COUNT(DISTINCT ke.id) as cnt
           FROM knowledge_entries ke
           WHERE ke.lifecycle IN ('active', 'pending')
           AND (ke.scope LIKE ? OR EXISTS (
             SELECT 1 FROM bootstrap_dim_files bdf
             WHERE bdf.file_path IN (${placeholders})
             AND bdf.dim_id = ke.id
           ))`
        )
        .get(`%${mc.name}%`, ...mc.files) as Record<string, unknown> | undefined;

      counts.set(mc.name, Number(row?.cnt ?? 0));
    }

    return counts;
  }

  /* ─── Knowledge Gaps ────────────────────────────── */

  #detectGaps(modules: Map<string, PanoramaModule>): KnowledgeGap[] {
    const gaps: KnowledgeGap[] = [];

    for (const [, mod] of modules) {
      if (mod.fileCount === 0) {
        continue;
      }

      // 高优: 模块文件多但 recipe 少
      if (mod.fileCount >= 5 && mod.recipeCount === 0) {
        gaps.push({
          module: mod.name,
          files: mod.fileCount,
          recipes: 0,
          priority: 'high',
          suggestedFocus: this.#inferFocusAreas(mod),
        });
      } else if (mod.coverageRatio < 0.2 && mod.fileCount >= 3) {
        gaps.push({
          module: mod.name,
          files: mod.fileCount,
          recipes: mod.recipeCount,
          priority: 'medium',
          suggestedFocus: this.#inferFocusAreas(mod),
        });
      } else if (mod.coverageRatio < 0.5 && mod.fanIn > 5) {
        // 高被依赖但覆盖不足
        gaps.push({
          module: mod.name,
          files: mod.fileCount,
          recipes: mod.recipeCount,
          priority: 'medium',
          suggestedFocus: ['api-contract', 'error-handling'],
        });
      }
    }

    return gaps.sort((a, b) => {
      const priorityOrder = { high: 0, medium: 1, low: 2 };
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    });
  }

  #inferFocusAreas(mod: PanoramaModule): string[] {
    const areas: string[] = [];
    const role = mod.refinedRole;

    if (role === 'core' || role === 'service') {
      areas.push('error-handling', 'api-contract');
    }
    if (role === 'ui') {
      areas.push('thread-safety', 'lifecycle');
    }
    if (role === 'networking') {
      areas.push('error-handling', 'retry-strategy');
    }
    if (role === 'storage') {
      areas.push('thread-safety', 'migration');
    }
    if (role === 'model') {
      areas.push('validation', 'serialization');
    }

    if (areas.length === 0) {
      areas.push('coding-standards');
    }

    return areas;
  }

  /* ─── Call Flow Summary ─────────────────────────── */

  #computeCallFlowSummary(): CallFlowSummary {
    // 最频繁被调用的方法
    const topCalled = this.#db
      .prepare(
        `SELECT to_id, COUNT(*) as call_count
         FROM knowledge_edges
         WHERE relation = 'calls'
         GROUP BY to_id
         ORDER BY call_count DESC
         LIMIT 10`
      )
      .all() as Array<Record<string, unknown>>;

    // 入口点: 只有出度没有入度的方法
    const entryPoints = this.#db
      .prepare(
        `SELECT DISTINCT ke.from_id
         FROM knowledge_edges ke
         WHERE ke.relation = 'calls'
         AND ke.from_id NOT IN (
           SELECT to_id FROM knowledge_edges WHERE relation = 'calls'
         )
         LIMIT 20`
      )
      .all() as Array<Record<string, unknown>>;

    // 数据生产者: data_flow outFlow >> inFlow
    const dataProducers = this.#db
      .prepare(
        `SELECT from_id, COUNT(*) as out_cnt
         FROM knowledge_edges
         WHERE relation = 'data_flow'
         GROUP BY from_id
         HAVING out_cnt > 3
         ORDER BY out_cnt DESC
         LIMIT 10`
      )
      .all() as Array<Record<string, unknown>>;

    // 数据消费者: data_flow inFlow >> outFlow
    const dataConsumers = this.#db
      .prepare(
        `SELECT to_id, COUNT(*) as in_cnt
         FROM knowledge_edges
         WHERE relation = 'data_flow'
         GROUP BY to_id
         HAVING in_cnt > 3
         ORDER BY in_cnt DESC
         LIMIT 10`
      )
      .all() as Array<Record<string, unknown>>;

    return {
      topCalledMethods: topCalled.map((r) => ({
        id: r.to_id as string,
        callCount: Number(r.call_count),
      })),
      entryPoints: entryPoints.map((r) => r.from_id as string),
      dataProducers: dataProducers.map((r) => r.from_id as string),
      dataConsumers: dataConsumers.map((r) => r.to_id as string),
    };
  }
}
