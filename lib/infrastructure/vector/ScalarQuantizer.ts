/**
 * ScalarQuantizer — SQ8 标量量化器
 *
 * 将 Float32 向量映射到 Uint8 (0-255)，使用 per-dimension min/max 线性缩放:
 *   q_i = round((v_i - min_i) / (max_i - min_i) * 255)
 *   v̂_i = q_i / 255 * (max_i - min_i) + min_i
 *
 * 优势:
 * - 内存: 768 维 × 4 bytes → 768 维 × 1 byte = 75% 节省
 * - Recall: > 95% (误差极小)
 *
 * @module infrastructure/vector/ScalarQuantizer
 */

export class ScalarQuantizer {
  #dimension;
  /** @type {Float32Array} 每维最小值 */
  #mins;
  /** @type {Float32Array} 每维最大值 */
  #maxs;
  /** @type {Float32Array} 每维范围 (max - min), 预计算避免重复减法 */
  #ranges;
  #trained = false;

  /**
   * @param {number} dimension 向量维度
   */
  constructor(dimension: number) {
    this.#dimension = dimension;
    this.#mins = new Float32Array(dimension);
    this.#maxs = new Float32Array(dimension);
    this.#ranges = new Float32Array(dimension);
  }

  get dimension() {
    return this.#dimension;
  }

  get trained() {
    return this.#trained;
  }

  /**
   * 训练量化器 — 从一批向量中统计 per-dimension min/max
   * @param {Array<Float32Array|number[]>} vectors 训练集 (建议 ≥ 100 条)
   */
  train(vectors: Array<Float32Array | number[]>) {
    if (!vectors || vectors.length === 0) {
      throw new Error('ScalarQuantizer.train() requires at least 1 vector');
    }

    const dim = this.#dimension;
    const mins = new Float32Array(dim).fill(Infinity);
    const maxs = new Float32Array(dim).fill(-Infinity);

    for (const vec of vectors) {
      for (let i = 0; i < dim; i++) {
        const v = vec[i] || 0;
        if (v < mins[i]) {
          mins[i] = v;
        }
        if (v > maxs[i]) {
          maxs[i] = v;
        }
      }
    }

    // 防止 range = 0 (所有值相同的维度), 设置最小范围
    const ranges = new Float32Array(dim);
    for (let i = 0; i < dim; i++) {
      const range = maxs[i] - mins[i];
      ranges[i] = range > 1e-10 ? range : 1e-10;
    }

    this.#mins = mins;
    this.#maxs = maxs;
    this.#ranges = ranges;
    this.#trained = true;
  }

  /**
   * 量化单个向量
   * @param {Float32Array|number[]} vector
   * @returns {Uint8Array}
   */
  encode(vector: Float32Array | number[]) {
    if (!this.#trained) {
      throw new Error('ScalarQuantizer not trained. Call train() first.');
    }

    const dim = this.#dimension;
    const result = new Uint8Array(dim);
    const mins = this.#mins;
    const ranges = this.#ranges;

    for (let i = 0; i < dim; i++) {
      const v = vector[i] || 0;
      // 钳位到 [min, max] 范围, 然后映射到 [0, 255]
      const normalized = (v - mins[i]) / ranges[i];
      result[i] = Math.max(0, Math.min(255, Math.round(normalized * 255)));
    }

    return result;
  }

  /**
   * 批量量化
   * @param {Array<Float32Array|number[]>} vectors
   * @returns {Uint8Array[]}
   */
  encodeBatch(vectors: Array<Float32Array | number[]>) {
    return vectors.map((v) => this.encode(v));
  }

  /**
   * 反量化 (用于精排 re-rank)
   * @param {Uint8Array} quantized
   * @returns {Float32Array}
   */
  decode(quantized: Uint8Array) {
    if (!this.#trained) {
      throw new Error('ScalarQuantizer not trained.');
    }

    const dim = this.#dimension;
    const result = new Float32Array(dim);
    const mins = this.#mins;
    const ranges = this.#ranges;

    for (let i = 0; i < dim; i++) {
      result[i] = (quantized[i] / 255) * ranges[i] + mins[i];
    }

    return result;
  }

  /**
   * 量化空间内的距离计算 (避免反量化, 整数运算)
   * 使用 L2 on quantized space 近似余弦距离
   *
   * @param {Uint8Array} a
   * @param {Uint8Array} b
   * @returns {number} 距离值 (越小越相似)
   */
  distance(a: Uint8Array, b: Uint8Array) {
    const dim = this.#dimension;
    let sum = 0;
    for (let i = 0; i < dim; i++) {
      const diff = a[i] - b[i];
      sum += diff * diff;
    }
    // 归一化到 ~[0, 1] 范围:  max possible = 255² × dim
    return sum / (255 * 255 * dim);
  }

  /**
   * 混合距离: 量化粗排 + 原始精排
   * 用于搜索时: 先用 SQ8 快速过滤, 再用 Float32 精确计算
   *
   * @param {Uint8Array} quantizedA
   * @param {Float32Array|number[]} originalA
   * @param {Uint8Array} quantizedB
   * @param {Float32Array|number[]} originalB
   * @returns {{ coarse: number, fine: number }}
   */
  hybridDistance(
    quantizedA: Uint8Array,
    originalA: Float32Array | number[],
    quantizedB: Uint8Array,
    originalB: Float32Array | number[]
  ) {
    return {
      coarse: this.distance(quantizedA, quantizedB),
      fine: ScalarQuantizer.#cosineDistanceFloat(originalA, originalB),
    };
  }

  /**
   * 余弦距离 (Float32 精确计算)
   * @param {Float32Array|number[]} a
   * @param {Float32Array|number[]} b
   * @returns {number}
   */
  static #cosineDistanceFloat(a: Float32Array | number[], b: Float32Array | number[]) {
    if (!a || !b || a.length === 0) {
      return 1;
    }
    const len = Math.min(a.length, b.length);
    let dot = 0,
      normA = 0,
      normB = 0;
    for (let i = 0; i < len; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 1 : 1 - dot / denom;
  }

  /**
   * 序列化量化器参数
   * @returns {{ dimension: number, mins: number[], maxs: number[] }}
   */
  serialize() {
    return {
      dimension: this.#dimension,
      mins: Array.from(this.#mins),
      maxs: Array.from(this.#maxs),
    };
  }

  /**
   * 从序列化数据恢复量化器
   * @param {{ dimension: number, mins: number[], maxs: number[] }} data
   * @returns {ScalarQuantizer}
   */
  static deserialize(data: { dimension: number; mins: number[]; maxs: number[] }) {
    const q = new ScalarQuantizer(data.dimension);
    q.#mins = new Float32Array(data.mins);
    q.#maxs = new Float32Array(data.maxs);
    const ranges = new Float32Array(data.dimension);
    for (let i = 0; i < data.dimension; i++) {
      const range = q.#maxs[i] - q.#mins[i];
      ranges[i] = range > 1e-10 ? range : 1e-10;
    }
    q.#ranges = ranges;
    q.#trained = true;
    return q;
  }
}
