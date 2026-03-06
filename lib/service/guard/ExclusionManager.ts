/**
 * ExclusionManager — Guard 规则排除策略管理
 * 三级排除: path（路径排除）、rule（规则在特定文件排除）、globalRule（全局禁用规则）
 * 持久化到 AutoSnippet/guard-exclusions.json（Git 友好，跟随知识库提交）
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Logger from '../../infrastructure/logging/Logger.js';
import pathGuard from '../../shared/PathGuard.js';

export class ExclusionManager {
  #exclusionsPath;
  #data; // { pathExclusions: [], ruleExclusions: {}, globalRuleExclusions: [] }

  constructor(projectRoot, options: any = {}) {
    const kbDir = options.knowledgeBaseDir || 'AutoSnippet';
    this.#exclusionsPath = join(projectRoot, kbDir, 'guard-exclusions.json');
    pathGuard.assertProjectWriteSafe(this.#exclusionsPath);
    // 迁移旧路径
    this.#migrateOldPath(projectRoot, options.internalDir || '.autosnippet');
    this.#data = this.#load();
  }

  // ─── Path 排除 ───────────────────────────────────────

  /**
   * 添加路径排除 (glob 或精确路径)
   * @param {string} pattern
   * @param {{ reason?: string }} meta
   */
  addPathExclusion(pattern, meta: any = {}) {
    if (!pattern) {
      return;
    }
    const exists = this.#data.pathExclusions.find((e) => e.pattern === pattern);
    if (exists) {
      return;
    }
    this.#data.pathExclusions.push({
      pattern,
      reason: meta.reason || '',
      addedAt: new Date().toISOString(),
    });
    this.#save();
  }

  /**
   * 检查文件路径是否被排除
   */
  isPathExcluded(filePath) {
    return this.#data.pathExclusions.some((e) => this.#matchGlob(filePath, e.pattern));
  }

  /**
   * 移除路径排除
   */
  removePathExclusion(pattern) {
    this.#data.pathExclusions = this.#data.pathExclusions.filter((e) => e.pattern !== pattern);
    this.#save();
  }

  // ─── Rule 排除 (per-file) ───────────────────────────

  /**
   * 为特定文件排除某条规则
   * @param {string} ruleId
   * @param {string} filePath
   */
  addRuleExclusion(ruleId, filePath, meta: any = {}) {
    if (!this.#data.ruleExclusions[ruleId]) {
      this.#data.ruleExclusions[ruleId] = [];
    }
    const list = this.#data.ruleExclusions[ruleId];
    if (list.find((e) => e.filePath === filePath)) {
      return;
    }
    list.push({ filePath, reason: meta.reason || '', addedAt: new Date().toISOString() });
    this.#save();
  }

  /**
   * 检查规则在特定文件是否被排除
   */
  isRuleExcluded(ruleId, filePath) {
    if (this.isRuleGloballyDisabled(ruleId)) {
      return true;
    }
    const list = this.#data.ruleExclusions[ruleId];
    if (!list) {
      return false;
    }
    return list.some((e) => e.filePath === filePath || this.#matchGlob(filePath, e.filePath));
  }

  /**
   * 移除文件级规则排除
   */
  removeRuleExclusion(ruleId, filePath) {
    const list = this.#data.ruleExclusions[ruleId];
    if (!list) {
      return;
    }
    this.#data.ruleExclusions[ruleId] = list.filter((e) => e.filePath !== filePath);
    if (this.#data.ruleExclusions[ruleId].length === 0) {
      delete this.#data.ruleExclusions[ruleId];
    }
    this.#save();
  }

  // ─── Global Rule 排除 ────────────────────────────────

  /**
   * 全局禁用某条规则
   */
  addGlobalRuleExclusion(ruleId, meta: any = {}) {
    if (this.#data.globalRuleExclusions.find((e) => e.ruleId === ruleId)) {
      return;
    }
    this.#data.globalRuleExclusions.push({
      ruleId,
      reason: meta.reason || '',
      addedAt: new Date().toISOString(),
    });
    this.#save();
  }

  /**
   * 检查规则是否被全局禁用
   */
  isRuleGloballyDisabled(ruleId) {
    return this.#data.globalRuleExclusions.some((e) => e.ruleId === ruleId);
  }

  /**
   * 移除全局规则排除
   */
  removeGlobalRuleExclusion(ruleId) {
    this.#data.globalRuleExclusions = this.#data.globalRuleExclusions.filter(
      (e) => e.ruleId !== ruleId
    );
    this.#save();
  }

  // ─── 批量操作 ─────────────────────────────────────────

  /**
   * 应用排除策略到审计结果
   * @param {object[]} violations - [{ruleId, filePath, ...}]
   * @returns {object[]} 过滤后的违反列表
   */
  applyExclusions(violations) {
    return violations.filter((v) => {
      if (v.filePath && this.isPathExcluded(v.filePath)) {
        return false;
      }
      if (v.ruleId && v.filePath && this.isRuleExcluded(v.ruleId, v.filePath)) {
        return false;
      }
      if (v.ruleId && this.isRuleGloballyDisabled(v.ruleId)) {
        return false;
      }
      return true;
    });
  }

  /**
   * 导入排除配置
   */
  importExclusions(config) {
    if (config.pathExclusions) {
      for (const e of config.pathExclusions) {
        this.addPathExclusion(e.pattern, e);
      }
    }
    if (config.ruleExclusions) {
      for (const [ruleId, list] of Object.entries(config.ruleExclusions)) {
        // @ts-expect-error TS migration: TS2488
        for (const e of list) {
          this.addRuleExclusion(ruleId, e.filePath, e);
        }
      }
    }
    if (config.globalRuleExclusions) {
      for (const e of config.globalRuleExclusions) {
        this.addGlobalRuleExclusion(e.ruleId, e);
      }
    }
  }

  /**
   * 导出当前排除配置
   */
  exportExclusions() {
    return { ...this.#data };
  }

  // ─── 私有方法 ─────────────────────────────────────────

  #matchGlob(filePath, pattern) {
    // 简易 glob 匹配: ** 表示任意路径, * 表示同级任意文件名, ? 表示单个字符
    // 1. 精确正则匹配 (支持 glob 通配符)
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '<<<GLOB>>>')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]')
      .replace(/<<<GLOB>>>/g, '.*');
    if (new RegExp(`^${escaped}$`).test(filePath)) {
      return true;
    }
    // 1b. 不含 / 的通配符 pattern 按文件名匹配 (如 *.test.js 匹配任意路径下的文件名)
    if (pattern.includes('*') && !pattern.includes('/')) {
      const basename = filePath.split('/').pop() || '';
      if (new RegExp(`^${escaped}$`).test(basename)) {
        return true;
      }
    }
    // 2. 路径段匹配 — pattern 不含通配符时，按完整路径段（/segment/）匹配
    //    避免 "test" 匹配 "contest.js" 这类误报
    if (!pattern.includes('*') && !pattern.includes('?')) {
      const segments = filePath.split('/');
      if (segments.includes(pattern)) {
        return true;
      }
      // 后缀匹配: 支持 "src/foo.js" 匹配 "/project/src/foo.js"
      if (pattern.includes('/') && filePath.endsWith(`/${pattern}`)) {
        return true;
      }
    }
    return false;
  }

  #load() {
    try {
      if (existsSync(this.#exclusionsPath)) {
        return JSON.parse(readFileSync(this.#exclusionsPath, 'utf-8'));
      }
    } catch {
      /* silent */
    }
    return { pathExclusions: [], ruleExclusions: {}, globalRuleExclusions: [] };
  }

  #save() {
    try {
      const dir = dirname(this.#exclusionsPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(this.#exclusionsPath, JSON.stringify(this.#data, null, 2));
    } catch (err: any) {
      Logger.getInstance().warn('ExclusionManager: failed to persist exclusions', {
        error: err.message,
      });
    }
  }

  /**
   * 自动迁移旧路径 .autosnippet/guard-exclusions.json → AutoSnippet/guard-exclusions.json
   */
  #migrateOldPath(projectRoot, internalDir) {
    try {
      const oldPath = join(projectRoot, internalDir, 'guard-exclusions.json');
      if (existsSync(oldPath) && !existsSync(this.#exclusionsPath)) {
        const content = readFileSync(oldPath, 'utf-8');
        const dir = dirname(this.#exclusionsPath);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        writeFileSync(this.#exclusionsPath, content);
        unlinkSync(oldPath);
        Logger.getInstance().info(
          'ExclusionManager: migrated guard-exclusions.json to knowledge base dir'
        );
      }
    } catch {
      // 迁移失败不阻断启动
    }
  }
}
