/**
 * ContextCollector — 自动化上下文收集器
 * 收集并规范化自动化执行所需的上下文信息
 */

import { LanguageService } from '../../shared/LanguageService.js';

export class ContextCollector {
  /**
   * 收集上下文
   * @param {object} rawContext 原始上下文
   * @returns {object} 规范化的上下文
   */
  collect(rawContext: Record<string, unknown> = {}) {
    return {
      ...rawContext,
      filePath: rawContext.filePath || null,
      content: rawContext.content || null,
      language:
        rawContext.language ||
        this.#detectLanguage(rawContext.filePath as string | null | undefined),
      projectRoot: rawContext.projectRoot || null,
      user: rawContext.user || 'default',
      timestamp: new Date().toISOString(),
      environment: {
        platform: process.platform,
        nodeVersion: process.version,
      },
    };
  }

  #detectLanguage(filePath: string | null | undefined) {
    if (!filePath) {
      return null;
    }
    const lang = LanguageService.inferLang(filePath);
    return lang === 'unknown' ? null : lang;
  }
}
