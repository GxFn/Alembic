/**
 * PanoramaAggregator — 全景数据汇总
 *
 * 编排 RoleRefiner → CouplingAnalyzer → LayerInferrer，
 * 汇总为统一的 PanoramaResult，附加知识覆盖率和空白区检测。
 *
 * @module PanoramaAggregator
 */

import type { BootstrapRepositoryImpl } from '../../repository/bootstrap/BootstrapRepository.js';
import type { CodeEntityRepositoryImpl } from '../../repository/code/CodeEntityRepository.js';
import type { KnowledgeEdgeRepositoryImpl } from '../../repository/knowledge/KnowledgeEdgeRepository.js';
import type { KnowledgeRepositoryImpl } from '../../repository/knowledge/KnowledgeRepository.impl.js';
import type { CouplingAnalyzer } from './CouplingAnalyzer.js';
import { DimensionAnalyzer } from './DimensionAnalyzer.js';
import type { ConfigLayer, LayerInferrer } from './LayerInferrer.js';
import type {
  CallFlowSummary,
  ExternalDepProfile,
  PanoramaModule,
  PanoramaResult,
} from './PanoramaTypes.js';
import type { ModuleCandidate, RoleRefiner } from './RoleRefiner.js';
import { profileTechStack } from './TechStackProfiler.js';

/* ═══ Options ═════════════════════════════════════════════ */

export interface PanoramaAggregatorOptions {
  roleRefiner: RoleRefiner;
  couplingAnalyzer: CouplingAnalyzer;
  layerInferrer: LayerInferrer;
  bootstrapRepo: BootstrapRepositoryImpl;
  entityRepo: CodeEntityRepositoryImpl;
  edgeRepo: KnowledgeEdgeRepositoryImpl;
  knowledgeRepo: KnowledgeRepositoryImpl;
  projectRoot: string;
  dimensionAnalyzer?: DimensionAnalyzer;
}

/* ═══ PanoramaAggregator Class ════════════════════════════ */

export class PanoramaAggregator {
  readonly #roleRefiner: RoleRefiner;
  readonly #couplingAnalyzer: CouplingAnalyzer;
  readonly #layerInferrer: LayerInferrer;
  readonly #entityRepo: CodeEntityRepositoryImpl;
  readonly #edgeRepo: KnowledgeEdgeRepositoryImpl;
  readonly #knowledgeRepo: KnowledgeRepositoryImpl;
  readonly #projectRoot: string;
  readonly #dimensionAnalyzer: DimensionAnalyzer;

  constructor(opts: PanoramaAggregatorOptions) {
    this.#roleRefiner = opts.roleRefiner;
    this.#couplingAnalyzer = opts.couplingAnalyzer;
    this.#layerInferrer = opts.layerInferrer;
    this.#entityRepo = opts.entityRepo;
    this.#edgeRepo = opts.edgeRepo;
    this.#knowledgeRepo = opts.knowledgeRepo;
    this.#projectRoot = opts.projectRoot;
    this.#dimensionAnalyzer =
      opts.dimensionAnalyzer ??
      new DimensionAnalyzer(
        opts.bootstrapRepo,
        opts.entityRepo,
        opts.knowledgeRepo,
        opts.projectRoot
      );
  }

  /**
   * 计算完整全景数据
   * @param moduleCandidates 模块候选列表
   * @param options.configLayers 来自配置文件的层级声明（如 Boxfile layer 定义）
   */
  async compute(
    moduleCandidates: ModuleCandidate[],
    options?: { configLayers?: ConfigLayer[] | null }
  ): Promise<PanoramaResult> {
    // 1. RoleRefiner: 精化角色
    const refinedRoles = await this.#roleRefiner.refineAll(moduleCandidates);

    // 2. 构建模块-文件映射
    const moduleFiles = new Map<string, string[]>();
    for (const mc of moduleCandidates) {
      moduleFiles.set(mc.name, mc.files);
    }

    // 3. CouplingAnalyzer: 耦合分析（含外部依赖 fan-in）
    const externalModules = await this.#collectExternalModules();
    const coupling = await this.#couplingAnalyzer.analyze(moduleFiles, externalModules);

    // 4. LayerInferrer: 层级推断（优先使用配置层级）
    const modules = moduleCandidates.map((m) => m.name);
    const configModuleLayerMap = new Map<string, string>();
    for (const mc of moduleCandidates) {
      if (mc.configLayer) {
        configModuleLayerMap.set(mc.name, mc.configLayer);
      }
    }

    const layers = this.#layerInferrer.infer(coupling.edges, modules, coupling.cycles, {
      configLayers: options?.configLayers,
      moduleLayerMap: configModuleLayerMap.size > 0 ? configModuleLayerMap : undefined,
    });

    // 5. 构建层级映射 (模块名 → 层级号)
    const moduleLayerMap = new Map<string, number>();
    for (const level of layers.levels) {
      for (const mod of level.modules) {
        moduleLayerMap.set(mod, level.level);
      }
    }

    // 6. 项目级 recipe 总数（recipe scope 通常为 universal，不做模块强关联）
    const projectRecipeCount = await this.#getProjectRecipeCount();

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

    // 8.5 基于模块角色重命名层级（仅在拓扑推断模式下；配置层级保留原名）
    if (!layers.configBased) {
      this.#renameLayersByRole(layers, panoramaModules);
    }

    // 9. 多维度知识健康分析 (替代旧的基于模块文件数的覆盖率模型)
    const moduleRoles = moduleCandidates.map((m) => {
      const pm = panoramaModules.get(m.name);
      return pm?.refinedRole ?? m.inferredRole;
    });
    const { radar, gaps } = await this.#dimensionAnalyzer.analyze(moduleRoles);

    // 10. 调用流概要
    const callFlowSummary = await this.#computeCallFlowSummary();

    // 11. 外部依赖概况 + 技术栈画像
    const externalDeps = await this.#buildExternalDepProfiles(coupling.externalDeps);
    const techStack = externalDeps.length > 0 ? profileTechStack(externalDeps) : null;

    return {
      modules: panoramaModules,
      layers,
      cycles: coupling.cycles,
      gaps,
      healthRadar: radar,
      callFlowSummary,
      projectRecipeCount,
      externalDeps,
      techStack,
      computedAt: Date.now(),
    };
  }

  /* ─── Project Recipe Count ──────────────────────── */

  async #getProjectRecipeCount(): Promise<number> {
    try {
      return await this.#knowledgeRepo.countByCountableLifecycles();
    } catch {
      return 0;
    }
  }

  /* ─── External Dependencies ─────────────────────── */

  /**
   * 从 code_entities 收集标记为 external 的模块名
   */
  async #collectExternalModules(): Promise<Set<string>> {
    try {
      const rows = await this.#entityRepo.findModulesByNodeTypes(this.#projectRoot, [
        'external',
        'host',
      ]);
      return new Set(rows.map((r) => r.entityId));
    } catch {
      return new Set();
    }
  }

  /**
   * 将 CouplingAnalyzer 的外部依赖统计转为 ExternalDepProfile
   * 并从 code_entities 补充 layer/version 元数据
   */
  async #buildExternalDepProfiles(
    rawExternalDeps: Array<{ name: string; fanIn: number; dependedBy: string[] }>
  ): Promise<ExternalDepProfile[]> {
    if (rawExternalDeps.length === 0) {
      return [];
    }

    // 查询外部依赖的元数据
    const metadataMap = new Map<string, { layer?: string; version?: string }>();
    try {
      for (const dep of rawExternalDeps) {
        const entity = await this.#entityRepo.findByEntityIdOnly(dep.name, this.#projectRoot);

        if (entity?.metadata) {
          const meta = entity.metadata;
          metadataMap.set(dep.name, {
            layer: meta.layer as string | undefined,
            version: meta.version as string | undefined,
          });
        }
      }
    } catch {
      /* skip metadata enrichment errors */
    }

    return rawExternalDeps.map((dep) => {
      const meta = metadataMap.get(dep.name);
      return {
        name: dep.name,
        fanIn: dep.fanIn,
        dependedBy: dep.dependedBy,
        layer: meta?.layer,
        version: meta?.version,
      };
    });
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

      // 去重：优先尝试次高票角色名，仍冲突则追加位置描述
      if (usedNames.has(layerName)) {
        // 尝试次高票角色
        let resolved = false;
        if (roleVotes.size > 1) {
          const sortedRoles = [...roleVotes.entries()].sort((a, b) => b[1] - a[1]);
          for (let i = 1; i < sortedRoles.length; i++) {
            const altName =
              PanoramaAggregator.#ROLE_TO_LAYER[sortedRoles[i][0]] ?? sortedRoles[i][0];
            if (!usedNames.has(altName)) {
              layerName = altName;
              resolved = true;
              break;
            }
          }
        }
        // 仍冲突：使用位置描述而非数字后缀
        if (!resolved && usedNames.has(layerName)) {
          const pos =
            level.level <= maxLevel * 0.33
              ? 'Core'
              : level.level >= maxLevel * 0.67
                ? 'App'
                : 'Mid';
          const qualifiedName = `${pos} ${layerName}`;
          layerName = usedNames.has(qualifiedName) ? `${layerName} L${level.level}` : qualifiedName;
        }
      }
      usedNames.add(layerName);

      level.name = layerName;
    }
  }

  /* ─── Call Flow Summary ─────────────────────────── */

  async #computeCallFlowSummary(): Promise<CallFlowSummary> {
    // 最频繁被调用的方法
    const topCalled = await this.#edgeRepo.findTopCalledNodes(10);

    // 入口点: 只有出度没有入度的方法
    const entryPoints = await this.#edgeRepo.findEntryPoints(20);

    // 数据生产者: data_flow outFlow >> inFlow
    const dataProducers = await this.#edgeRepo.findTopDataFlowSources(10, 3);

    // 数据消费者: data_flow inFlow >> outFlow
    const dataConsumers = await this.#edgeRepo.findTopDataFlowSinks(10, 3);

    return {
      topCalledMethods: topCalled.map((r) => ({
        id: r.toId,
        callCount: r.callCount,
      })),
      entryPoints,
      dataProducers,
      dataConsumers,
    };
  }
}
