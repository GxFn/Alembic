/**
 * FeedbackCollector — 用户反馈收集器
 * 记录交互事件 (view/click/rate/dismiss)，可持久化，支持统计汇总
 * 持久化到 AutoSnippet/feedback.json（Git 友好）
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import pathGuard from '../../shared/PathGuard.js';

export class FeedbackCollector {
  #feedbackPath;
  #events; // [{ type, recipeId, data, timestamp }]
  #maxEvents;

  constructor(projectRoot, options: any = {}) {
    const kbDir = options.knowledgeBaseDir || 'AutoSnippet';
    this.#feedbackPath = join(projectRoot, kbDir, 'feedback.json');
    pathGuard.assertProjectWriteSafe(this.#feedbackPath);
    this.#maxEvents = options.maxEvents || 1000;
    this.#migrateOldPath(projectRoot, options.internalDir || '.autosnippet');
    this.#events = this.#load();
  }

  /**
   * 记录一个交互事件
   * @param {'view'|'click'|'rate'|'dismiss'|'copy'|'insert'|'feedback'} type
   * @param {string} recipeId
   * @param {object} data 任意附加数据 (rating, comment, etc.)
   */
  record(type, recipeId, data: any = {}) {
    this.#events.push({
      type,
      recipeId,
      data,
      timestamp: new Date().toISOString(),
    });

    if (this.#events.length > this.#maxEvents) {
      this.#events = this.#events.slice(-this.#maxEvents);
    }

    this.#save();
  }

  /**
   * 获取指定 Recipe 的事件统计
   * @param {string} recipeId
   * @returns {{ views: number, clicks: number, copies: number, avgRating: number, feedbackCount: number }}
   */
  getRecipeStats(recipeId) {
    const events = this.#events.filter((e) => e.recipeId === recipeId);
    const ratings = events
      .filter((e) => e.type === 'rate' && e.data.rating)
      .map((e) => e.data.rating);

    return {
      views: events.filter((e) => e.type === 'view').length,
      clicks: events.filter((e) => e.type === 'click').length,
      copies: events.filter((e) => e.type === 'copy' || e.type === 'insert').length,
      avgRating: ratings.length > 0 ? ratings.reduce((a, b) => a + b, 0) / ratings.length : 0,
      feedbackCount: events.filter((e) => e.type === 'feedback').length,
      totalEvents: events.length,
    };
  }

  /**
   * 获取全局统计
   */
  getGlobalStats() {
    const byType = {};
    for (const e of this.#events) {
      byType[e.type] = (byType[e.type] || 0) + 1;
    }
    return {
      totalEvents: this.#events.length,
      byType,
      uniqueRecipes: new Set(this.#events.map((e) => e.recipeId)).size,
    };
  }

  /**
   * 获取热门 Recipes (by interaction count)
   */
  getTopRecipes(n = 10) {
    const counts = {};
    for (const e of this.#events) {
      counts[e.recipeId] = (counts[e.recipeId] || 0) + 1;
    }
    return Object.entries(counts)
      .sort(([, a], [, b]) => (b as number) - (a as number))
      .slice(0, n)
      .map(([recipeId, count]) => ({ recipeId, count }));
  }

  /**
   * 清空记录
   */
  clear() {
    this.#events = [];
    this.#save();
  }

  // ─── 私有 ─────────────────────────────────────────────

  #load() {
    try {
      if (existsSync(this.#feedbackPath)) {
        const data = JSON.parse(readFileSync(this.#feedbackPath, 'utf-8'));
        return Array.isArray(data) ? data : data.events || [];
      }
    } catch {
      /* silent */
    }
    return [];
  }

  #save() {
    try {
      const dir = dirname(this.#feedbackPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(this.#feedbackPath, JSON.stringify(this.#events, null, 2));
    } catch {
      /* silent */
    }
  }

  #migrateOldPath(projectRoot, internalDir) {
    try {
      const oldPath = join(projectRoot, internalDir, 'feedback.json');
      if (existsSync(oldPath) && !existsSync(this.#feedbackPath)) {
        const content = readFileSync(oldPath, 'utf-8');
        const dir = dirname(this.#feedbackPath);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        writeFileSync(this.#feedbackPath, content);
        unlinkSync(oldPath);
      }
    } catch {
      /* 迁移失败不阻断启动 */
    }
  }
}
