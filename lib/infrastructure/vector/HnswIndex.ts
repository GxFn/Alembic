/**
 * HnswIndex — 纯 JS 实现的 HNSW 近似最近邻索引
 *
 * 参考论文: "Efficient and robust approximate nearest neighbor search
 *           using Hierarchical Navigable Small World graphs" (Malkov & Yashunin, 2018)
 *
 * 特点:
 * - 零外部依赖, 纯 JavaScript 实现
 * - 支持增量插入 (无需全量重建)
 * - 余弦距离 (1 - cosineSimilarity)
 * - 可配置超参数 (M, efConstruct, efSearch)
 *
 * @module infrastructure/vector/HnswIndex
 */

// ── 堆结构 ──

class MinHeap {
  #data: { nodeIdx: number; dist: number }[] = [];

  get size() {
    return this.#data.length;
  }

  peek() {
    return this.#data[0] || null;
  }

  push(nodeIdx: number, dist: number) {
    this.#data.push({ nodeIdx, dist });
    this.#siftUp(this.#data.length - 1);
  }

  pop() {
    if (this.#data.length === 0) {
      return null;
    }
    const top = this.#data[0];
    const last = this.#data.pop();
    if (this.#data.length > 0 && last) {
      this.#data[0] = last;
      this.#siftDown(0);
    }
    return top;
  }

  toArray() {
    return [...this.#data];
  }

  #siftUp(i: number) {
    const data = this.#data;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (data[parent].dist <= data[i].dist) {
        break;
      }
      [data[parent], data[i]] = [data[i], data[parent]];
      i = parent;
    }
  }

  #siftDown(i: number) {
    const data = this.#data;
    const n = data.length;
    while (true) {
      let smallest = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      if (left < n && data[left].dist < data[smallest].dist) {
        smallest = left;
      }
      if (right < n && data[right].dist < data[smallest].dist) {
        smallest = right;
      }
      if (smallest === i) {
        break;
      }
      [data[smallest], data[i]] = [data[i], data[smallest]];
      i = smallest;
    }
  }
}

class MaxHeap {
  #data: { nodeIdx: number; dist: number }[] = [];

  get size() {
    return this.#data.length;
  }

  peek() {
    return this.#data[0] || null;
  }

  push(nodeIdx: number, dist: number) {
    this.#data.push({ nodeIdx, dist });
    this.#siftUp(this.#data.length - 1);
  }

  pop() {
    if (this.#data.length === 0) {
      return null;
    }
    const top = this.#data[0];
    const last = this.#data.pop();
    if (this.#data.length > 0 && last) {
      this.#data[0] = last;
      this.#siftDown(0);
    }
    return top;
  }

  /** 按距离升序返回所有元素 */
  toSortedArray() {
    return [...this.#data].sort((a, b) => a.dist - b.dist);
  }

  #siftUp(i: number) {
    const data = this.#data;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (data[parent].dist >= data[i].dist) {
        break;
      }
      [data[parent], data[i]] = [data[i], data[parent]];
      i = parent;
    }
  }

  #siftDown(i: number) {
    const data = this.#data;
    const n = data.length;
    while (true) {
      let largest = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      if (left < n && data[left].dist > data[largest].dist) {
        largest = left;
      }
      if (right < n && data[right].dist > data[largest].dist) {
        largest = right;
      }
      if (largest === i) {
        break;
      }
      [data[largest], data[i]] = [data[i], data[largest]];
      i = largest;
    }
  }
}

// ── HNSW Index ──

export class HnswIndex {
  // ── 超参数 ──
  M; // 每层最大邻居数
  M0; // L0 层最大邻居数 (= 2*M)
  efConstruct; // 构建时搜索宽度
  efSearch; // 查询时搜索宽度
  mL; // 层级采样因子 = 1 / ln(M)

  // ── 存储 ──
  /** >} */
  nodes: Array<{
    id: string;
    vector: Float32Array | number[];
    level: number;
    qvector?: Uint8Array | null;
  } | null> = [];
  /** graphs — per-level adjacency: graphs[level].get(nodeIdx) → Set<neighborIdx> */
  graphs: Map<number, Set<number>>[] = [];
  entryPoint = -1; // 入口节点索引
  maxLevel = -1; // 当前最大层级
  /** id → nodeIdx */
  idToIndex = new Map();

  // ── 可选的自定义距离函数 (用于量化空间) ──
  #distanceFn: ((a: Float32Array | number[], b: Float32Array | number[]) => number) | null = null;

  /** @param [options.distanceFn] 自定义距离函数 (a, b) => number */
  constructor(
    options: {
      M?: number;
      efConstruct?: number;
      efSearch?: number;
      distanceFn?: (a: Float32Array | number[], b: Float32Array | number[]) => number;
    } = {}
  ) {
    this.M = options.M || 16;
    this.M0 = this.M * 2;
    this.efConstruct = options.efConstruct || 200;
    this.efSearch = options.efSearch || 100;
    this.mL = 1 / Math.log(this.M);
    if (options.distanceFn) {
      this.#distanceFn = options.distanceFn;
    }
  }

  /** 获取节点数量 */
  get size() {
    return this.nodes.length;
  }

  /** 余弦距离 = 1 - cosineSimilarity (越小越相似) */
  distance(a: Float32Array | number[], b: Float32Array | number[]) {
    if (this.#distanceFn) {
      return this.#distanceFn(a, b);
    }
    return cosineDistance(a, b);
  }

  /**
   * 随机选取节点层级 (几何分布)
   * 使用 1 - Math.random() 避免 log(0) = -Infinity
   */
  #randomLevel() {
    // 1 - Math.random() ∈ (0, 1], 永远不会为 0
    return Math.floor(-Math.log(1 - Math.random()) * this.mL);
  }

  /** 确保 graphs 数组至少有 level+1 层 */
  #ensureLevel(level: number) {
    while (this.graphs.length <= level) {
      this.graphs.push(new Map());
    }
  }

  /** 获取节点在某层的邻居集合 (如不存在则创建) */
  #getNeighbors(level: number, nodeIdx: number): Set<number> {
    const graph = this.graphs[level];
    if (!graph) {
      return new Set<number>();
    }
    let neighbors = graph.get(nodeIdx);
    if (!neighbors) {
      neighbors = new Set();
      graph.set(nodeIdx, neighbors);
    }
    return neighbors;
  }

  /**
   * 插入一个向量到索引
   * @param id 文档 ID
   * @param [options.qvector] 预量化向量 (SQ8), 用于 2-pass 搜索加速
   */
  addPoint(
    id: string,
    vector: Float32Array | number[],
    options: { qvector?: Uint8Array | null } = {}
  ) {
    // 如果 id 已存在, 先移除旧的 (支持更新)
    if (this.idToIndex.has(id)) {
      this.removePoint(id);
    }

    const nodeLevel = this.#randomLevel();
    const nodeIdx = this.nodes.length;
    this.nodes.push({ id, vector, level: nodeLevel, qvector: options.qvector || null });
    this.idToIndex.set(id, nodeIdx);
    this.#ensureLevel(nodeLevel);

    // 第一个节点
    if (this.entryPoint === -1) {
      this.entryPoint = nodeIdx;
      this.maxLevel = nodeLevel;
      return;
    }

    // Phase 1: 从顶层贪心搜索到 nodeLevel+1 层
    let current = this.entryPoint;
    for (let level = this.maxLevel; level > nodeLevel; level--) {
      current = this.#greedySearch(vector, current, level);
    }

    // Phase 2: 从 min(nodeLevel, maxLevel) 向下, 每层做 efConstruct 宽度搜索
    for (let level = Math.min(nodeLevel, this.maxLevel); level >= 0; level--) {
      const candidates = this.#searchLayer(vector, current, this.efConstruct, level);

      // 选择 M (或 M0 for L0) 个最近邻作为邻居
      const maxNeighbors = level === 0 ? this.M0 : this.M;
      const neighbors = this.#selectNeighborsSimple(candidates, maxNeighbors);

      // 双向连接
      for (const neighbor of neighbors) {
        const neighborsOfNode = this.#getNeighbors(level, nodeIdx);
        neighborsOfNode.add(neighbor.nodeIdx);

        const neighborsOfNeighbor = this.#getNeighbors(level, neighbor.nodeIdx);
        neighborsOfNeighbor.add(nodeIdx);

        // 如果邻居的邻居数超限, 裁剪最远的
        const limit = level === 0 ? this.M0 : this.M;
        if (neighborsOfNeighbor.size > limit) {
          this.#pruneConnections(neighbor.nodeIdx, level, limit);
        }
      }

      // 更新入口 (取最近候选)
      if (candidates.length > 0) {
        current = candidates[0].nodeIdx;
      }
    }

    // 如果新节点层级 > 当前最大层级, 更新入口点
    if (nodeLevel > this.maxLevel) {
      this.maxLevel = nodeLevel;
      this.entryPoint = nodeIdx;
    }
  }

  /**
   * 移除一个向量 (软删除: 断开所有连接但保留 slot)
   * 完整的 compaction 可在持久化时做
   */
  removePoint(id: string) {
    const nodeIdx = this.idToIndex.get(id);
    if (nodeIdx === undefined) {
      return;
    }

    const node = this.nodes[nodeIdx];
    if (!node) {
      return;
    }

    // 断开所有层级的连接
    for (let level = 0; level <= node.level; level++) {
      const graph = this.graphs[level];
      if (!graph) {
        continue;
      }

      const neighbors = graph.get(nodeIdx);
      if (neighbors) {
        // 移除邻居对该节点的引用
        for (const neighborIdx of neighbors) {
          const neighborSet = graph.get(neighborIdx);
          if (neighborSet) {
            neighborSet.delete(nodeIdx);
          }
        }
        graph.delete(nodeIdx);
      }
    }

    // 标记为已删除 (保留 slot 避免 index 移位)
    this.nodes[nodeIdx] = null;
    this.idToIndex.delete(id);

    // 如果删的是入口点, 需要找新入口
    if (this.entryPoint === nodeIdx) {
      this.#findNewEntryPoint();
    }
  }

  /** 查找新的入口点 (删除后) */
  #findNewEntryPoint() {
    this.entryPoint = -1;
    this.maxLevel = -1;
    for (let i = 0; i < this.nodes.length; i++) {
      const node = this.nodes[i];
      if (node && node.level > this.maxLevel) {
        this.maxLevel = node.level;
        this.entryPoint = i;
      }
    }
  }

  /** 为所有现有节点批量设置量化向量 */
  setQuantizedVectors(quantizer: { encode: (vector: Float32Array | number[]) => Uint8Array }) {
    for (const node of this.nodes) {
      if (node && node.vector.length > 0) {
        node.qvector = quantizer.encode(node.vector);
      }
    }
  }

  /**
   * 搜索 K 个最近邻
   *
   * 支持 2-pass 搜索 (SQ8 粗排 + Float32 精排):
   * - 传入 quantizedQuery + quantizer 时启用
   * - Phase 1-2: 使用 SQ8 量化距离图遍历 (快速粗排)
   * - Phase 3: 对候选用 Float32 精确余弦距离重排 (精排)
   *
   * @param [options.quantizedQuery] SQ8 编码后的查询向量
   * @returns >}
   */
  searchKnn(
    queryVector: Float32Array | number[],
    k = 10,
    options: {
      quantizedQuery?: Uint8Array;
      quantizer?: { distance: (a: Uint8Array, b: Uint8Array) => number };
    } = {}
  ) {
    if (this.entryPoint === -1 || this.nodes.length === 0) {
      return [];
    }

    const { quantizedQuery, quantizer } = options;
    const use2Pass = !!(quantizedQuery && quantizer);

    // Phase 1: 从顶层贪心搜索到 L1 (使用 SQ8 距离加速, 如果可用)
    let current = this.entryPoint;
    for (let level = this.maxLevel; level > 0; level--) {
      current = this.#greedySearch(
        queryVector,
        current,
        level,
        use2Pass ? quantizer : null,
        quantizedQuery
      );
    }

    // Phase 2: L0 层做 efSearch 宽度搜索 (SQ8 粗排)
    const ef = Math.max(this.efSearch, k);
    const candidates = this.#searchLayer(
      queryVector,
      current,
      ef,
      0,
      use2Pass ? quantizer : null,
      quantizedQuery
    );

    // Phase 3: 2-pass 精排 — 用 Float32 精确余弦距离重新排序候选
    if (use2Pass) {
      for (const c of candidates) {
        const node = this.nodes[c.nodeIdx];
        if (node) {
          c.dist = cosineDistance(queryVector, node.vector);
        }
      }
      candidates.sort((a, b) => a.dist - b.dist);
    }

    // 返回前 k 个
    return candidates.slice(0, k).map((c) => ({
      id: this.nodes[c.nodeIdx]?.id,
      nodeIdx: c.nodeIdx,
      dist: c.dist,
    }));
  }

  /**
   * 贪心搜索 — 在单一层级中找到离 query 最近的节点
   * @param quantizer SQ8 量化器 (可选)
   * @param quantizedQuery SQ8 编码后的查询向量 (可选)
   * @returns 最近节点的 index
   */
  #greedySearch(
    query: Float32Array | number[],
    entryNodeIdx: number,
    level: number,
    quantizer: { distance: (a: Uint8Array, b: Uint8Array) => number } | null = null,
    quantizedQuery: Uint8Array | null = null
  ) {
    let current = entryNodeIdx;
    const currentNode = this.nodes[current];
    if (!currentNode) {
      return current;
    }

    let currentDist = this.#dist(query, currentNode, quantizer, quantizedQuery);

    let improved = true;
    while (improved) {
      improved = false;
      const neighbors = this.#getNeighbors(level, current);
      for (const neighborIdx of neighbors) {
        const neighbor = this.nodes[neighborIdx];
        if (!neighbor) {
          continue; // 已删除的节点
        }
        const dist = this.#dist(query, neighbor, quantizer, quantizedQuery);
        if (dist < currentDist) {
          current = neighborIdx;
          currentDist = dist;
          improved = true;
        }
      }
    }
    return current;
  }

  /**
   * searchLayer — HNSW 核心的宽度优先搜索
   * @param ef 搜索宽度
   * @returns >} 按距离升序排列
   */
  #searchLayer(
    query: Float32Array | number[],
    entryNodeIdx: number,
    ef: number,
    level: number,
    quantizer: { distance: (a: Uint8Array, b: Uint8Array) => number } | null = null,
    quantizedQuery: Uint8Array | null = null
  ) {
    const entryNode = this.nodes[entryNodeIdx];
    if (!entryNode) {
      return [];
    }

    const visited = new Set([entryNodeIdx]);
    const entryDist = this.#dist(query, entryNode, quantizer, quantizedQuery);

    // candidates: 待探索, MinHeap (距离最小优先)
    const candidates = new MinHeap();
    candidates.push(entryNodeIdx, entryDist);

    // results: 当前 top-ef 结果, MaxHeap (距离最大在顶, 方便淘汰)
    const results = new MaxHeap();
    results.push(entryNodeIdx, entryDist);

    while (candidates.size > 0) {
      const nearest = candidates.pop()!;
      const farthest = results.peek();

      // 如果最近候选比当前最差结果还远, 终止
      if (nearest.dist > farthest.dist) {
        break;
      }

      // 探索最近候选的邻居
      const neighbors = this.#getNeighbors(level, nearest.nodeIdx);
      for (const neighborIdx of neighbors) {
        if (visited.has(neighborIdx)) {
          continue;
        }
        visited.add(neighborIdx);

        const neighbor = this.nodes[neighborIdx];
        if (!neighbor) {
          continue; // 已删除
        }

        const dist = this.#dist(query, neighbor, quantizer, quantizedQuery);
        const currentFarthest = results.peek();

        if (dist < currentFarthest.dist || results.size < ef) {
          candidates.push(neighborIdx, dist);
          results.push(neighborIdx, dist);
          if (results.size > ef) {
            results.pop(); // 淘汰最远的
          }
        }
      }
    }

    return results.toSortedArray();
  }

  /**
   * 距离计算: 优先使用 SQ8 量化距离, 降级到 Float32 精确距离
   * @param node { vector, qvector? }
   */
  #dist(
    query: Float32Array | number[],
    node: { vector: Float32Array | number[]; qvector?: Uint8Array | null },
    quantizer: { distance: (a: Uint8Array, b: Uint8Array) => number } | null,
    quantizedQuery: Uint8Array | null
  ) {
    if (quantizer && quantizedQuery && node.qvector) {
      return quantizer.distance(quantizedQuery, node.qvector);
    }
    return this.distance(query, node.vector);
  }

  /**
   * 简单邻居选择 — 取距离最近的 maxNeighbors 个
   * @param candidates
   * @returns >}
   */
  #selectNeighborsSimple(candidates: { nodeIdx: number; dist: number }[], maxNeighbors: number) {
    return candidates.sort((a, b) => a.dist - b.dist).slice(0, maxNeighbors);
  }

  /**
   * 裁剪节点的连接数到 maxNeighbors
   * 保留距离最近的邻居, 移除最远的
   */
  #pruneConnections(nodeIdx: number, level: number, maxNeighbors: number) {
    const node = this.nodes[nodeIdx];
    if (!node) {
      return;
    }

    const neighbors = this.#getNeighbors(level, nodeIdx);
    if (neighbors.size <= maxNeighbors) {
      return;
    }

    // 计算所有邻居的距离, 保留最近的
    const scored: { nodeIdx: number; dist: number }[] = [];
    for (const nIdx of neighbors) {
      const nNode = this.nodes[nIdx];
      if (!nNode) {
        continue;
      }
      scored.push({ nodeIdx: nIdx, dist: this.distance(node.vector, nNode.vector) });
    }
    scored.sort((a, b) => a.dist - b.dist);

    // 重建邻居集合
    const newNeighbors = new Set(scored.slice(0, maxNeighbors).map((s) => s.nodeIdx));
    this.graphs[level].set(nodeIdx, newNeighbors);

    // 清理被移除邻居的反向链接
    for (const s of scored.slice(maxNeighbors)) {
      const removedNeighborSet = this.graphs[level]?.get(s.nodeIdx);
      if (removedNeighborSet) {
        removedNeighborSet.delete(nodeIdx);
      }
    }
  }

  // ── 序列化/反序列化 (供 BinaryPersistence 使用) ──

  /**
   * 导出索引状态 (用于持久化)
   * @returns }
   */
  serialize() {
    // 将 graphs Map<Set> 转为可序列化格式
    const serializedGraphs = this.graphs.map((graph) => {
      const entries: [number, number[]][] = [];
      for (const [nodeIdx, neighbors] of graph) {
        entries.push([nodeIdx, [...neighbors]]);
      }
      return entries;
    });

    // 注意: qvector 不序列化 (启动时由 quantizer 重新编码, 节省空间)
    return {
      M: this.M,
      M0: this.M0,
      efConstruct: this.efConstruct,
      efSearch: this.efSearch,
      entryPoint: this.entryPoint,
      maxLevel: this.maxLevel,
      nodes: this.nodes.map((n) =>
        n ? { id: n.id, vector: Array.from(n.vector), level: n.level } : null
      ),
      graphs: serializedGraphs,
    };
  }

  /**
   * 从序列化数据恢复索引
   * @param data serialize() 的返回值
   */
  static deserialize(data: {
    M: number;
    M0: number;
    efConstruct: number;
    efSearch: number;
    entryPoint: number;
    maxLevel: number;
    nodes: Array<{ id: string; vector: number[]; level: number } | null>;
    graphs: [number, number[]][][];
  }) {
    const index = new HnswIndex({
      M: data.M,
      efConstruct: data.efConstruct,
      efSearch: data.efSearch,
    });
    index.M0 = data.M0;
    index.entryPoint = data.entryPoint;
    index.maxLevel = data.maxLevel;
    index.nodes = data.nodes.map((n) =>
      n ? { id: n.id, vector: new Float32Array(n.vector), level: n.level } : null
    );

    // 恢复 idToIndex
    for (let i = 0; i < index.nodes.length; i++) {
      const node = index.nodes[i];
      if (node) {
        index.idToIndex.set(node.id, i);
      }
    }

    // 恢复 graphs
    index.graphs = data.graphs.map((entries) => {
      const graph = new Map();
      for (const [nodeIdx, neighbors] of entries) {
        graph.set(nodeIdx, new Set(neighbors));
      }
      return graph;
    });

    return index;
  }

  /**
   * 批量插入 (比逐个 addPoint 更高效的初始构建)
   * @param items
   */
  addPoints(items: Array<{ id: string; vector: Float32Array | number[] }>) {
    for (const item of items) {
      this.addPoint(item.id, item.vector);
    }
  }

  /** 获取索引统计信息 */
  getStats() {
    const activeNodes = this.nodes.filter((n) => n !== null).length;
    let totalEdges = 0;
    for (const graph of this.graphs) {
      for (const neighbors of graph.values()) {
        totalEdges += neighbors.size;
      }
    }
    return {
      totalNodes: activeNodes,
      deletedSlots: this.nodes.length - activeNodes,
      maxLevel: this.maxLevel,
      levels: this.graphs.length,
      totalEdges,
      entryPoint: this.entryPoint,
    };
  }
}

/** 余弦距离 = 1 - cosineSimilarity */
export function cosineDistance(a: Float32Array | number[], b: Float32Array | number[]) {
  if (!a || !b || a.length === 0 || b.length === 0) {
    return 1;
  }
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) {
    return 1;
  }
  const similarity = dot / denom;
  return 1 - similarity;
}

export { MinHeap, MaxHeap };
