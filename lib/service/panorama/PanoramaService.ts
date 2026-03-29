/**
 * PanoramaService — 全景服务主入口
 *
 * 提供 4 个 operation:
 *   overview — 项目骨架 + 层级 + token 预算截断
 *   module   — 单模块详情 + Recipe 覆盖率
 *   gaps     — 知识空白区 (有代码无 Recipe)
 *   health   — 全景健康度 (覆盖率 + 耦合度 + 衰退)
 *
 * 模块发现委托给 ModuleDiscoverer（SRP）。
 * 内存缓存 + 24h 过期策略。
 *
 * @module PanoramaService
 */

import type { SignalBus } from '../../infrastructure/signal/SignalBus.js';
import { ModuleDiscoverer } from './ModuleDiscoverer.js';
import type { PanoramaAggregator } from './PanoramaAggregator.js';
import type { PanoramaScanner } from './PanoramaScanner.js';
import type {
  CeDbLike,
  HealthRadar,
  KnowledgeGap,
  PanoramaModule,
  PanoramaResult,
} from './PanoramaTypes.js';

/* ═══ Types ═══════════════════════════════════════════════ */

export interface PanoramaServiceOptions {
  aggregator: PanoramaAggregator;
  db: CeDbLike;
  projectRoot: string;
  scanner?: PanoramaScanner;
  moduleDiscoverer?: ModuleDiscoverer;
  signalBus?: SignalBus;
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
  /** 多维度知识健康雷达 */
  healthRadar: HealthRadar;
  computedAt: number;
  stale: boolean;
}

export interface PanoramaModuleDetail {
  module: PanoramaModule;
  layerName: string;
  neighbors: Array<{ name: string; direction: 'in' | 'out'; weight: number }>;
}

export interface PanoramaHealth {
  /** 多维度知识健康雷达 */
  healthRadar: HealthRadar;
  avgCoupling: number;
  cycleCount: number;
  gapCount: number;
  highPriorityGaps: number;
  moduleCount: number;
  /** 综合健康分 0-100 (维度覆盖 60 + 无循环 20 + 无高优空白 10 + 耦合适中 10) */
  healthScore: number;
}

/* ═══ Constants ═══════════════════════════════════════════ */

const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24h

/* ═══ PanoramaService Class ═══════════════════════════════ */

export class PanoramaService {
  readonly #aggregator: PanoramaAggregator;
  readonly #db: CeDbLike;
  readonly #projectRoot: string;
  readonly #scanner: PanoramaScanner | null;
  readonly #moduleDiscoverer: ModuleDiscoverer;
  readonly #signalBus: SignalBus | null;
  #cache: PanoramaResult | null = null;
  #scanPromise: Promise<void> | null = null;
  #lastOverview: PanoramaOverview | null = null;

  constructor(opts: PanoramaServiceOptions) {
    this.#aggregator = opts.aggregator;
    this.#db = opts.db;
    this.#projectRoot = opts.projectRoot;
    this.#scanner = opts.scanner ?? null;
    this.#moduleDiscoverer =
      opts.moduleDiscoverer ?? new ModuleDiscoverer(opts.db, opts.projectRoot);
    this.#signalBus = opts.signalBus ?? null;

    // Phase 2: 订阅信号标记缓存失效
    if (this.#signalBus) {
      this.#signalBus.subscribe('guard|lifecycle|usage', () => {
        this.#cache = null;
      });
    }
  }

  /* ─── Public API ────────────────────────────────── */

  /**
   * 获取项目全景概览
   */
  getOverview(): PanoramaOverview {
    const result = this.#getOrCompute();
    const isStale = Date.now() - result.computedAt > STALE_THRESHOLD_MS;

    let totalFiles = 0;
    for (const [, mod] of result.modules) {
      totalFiles += mod.fileCount;
    }
    // 使用项目级 recipe 总数，而非 per-module 之和
    // 因为大多数 recipe scope 为 universal，无法匹配到具体模块
    const totalRecipes = result.projectRecipeCount;

    const overview: PanoramaOverview = {
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
      healthRadar: result.healthRadar,
      computedAt: result.computedAt,
      stale: isStale,
    };

    // Phase 3: 发射 panorama 信号 — 覆盖率/健康度变化检测
    if (this.#signalBus && this.#lastOverview) {
      if (Math.abs(overview.overallCoverage - this.#lastOverview.overallCoverage) >= 0.05) {
        this.#signalBus.send('panorama', 'PanoramaService.coverage', overview.overallCoverage, {
          metadata: {
            oldCoverage: this.#lastOverview.overallCoverage,
            newCoverage: overview.overallCoverage,
          },
        });
      }
    }
    this.#lastOverview = overview;

    return overview;
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

    // 从 DB 查邻居边
    const neighbors: Array<{ name: string; direction: 'in' | 'out'; weight: number }> = [];

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

    let totalCoupling = 0;
    let count = 0;

    for (const [, mod] of result.modules) {
      totalCoupling += mod.fanIn + mod.fanOut;
      count++;
    }

    const avgCoupling = count > 0 ? totalCoupling / count : 0;
    const highPriorityGaps = result.gaps.filter((g) => g.priority === 'high').length;
    const radar = result.healthRadar;

    // 健康分: 100 分制 (基于维度覆盖率 + 结构健康)
    // 维度覆盖 60 分 + 无循环 20 分 + 无高优空白 10 分 + 耦合度适中 10 分
    let healthScore = radar.overallScore * 0.6;
    healthScore += result.cycles.length === 0 ? 20 : Math.max(0, 20 - result.cycles.length * 5);
    healthScore += highPriorityGaps === 0 ? 10 : Math.max(0, 10 - highPriorityGaps * 2);
    healthScore += avgCoupling < 10 ? 10 : Math.max(0, 10 - (avgCoupling - 10));
    healthScore = Math.round(Math.max(0, Math.min(100, healthScore)));

    return {
      healthRadar: radar,
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
   * 确保全景数据已就绪（无数据时自动扫描）
   * MCP handler / HTTP route 应在返回数据前调用此方法
   */
  async ensureData(): Promise<void> {
    if (!this.#scanner) {
      return;
    }
    if (!this.#scanPromise) {
      this.#scanPromise = this.#scanner.ensureData().then(() => {
        this.#cache = null; // 扫描后清除缓存以触发重新计算
      });
    }
    await this.#scanPromise;
  }

  /**
   * 强制刷新缓存
   */
  invalidate(): void {
    this.#cache = null;
    this.#scanPromise = null;
  }

  /**
   * 强制重新扫描（invalidate + 重置 scanner）
   */
  async rescan(): Promise<void> {
    this.invalidate();
    if (this.#scanner) {
      this.#scanner.reset();
      await this.ensureData();
    }
  }

  /* ─── Cache + Compute ───────────────────────────── */

  #getOrCompute(): PanoramaResult {
    if (this.#cache) {
      return this.#cache;
    }

    const candidates = this.#moduleDiscoverer.discover();
    this.#cache = this.#aggregator.compute(candidates);
    return this.#cache;
  }
}
