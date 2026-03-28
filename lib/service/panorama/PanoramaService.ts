/**
 * PanoramaService — 全景服务主入口
 *
 * 提供 4 个 operation:
 *   overview — 项目骨架 + 层级 + token 预算截断
 *   module   — 单模块详情 + Recipe 覆盖率
 *   gaps     — 知识空白区 (有代码无 Recipe)
 *   health   — 全景健康度 (覆盖率 + 耦合度 + 衰退)
 *
 * 内存缓存 + 24h 过期策略。
 *
 * @module PanoramaService
 */

import { inferTargetRole } from '../../external/mcp/handlers/TargetClassifier.js';
import type { PanoramaAggregator } from './PanoramaAggregator.js';
import type { CeDbLike, KnowledgeGap, PanoramaModule, PanoramaResult } from './PanoramaTypes.js';
import type { ModuleCandidate, ModuleRole } from './RoleRefiner.js';

/* ═══ Types ═══════════════════════════════════════════════ */

export interface PanoramaServiceOptions {
  aggregator: PanoramaAggregator;
  db: CeDbLike;
  projectRoot: string;
}

export interface PanoramaOverview {
  projectRoot: string;
  moduleCount: number;
  layerCount: number;
  totalFiles: number;
  totalRecipes: number;
  overallCoverage: number;
  layers: Array<{
    level: number;
    name: string;
    modules: Array<{
      name: string;
      role: string;
      fileCount: number;
      recipeCount: number;
    }>;
  }>;
  cycleCount: number;
  gapCount: number;
  computedAt: number;
  stale: boolean;
}

export interface PanoramaModuleDetail {
  module: PanoramaModule;
  layerName: string;
  neighbors: Array<{ name: string; direction: 'in' | 'out'; weight: number }>;
}

export interface PanoramaHealth {
  overallCoverage: number;
  avgCoupling: number;
  cycleCount: number;
  gapCount: number;
  highPriorityGaps: number;
  moduleCount: number;
  healthScore: number; // 0-100
}

/* ═══ Constants ═══════════════════════════════════════════ */

const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24h

/* ═══ PanoramaService Class ═══════════════════════════════ */

export class PanoramaService {
  readonly #aggregator: PanoramaAggregator;
  readonly #db: CeDbLike;
  readonly #projectRoot: string;
  #cache: PanoramaResult | null = null;

  constructor(opts: PanoramaServiceOptions) {
    this.#aggregator = opts.aggregator;
    this.#db = opts.db;
    this.#projectRoot = opts.projectRoot;
  }

  /* ─── Public API ────────────────────────────────── */

  /**
   * 获取项目全景概览
   */
  getOverview(): PanoramaOverview {
    const result = this.#getOrCompute();
    const isStale = Date.now() - result.computedAt > STALE_THRESHOLD_MS;

    let totalFiles = 0;
    let totalRecipes = 0;
    for (const [, mod] of result.modules) {
      totalFiles += mod.fileCount;
      totalRecipes += mod.recipeCount;
    }

    return {
      projectRoot: this.#projectRoot,
      moduleCount: result.modules.size,
      layerCount: result.layers.levels.length,
      totalFiles,
      totalRecipes,
      overallCoverage: totalFiles > 0 ? totalRecipes / totalFiles : 0,
      layers: result.layers.levels.map((l) => ({
        level: l.level,
        name: l.name,
        modules: l.modules.map((mName) => {
          const mod = result.modules.get(mName);
          return {
            name: mName,
            role: mod?.refinedRole ?? 'feature',
            fileCount: mod?.fileCount ?? 0,
            recipeCount: mod?.recipeCount ?? 0,
          };
        }),
      })),
      cycleCount: result.cycles.length,
      gapCount: result.gaps.length,
      computedAt: result.computedAt,
      stale: isStale,
    };
  }

  /**
   * 获取单模块详情
   */
  getModule(moduleName: string): PanoramaModuleDetail | null {
    const result = this.#getOrCompute();
    const mod = result.modules.get(moduleName);
    if (!mod) {
      return null;
    }

    // 找到该模块所在层级
    const layerName =
      result.layers.levels.find((l) => l.modules.includes(moduleName))?.name ?? 'Unknown';

    // 找邻居 (通过 CouplingAnalyzer 边)
    const neighbors: Array<{ name: string; direction: 'in' | 'out'; weight: number }> = [];
    for (const [, otherMod] of result.modules) {
      if (otherMod.name === moduleName) {
        continue;
      }
      if (otherMod.fanOut > 0) {
        // 简化：使用耦合数据近似
      }
    }

    // 使用 DB 直接查
    const outNeighbors = this.#db
      .prepare(
        `SELECT DISTINCT to_id, weight FROM knowledge_edges
         WHERE from_id = ? AND from_type = 'module' AND relation = 'depends_on'`
      )
      .all(moduleName) as Array<Record<string, unknown>>;

    for (const n of outNeighbors) {
      neighbors.push({
        name: n.to_id as string,
        direction: 'out',
        weight: Number(n.weight ?? 1),
      });
    }

    const inNeighbors = this.#db
      .prepare(
        `SELECT DISTINCT from_id, weight FROM knowledge_edges
         WHERE to_id = ? AND to_type = 'module' AND relation = 'depends_on'`
      )
      .all(moduleName) as Array<Record<string, unknown>>;

    for (const n of inNeighbors) {
      neighbors.push({
        name: n.from_id as string,
        direction: 'in',
        weight: Number(n.weight ?? 1),
      });
    }

    return { module: mod, layerName, neighbors };
  }

  /**
   * 获取知识空白区
   */
  getGaps(): KnowledgeGap[] {
    const result = this.#getOrCompute();
    return result.gaps;
  }

  /**
   * 获取全景健康度
   */
  getHealth(): PanoramaHealth {
    const result = this.#getOrCompute();

    let totalCoverage = 0;
    let totalCoupling = 0;
    let count = 0;

    for (const [, mod] of result.modules) {
      totalCoverage += mod.coverageRatio;
      totalCoupling += mod.fanIn + mod.fanOut;
      count++;
    }

    const avgCoverage = count > 0 ? totalCoverage / count : 0;
    const avgCoupling = count > 0 ? totalCoupling / count : 0;
    const highPriorityGaps = result.gaps.filter((g) => g.priority === 'high').length;

    // 健康分: 100 分制
    // 覆盖率 50 分 + 无循环 20 分 + 无高优空白 20 分 + 耦合度适中 10 分
    let healthScore = Math.min(avgCoverage, 1) * 50;
    healthScore += result.cycles.length === 0 ? 20 : Math.max(0, 20 - result.cycles.length * 5);
    healthScore += highPriorityGaps === 0 ? 20 : Math.max(0, 20 - highPriorityGaps * 4);
    healthScore += avgCoupling < 10 ? 10 : Math.max(0, 10 - (avgCoupling - 10));
    healthScore = Math.round(Math.max(0, Math.min(100, healthScore)));

    return {
      overallCoverage: avgCoverage,
      avgCoupling,
      cycleCount: result.cycles.length,
      gapCount: result.gaps.length,
      highPriorityGaps,
      moduleCount: count,
      healthScore,
    };
  }

  /**
   * 获取完整 PanoramaResult（内部使用或 Bootstrap 注入）
   */
  getResult(): PanoramaResult {
    return this.#getOrCompute();
  }

  /**
   * 强制刷新缓存
   */
  invalidate(): void {
    this.#cache = null;
  }

  /* ─── Cache + Compute ───────────────────────────── */

  #getOrCompute(): PanoramaResult {
    if (this.#cache) {
      return this.#cache;
    }

    const candidates = this.#discoverModules();
    this.#cache = this.#aggregator.compute(candidates);
    return this.#cache;
  }

  /**
   * 从 code_entities 和 bootstrap_dim_files 发现模块
   */
  #discoverModules(): ModuleCandidate[] {
    // 方式 1: 从 code_entities 中查 entity_type = 'module'
    const moduleEntities = this.#db
      .prepare(
        `SELECT DISTINCT entity_id, name FROM code_entities
         WHERE entity_type = 'module' AND project_root = ?`
      )
      .all(this.#projectRoot) as Array<Record<string, unknown>>;

    const moduleFiles = new Map<string, Set<string>>();

    // 收集模块的文件
    for (const me of moduleEntities) {
      const moduleName = me.entity_id as string;
      moduleFiles.set(moduleName, new Set());

      // 查 is_part_of 边 (entity → module)
      const parts = this.#db
        .prepare(
          `SELECT ke.from_id FROM knowledge_edges ke
           WHERE ke.to_id = ? AND ke.to_type = 'module' AND ke.relation = 'is_part_of'`
        )
        .all(moduleName) as Array<Record<string, unknown>>;

      for (const part of parts) {
        // 查实体文件
        const entity = this.#db
          .prepare(
            `SELECT file_path FROM code_entities
             WHERE entity_id = ? AND project_root = ? LIMIT 1`
          )
          .get(part.from_id as string, this.#projectRoot) as Record<string, unknown> | undefined;

        if (entity?.file_path) {
          moduleFiles.get(moduleName)!.add(entity.file_path as string);
        }
      }
    }

    // 方式 2: 如果模块数为 0，尝试从目录结构推断
    if (moduleFiles.size === 0) {
      return this.#discoverModulesFromFiles();
    }

    return [...moduleFiles.entries()].map(([name, files]) => ({
      name,
      inferredRole: inferTargetRole(name) as ModuleRole,
      files: [...files],
    }));
  }

  /**
   * 目录结构推断: 按顶层目录分组文件
   */
  #discoverModulesFromFiles(): ModuleCandidate[] {
    const allFiles = this.#db
      .prepare(`SELECT DISTINCT file_path FROM code_entities WHERE project_root = ?`)
      .all(this.#projectRoot) as Array<Record<string, unknown>>;

    const groups = new Map<string, string[]>();

    for (const row of allFiles) {
      const filePath = row.file_path as string;
      if (!filePath) {
        continue;
      }

      // 取相对于 projectRoot 的第一级目录作为模块名
      const relative = filePath.startsWith(this.#projectRoot)
        ? filePath.slice(this.#projectRoot.length).replace(/^\//, '')
        : filePath;
      const firstDir = relative.split('/')[0];
      if (!firstDir) {
        continue;
      }

      if (!groups.has(firstDir)) {
        groups.set(firstDir, []);
      }
      groups.get(firstDir)!.push(filePath);
    }

    return [...groups.entries()].map(([name, files]) => ({
      name,
      inferredRole: inferTargetRole(name) as ModuleRole,
      files,
    }));
  }
}
