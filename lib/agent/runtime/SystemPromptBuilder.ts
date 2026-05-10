import type { FileCacheEntry } from "./AgentRuntimeTypes.js";

export interface RuntimeCapability {
  readonly promptFragment: string;
  buildContext?(context: Record<string, unknown>): string | null | undefined;
}

export interface SystemPromptBuilderOptions {
  readonly persona?: { readonly description?: string; readonly [key: string]: unknown } | null;
  readonly fileCache?: readonly FileCacheEntry[] | null;
  readonly lang?: string | null;
  readonly memoryConfig?: { readonly mode?: string; readonly [key: string]: unknown } | null;
}

export interface BudgetPromptOptions {
  readonly source?: string;
  readonly tracker: unknown;
  readonly budget: { readonly maxIterations?: number; readonly [key: string]: unknown };
}

export class SystemPromptBuilder {
  #persona: SystemPromptBuilderOptions["persona"];
  #fileCache: readonly FileCacheEntry[] | null;
  #lang: string | null;
  #memoryConfig: SystemPromptBuilderOptions["memoryConfig"];

  constructor({
    persona = null,
    fileCache = null,
    lang = null,
    memoryConfig = null,
  }: SystemPromptBuilderOptions = {}) {
    this.#persona = persona;
    this.#fileCache = fileCache;
    this.#lang = lang;
    this.#memoryConfig = memoryConfig;
  }

  /** bootstrap 注入文件后，用同一个 builder 刷新文件清单。 */
  setFileCache(files: readonly FileCacheEntry[] | null): void {
    this.#fileCache = files;
  }

  build(caps: readonly RuntimeCapability[], context: Record<string, unknown> = {}): string {
    const parts: string[] = [];
    if (this.#persona?.description) {
      parts.push(`# 角色\n${this.#persona.description}`);
    }

    if (this.#fileCache && this.#fileCache.length > 0) {
      const fileList = this.#fileCache
        .map((file) => {
          const lines = file.content ? file.content.split("\n").length : 0;
          const name = file.name ?? file.relativePath;
          return `- ${name} (${lines} 行${file.language ? `, ${file.language}` : ""})`;
        })
        .join("\n");
      parts.push(
        `## 预加载文件\n以下文件已加载到缓存中，工具可通过 filePath 参数引用：\n${fileList}`,
      );
    }

    for (const cap of caps) {
      parts.push(cap.promptFragment);
      const dynamicContext = cap.buildContext?.({
        ...context,
        lang: this.#lang,
        memoryMode: this.#memoryConfig?.mode,
      });
      if (dynamicContext) {
        parts.push(dynamicContext);
      }
    }

    if (this.#lang === "en") {
      parts.push("\n## Language\nRespond in English.");
    } else if (this.#lang === "zh") {
      parts.push("\n## 语言\n用中文回复。代码/字段名保持英文。");
    }

    return parts.join("\n\n");
  }

  static injectBudget(prompt: string, { source, tracker, budget }: BudgetPromptOptions): string {
    if (source !== "system" || !tracker || prompt.includes("轮次预算")) {
      return prompt;
    }
    const maxIter = budget.maxIterations ?? 24;
    const exploreEnd = Math.floor(maxIter * 0.6);
    const verifyEnd = Math.floor(maxIter * 0.8);
    return (
      `${prompt}\n\n## 轮次预算\n- 总轮次: **${maxIter} 轮**\n` +
      `- 探索阶段: 第 1-${exploreEnd} 轮（搜索和结构化查询）\n` +
      `- 验证阶段: 第 ${exploreEnd + 1}-${verifyEnd} 轮（读取关键文件确认细节）\n` +
      `- 总结阶段: 第 ${verifyEnd + 1}-${maxIter} 轮（停止工具调用，输出分析文本）\n\n` +
      `到达第 ${verifyEnd} 轮时你必须开始输出总结，不要继续搜索。`
    );
  }
}
