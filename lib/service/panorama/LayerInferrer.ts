/**
 * LayerInferrer — 拓扑排序层级推断
 *
 * 基于模块依赖图，通过去环 + 拓扑排序 + 最长路径法推断架构层级 (L0-Ln)。
 * 底层 (L0) = Foundation/Core，顶层 = App/UI。
 *
 * @module LayerInferrer
 */

import type { CyclicDependency, Edge, LayerHierarchy, LayerViolation } from './PanoramaTypes.js';

/* ═══ Constants ═══════════════════════════════════════════ */

/** 层级命名启发式 — 按优先级排列，匹配模块名（边界安全） */
const LAYER_NAME_HINTS: Array<{ pattern: RegExp; name: string; bias: number }> = [
  { pattern: /^(foundation|core|base|shared|common)$/i, name: 'Foundation', bias: -2 },
  { pattern: /foundation/i, name: 'Foundation', bias: -2 },
  { pattern: /^(model|entity|dto)$/i, name: 'Model', bias: -1 },
  { pattern: /service|repository|manager|provider|store/i, name: 'Service', bias: 0 },
  { pattern: /network|api|http/i, name: 'Networking', bias: 0 },
  { pattern: /(?:^ui$|^ui[A-Z]|view|screen|component|widget)/i, name: 'UI', bias: 1 },
  { pattern: /router|coordinator|navigation/i, name: 'Routing', bias: 1 },
  { pattern: /^(app|main|launch|entry)$/i, name: 'Application', bias: 2 },
  { pattern: /test|spec|mock/i, name: 'Test', bias: 3 },
];

/* ═══ LayerInferrer Class ═════════════════════════════════ */

export class LayerInferrer {
  /**
   * 从模块依赖边推断架构层级
   * @param edges - 模块间依赖边 (from depends_on/calls/data_flow to)
   * @param modules - 所有模块名
   * @param cycles - 已检测到的循环依赖
   */
  infer(edges: Edge[], modules: string[], cycles: CyclicDependency[]): LayerHierarchy {
    // 1. 建图 (邻接表: from → to[])
    const adjacency = new Map<string, Set<string>>();
    const reverseAdj = new Map<string, Set<string>>();
    const allModules = new Set(modules);

    for (const mod of allModules) {
      adjacency.set(mod, new Set());
      reverseAdj.set(mod, new Set());
    }

    // 收集环中的节点
    const cycleEdges = new Set<string>();
    for (const c of cycles) {
      for (let i = 0; i < c.cycle.length; i++) {
        const from = c.cycle[i];
        const to = c.cycle[(i + 1) % c.cycle.length];
        cycleEdges.add(`${from}→${to}`);
      }
    }

    // 2. 添加边 (跳过环边)
    const violations: LayerViolation[] = [];
    for (const edge of edges) {
      if (!allModules.has(edge.from) || !allModules.has(edge.to) || edge.from === edge.to) {
        continue;
      }

      const edgeKey = `${edge.from}→${edge.to}`;
      if (cycleEdges.has(edgeKey)) {
        // 环边作为违规记录，不加入 DAG
        continue;
      }

      adjacency.get(edge.from)!.add(edge.to);
      reverseAdj.get(edge.to)!.add(edge.from);
    }

    // 3. 拓扑排序 (Kahn's algorithm)
    const inDegree = new Map<string, number>();
    for (const mod of allModules) {
      inDegree.set(mod, reverseAdj.get(mod)?.size ?? 0);
    }

    const queue: string[] = [];
    for (const [mod, deg] of inDegree) {
      if (deg === 0) {
        queue.push(mod);
      }
    }

    const order: string[] = [];
    while (queue.length > 0) {
      const node = queue.shift()!;
      order.push(node);

      for (const neighbor of adjacency.get(node) ?? []) {
        const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
        inDegree.set(neighbor, newDeg);
        if (newDeg === 0) {
          queue.push(neighbor);
        }
      }
    }

    // 未排入的节点 (仍在环中) 追加到末尾
    for (const mod of allModules) {
      if (!order.includes(mod)) {
        order.push(mod);
      }
    }

    // 4. 分配层级: 最长路径法
    // A 依赖 B → A 的 level ≥ B 的 level + 1
    // reverseAdj: "B 被 A 依赖" → predecessors 是 reverseAdj(node) = {A}
    // 但我们要的是 "A 依赖 B" → A 的 predecessors = adjacency(A) 出度目标的 level
    // 换言之: level(A) = max(level(dep) for dep in adjacency(A)) + 1
    // 底层 (无出度) = L0
    const levels = new Map<string, number>();

    // 反向遍历: 从源头 (无出度) 开始
    const reverseOrder = [...order].reverse();
    for (const node of reverseOrder) {
      const deps = adjacency.get(node) ?? new Set();
      if (deps.size === 0) {
        levels.set(node, 0);
      } else {
        let maxDepLevel = 0;
        for (const dep of deps) {
          maxDepLevel = Math.max(maxDepLevel, levels.get(dep) ?? 0);
        }
        levels.set(node, maxDepLevel + 1);
      }
    }

    // 5. 聚合: 同层模块分组
    const layerGroups = new Map<number, string[]>();
    for (const [mod, level] of levels) {
      if (!layerGroups.has(level)) {
        layerGroups.set(level, []);
      }
      layerGroups.get(level)!.push(mod);
    }

    // 按 level 排序
    const sortedLevels = [...layerGroups.entries()].sort((a, b) => a[0] - b[0]);

    // 6. 推断层级名
    const levelEntries = sortedLevels.map(([level, mods]) => ({
      level,
      name: this.#inferLayerName(mods, level, sortedLevels.length),
      modules: mods.sort(),
    }));

    // 7. 检测层级违规 (高层 → 低层调用正常；低层 → 高层调用为违规)
    for (const edge of edges) {
      const fromLevel = levels.get(edge.from);
      const toLevel = levels.get(edge.to);
      if (fromLevel !== undefined && toLevel !== undefined && fromLevel < toLevel) {
        violations.push({
          from: edge.from,
          to: edge.to,
          fromLayer: fromLevel,
          toLayer: toLevel,
          relation: edge.relation,
        });
      }
    }

    return { levels: levelEntries, violations };
  }

  /* ─── Layer Naming ──────────────────────────────── */

  #inferLayerName(modules: string[], level: number, totalLevels: number): string {
    // 投票: 每个匹配的 hint 累加权重，取最高分的名称
    const votes = new Map<string, number>();
    for (const mod of modules) {
      for (const hint of LAYER_NAME_HINTS) {
        if (hint.pattern.test(mod)) {
          votes.set(hint.name, (votes.get(hint.name) ?? 0) + 1);
          break; // 每个模块只投一票（匹配第一个 hint）
        }
      }
    }

    if (votes.size > 0) {
      // 选最高票
      let best = '';
      let bestCount = 0;
      for (const [name, count] of votes) {
        if (count > bestCount) {
          best = name;
          bestCount = count;
        }
      }
      return best;
    }

    // 基于层级位置推断
    const position = totalLevels > 1 ? level / (totalLevels - 1) : 0.5;
    if (position <= 0.2) {
      return 'Foundation';
    }
    if (position <= 0.5) {
      return 'Service';
    }
    if (position <= 0.8) {
      return 'Feature';
    }
    return 'Application';
  }
}
