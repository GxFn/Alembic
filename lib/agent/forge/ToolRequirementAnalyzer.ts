/**
 * ToolRequirementAnalyzer — 工具需求分析器
 *
 * 分析结构化意图，确定满足需求的最佳路径：
 *   1. Reuse  — 注册表中已有完全匹配的工具
 *   2. Compose — 可通过组合已有工具满足
 *   3. Generate — 必须由 LLM 生成新工具代码
 */

import Logger from '#infra/logging/Logger.js';

/* ────────────────────── Types ────────────────────── */

interface ToolRegistryLike {
  has(name: string): boolean;
  getToolNames(): string[];
}

export interface ToolRequirement {
  /** 用户意图描述 */
  intent: string;
  /** 关键动作词（如 read / search / transform / validate） */
  action: string;
  /** 目标对象（如 file / database / API） */
  target: string;
  /** 附加约束 */
  constraints?: string[];
}

export type ForgeMode = 'reuse' | 'compose' | 'generate';

export interface AnalysisResult {
  /** 推荐的 Forge 模式 */
  mode: ForgeMode;
  /** 置信度 0-1 */
  confidence: number;
  /** 推理理由 */
  reasoning: string;
  /** mode=reuse 时：匹配的工具名 */
  matchedTool?: string;
  /** mode=compose 时：建议参与组合的工具列表 */
  composableTools?: string[];
}

/* ────────────── Action → Tool Keyword mapping ────────────── */

const ACTION_TOOL_HINTS: Record<string, string[]> = {
  read: ['read', 'get', 'fetch', 'load', 'file'],
  search: ['search', 'find', 'query', 'lookup'],
  write: ['write', 'save', 'create', 'update', 'set'],
  delete: ['delete', 'remove', 'clear'],
  transform: ['transform', 'convert', 'parse', 'format'],
  validate: ['validate', 'check', 'guard', 'lint'],
  analyse: ['analyze', 'analyse', 'inspect', 'stats'],
  list: ['list', 'browse', 'enumerate'],
  execute: ['execute', 'run', 'invoke', 'call'],
};

/* ────────────────────── Class ────────────────────── */

export class ToolRequirementAnalyzer {
  #registry: ToolRegistryLike;
  #logger = Logger.getInstance();

  constructor(registry: ToolRegistryLike) {
    this.#registry = registry;
  }

  /**
   * 分析需求并推荐 Forge 模式
   */
  analyze(requirement: ToolRequirement): AnalysisResult {
    // 1. 尝试精确匹配
    const exactMatch = this.#tryExactMatch(requirement);
    if (exactMatch) {
      return exactMatch;
    }

    // 2. 尝试组合匹配
    const composeMatch = this.#tryComposeMatch(requirement);
    if (composeMatch) {
      return composeMatch;
    }

    // 3. Fallback: 需要生成
    return {
      mode: 'generate',
      confidence: 0.5,
      reasoning: `No existing tool matches "${requirement.action} ${requirement.target}". Code generation required.`,
    };
  }

  /* ── Internal ── */

  #tryExactMatch(req: ToolRequirement): AnalysisResult | null {
    // 直接检查 action_target 形式的工具名
    const directName = `${req.action}_${req.target}`.toLowerCase();
    if (this.#registry.has(directName)) {
      return {
        mode: 'reuse',
        confidence: 1.0,
        reasoning: `Exact tool match: "${directName}"`,
        matchedTool: directName,
      };
    }

    // 模糊匹配：遍历已注册工具，看名称是否同时包含 action 和 target 关键词
    const allTools = this.#registry.getToolNames();
    const actionLower = req.action.toLowerCase();
    const targetLower = req.target.toLowerCase();

    for (const tool of allTools) {
      const toolLower = tool.toLowerCase();
      if (toolLower.includes(actionLower) && toolLower.includes(targetLower)) {
        return {
          mode: 'reuse',
          confidence: 0.85,
          reasoning: `Fuzzy match: tool "${tool}" contains both "${req.action}" and "${req.target}"`,
          matchedTool: tool,
        };
      }
    }

    // 通过 action hint 词尝试
    const hints = ACTION_TOOL_HINTS[actionLower] ?? [actionLower];
    for (const tool of allTools) {
      const toolLower = tool.toLowerCase();
      const matchesHint = hints.some((h) => toolLower.includes(h));
      const matchesTarget = toolLower.includes(targetLower);

      if (matchesHint && matchesTarget) {
        return {
          mode: 'reuse',
          confidence: 0.7,
          reasoning: `Hint match: tool "${tool}" matches action hint and target "${req.target}"`,
          matchedTool: tool,
        };
      }
    }

    return null;
  }

  #tryComposeMatch(req: ToolRequirement): AnalysisResult | null {
    const allTools = this.#registry.getToolNames();
    const actionLower = req.action.toLowerCase();
    const targetLower = req.target.toLowerCase();

    const hints = ACTION_TOOL_HINTS[actionLower] ?? [actionLower];

    // 寻找和 action 相关的工具
    const actionRelated = allTools.filter((t) => {
      const tl = t.toLowerCase();
      return hints.some((h) => tl.includes(h));
    });

    // 寻找和 target 相关的工具
    const targetRelated = allTools.filter((t) => t.toLowerCase().includes(targetLower));

    // 取并集
    const candidates = [...new Set([...actionRelated, ...targetRelated])];

    if (candidates.length >= 2) {
      this.#logger.debug(
        `ToolRequirementAnalyzer: compose candidates for "${req.intent}": ${candidates.join(', ')}`
      );
      return {
        mode: 'compose',
        confidence: 0.65,
        reasoning: `Found ${candidates.length} composable tools for "${req.action} ${req.target}"`,
        composableTools: candidates.slice(0, 5),
      };
    }

    return null;
  }
}
