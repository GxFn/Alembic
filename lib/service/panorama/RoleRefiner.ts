/**
 * RoleRefiner — 四重信号融合角色精化
 *
 * 将 TargetClassifier 的正则推断 (~65% 准确率) 提升到 ≥90%，
 * 通过融合 AST 结构、CallGraph 行为、DataFlow 数据流、EntityGraph 拓扑四重信号。
 *
 * 信号权重:
 *   AST 结构        0.30   继承链/协议/import/后缀
 *   CallGraph 行为   0.30   被调用分析/扇入扇出比/调用类型
 *   DataFlow 数据流  0.15   源汇分析/转换检测
 *   EntityGraph 拓扑 0.10   入度分析/模式检测
 *   正则基线         0.15   TargetClassifier 结果
 *
 * @module RoleRefiner
 */

import type { LanguageFamily, RolePattern } from '#shared/LanguageProfiles.js';
import { LanguageProfiles } from '#shared/LanguageProfiles.js';
import type { BootstrapRepositoryImpl } from '../../repository/bootstrap/BootstrapRepository.js';
import type { CodeEntityRepositoryImpl } from '../../repository/code/CodeEntityRepository.js';
import type { KnowledgeEdgeRepositoryImpl } from '../../repository/knowledge/KnowledgeEdgeRepository.js';
import type { ModuleRole } from './PanoramaTypes.js';

// re-export for backward compat
export type { ModuleRole } from './PanoramaTypes.js';

export interface RoleSignal {
  role: ModuleRole;
  confidence: number; // 0-1
  weight: number;
  source: string;
}

export type RoleResolution = 'clear' | 'uncertain' | 'fallback';

export interface RefinedRole {
  refinedRole: ModuleRole;
  confidence: number;
  resolution: RoleResolution;
  alternatives?: Array<[string, number]>;
  signals: RoleSignal[];
}

export interface ModuleCandidate {
  name: string;
  inferredRole: ModuleRole;
  files: string[];
  /** 来自配置文件的层级名称（如 Boxfile 中的 layer 声明） */
  configLayer?: string;
}

/* ═══ Constants ═══════════════════════════════════════════ */

const WEIGHTS = {
  ast: 0.3,
  callGraph: 0.3,
  dataFlow: 0.15,
  entityGraph: 0.1,
  regex: 0.15,
} as const;

/**
 * 配置文件层级名 → 模块角色映射
 * 当配置文件声明了层级时（如 Boxfile 的 layer），
 * 层级名是判断模块角色的强信号
 */
const CONFIG_LAYER_TO_ROLE: Record<string, ModuleRole> = {
  vendors: 'utility',
  vendor: 'utility',
  basics: 'core',
  basic: 'core',
  foundation: 'core',
  core: 'core',
  services: 'service',
  service: 'service',
  components: 'feature',
  component: 'feature',
  accessories: 'feature',
  accessory: 'feature',
  underlays: 'feature',
  application: 'app',
  app: 'app',
  ui: 'ui',
  networking: 'networking',
  network: 'networking',
  storage: 'storage',
  model: 'model',
  test: 'test',
  tests: 'test',
};

/* ═══ RoleRefiner Class ═══════════════════════════════════ */

export class RoleRefiner {
  readonly #bootstrapRepo: BootstrapRepositoryImpl;
  readonly #entityRepo: CodeEntityRepositoryImpl;
  readonly #edgeRepo: KnowledgeEdgeRepositoryImpl;
  readonly #projectRoot: string;
  #families: LanguageFamily[] | null = null;
  #superclassMap: Record<string, ModuleRole> | null = null;
  #protocolMap: Record<string, ModuleRole> | null = null;
  #importPatterns: RolePattern[] | null = null;

  constructor(
    bootstrapRepo: BootstrapRepositoryImpl,
    entityRepo: CodeEntityRepositoryImpl,
    edgeRepo: KnowledgeEdgeRepositoryImpl,
    projectRoot: string
  ) {
    this.#bootstrapRepo = bootstrapRepo;
    this.#entityRepo = entityRepo;
    this.#edgeRepo = edgeRepo;
    this.#projectRoot = projectRoot;
  }

  /** 检测项目语言族，基于 bootstrap_snapshots.primary_lang */
  async #detectFamilies(): Promise<LanguageFamily[]> {
    if (this.#families) {
      return this.#families;
    }

    const primaryLang = await this.#bootstrapRepo.getLatestPrimaryLang(this.#projectRoot);
    this.#families = LanguageProfiles.resolveFamilies(primaryLang);

    return this.#families;
  }

  /** 构建当前项目语言族的超类合并映射 */
  async #getSuperclassMap(): Promise<Record<string, ModuleRole>> {
    if (this.#superclassMap) {
      return this.#superclassMap;
    }
    this.#superclassMap = LanguageProfiles.superclassRoles(await this.#detectFamilies());
    return this.#superclassMap;
  }

  /** 构建当前项目语言族的协议合并映射 */
  async #getProtocolMap(): Promise<Record<string, ModuleRole>> {
    if (this.#protocolMap) {
      return this.#protocolMap;
    }
    this.#protocolMap = LanguageProfiles.protocolRoles(await this.#detectFamilies());
    return this.#protocolMap;
  }

  /** 构建当前项目语言族的 import 模式列表 */
  async #getImportPatterns(): Promise<RolePattern[]> {
    if (this.#importPatterns) {
      return this.#importPatterns;
    }
    this.#importPatterns = LanguageProfiles.importRolePatterns(await this.#detectFamilies());
    return this.#importPatterns;
  }

  /**
   * 精化单个模块的角色
   */
  async refineRole(module: ModuleCandidate): Promise<RefinedRole> {
    const signals: RoleSignal[] = [];

    // 1. AST 结构信号 (0.30)
    signals.push(...(await this.#extractAstSignals(module)));

    // 2. CallGraph 行为信号 (0.30)
    signals.push(...(await this.#extractCallSignals(module)));

    // 3. DataFlow 数据流信号 (0.15)
    signals.push(...(await this.#extractFlowSignals(module)));

    // 4. EntityGraph 拓扑信号 (0.10)
    signals.push(...(await this.#extractTopoSignals(module)));

    // 4.5. 配置层级信号 — 来自 Boxfile/Tuist 等配置文件的 layer 声明
    if (module.configLayer) {
      const layerRole = CONFIG_LAYER_TO_ROLE[module.configLayer.toLowerCase()];
      if (layerRole) {
        signals.push({
          role: layerRole,
          confidence: 0.85,
          weight: WEIGHTS.ast, // 与 AST 等权重级别 (0.30)
          source: 'config-layer',
        });
      }
    }

    // 5. 正则基线 (0.15)
    signals.push({
      role: module.inferredRole,
      confidence: 0.5,
      weight: WEIGHTS.regex,
      source: 'regex-baseline',
    });

    // 5.5. 项目同名模块 → 主 App 目标（强信号）
    // 当模块名与项目根目录同名时，几乎一定是主 App Target
    const projectDirName = this.#projectRoot.replace(/\/+$/, '').split('/').pop() ?? '';
    if (projectDirName && module.name.toLowerCase() === projectDirName.toLowerCase()) {
      signals.push({
        role: 'app',
        confidence: 0.95,
        weight: WEIGHTS.ast, // 0.30，与 AST 同级
        source: 'project-name-match',
      });
    }

    // 加权投票
    const roleScores: Record<string, number> = {};
    for (const signal of signals) {
      roleScores[signal.role] = (roleScores[signal.role] ?? 0) + signal.confidence * signal.weight;
    }

    const sorted = Object.entries(roleScores).sort((a, b) => b[1] - a[1]);
    if (sorted.length === 0) {
      return {
        refinedRole: module.inferredRole,
        confidence: 0,
        resolution: 'fallback',
        signals,
      };
    }

    const [topRole, topScore] = sorted[0];
    const secondScore = sorted[1]?.[1] ?? 0;

    // 冲突解决
    if (topScore > 0.7) {
      return {
        refinedRole: topRole as ModuleRole,
        confidence: Math.min(topScore, 1),
        resolution: 'clear',
        signals,
      };
    }
    if (topScore - secondScore < 0.1) {
      return {
        refinedRole: topRole as ModuleRole,
        confidence: Math.min(topScore, 1),
        resolution: 'uncertain',
        alternatives: sorted.slice(0, 3) as Array<[string, number]>,
        signals,
      };
    }
    return {
      refinedRole: topRole as ModuleRole,
      confidence: Math.min(topScore, 1),
      resolution: topScore > 0.4 ? 'clear' : 'fallback',
      signals,
    };
  }

  /**
   * 批量精化所有模块
   */
  async refineAll(modules: ModuleCandidate[]): Promise<Map<string, RefinedRole>> {
    const result = new Map<string, RefinedRole>();
    for (const m of modules) {
      result.set(m.name, await this.refineRole(m));
    }
    return result;
  }

  /* ─── Signal Extractors ──────────────────────────── */

  /** AST 结构信号: 继承链、协议、import */
  async #extractAstSignals(module: ModuleCandidate): Promise<RoleSignal[]> {
    const signals: RoleSignal[] = [];
    const filePaths = module.files;
    if (filePaths.length === 0) {
      return signals;
    }

    // 查询模块内实体的继承关系
    const entities = await this.#entityRepo.findByProjectAndFilePaths(this.#projectRoot, filePaths);

    const roleCounts: Record<string, number> = {};
    const superclassMap = await this.#getSuperclassMap();
    const protocolMap = await this.#getProtocolMap();

    for (const entity of entities) {
      // 继承链推断
      const superclass = entity.superclass as string | null;
      if (superclass && superclassMap[superclass]) {
        const role = superclassMap[superclass];
        roleCounts[role] = (roleCounts[role] ?? 0) + 1;
      }

      // 协议推断
      const protocols = entity.protocols ?? [];
      for (const proto of protocols) {
        if (protocolMap[proto]) {
          const role = protocolMap[proto];
          roleCounts[role] = (roleCounts[role] ?? 0) + 0.5;
        }
      }
    }

    // import 模式推断
    const imports = await this.#edgeRepo.findOutgoingByRelation(module.name, 'depends_on');

    for (const imp of imports) {
      const depName = imp.toId.toLowerCase();
      for (const pat of await this.#getImportPatterns()) {
        if (pat.regex.test(depName)) {
          roleCounts[pat.role] = (roleCounts[pat.role] ?? 0) + 0.5;
        }
      }
    }

    // 转换为信号
    const totalSignals = Object.values(roleCounts).reduce((a, b) => a + b, 0);
    if (totalSignals > 0) {
      for (const [role, count] of Object.entries(roleCounts)) {
        signals.push({
          role: role as ModuleRole,
          confidence: Math.min(count / totalSignals, 1),
          weight: WEIGHTS.ast,
          source: 'ast-structure',
        });
      }
    }

    return signals;
  }

  /** CallGraph 行为信号: 调用流向分析 */
  async #extractCallSignals(module: ModuleCandidate): Promise<RoleSignal[]> {
    const signals: RoleSignal[] = [];

    const filePaths = module.files;
    if (filePaths.length === 0) {
      return signals;
    }

    // fan-out: 模块内实体调用外部
    const fanOut = await this.#edgeRepo.countEdgesJoinedByEntityFiles(
      this.#projectRoot,
      filePaths,
      'calls',
      'from'
    );

    // fan-in: 外部调用模块内实体
    const fanIn = await this.#edgeRepo.countEdgesJoinedByEntityFiles(
      this.#projectRoot,
      filePaths,
      'calls',
      'to'
    );

    if (fanIn + fanOut === 0) {
      return signals;
    }

    const ratio = fanIn / (fanIn + fanOut);

    // 高被调用 → 偏 core/service (被依赖)
    // 高调用 → 偏 app/ui (消费者)
    if (ratio > 0.7) {
      signals.push({
        role: 'core',
        confidence: ratio * 0.8,
        weight: WEIGHTS.callGraph,
        source: 'call-fanin-heavy',
      });
    } else if (ratio < 0.3) {
      signals.push({
        role: 'ui',
        confidence: (1 - ratio) * 0.6,
        weight: WEIGHTS.callGraph,
        source: 'call-fanout-heavy',
      });
    } else {
      signals.push({
        role: 'service',
        confidence: 0.5,
        weight: WEIGHTS.callGraph,
        source: 'call-balanced',
      });
    }

    return signals;
  }

  /** DataFlow 数据流信号: 源/汇分析 */
  async #extractFlowSignals(module: ModuleCandidate): Promise<RoleSignal[]> {
    const signals: RoleSignal[] = [];
    const filePaths = module.files;
    if (filePaths.length === 0) {
      return signals;
    }

    // data_flow out (data producer)
    const out = await this.#edgeRepo.countEdgesJoinedByEntityFiles(
      this.#projectRoot,
      filePaths,
      'data_flow',
      'from'
    );

    // data_flow in (data consumer)
    const _in = await this.#edgeRepo.countEdgesJoinedByEntityFiles(
      this.#projectRoot,
      filePaths,
      'data_flow',
      'to'
    );

    if (out + _in === 0) {
      return signals;
    }

    // 大量产出数据 → model/networking
    if (out > _in * 2) {
      signals.push({
        role: 'model',
        confidence: 0.6,
        weight: WEIGHTS.dataFlow,
        source: 'dataflow-producer',
      });
    }
    // 大量消费数据 → ui
    if (_in > out * 2) {
      signals.push({
        role: 'ui',
        confidence: 0.5,
        weight: WEIGHTS.dataFlow,
        source: 'dataflow-consumer',
      });
    }

    return signals;
  }

  /** EntityGraph 拓扑信号: 入度分析/模式检测 */
  async #extractTopoSignals(module: ModuleCandidate): Promise<RoleSignal[]> {
    const signals: RoleSignal[] = [];

    // 查模块下是否有 singleton / delegate 等设计模式
    const patterns = await this.#edgeRepo.findPatternsUsedByEntities(
      this.#projectRoot,
      module.files
    );

    for (const name of patterns) {
      const lowerName = name?.toLowerCase();
      if (!lowerName) {
        continue;
      }
      if (lowerName === 'singleton') {
        signals.push({
          role: 'service',
          confidence: 0.6,
          weight: WEIGHTS.entityGraph,
          source: 'pattern-singleton',
        });
      }
      if (lowerName === 'delegate') {
        signals.push({
          role: 'ui',
          confidence: 0.4,
          weight: WEIGHTS.entityGraph,
          source: 'pattern-delegate',
        });
      }
    }

    return signals;
  }
}
