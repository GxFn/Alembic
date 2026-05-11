/**
 * CouplingAnalyzer — 模块耦合分析
 *
 * 三边融合 (import + call + dataFlow) 构建加权依赖图，
 * 使用 Tarjan SCC 检测循环依赖，计算 fanIn/fanOut。
 *
 * @module CouplingAnalyzer
 */

import { readFileSync } from 'node:fs';
import { LanguageProfiles } from '#shared/LanguageProfiles.js';
import type { CodeEntityRepositoryImpl } from '../../repository/code/CodeEntityRepository.js';
import type { KnowledgeEdgeRepositoryImpl } from '../../repository/knowledge/KnowledgeEdgeRepository.js';
import type { CyclicDependency, Edge } from './PanoramaTypes.js';

/* ═══ Types ═══════════════════════════════════════════════ */

export interface CouplingMetrics {
  fanIn: number;
  fanOut: number;
}

export interface ExternalDepMetrics {
  name: string;
  fanIn: number;
  /** 依赖此外部库的本地模块列表 */
  dependedBy: string[];
}

export interface CouplingResult {
  cycles: CyclicDependency[];
  metrics: Map<string, CouplingMetrics>;
  edges: Edge[];
  /** 外部依赖 fan-in 统计（按 fan-in 降序排列） */
  externalDeps: ExternalDepMetrics[];
}

/* ═══ Edge Weights ════════════════════════════════════════ */

const EDGE_WEIGHTS: Record<string, number> = {
  depends_on: 0.5,
  calls: 1.0,
  data_flow: 0.8,
};

/* ═══ CouplingAnalyzer Class ══════════════════════════════ */

export class CouplingAnalyzer {
  readonly #edgeRepo: KnowledgeEdgeRepositoryImpl;
  readonly #entityRepo: CodeEntityRepositoryImpl;
  readonly #projectRoot: string;

  constructor(
    edgeRepo: KnowledgeEdgeRepositoryImpl,
    entityRepo: CodeEntityRepositoryImpl,
    projectRoot: string
  ) {
    this.#edgeRepo = edgeRepo;
    this.#entityRepo = entityRepo;
    this.#projectRoot = projectRoot;
  }

  /**
   * 分析模块间耦合关系
   * @param moduleFiles - Map<moduleName, filePaths[]>
   * @param externalModules - 外部模块名集合（无源码但参与依赖图）
   */
  async analyze(
    moduleFiles: Map<string, string[]>,
    externalModules?: Set<string>
  ): Promise<CouplingResult> {
    // 1. 构建 file → module 反向索引
    const fileToModule = new Map<string, string>();
    for (const [mod, files] of moduleFiles) {
      for (const f of files) {
        fileToModule.set(f, mod);
      }
    }

    // 2. 从 knowledge_edges 聚合模块间边
    const edges = await this.#buildModuleEdges(moduleFiles, fileToModule);

    // 3. 建图
    const adjacency = new Map<string, Map<string, number>>();
    const allModules = new Set<string>(moduleFiles.keys());

    for (const edge of edges) {
      allModules.add(edge.from);
      allModules.add(edge.to);

      if (!adjacency.has(edge.from)) {
        adjacency.set(edge.from, new Map());
      }
      const existing = adjacency.get(edge.from)!.get(edge.to) ?? 0;
      adjacency.get(edge.from)!.set(edge.to, existing + edge.weight);
    }

    // 4. Tarjan SCC
    const cycles = this.#tarjanSCC(adjacency, allModules);

    // 5. fanIn / fanOut
    const metrics = new Map<string, CouplingMetrics>();
    for (const mod of allModules) {
      metrics.set(mod, { fanIn: 0, fanOut: 0 });
    }

    for (const edge of edges) {
      if (edge.from === edge.to) {
        continue;
      }
      const fromM = metrics.get(edge.from);
      const toM = metrics.get(edge.to);
      if (fromM) {
        fromM.fanOut++;
      }
      if (toM) {
        toM.fanIn++;
      }
    }

    // 5.5 外部依赖 fan-in 统计
    const externalDeps = await this.#computeExternalFanIn(moduleFiles, externalModules);

    // 去重边 (同 from→to 聚合)
    const dedupEdges = this.#deduplicateEdges(edges);

    return { cycles, metrics, edges: dedupEdges, externalDeps };
  }

  /* ─── Internal helpers ──────────────────────────── */

  async #buildModuleEdges(
    moduleFiles: Map<string, string[]>,
    fileToModule: Map<string, string>
  ): Promise<Edge[]> {
    const edges: Edge[] = [];
    const relations = ['depends_on', 'calls', 'data_flow'];

    // 跟踪哪些模块有 DB 边（用于判断是否需要 import 推断）
    const modulesWithDbEdges = new Set<string>();

    for (const relation of relations) {
      const weight = EDGE_WEIGHTS[relation] ?? 0.5;

      // 查询该类型的边（仅限当前项目：至少 from 侧实体属于本项目）
      const rows = await this.#edgeRepo.findEdgesFilteredByEntityExistence(
        relation,
        this.#projectRoot
      );

      for (const row of rows) {
        const fromId = row.fromId;
        const toId = row.toId;
        const fromType = row.fromType;
        const toType = row.toType;

        // module-to-module 直接边 (depends_on)
        if (fromType === 'module' && toType === 'module') {
          if (fromId !== toId && moduleFiles.has(fromId) && moduleFiles.has(toId)) {
            edges.push({ from: fromId, to: toId, weight, relation });
            modulesWithDbEdges.add(fromId);
          }
          continue;
        }

        // entity-to-entity 边 → 解析 file → module
        const fromModule = await this.#resolveEntityModule(fromId, fromType, fileToModule);
        const toModule = await this.#resolveEntityModule(toId, toType, fileToModule);

        if (fromModule && toModule && fromModule !== toModule) {
          edges.push({ from: fromModule, to: toModule, weight, relation });
          modulesWithDbEdges.add(fromModule);
        }
      }
    }

    // 对没有 DB 边的模块，通过 import 扫描推断依赖
    const importEdges = this.#inferEdgesFromImports(moduleFiles, modulesWithDbEdges);
    edges.push(...importEdges);

    return edges;
  }

  async #resolveEntityModule(
    entityId: string,
    _entityType: string,
    fileToModule: Map<string, string>
  ): Promise<string | null> {
    // 先查实体所在文件
    const entity = await this.#entityRepo.findByEntityIdOnly(entityId, this.#projectRoot);

    if (!entity?.filePath) {
      return null;
    }

    return fileToModule.get(entity.filePath) ?? null;
  }

  /**
   * Tarjan 强连通分量算法
   */
  #tarjanSCC(
    adjacency: Map<string, Map<string, number>>,
    allNodes: Set<string>
  ): CyclicDependency[] {
    let index = 0;
    const stack: string[] = [];
    const onStack = new Set<string>();
    const indices = new Map<string, number>();
    const lowlinks = new Map<string, number>();
    const sccs: string[][] = [];

    const strongConnect = (v: string) => {
      indices.set(v, index);
      lowlinks.set(v, index);
      index++;
      stack.push(v);
      onStack.add(v);

      const neighbors = adjacency.get(v);
      if (neighbors) {
        for (const w of neighbors.keys()) {
          if (!indices.has(w)) {
            strongConnect(w);
            lowlinks.set(v, Math.min(lowlinks.get(v)!, lowlinks.get(w)!));
          } else if (onStack.has(w)) {
            lowlinks.set(v, Math.min(lowlinks.get(v)!, indices.get(w)!));
          }
        }
      }

      if (lowlinks.get(v) === indices.get(v)) {
        const scc: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          scc.push(w);
        } while (w !== v);
        sccs.push(scc);
      }
    };

    for (const node of allNodes) {
      if (!indices.has(node)) {
        strongConnect(node);
      }
    }

    // 过滤出 size > 1 的 SCC (即循环依赖)
    return sccs
      .filter((scc) => scc.length > 1)
      .map((cycle) => ({
        cycle: cycle.reverse(),
        severity: cycle.length > 3 ? ('error' as const) : ('warning' as const),
      }));
  }

  /**
   * 统计外部依赖的 fan-in（被多少本地模块依赖）
   * 数据来源：knowledge_edges 中 from_type='module' AND to_type='module' 且 to 不在 moduleFiles 中
   */
  async #computeExternalFanIn(
    moduleFiles: Map<string, string[]>,
    externalModules?: Set<string>
  ): Promise<ExternalDepMetrics[]> {
    const fanInMap = new Map<string, Set<string>>();

    // 从 DB 查询 module-to-module depends_on 边
    const rows = await this.#edgeRepo.findModuleDependencyPairs();

    for (const row of rows) {
      const fromId = row.fromId;
      const toId = row.toId;

      // from 必须是本地模块, to 必须是外部模块
      if (!moduleFiles.has(fromId)) {
        continue;
      }
      if (moduleFiles.has(toId)) {
        continue;
      }
      // 如果提供了 externalModules 集合，检查 toId 是否在其中
      if (externalModules && !externalModules.has(toId)) {
        continue;
      }

      if (!fanInMap.has(toId)) {
        fanInMap.set(toId, new Set());
      }
      fanInMap.get(toId)!.add(fromId);
    }

    // 转换为排序数组（按 fan-in 降序）
    return [...fanInMap.entries()]
      .map(([name, deps]) => ({
        name,
        fanIn: deps.size,
        dependedBy: [...deps].sort(),
      }))
      .sort((a, b) => b.fanIn - a.fanIn);
  }

  /**
   * 对无 DB 边的模块，扫描源文件 import 语句推断依赖。
   * 典型场景：iOS 宿主应用中未声明在 Boxfile 的子模块。
   */
  #inferEdgesFromImports(
    moduleFiles: Map<string, string[]>,
    modulesWithDbEdges: Set<string>
  ): Edge[] {
    const sourceExts = LanguageProfiles.sourceExts;
    const importPatterns = LanguageProfiles.importPatterns;
    const MAX_READ_BYTES = 8192; // 只读文件前 8KB（import 几乎总在文件头部）
    const edges: Edge[] = [];

    // 建立已知模块名集合（用于快速匹配 import 目标）
    const knownModules = new Set(moduleFiles.keys());

    for (const [modName, files] of moduleFiles) {
      // 跳过已有 DB 边的模块——它们的依赖已由 Boxfile/配置声明
      if (modulesWithDbEdges.has(modName)) {
        continue;
      }

      const importedModules = new Set<string>();

      for (const filePath of files) {
        // 只扫描源码文件
        const dotIdx = filePath.lastIndexOf('.');
        if (dotIdx < 0) {
          continue;
        }
        const ext = filePath.slice(dotIdx).toLowerCase();
        if (!sourceExts.has(ext)) {
          continue;
        }

        let content: string;
        try {
          const fd = readFileSync(filePath, { flag: 'r' });
          content =
            fd.length > MAX_READ_BYTES
              ? fd.subarray(0, MAX_READ_BYTES).toString('utf8')
              : fd.toString('utf8');
        } catch {
          continue; // 文件不可读则跳过
        }

        // 逐行匹配 import 模式
        const lines = content.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          for (const pattern of importPatterns) {
            const m = pattern.regex.exec(trimmed);
            if (m) {
              const candidates = pattern.extract(m);
              for (const c of candidates) {
                if (c) {
                  importedModules.add(c);
                }
              }
            }
          }
        }
      }

      // 生成边：仅在目标是已知模块且非自身时
      for (const imported of importedModules) {
        if (imported !== modName && knownModules.has(imported)) {
          edges.push({
            from: modName,
            to: imported,
            weight: EDGE_WEIGHTS.depends_on,
            relation: 'depends_on',
          });
        }
      }
    }

    return edges;
  }

  #deduplicateEdges(edges: Edge[]): Edge[] {
    const key = (e: Edge) => `${e.from}→${e.to}`;
    const map = new Map<string, Edge>();
    for (const e of edges) {
      const k = key(e);
      const existing = map.get(k);
      if (existing) {
        existing.weight = Math.max(existing.weight, e.weight);
      } else {
        map.set(k, { ...e });
      }
    }
    return [...map.values()];
  }
}
