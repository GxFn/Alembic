/**
 * PanoramaAggregator — 全景数据汇总
 *
 * 编排 RoleRefiner → CouplingAnalyzer → LayerInferrer，
 * 汇总为统一的 PanoramaResult，附加知识覆盖率和空白区检测。
 *
 * @module PanoramaAggregator
 */

import type { CouplingAnalyzer } from './CouplingAnalyzer.js';
import { DimensionAnalyzer } from './DimensionAnalyzer.js';
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
  dimensionAnalyzer?: DimensionAnalyzer;
}

/* ═══ PanoramaAggregator Class ════════════════════════════ */

export class PanoramaAggregator {
  readonly #roleRefiner: RoleRefiner;
  readonly #couplingAnalyzer: CouplingAnalyzer;
  readonly #layerInferrer: LayerInferrer;
  readonly #db: CeDbLike;
  readonly #projectRoot: string;
  readonly #dimensionAnalyzer: DimensionAnalyzer;

  constructor(opts: PanoramaAggregatorOptions) {
    this.#roleRefiner = opts.roleRefiner;
    this.#couplingAnalyzer = opts.couplingAnalyzer;
    this.#layerInferrer = opts.layerInferrer;
    this.#db = opts.db;
    this.#projectRoot = opts.projectRoot;
    this.#dimensionAnalyzer = opts.dimensionAnalyzer ?? new DimensionAnalyzer(opts.db);
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

    // 6. 项目级 recipe 总数（recipe scope 通常为 universal，不做模块强关联）
    const projectRecipeCount = this.#getProjectRecipeCount();

    // 7. 计算总文件数
    let totalFiles = 0;
    for (const mc of moduleCandidates) {
      totalFiles += mc.files.length;
    }

    // 8. 汇总 PanoramaModule
    // 模块 recipeCount 按文件数等比分配项目级 recipe（反映覆盖贡献度）
    const panoramaModules = new Map<string, PanoramaModule>();
    for (const mc of moduleCandidates) {
      const refined = refinedRoles.get(mc.name);
      const metrics = coupling.metrics.get(mc.name);
      const recipeCount =
        totalFiles > 0 ? Math.round((projectRecipeCount * mc.files.length) / totalFiles) : 0;

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

    // 8.5 基于模块角色重命名层级（比模块名 pattern 更准确）
    this.#renameLayersByRole(layers, panoramaModules);

    // 9. 多维度知识健康分析 (替代旧的基于模块文件数的覆盖率模型)
    const moduleRoles = moduleCandidates.map((m) => {
      const pm = panoramaModules.get(m.name);
      return pm?.refinedRole ?? m.inferredRole;
    });
    const { radar, gaps } = this.#dimensionAnalyzer.analyze(moduleRoles);

    // 10. 调用流概要
    const callFlowSummary = this.#computeCallFlowSummary();

    return {
      modules: panoramaModules,
      layers,
      cycles: coupling.cycles,
      gaps,
      healthRadar: radar,
      callFlowSummary,
      projectRecipeCount,
      computedAt: Date.now(),
    };
  }

  /* ─── Project Recipe Count ──────────────────────── */

  #getProjectRecipeCount(): number {
    try {
      const row = this.#db
        .prepare(
          `SELECT COUNT(*) as cnt FROM knowledge_entries WHERE lifecycle IN ('active', 'pending')`
        )
        .get() as Record<string, unknown> | undefined;
      return Number(row?.cnt ?? 0);
    } catch {
      return 0;
    }
  }

  /* ─── Layer Naming (role-based) ─────────────────── */

  /** 角色 → 层级名映射 */
  static readonly #ROLE_TO_LAYER: Record<string, string> = {
    core: 'Foundation',
    foundation: 'Foundation',
    model: 'Model',
    service: 'Service',
    networking: 'Infrastructure',
    storage: 'Infrastructure',
    ui: 'UI',
    feature: 'Feature',
    config: 'Configuration',
    test: 'Test',
    app: 'Application',
  };

  /**
   * 基于模块 refinedRole 投票重命名层级
   * 比模块名 pattern 匹配更准确（避免 BDUIKit 被误匹配为 Foundation 等问题）
   */
  #renameLayersByRole(
    layers: { levels: Array<{ level: number; name: string; modules: string[] }> },
    panoramaModules: Map<string, PanoramaModule>
  ): void {
    const usedNames = new Set<string>();
    const maxLevel = Math.max(...layers.levels.map((l) => l.level), 0);

    for (const level of layers.levels) {
      // 只统计有文件的模块（排除 0 文件的第三方依赖干扰）
      const roleVotes = new Map<string, number>();
      for (const modName of level.modules) {
        const mod = panoramaModules.get(modName);
        if (mod && mod.fileCount > 0) {
          const role = mod.refinedRole || mod.inferredRole;
          roleVotes.set(role, (roleVotes.get(role) ?? 0) + 1);
        }
      }

      let layerName: string;

      if (roleVotes.size === 0) {
        // 全部是 0 文件模块 → 用位置推断
        layerName =
          level.level === 0 ? 'Foundation' : level.level === maxLevel ? 'Application' : 'Feature';
      } else {
        // 选最高票角色
        let bestRole = '';
        let bestCount = 0;
        for (const [role, count] of roleVotes) {
          if (count > bestCount) {
            bestRole = role;
            bestCount = count;
          }
        }

        layerName = PanoramaAggregator.#ROLE_TO_LAYER[bestRole] ?? 'Feature';

        // 位置修正：最底层优先 Foundation，最顶层优先 Application
        if (level.level === 0 && roleVotes.has('core')) {
          layerName = 'Foundation';
        } else if (level.level === maxLevel && layers.levels.length > 1) {
          layerName = 'Application';
        }
      }

      // 去重：已使用的名称追加 level 号
      if (usedNames.has(layerName)) {
        layerName = `${layerName} ${level.level}`;
      }
      usedNames.add(layerName);

      level.name = layerName;
    }
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
