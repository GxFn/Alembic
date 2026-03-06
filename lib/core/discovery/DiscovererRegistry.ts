/**
 * @module DiscovererRegistry
 * @description 注册所有 Discoverer 实现，按项目根目录自动选择最佳匹配。
 *
 * 检测顺序：按 confidence 降序。多个匹配时取最高 confidence。
 * 若全部未命中，回退到 GenericDiscoverer（目录扫描兜底）。
 */

export class DiscovererRegistry {
  /** @type {import('./ProjectDiscoverer.js').ProjectDiscoverer[]} */
  #discoverers: any[] = [];

  /**
   * 注册一个 Discoverer 实现
   * @param {import('./ProjectDiscoverer.js').ProjectDiscoverer} discoverer
   * @returns {DiscovererRegistry} this 支持链式调用
   */
  register(discoverer: any) {
    this.#discoverers.push(discoverer);
    return this;
  }

  /**
   * 自动检测项目类型，返回最佳 Discoverer
   * @param {string} projectRoot
   * @returns {Promise<import('./ProjectDiscoverer.js').ProjectDiscoverer>}
   */
  async detect(projectRoot: any) {
    const results = await Promise.all(
      this.#discoverers.map(async (d) => ({
        discoverer: d,
        result: await d
          .detect(projectRoot)
          .catch(() => ({ match: false, confidence: 0, reason: 'detect error' })),
      }))
    );

    const matched = results
      .filter((r) => r.result.match)
      .sort((a, b) => b.result.confidence - a.result.confidence);

    if (matched.length > 0) {
      return matched[0].discoverer;
    }

    // 回退到 GenericDiscoverer
    const generic = this.#discoverers.find((d) => d.id === 'generic');
    if (generic) {
      return generic;
    }

    throw new Error('No Discoverer matched and no GenericDiscoverer registered');
  }

  /**
   * 检测所有匹配的 Discoverer（用于混合项目）
   * @param {string} projectRoot
   * @returns {Promise<Array<{ discoverer: import('./ProjectDiscoverer.js').ProjectDiscoverer, confidence: number }>>}
   */
  async detectAll(projectRoot: any) {
    const results = await Promise.all(
      this.#discoverers.map(async (d) => ({
        discoverer: d,
        result: await d
          .detect(projectRoot)
          .catch(() => ({ match: false, confidence: 0, reason: 'detect error' })),
      }))
    );

    return results
      .filter((r) => r.result.match)
      .sort((a, b) => b.result.confidence - a.result.confidence)
      .map((r) => ({ discoverer: r.discoverer, confidence: r.result.confidence }));
  }

  /**
   * 获取所有已注册的 Discoverer
   * @returns {import('./ProjectDiscoverer.js').ProjectDiscoverer[]}
   */
  getAll() {
    return [...this.#discoverers];
  }
}
