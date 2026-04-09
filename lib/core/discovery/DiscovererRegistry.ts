/**
 * @module DiscovererRegistry
 * @description 注册所有 Discoverer 实现，按项目根目录自动选择最佳匹配。
 *
 * 检测顺序：按 confidence 降序。多个匹配时取最高 confidence。
 * 若全部未命中，回退到 GenericDiscoverer（目录扫描兜底）。
 *
 * 支持用户偏好持久化: 当匹配模糊时，保存/加载用户选择。
 */

import type { ConflictResult, DetectMatch } from './DiscovererPreference.js';
import { detectConflict, loadPreference } from './DiscovererPreference.js';
import type { ProjectDiscoverer } from './ProjectDiscoverer.js';

export class DiscovererRegistry {
  #discoverers: ProjectDiscoverer[] = [];

  /**
   * 注册一个 Discoverer 实现
   * @returns this 支持链式调用
   */
  register(discoverer: ProjectDiscoverer) {
    this.#discoverers.push(discoverer);
    return this;
  }

  /** 自动检测项目类型，返回最佳 Discoverer */
  async detect(projectRoot: string) {
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
   * 若存在用户偏好，将偏好 Discoverer 提升到首位。
   * @returns 按 confidence 降序排列的匹配结果（偏好优先）
   */
  async detectAll(projectRoot: string) {
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
      .sort((a, b) => b.result.confidence - a.result.confidence)
      .map((r) => ({ discoverer: r.discoverer, confidence: r.result.confidence }));

    // 如果有用户持久化偏好，将偏好 Discoverer 提升到首位
    const preference = loadPreference(projectRoot);
    if (preference?.userConfirmed) {
      const prefIdx = matched.findIndex((m) => m.discoverer.id === preference.selectedDiscoverer);
      if (prefIdx > 0) {
        const [preferred] = matched.splice(prefIdx, 1);
        matched.unshift(preferred);
      }
    }

    return matched;
  }

  /**
   * 分析检测结果的冲突/模糊性
   * @returns 冲突分析结果，含 ambiguous 标记和推荐
   */
  async analyzeConflict(projectRoot: string): Promise<ConflictResult> {
    const results = await Promise.all(
      this.#discoverers.map(async (d) => ({
        discoverer: d,
        result: await d
          .detect(projectRoot)
          .catch(() => ({ match: false, confidence: 0, reason: 'detect error' })),
      }))
    );

    const matches: DetectMatch[] = results
      .filter((r) => r.result.match)
      .sort((a, b) => b.result.confidence - a.result.confidence)
      .map((r) => ({
        discovererId: r.discoverer.id,
        displayName: r.discoverer.displayName,
        confidence: r.result.confidence,
      }));

    // 如果有用户偏好，直接信任
    const preference = loadPreference(projectRoot);
    if (preference?.userConfirmed) {
      return { ambiguous: false, matches, recommended: matches[0] };
    }

    return detectConflict(matches);
  }

  /** 获取所有已注册的 Discoverer */
  getAll() {
    return [...this.#discoverers];
  }
}
