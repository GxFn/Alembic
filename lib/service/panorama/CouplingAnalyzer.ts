/**
 * CouplingAnalyzer — 模块耦合分析
 *
 * 三边融合 (import + call + dataFlow) 构建加权依赖图，
 * 使用 Tarjan SCC 检测循环依赖，计算 fanIn/fanOut。
 *
 * @module CouplingAnalyzer
 */

import type { CeDbLike, CyclicDependency, Edge } from './PanoramaTypes.js';

/* ═══ Types ═══════════════════════════════════════════════ */

export interface CouplingMetrics {
  fanIn: number;
  fanOut: number;
}

export interface CouplingResult {
  cycles: CyclicDependency[];
  metrics: Map<string, CouplingMetrics>;
  edges: Edge[];
}

/* ═══ Edge Weights ════════════════════════════════════════ */

const EDGE_WEIGHTS: Record<string, number> = {
  depends_on: 0.5,
  calls: 1.0,
  data_flow: 0.8,
};

/* ═══ CouplingAnalyzer Class ══════════════════════════════ */

export class CouplingAnalyzer {
  readonly #db: CeDbLike;
  readonly #projectRoot: string;

  constructor(db: CeDbLike, projectRoot: string) {
    this.#db = db;
    this.#projectRoot = projectRoot;
  }

  /**
   * 分析模块间耦合关系
   * @param moduleFiles - Map<moduleName, filePaths[]>
   */
  analyze(moduleFiles: Map<string, string[]>): CouplingResult {
    // 1. 构建 file → module 反向索引
    const fileToModule = new Map<string, string>();
    for (const [mod, files] of moduleFiles) {
      for (const f of files) {
        fileToModule.set(f, mod);
      }
    }

    // 2. 从 knowledge_edges 聚合模块间边
    const edges = this.#buildModuleEdges(moduleFiles, fileToModule);

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

    // 去重边 (同 from→to 聚合)
    const dedupEdges = this.#deduplicateEdges(edges);

    return { cycles, metrics, edges: dedupEdges };
  }

  /* ─── Internal helpers ──────────────────────────── */

  #buildModuleEdges(moduleFiles: Map<string, string[]>, fileToModule: Map<string, string>): Edge[] {
    const edges: Edge[] = [];
    const relations = ['depends_on', 'calls', 'data_flow'];

    for (const relation of relations) {
      const weight = EDGE_WEIGHTS[relation] ?? 0.5;

      // 查询该类型的边（仅限当前项目：至少 from 侧实体属于本项目）
      const rows = this.#db
        .prepare(
          `SELECT ke.from_id, ke.from_type, ke.to_id, ke.to_type
           FROM knowledge_edges ke
           WHERE ke.relation = ?
           AND (
             ke.from_type = 'module'
             OR EXISTS (
               SELECT 1 FROM code_entities ce
               WHERE ce.entity_id = ke.from_id AND ce.project_root = ?
             )
           )`
        )
        .all(relation, this.#projectRoot) as Array<Record<string, unknown>>;

      for (const row of rows) {
        const fromId = row.from_id as string;
        const toId = row.to_id as string;
        const fromType = row.from_type as string;
        const toType = row.to_type as string;

        // module-to-module 直接边 (depends_on)
        if (fromType === 'module' && toType === 'module') {
          if (fromId !== toId && moduleFiles.has(fromId) && moduleFiles.has(toId)) {
            edges.push({ from: fromId, to: toId, weight, relation });
          }
          continue;
        }

        // entity-to-entity 边 → 解析 file → module
        const fromModule = this.#resolveEntityModule(fromId, fromType, fileToModule);
        const toModule = this.#resolveEntityModule(toId, toType, fileToModule);

        if (fromModule && toModule && fromModule !== toModule) {
          edges.push({ from: fromModule, to: toModule, weight, relation });
        }
      }
    }

    return edges;
  }

  #resolveEntityModule(
    entityId: string,
    _entityType: string,
    fileToModule: Map<string, string>
  ): string | null {
    // 先查实体所在文件
    const row = this.#db
      .prepare(
        `SELECT file_path FROM code_entities
         WHERE entity_id = ? AND project_root = ? LIMIT 1`
      )
      .get(entityId, this.#projectRoot) as Record<string, unknown> | undefined;

    if (!row?.file_path) {
      return null;
    }

    return fileToModule.get(row.file_path as string) ?? null;
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
