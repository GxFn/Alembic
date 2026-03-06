/**
 * DependencyGraph — SPM 依赖图构建与分析
 * 合并 V1 DepGraphService + DepGraphAnalyzer
 * 构建 target 级依赖 DAG，支持层级计算、拓扑排序、可达性检查
 */

import Logger from '../../../infrastructure/logging/Logger.js';

export class DependencyGraph {
  #adjacency; // Map<string, Set<string>>
  #reverseAdj; // Map<string, Set<string>>
  #nodes; // Set<string>
  #logger;

  constructor() {
    this.#adjacency = new Map();
    this.#reverseAdj = new Map();
    this.#nodes = new Set();
    this.#logger = Logger.getInstance();
  }

  /**
   * 从 PackageSwiftParser 的解析结果构建图
   * @param {{ targets: { name: string, dependencies: string[] }[] }} parsed
   */
  buildFromParsed(parsed) {
    this.clear();
    for (const target of parsed.targets || []) {
      this.addNode(target.name);
      for (const dep of target.dependencies || []) {
        this.addEdge(target.name, dep);
      }
    }
    this.#logger.debug(
      `[DependencyGraph] built: ${this.#nodes.size} nodes, ${this.edgeCount()} edges`
    );
  }

  /**
   * 添加节点
   */
  addNode(name) {
    this.#nodes.add(name);
    if (!this.#adjacency.has(name)) {
      this.#adjacency.set(name, new Set());
    }
    if (!this.#reverseAdj.has(name)) {
      this.#reverseAdj.set(name, new Set());
    }
  }

  /**
   * 添加边: from 依赖 to
   */
  addEdge(from, to) {
    this.addNode(from);
    this.addNode(to);
    this.#adjacency.get(from).add(to);
    this.#reverseAdj.get(to).add(from);
  }

  /**
   * BFS 可达性检查
   */
  isReachable(from, to) {
    if (from === to) {
      return true;
    }
    const visited = new Set();
    const queue = [from];
    while (queue.length > 0) {
      const node = queue.shift();
      if (node === to) {
        return true;
      }
      if (visited.has(node)) {
        continue;
      }
      visited.add(node);
      for (const neighbor of this.#adjacency.get(node) || []) {
        queue.push(neighbor);
      }
    }
    return false;
  }

  /**
   * 检测循环依赖
   * @returns {string[][]} 循环路径列表
   */
  detectCycles() {
    const cycles: any[][] = [];
    const white = new Set(this.#nodes);
    const gray = new Set();
    const black = new Set();
    const path: any[] = [];

    const dfs = (node) => {
      white.delete(node);
      gray.add(node);
      path.push(node);

      for (const neighbor of this.#adjacency.get(node) || []) {
        if (gray.has(neighbor)) {
          const cycleStart = path.indexOf(neighbor);
          cycles.push(path.slice(cycleStart).concat(neighbor));
        } else if (white.has(neighbor)) {
          dfs(neighbor);
        }
      }

      path.pop();
      gray.delete(node);
      black.add(node);
    };

    for (const node of this.#nodes) {
      if (white.has(node)) {
        dfs(node);
      }
    }
    return cycles;
  }

  /**
   * 拓扑排序 (Kahn's algorithm)
   * @returns {string[]} 若有环则返回部分结果
   */
  topologicalSort() {
    const inDegree = new Map();
    for (const node of this.#nodes) {
      inDegree.set(node, 0);
    }
    for (const [, deps] of this.#adjacency) {
      for (const dep of deps) {
        inDegree.set(dep, (inDegree.get(dep) || 0) + 1);
      }
    }

    const queue: any[] = [];
    for (const [node, degree] of inDegree) {
      if (degree === 0) {
        queue.push(node);
      }
    }

    const result: undefined[] = [];
    while (queue.length > 0) {
      const node = queue.shift();
      result.push(node);
      for (const dep of this.#adjacency.get(node) || []) {
        inDegree.set(dep, inDegree.get(dep) - 1);
        if (inDegree.get(dep) === 0) {
          queue.push(dep);
        }
      }
    }

    return result;
  }

  /**
   * 层级计算: L0 = 无依赖的节点, L1 = 只依赖 L0, etc.
   * @returns {Map<string, number>} node → level
   */
  computeLevels() {
    const levels = new Map();
    const topo = this.topologicalSort();

    // 反向处理: 叶子节点是 L0
    for (const node of topo.reverse()) {
      const deps = this.#adjacency.get(node) || new Set();
      if (deps.size === 0) {
        levels.set(node, 0);
      } else {
        let maxDepLevel = 0;
        for (const dep of deps) {
          maxDepLevel = Math.max(maxDepLevel, levels.get(dep) || 0);
        }
        levels.set(node, maxDepLevel + 1);
      }
    }

    return levels;
  }

  /**
   * 获取节点的直接依赖
   */
  getDependencies(node) {
    return [...(this.#adjacency.get(node) || [])];
  }

  /**
   * 获取节点的直接依赖者 (谁依赖了这个节点)
   */
  getDependents(node) {
    return [...(this.#reverseAdj.get(node) || [])];
  }

  /**
   * 获取所有节点
   */
  getNodes() {
    return [...this.#nodes];
  }

  edgeCount() {
    let count = 0;
    for (const deps of this.#adjacency.values()) {
      count += deps.size;
    }
    return count;
  }

  clear() {
    this.#adjacency.clear();
    this.#reverseAdj.clear();
    this.#nodes.clear();
  }

  /**
   * 导出为 JSON (可视化用)
   */
  toJSON() {
    const edges: { from: any; to: any }[] = [];
    for (const [from, deps] of this.#adjacency) {
      for (const to of deps) {
        edges.push({ from, to });
      }
    }
    return { nodes: [...this.#nodes], edges };
  }
}
