/**
 * ActionPipeline — 自动化动作管线
 * 按顺序执行注册的 action handlers
 */

import Logger from '../../infrastructure/logging/Logger.js';

export class ActionPipeline {
  #actions; // Map<type, handler>
  #logger;

  constructor() {
    this.#actions = new Map();
    this.#logger = Logger.getInstance();
  }

  /**
   * 注册动作处理器
   * @param {string} type 触发类型
   * @param {function} handler - async (trigger, context) => result
   */
  register(type: any, handler: any) {
    this.#actions.set(type, handler);
  }

  /**
   * 执行管线
   * @param {{ type: string, name?: string, params?: object }} trigger
   * @param {object} context
   * @returns {Promise<{ success: boolean, result?: any, error?: string }>}
   */
  async execute(trigger: any, context: any) {
    const handler = this.#actions.get(trigger.type);
    if (!handler) {
      // 尝试通用 handler
      const fallback = this.#actions.get('*');
      if (fallback) {
        return this.#runHandler(fallback, trigger, context);
      }
      this.#logger.warn(`[ActionPipeline] 未找到 handler: ${trigger.type}`);
      return { success: false, error: `未知触发类型: ${trigger.type}` };
    }

    return this.#runHandler(handler, trigger, context);
  }

  /**
   * 获取已注册的动作类型
   */
  getRegisteredTypes() {
    return [...this.#actions.keys()];
  }

  async #runHandler(handler: any, trigger: any, context: any) {
    try {
      const result = await handler(trigger, context);
      return { success: true, result };
    } catch (err: any) {
      this.#logger.error(`[ActionPipeline] handler 异常:`, err.message);
      return { success: false, error: err.message };
    }
  }
}
