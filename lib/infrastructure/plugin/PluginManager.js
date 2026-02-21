/**
 * PluginManager — 插件管理器
 * 支持注册、启用/禁用、优先级排序的插件系统
 */

import Logger from '../logging/Logger.js';

export class PluginManager {
  #plugins; // Map<name, { plugin, enabled, priority, meta }>
  #logger;

  constructor() {
    this.#plugins = new Map();
    this.#logger = Logger.getInstance();
  }

  /**
   * 注册插件
   * @param {string} name
   * @param {object} plugin - 插件对象，需有 init()/destroy() 方法
   * @param {{ priority?: number, description?: string }} meta
   */
  register(name, plugin, meta = {}) {
    this.#plugins.set(name, {
      plugin,
      enabled: true,
      priority: meta.priority || 0,
      description: meta.description || '',
      registeredAt: new Date().toISOString(),
    });
    this.#logger.debug(`[PluginManager] 注册插件: ${name}`);
  }

  /**
   * 卸载插件
   */
  unregister(name) {
    const entry = this.#plugins.get(name);
    if (entry?.plugin?.destroy) {
      try {
        entry.plugin.destroy();
      } catch {
        /* silent */
      }
    }
    this.#plugins.delete(name);
  }

  /**
   * 启用/禁用插件
   */
  setEnabled(name, enabled) {
    const entry = this.#plugins.get(name);
    if (entry) {
      entry.enabled = enabled;
    }
  }

  /**
   * 初始化所有已启用的插件（按 priority 降序）
   */
  async initAll(context = {}) {
    const sorted = this.#getSorted();
    for (const { name, entry } of sorted) {
      if (!entry.enabled || !entry.plugin.init) {
        continue;
      }
      try {
        await entry.plugin.init(context);
        this.#logger.debug(`[PluginManager] 初始化: ${name}`);
      } catch (err) {
        this.#logger.error(`[PluginManager] 初始化失败: ${name}`, err.message);
      }
    }
  }

  /**
   * 销毁所有插件
   */
  async destroyAll() {
    for (const [_name, entry] of this.#plugins) {
      if (entry.plugin.destroy) {
        try {
          await entry.plugin.destroy();
        } catch {
          /* silent */
        }
      }
    }
    this.#plugins.clear();
  }

  /**
   * 获取所有已启用插件
   */
  getEnabled() {
    return this.#getSorted()
      .filter(({ entry }) => entry.enabled)
      .map(({ name, entry }) => ({
        name,
        priority: entry.priority,
        description: entry.description,
      }));
  }

  /**
   * 获取插件实例
   */
  getPlugin(name) {
    return this.#plugins.get(name)?.plugin || null;
  }

  /**
   * 在所有启用的插件上调用钩子方法
   * @param {string} hookName
   * @param  {...any} args
   */
  async callHook(hookName, ...args) {
    const results = [];
    for (const { name, entry } of this.#getSorted()) {
      if (!entry.enabled || !entry.plugin[hookName]) {
        continue;
      }
      try {
        const result = await entry.plugin[hookName](...args);
        results.push({ name, result });
      } catch (err) {
        this.#logger.warn(`[PluginManager] hook ${hookName} 失败 (${name}):`, err.message);
      }
    }
    return results;
  }

  #getSorted() {
    return [...this.#plugins.entries()]
      .map(([name, entry]) => ({ name, entry }))
      .sort((a, b) => b.entry.priority - a.entry.priority);
  }
}
