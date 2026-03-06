/**
 * insight-analyst.js — Insight Analyst 领域函数
 *
 * 从旧 AnalystAgent.js 提取的纯领域逻辑:
 * - Analyst System Prompt
 * - 工具白名单
 * - 预算常量
 * - 9 段式 Prompt 构建器
 *
 * 被 PipelineStrategy 的 bootstrap preset 直接引用。
 * 不再包含任何 Agent 类 — Agent 由 AgentRuntime + PipelineStrategy 驱动。
 *
 * @module insight-analyst
 */

import { getDimensionSOP } from '../../../external/mcp/handlers/bootstrap/shared/dimension-sop.js';

// ──────────────────────────────────────────────────────────────────
// System Prompt — Analyst 专用 (~100 tokens)
// ──────────────────────────────────────────────────────────────────

export const ANALYST_SYSTEM_PROMPT = `你是一位高级软件架构师，正在深度分析一个真实项目的某个维度。

## 执行计划
你有 **N 轮**工具调用机会（系统会告知具体数字）。请严格按以下节奏分配：

| 阶段 | 轮次占比 | 目标 |
|------|---------|------|
| 1. 全局扫描 | 第 1-3 轮 | get_project_overview + list_project_structure 了解项目结构 |
| 2. 结构化探索 | 第 4-N×60% 轮 | get_class_hierarchy / get_class_info 理解核心类；search_project_code 批量搜索关键模式 |
| 3. 深度验证 | 第 N×60%-N×80% 轮 | read_project_file 阅读关键实现，确认细节 |
| 4. 输出总结 | 最后 20% | **停止调用工具**，直接输出你的分析文本 |

## 关键规则
- **到达 80% 轮次时必须开始写总结**，不要等系统提醒
- 每一轮都必须调用工具获取新信息，不要花轮次在纯文本思考上
- 不要重复搜索相同关键词或读取相同文件（系统会返回缓存并扣轮次）

## 工具效率
- **批量搜索**: search_project_code({ patterns: ["keywordA", "keywordB", "keywordC"] }) — 一次搜 3-5 个
- **批量读文件**: read_project_file({ filePaths: ["a.m", "b.m", "c.m"] }) — 一次读 3-5 个
- **结构化查询优先**: get_class_hierarchy / get_class_info 比文本搜索更精确高效

## 输出要求
输出你的分析发现，包括具体的文件路径和代码位置。
用自然语言描述你的理解，不需要特定格式。`;

// ──────────────────────────────────────────────────────────────────
// Analyst 可用工具白名单 — 只做探索，不做提交
// ──────────────────────────────────────────────────────────────────

export const ANALYST_TOOLS = [
  // AST 结构化分析
  'get_project_overview',
  'get_class_hierarchy',
  'get_class_info',
  'get_protocol_info',
  'get_method_overrides',
  'get_category_map',
  // 文件访问
  'search_project_code',
  'read_project_file',
  'list_project_structure',
  'get_file_summary',
  'semantic_search_code',
  // 前序上下文 (可选)
  'get_previous_analysis',
  // Agent Memory (v4.0) — 工作记忆 + 情景记忆
  'note_finding',
  'get_previous_evidence',
  // Phase E: 代码实体图谱查询
  'query_code_graph',
];

// ──────────────────────────────────────────────────────────────────
// Analyst 预算 — 使用 analyst 策略（自由探索，无阶段约束）
// ──────────────────────────────────────────────────────────────────

export const ANALYST_BUDGET = {
  maxIterations: 24,
  searchBudget: 18,
  searchBudgetGrace: 10,
  maxSubmits: 0,
  softSubmitLimit: 0,
  idleRoundsToExit: 2,
};

// ──────────────────────────────────────────────────────────────────
// 维度 Prompt 模板 (9 段式)
// ──────────────────────────────────────────────────────────────────

/**
 * 构建 Analyst Prompt
 *
 * 9 段结构:
 *   §1 任务描述
 *   §2 维度指引
 *   §3 SOP (分析步骤 + 常见错误)
 *   §4 输出要求
 *   §5 工具提示
 *   §6 前序维度上下文 (SessionStore / DimensionContext)
 *   §7 Tier Reflection 洞察
 *   §8 历史语义记忆 (Tier 3)
 *   §9 代码实体图谱 (Phase E)
 *
 * @param {object} dimConfig 维度配置 { id, label, guide, focusKeywords, outputType }
 * @param {object} projectInfo - { name, lang, fileCount }
 * @param {object} [dimensionContext] - DimensionContext 实例 (跨维度上下文)
 * @param {object} [episodicMemory] - SessionStore 实例 (v4.0 增强上下文)
 * @param {object} [semanticMemory] - PersistentMemory 实例 (v4.1 历史记忆)
 * @param {object} [codeEntityGraph] - CodeEntityGraph 实例 (Phase E 代码实体图谱)
 * @returns {string}
 */
export function buildAnalystPrompt(
  dimConfig,
  projectInfo,
  dimensionContext,
  episodicMemory,
  semanticMemory,
  codeEntityGraph
) {
  const parts = [];

  // §1 任务描述
  parts.push(
    `分析项目 ${projectInfo.name} (${projectInfo.lang}, ${projectInfo.fileCount} 个文件) 的 ${dimConfig.label}。`
  );

  // §2 维度指引
  if (dimConfig.guide) {
    parts.push(dimConfig.guide);
  }

  // §3 结构化 SOP (优先) — 替代 focusAreas
  const sop = getDimensionSOP(dimConfig.id);
  if (sop) {
    parts.push('## 分析步骤 (SOP)');
    for (const step of sop.steps) {
      parts.push(`### ${step.phase}`);
      parts.push(step.action);
      if (step.expectedOutput) parts.push(`→ 预期产出: ${step.expectedOutput}`);
    }
    // §3.1 常见错误 (关键质量防护)
    if (sop.commonMistakes?.length > 0) {
      parts.push('## ⚠️ 常见错误（务必避免）');
      for (const m of sop.commonMistakes) {
        parts.push(`- ${m}`);
      }
    }
  } else if (dimConfig.guide) {
    const items = dimConfig.guide.split(/[、，,/]/).map(s => s.trim()).filter(Boolean);
    if (items.length > 1) {
      parts.push(`重点关注:\n${items.map((f) => `- ${f}`).join('\n')}`);
    } else {
      parts.push(`重点关注: ${dimConfig.guide}`);
    }
  }

  // §4 输出要求
  const outputType = dimConfig.outputType || 'analysis';
  const needsCandidates = outputType === 'dual' || outputType === 'candidate';
  const depthHint = needsCandidates
    ? '你的分析将被转化为知识候选，请确保每个发现都有足够的代码证据和文件引用。目标: 发现 3-5 个独立的知识点。'
    : '';

  parts.push(`请将分析组织成结构化段落，包含:
1. 在哪些文件/类中发现 (写出具体文件路径)
2. 具体的实现方式和代码特征
3. 为什么选择这种方式（设计意图）
4. 统计数据 (如数量、占比)

每个关键发现用编号列表呈现，引用 3 个以上具体文件。
${depthHint}
重要: 务必使用 read_project_file 阅读代码确认，不要假设文件存在。引用的每个文件路径都必须是你亲眼看到的。`);

  // §5 前序上下文提示
  parts.push('可以调用 get_previous_analysis 获取前序维度的分析结果，避免重复分析。');
  parts.push('使用 note_finding 工具记录关键发现到工作记忆，确保重要信息不会在后期被遗忘。');
  parts.push('使用 get_previous_evidence 工具查询前序维度对特定文件/类的分析证据，避免重复搜索。');

  // §6 前序维度分析摘要 (Tier 2+ 才有)
  if (episodicMemory) {
    const emContext = episodicMemory.buildContextForDimension(
      dimConfig.id,
      dimConfig.focusKeywords || []
    );
    if (emContext) {
      parts.push(emContext);
    }

    // §7: Tier Reflection 洞察
    const reflections = episodicMemory.getRelevantReflections(dimConfig.id);
    if (reflections) {
      parts.push('## 跨维度综合洞察');
      parts.push(reflections);
    }
  } else if (dimensionContext) {
    const snapshot = dimensionContext.buildContextForDimension(dimConfig.id);
    const prevDims = Object.entries(snapshot.previousDimensions);
    if (prevDims.length > 0) {
      parts.push(`## 前序维度分析摘要（避免重复探索）`);
      for (const [dimId, digest] of prevDims) {
        parts.push(`### ${dimId}\n${digest.summary || '(无摘要)'}`);
        if (digest.keyFindings?.length > 0) {
          parts.push(`关键发现: ${digest.keyFindings.join('; ')}`);
        }
        if (digest.crossRefs?.[dimConfig.id]) {
          parts.push(`💡 对本维度的建议: ${digest.crossRefs[dimConfig.id]}`);
        }
      }
    }
  }

  // §8: 历史语义记忆 (Tier 3)
  if (semanticMemory) {
    try {
      const query = `${dimConfig.label} ${dimConfig.guide || ''} ${projectInfo.lang}`;
      const section = semanticMemory.toPromptSection({
        source: 'bootstrap',
        query,
        limit: 10,
      });
      if (section) {
        parts.push(section);
      }
    } catch {
      /* SemanticMemory retrieval failed, non-critical */
    }
  }

  // §9: 代码实体图谱 (Phase E)
  if (codeEntityGraph) {
    try {
      const graphCtx = codeEntityGraph.generateContextForAgent({ maxEntities: 20, maxEdges: 40 });
      if (graphCtx) {
        parts.push(graphCtx);
        parts.push('使用 query_code_graph 工具可以查询更详细的继承链、影响分析等。');
      }
    } catch {
      /* CodeEntityGraph context failed, non-critical */
    }
  }

  return parts.join('\n\n');
}
