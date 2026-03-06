/**
 * SystemPromptBuilder — 系统提示词组装器
 *
 * 从 AgentRuntime.js 提取的 Prompt 组装逻辑。
 * 负责:
 *   - 角色定义 (Persona)
 *   - 预加载文件清单注入
 *   - Capability prompt fragments + 动态上下文
 *   - 语言偏好
 *   - 轮次预算注入 (system 源)
 *
 * @module SystemPromptBuilder
 */

export class SystemPromptBuilder {
  /** @type {object|null} persona 配置 */
  #persona;

  /** @type {Array|null} 文件缓存 */
  #fileCache;

  /** @type {string|null} 语言偏好 */
  #lang;

  /** @type {object|null} 记忆配置 */
  #memoryConfig;

  /**
   * @param {object} [opts]
   * @param {object}   [opts.persona]
   * @param {Array}    [opts.fileCache]
   * @param {string}   [opts.lang]
   * @param {object}   [opts.memoryConfig]
   */
  constructor({ persona, fileCache, lang, memoryConfig }: any = {}) {
    this.#persona = persona || null;
    this.#fileCache = fileCache || null;
    this.#lang = lang || null;
    this.#memoryConfig = memoryConfig || null;
  }

  /**
   * 更新文件缓存引用 (bootstrap 场景: allFiles 注入后更新)
   * @param {Array|null} files
   */
  setFileCache(files) {
    this.#fileCache = files;
  }

  /**
   * 构建基础系统提示词
   *
   * @param {import('../capabilities.js').Capability[]} caps 已解析的 Capability 列表
   * @param {object} context 额外上下文
   * @returns {string}
   */
  build(caps, context: any = {}) {
    const parts: any[] = [];

    // Persona (角色定义)
    if (this.#persona?.description) {
      parts.push(`# 角色\n${this.#persona.description}`);
    }

    // fileCache 文件清单
    if (this.#fileCache && this.#fileCache.length > 0) {
      const fileList = this.#fileCache
        .map((f) => {
          const lines = f.content ? f.content.split('\n').length : 0;
          const name = f.name || f.relativePath || 'unknown';
          return `- ${name} (${lines} 行${f.language ? `, ${f.language}` : ''})`;
        })
        .join('\n');
      parts.push(
        `## 预加载文件\n以下文件已加载到缓存中，工具可通过 filePath 参数引用：\n${fileList}`
      );
    }

    // Capability prompt fragments + 动态上下文
    for (const cap of caps) {
      parts.push(cap.promptFragment);

      const dynamicCtx = cap.buildContext({
        ...context,
        lang: this.#lang,
        memoryMode: this.#memoryConfig?.mode,
      });
      if (dynamicCtx) {
        parts.push(dynamicCtx);
      }
    }

    // 语言要求
    if (this.#lang === 'en') {
      parts.push('\n## Language\nRespond in English.');
    } else if (this.#lang === 'zh') {
      parts.push('\n## 语言\n用中文回复。代码/字段名保持英文。');
    }

    return parts.join('\n\n');
  }

  /**
   * 注入轮次预算 (system 源专用)
   *
   * 先验锚定阶段节奏: 60% 探索 → 80% 验证 → 最后 20% 输出总结
   *
   * @param {string} prompt 基础系统提示词
   * @param {object} opts
   * @param {string}  opts.source 消息源 (仅 'system' 时注入)
   * @param {object}  opts.tracker - ExplorationTracker (非 null 时注入)
   * @param {object}  opts.budget 预算配置
   * @returns {string} 可能追加了轮次预算段的提示词
   */
  static injectBudget(prompt, { source, tracker, budget }) {
    if (source !== 'system' || !tracker || prompt.includes('轮次预算')) {
      return prompt;
    }

    const maxIter = budget?.maxIterations || 24;
    const exploreEnd = Math.floor(maxIter * 0.6);
    const verifyEnd = Math.floor(maxIter * 0.8);

    return (
      prompt +
      `\n\n## 轮次预算\n- 总轮次: **${maxIter} 轮**\n` +
      `- 探索阶段: 第 1-${exploreEnd} 轮（搜索和结构化查询）\n` +
      `- 验证阶段: 第 ${exploreEnd + 1}-${verifyEnd} 轮（读取关键文件确认细节）\n` +
      `- 总结阶段: 第 ${verifyEnd + 1}-${maxIter} 轮（**停止工具调用，输出分析文本**）\n\n` +
      `到达第 ${verifyEnd} 轮时你必须开始输出总结，不要继续搜索。`
    );
  }
}
