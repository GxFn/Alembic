/**
 * SkillHooks — Skill 生命周期钩子管理器
 *
 * 每个 Skill 目录可以包含一个 hooks.js 文件，导出生命周期回调。
 * SkillHooks 在启动时扫描并注册所有钩子，在特定事件发生时按序调用。
 *
 * 支持的钩子:
 *   - onCandidateSubmit(candidate, ctx) → { block?: boolean, reason?: string }
 *   - onRecipeCreated(recipe, ctx) → void
 *   - onGuardCheck(violation, ctx) → violation (可修改)
 *   - onBootstrapComplete(stats, ctx) → void
 *
 * 加载顺序: 内置 skills/ → 项目级 AutoSnippet/skills/（同名覆盖）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getProjectSkillsPath } from '../../infrastructure/config/Paths.js';
import Logger from '../../infrastructure/logging/Logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = path.resolve(__dirname, '../../../skills');

/**
 * 获取项目级 Skills 目录（运行时动态解析）
 * 路径: {projectRoot}/AutoSnippet/skills/
 */
function _getProjectSkillsDir() {
  const projectRoot = process.env.ASD_PROJECT_DIR || process.cwd();
  return getProjectSkillsPath(projectRoot);
}

const HOOK_NAMES = ['onCandidateSubmit', 'onRecipeCreated', 'onGuardCheck', 'onBootstrapComplete'];

export class SkillHooks {
  hooks: any;
  logger: any;
  constructor() {
    this.logger = Logger.getInstance();
    /** @type {Map<string, Function[]>} hookName → [handler, ...] */
    this.hooks = new Map(HOOK_NAMES.map((n) => [n, []]));
  }

  /**
   * 扫描 skills 目录，加载所有 hooks.js
   * 项目级 hooks 覆盖同名内置 hooks
   */
  async load() {
    const loaded = new Map(); // skillName → hooks module

    // 1. 内置 skills
    await this.#loadFromDir(SKILLS_DIR, loaded);

    // 2. 项目级 skills（覆盖同名）
    await this.#loadFromDir(_getProjectSkillsDir(), loaded);

    // 3. 注册所有钩子
    for (const [skillName, mod] of loaded) {
      for (const hookName of HOOK_NAMES) {
        if (typeof mod[hookName] === 'function') {
          this.hooks.get(hookName).push(mod[hookName]);
          this.logger.debug(`SkillHook registered: ${skillName}.${hookName}`);
        }
      }
    }

    const totalHooks = [...this.hooks.values()].reduce((s, a) => s + a.length, 0);
    if (totalHooks > 0) {
      this.logger.info(`SkillHooks: loaded ${totalHooks} hooks from ${loaded.size} skills`);
    }
  }

  /**
   * 触发钩子 — 按注册顺序调用
   *
   * @param {string} hookName
   * @param  {...any} args
   * @returns {Promise<any>} 最后一个返回值（用于 blocking hooks 如 onCandidateSubmit）
   */
  async run(hookName: any, ...args: any[]) {
    const handlers = this.hooks.get(hookName);
    if (!handlers || handlers.length === 0) {
      return undefined;
    }

    let result;
    for (const handler of handlers) {
      try {
        result = await handler(...args);
        // 如果是 blocking hook 且返回 block=true，立即中断
        if (result?.block) {
          return result;
        }
      } catch (err: any) {
        this.logger.warn(`SkillHook error in ${hookName}`, { error: err.message });
      }
    }
    return result;
  }

  /**
   * 检查是否有任何钩子注册
   */
  has(hookName: any) {
    const handlers = this.hooks.get(hookName);
    return handlers && handlers.length > 0;
  }

  // ─── Internal ──────────────────────────────────────────

  async #loadFromDir(dir: any, loaded: any) {
    let dirs;
    try {
      dirs = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return; // 目录不存在
    }

    for (const name of dirs) {
      const hooksPath = path.join(dir, name, 'hooks.js');
      if (!fs.existsSync(hooksPath)) {
        continue;
      }
      try {
        const mod = await import(hooksPath);
        loaded.set(name, mod.default || mod);
      } catch (err: any) {
        this.logger.warn(`SkillHooks: failed to load ${name}/hooks.js`, { error: err.message });
      }
    }
  }
}

export default SkillHooks;
