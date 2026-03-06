/**
 * AutomationOrchestrator — 自动化编排器
 * 整合 TriggerResolver + ContextCollector + ActionPipeline
 */

import Logger from '../../infrastructure/logging/Logger.js';
import { ActionPipeline } from './ActionPipeline.js';
import { ContextCollector } from './ContextCollector.js';
import { TriggerResolver } from './TriggerResolver.js';

export class AutomationOrchestrator {
  #triggerResolver;
  #contextCollector;
  #pipeline;
  #logger;
  #history;

  constructor(options: any = {}) {
    this.#triggerResolver = options.triggerResolver || new TriggerResolver();
    this.#contextCollector = options.contextCollector || new ContextCollector();
    this.#pipeline = options.pipeline || new ActionPipeline();
    this.#logger = Logger.getInstance();
    this.#history = [];
  }

  /**
   * 执行自动化流程
   * @param {string|object} trigger 原始触发
   * @param {object} context 原始上下文
   * @returns {Promise<{ success: boolean, result?: any, error?: string, resolvedTrigger: object }>}
   */
  async run(trigger, context: any = {}) {
    const resolvedTrigger = this.#triggerResolver.resolve(trigger);
    const collectedContext = this.#contextCollector.collect(context);

    this.#logger.info(
      `[AutomationOrchestrator] run type=${resolvedTrigger.type} name=${resolvedTrigger.name || ''}`
    );

    const pipelineResult = await this.#pipeline.execute(resolvedTrigger, collectedContext);

    const record = {
      trigger: resolvedTrigger,
      context: { filePath: collectedContext.filePath, language: collectedContext.language },
      result: pipelineResult,
      timestamp: new Date().toISOString(),
    };
    this.#history.push(record);
    if (this.#history.length > 200) {
      this.#history = this.#history.slice(-200);
    }

    return { ...pipelineResult, resolvedTrigger };
  }

  /**
   * 注册动作处理器
   */
  registerAction(type, handler) {
    this.#pipeline.register(type, handler);
  }

  /**
   * 获取执行历史
   */
  getHistory() {
    return [...this.#history];
  }

  /**
   * 获取管线
   */
  getPipeline() {
    return this.#pipeline;
  }
}
