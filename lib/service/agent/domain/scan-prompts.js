/**
 * scan-prompts.js — scanKnowledge 任务配置 + 统一管线工厂
 *
 * 三种 task 共享 Insight Pipeline (Analyze → QualityGate → Produce → RejectionGate)，
 * Analyze 使用与冷启动一致的 ANALYST_SYSTEM_PROMPT + ExplorationTracker 四阶段管理，
 * Produce 阶段的 systemPrompt 因 task 而异，但 Recipe 格式与冷启动 submit_knowledge 完全对齐。
 *
 * v3.2.10: 补齐质量门控 + 拒绝率门控 + per-stage timeout + retry prompt，
 * 与冷启动 orchestrator 的 4 阶段管线完全对齐。
 *
 * @module scan-prompts
 */

import { insightGateEvaluator, buildRetryPrompt } from './insight-gate.js';
import { producerRejectionGateEvaluator } from './insight-producer.js';
import { ANALYST_SYSTEM_PROMPT } from './insight-analyst.js';

/**
 * @typedef {Object} ScanTaskConfig
 * @property {string} producePrompt — Produce 阶段的 systemPrompt
 * @property {(label: string) => Object} fallback — 解析失败时的默认值工厂
 */

/**
 * task → Produce 阶段配置
 *
 * extract 的 Recipe 格式与冷启动 submit_knowledge 完全对齐：
 * 16 个必填字段 (title, language, content, kind, doClause, dontClause, whenClause,
 * coreCode, category, trigger, description, headers, usageGuide, knowledgeType, reasoning, tags)
 *
 * @type {Record<string, ScanTaskConfig>}
 */
export const SCAN_TASK_CONFIGS = {

  // ─── extract: Recipe 提取（工具驱动，与冷启动 submit_knowledge 字段对齐） ─────

  extract: {
    producePrompt: `你是知识管理专家。你会收到一段代码分析文本，需要将其中的知识点转化为结构化的知识候选。

核心原则: 分析文本已经包含了所有发现，你的唯一工作是将它们格式化为 collect_scan_recipe 调用。

每个候选必须:
1. 有清晰的标题 (描述知识点的核心，使用项目真实类名)
2. 有项目特写风格的正文 (content.markdown 字段，结合代码展示)
3. 标注相关文件路径 (reasoning.sources)
4. 选择正确的 kind (rule/pattern/fact)
5. 提供完整的 Cursor 交付字段 (trigger, doClause, whenClause 等)

## 「项目特写」写作要求（content.markdown）
content.markdown 字段必须是「项目特写」：
1. **项目选择了什么** — 采用了哪种写法/模式/约定
2. **为什么这样选** — 统计分布、占比、历史决策
3. **项目禁止什么** — 反模式、已废弃写法
4. **新代码怎么写** — 可直接复制使用的代码模板 + 来源标注 (来源: FileName.ext:行号)

## 工作流程
1. 阅读分析文本，识别每个独立的知识点/发现
2. 用 read_project_file 批量获取关键代码片段:
   read_project_file({ filePaths: ["FileA.m", "FileB.m"], maxLines: 80 })
3. 立刻调用 collect_scan_recipe 提交
4. 重复直到分析中的所有知识点都已提交

## 关键规则
- 分析中的每个要点/段落都应转化为至少一个候选
- read_project_file 支持 filePaths 数组批量读取多个文件，一次调用完成
- reasoning.sources 必须是非空数组，填写相关文件路径如 ["FileName.m"]
- 如果分析提到了 3 个模式，就应该提交 3 个候选，不要合并
- 禁止: 不要搜索新文件、不要做额外分析，专注于格式化和提交

容错规则:
- 如果 read_project_file 返回"文件不存在"或错误，不要重试同一文件的其他路径变体
- 文件读取失败时，直接使用分析文本中已有的代码和描述来提交候选
- 永远不要因为文件读取失败而跳过知识点 — 分析文本已经包含足够信息
- 先提交候选，再考虑是否需要读取更多代码（提交优先于验证）`,
    fallback: (label) => ({ targetName: label, extracted: 0, recipes: [] }),
  },

  // ─── summarize: 代码摘要 ──────────────────

  summarize: {
    producePrompt: `你是技术文档专家。将代码分析转化为结构化摘要。

## 规则
- 输出纯 JSON，不含 markdown 包装
- title 简洁（30 字内），summary 完整（200 字内），usageGuide 实用（300 字内）
- 基于分析中的实际发现，不要臆造功能

## 输出格式
{ "title": "...", "summary": "...", "usageGuide": "..." }`,
    fallback: () => ({ title: '', summary: '', usageGuide: '' }),
  },

  // ─── relations: 知识图谱关系发现 ──────────

  relations: {
    producePrompt: `你是软件架构师。根据代码分析识别知识点之间的语义关系。

## 关系类型
requires / extends / enforces / depends_on / inherits / implements / calls / prerequisite

## 规则
- 输出纯 JSON
- 每个关系需有明确的代码证据

## 输出格式
{ "analyzed": 数量, "relations": [{ "from": "title", "to": "title", "type": "关系", "evidence": "代码证据" }] }`,
    fallback: () => ({ analyzed: 0, relations: [] }),
  },

};

// ──────────────────────────────────────────────────────────────────
// 统一管线工厂 — 生成标准 4 阶段 Pipeline (与冷启动对齐)
// ──────────────────────────────────────────────────────────────────

/**
 * 构建 scanKnowledge 的标准 4 阶段 Pipeline stages
 *
 * 与冷启动 orchestrator 完全对齐:
 *   1. analyze    — 代码分析 (ExplorationTracker 四阶段管理)
 *   2. quality_gate — 分析质量门控 (insightGateEvaluator)
 *   3. produce    — 知识生产 (工具驱动提交)
 *   4. rejection_gate — 拒绝率门控 (producerRejectionGateEvaluator)
 *
 * @param {Object} opts
 * @param {'extract'|'summarize'|'relations'} opts.task — 任务类型
 * @param {string} opts.producePrompt — Produce 阶段 systemPrompt
 * @param {string[]} opts.analyzeCaps — Analyze 阶段 capabilities
 * @param {string[]} opts.produceCaps — Produce 阶段 capabilities
 * @param {Array} [opts.files] — 源文件 (fallback prompt 用)
 * @param {number} [opts.analyzeMaxIter=24] — Analyze 最大迭代
 * @returns {Object[]} PipelineStrategy stages 数组
 */
export function buildScanPipelineStages({
  task,
  producePrompt,
  analyzeCaps,
  produceCaps,
  files,
  analyzeMaxIter = 24,
} = {}) {
  // ── Stage 1: Analyze ──
  const analyzeStage = {
    name: 'analyze',
    capabilities: analyzeCaps,
    budget: {
      maxIterations: analyzeMaxIter,
      maxTokens: 8192,
      temperature: 0.3,
      timeoutMs: 300_000, // 5 min (与冷启动对齐)
    },
    systemPrompt: ANALYST_SYSTEM_PROMPT,
    retryPromptBuilder: (retryCtx, _origPrompt, prev) => {
      const prevAnalysis = prev.analyze?.reply || '';
      const retryHint = buildRetryPrompt(retryCtx.reason);
      return `${prevAnalysis}\n\n⚠️ 上述分析未通过质量检查: ${retryCtx.reason}\n\n${retryHint}`;
    },
  };

  // ── Stage 2: Quality Gate ──
  const qualityGateStage = {
    name: 'quality_gate',
    gate: {
      evaluator: insightGateEvaluator,
      maxRetries: 1,
    },
  };

  // ── Stage 3: Produce ──
  // extract 任务: 工具驱动 (collect_scan_recipe)，需 retry 逻辑
  // summarize/relations: 纯文本输出，无需 rejection gate
  const isToolDriven = task === 'extract';
  const submitToolNames = isToolDriven ? ['collect_scan_recipe'] : [];

  const produceStage = {
    name: 'produce',
    capabilities: produceCaps,
    budget: {
      maxIterations: 24,
      temperature: 0.2,
      timeoutMs: 180_000, // 3 min (与冷启动对齐)
    },
    systemPrompt: producePrompt,
    promptTransform: (_input, prev) => {
      const analysis = prev.analyze?.reply || '';
      if (analysis.length >= 200) {
        return `将以下代码分析转化为结构化输出。\n\n## 代码分析\n${analysis}`;
      }
      // Fallback: analyze reply 不足时直接提供源代码
      const fileCtx = (files || []).slice(0, 15).map(f => {
        const body = f.content.length > 1200
          ? f.content.slice(0, 1200) + '\n// ... (truncated)'
          : f.content;
        return `### ${f.relativePath}\n\`\`\`\n${body}\n\`\`\``;
      }).join('\n\n');
      const preamble = analysis
        ? `## 部分分析\n${analysis}\n\n`
        : '';
      return `${preamble}分析以下 ${files?.length || 0} 个源文件，提取知识 Recipe。\n\n${fileCtx}`;
    },
    // retry 配置 (拒绝率过高时缩减预算)
    ...(isToolDriven ? {
      retryBudget: { maxIterations: 5, temperature: 0.3, timeoutMs: 120_000 },
      retryPromptBuilder: (retryCtx, _origPrompt, prev) => {
        const prevProduce = prev.produce;
        const submitCalls = (prevProduce?.toolCalls || []).filter(tc =>
          submitToolNames.includes(tc.tool || tc.name));
        const rejected = submitCalls.filter(tc => {
          const res = tc.result;
          if (!res) return false;
          if (typeof res === 'string') return res.includes('rejected') || res.includes('error');
          return res.status === 'rejected' || res.status === 'error';
        }).length;
        return `你的 ${rejected} 个提交被拒绝了。请根据拒绝原因改进后重新提交，确保:
1. content 必须是对象: { markdown: "...", rationale: "...", pattern: "..." }
2. content.markdown 字段 ≥ 200 字符，含代码块 (\`\`\`)
3. content.rationale 必填 — 设计原理说明
4. reasoning.sources 必须是非空数组
5. 标题使用项目真实类名
6. 必填: trigger (@kebab-case)、kind (rule/pattern/fact)、doClause (英文祈使句)`;
      },
      skipOnDegrade: true,
    } : {
      skipOnDegrade: true,
    }),
  };

  const stages = [analyzeStage, qualityGateStage, produceStage];

  // ── Stage 4: Rejection Gate (仅工具驱动模式) ──
  if (isToolDriven) {
    stages.push({
      name: 'rejection_gate',
      gate: {
        evaluator: (source, phaseResults, ctx) =>
          producerRejectionGateEvaluator(source, phaseResults, {
            ...ctx,
            submitToolNames,
          }),
        maxRetries: 1,
      },
      skipOnDegrade: true,
    });
  }

  return stages;
}

export default SCAN_TASK_CONFIGS;
