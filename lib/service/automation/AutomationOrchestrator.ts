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
  #history: Record<string, unknown>[];

  constructor(
    options: {
      triggerResolver?: TriggerResolver;
      contextCollector?: ContextCollector;
      pipeline?: ActionPipeline;
    } = {}
  ) {
    this.#triggerResolver = options.triggerResolver || new TriggerResolver();
    this.#contextCollector = options.contextCollector || new ContextCollector();
    this.#pipeline = options.pipeline || new ActionPipeline();
    this.#logger = Logger.getInstance();
    this.#history = [];
  }

  /**
   * 执行自动化流程
   * @param trigger 原始触发
   * @param context 原始上下文
   * @returns >}
   */
  async run(trigger: string | Record<string, unknown>, context: Record<string, unknown> = {}) {
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

  /** 注册动作处理器 */
  registerAction(
    type: string,
    handler: (
      trigger: Record<string, unknown>,
      context: Record<string, unknown>
    ) => Promise<unknown>
  ) {
    this.#pipeline.register(type, handler);
  }

  /** 获取执行历史 */
  getHistory() {
    return [...this.#history];
  }

  /** 获取管线 */
  getPipeline() {
    return this.#pipeline;
  }
}
