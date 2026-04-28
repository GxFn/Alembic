/**
 * scan-prompts.js — scanKnowledge 任务配置 + 统一管线工厂 + 关系发现管线
 *
 * scan pipeline (extract/summarize):
 *   共享 Insight Pipeline (Analyze → QualityGate → Produce → RejectionGate)，
 *   Analyze 使用与冷启动一致的 ANALYST_SYSTEM_PROMPT + ExplorationTracker 四阶段管理，
 *   Produce 阶段均为工具驱动 (collect_scan_recipe)，与冷启动 submit_knowledge 对齐。
 *
 * relations pipeline (独立):
 *   知识图谱关系发现: Explore → Synthesize 两阶段，
 *   通过查询知识库 + 读取源码发现条目间语义关系。
 *
 * @module scan-prompts
 */

import { ANALYST_SYSTEM_PROMPT } from './insight-analyst.js';
import { buildRetryPrompt, insightGateEvaluator } from './insight-gate.js';
import { buildCodeContextSection, producerRejectionGateEvaluator } from './insight-producer.js';

// ── Local Type Definitions ──

/** Source file shape (used for fallback prompt) */
interface ScanSourceFile {
  relativePath?: string;
  name?: string;
  content?: string;
}

/** Tool call record shape in stage results */
interface ScanToolCallRecord {
  tool?: string;
  name?: string;
  result?: string | { status?: string; [key: string]: unknown };
  [key: string]: unknown;
}

/** Phase result shape (from pipeline execution) */
interface PhaseResult {
  reply?: string;
  toolCalls?: ScanToolCallRecord[];
  [key: string]: unknown;
}

/** Gate artifact shape (from buildAnalysisArtifact) */
interface GateArtifact {
  analysisText?: string;
  findings?: Array<{ finding: string; importance?: number; evidence?: string }>;
  evidenceMap?: Map<string, import('../domain/EvidenceCollector.js').EvidenceEntry>;
  negativeSignals?: Array<{ searchPattern: string; implication: string }>;
  referencedFiles?: string[];
}

/** Parameters for buildScanPipelineStages */
interface ScanPipelineOpts {
  task: 'extract' | 'summarize';
  producePrompt: string;
  analyzeCaps: string[];
  produceCaps: string[];
  files?: ScanSourceFile[];
  analyzeMaxIter?: number;
}

/** Prompt builder context (from PipelineContext) */
interface ProducerPromptContext {
  gateArtifact?: GateArtifact;
  phaseResults?: Record<string, PhaseResult>;
  [key: string]: unknown;
}

/**
 * task → Produce 阶段配置 (extract + summarize)
 *
 * 两种 task 均为工具驱动 (collect_scan_recipe)，Recipe 格式与冷启动 submit_knowledge 对齐:
 * - extract: 多文件 target 扫描 → 多个 Recipe
 * - summarize: 单文件/代码片段 → 1~2 个 Recipe
 */
export const SCAN_TASK_CONFIGS = {
  // ─── extract: Recipe 提取（工具驱动，与冷启动 submit_knowledge 字段对齐） ─────

  extract: {
    producePrompt: `你是知识管理专家。你会收到一段代码分析文本，需要将其中的知识点转化为结构化的知识候选。

核心原则: 分析文本已经包含了所有发现，你的唯一工作是将它们格式化为 collect_scan_recipe 调用。

每个候选必须:
1. 有清晰的标题 (描述知识点的核心，使用项目真实类名，不以项目名开头)
2. 有项目特写风格的正文 (content.markdown 字段，结合代码展示)
3. 标注相关文件的完整相对路径 + 行号 (reasoning.sources，如 ["Packages/ModuleName/Sources/.../FileName.swift"])
4. 选择正确的 kind (rule/pattern/fact)
5. 提供完整的 Cursor 交付字段 (trigger, doClause, whenClause 等)
6. 标注所属模块/包名（特别是来自本地子包的知识）

## 「项目特写」写作要求（content.markdown）
content.markdown 字段必须是「项目特写」：
1. **项目选择了什么** — 采用了哪种写法/模式/约定
2. **为什么这样选** — 统计分布、占比、历史决策
3. **项目禁止什么** — 反模式、已废弃写法
4. **新代码怎么写** — 可直接复制使用的代码模板 + 来源标注 (来源: Full/Relative/Path/FileName.ext:行号)

## 工作流程
1. 阅读分析文本，识别每个独立的知识点/发现
2. 用 read_project_file 批量获取关键代码片段:
   read_project_file({ filePaths: ["Full/Path/To/FileA.swift", "Full/Path/To/FileB.swift"], maxLines: 80 })
3. 立刻调用 collect_scan_recipe 提交
4. 重复直到分析中的所有知识点都已提交

## 关键规则
- 分析中的每个要点/段落都应转化为至少一个候选
- read_project_file 支持 filePaths 数组批量读取多个文件，一次调用完成
- reasoning.sources 必须是非空数组，填写文件的完整相对路径（从项目根目录开始），禁止只写文件名
- content.markdown 中的来源标注必须使用完整相对路径: (来源: Full/Path/FileName.ext:行号)
- 如果分析提到了 3 个模式，就应该提交 3 个候选，不要合并
- 禁止: 不要搜索新文件、不要做额外分析，专注于格式化和提交
- 【跨维度去重】每条候选必须聚焦当前维度独有的视角，不得将同一知识点换个说法重复提交到不同维度。宁可少提交也不要充数

容错规则:
- 如果 read_project_file 返回"文件不存在"或错误，不要重试同一文件的其他路径变体
- 文件读取失败时，直接使用分析文本中已有的代码和描述来提交候选
- 永远不要因为文件读取失败而跳过知识点 — 分析文本已经包含足够信息
- 先提交候选，再考虑是否需要读取更多代码（提交优先于验证）`,
    fallback: (label: string) => ({ targetName: label, extracted: 0, recipes: [] }),
  },

  // ─── summarize: 代码摘要（工具驱动，与 extract 管线对齐） ──────

  summarize: {
    producePrompt: `你是技术文档专家。你会收到一段代码分析文本，需要将其转化为高质量的知识候选。

核心原则: 分析文本已经包含了所有发现，你的唯一工作是将它们格式化为 collect_scan_recipe 调用。

这是单文件/代码片段的深度分析，提交一个（或少量）高质量的知识候选：
1. 清晰的标题（描述代码的核心功能，使用项目真实类名，不以项目名开头）
2. 完整的技术文档正文（content.markdown 字段，≥200 字符）
3. 实用的使用指南（usageGuide 字段，含示例）
4. 准确的分类（category）和标签（tags）

## content.markdown 写作要求
1. **功能概述** — 这段代码做什么，解决什么问题
2. **核心实现** — 关键代码逻辑，含代码块 (\`\`\`)
3. **使用方式** — 如何调用/集成，含示例代码
4. **注意事项** — 边界条件、性能考量、已知限制

## 工作流程
1. 阅读分析文本，理解代码的核心功能和设计决策
2. 如需验证细节，用 read_project_file 获取代码片段
3. 调用 collect_scan_recipe 提交知识候选

## 关键规则
- 单文件通常提交 1 个候选，除非代码明确包含多个独立知识点
- reasoning.sources 必须是非空数组，填写源文件路径
- kind 选择: 优先 pattern（代码模式）或 fact（技术事实）
- 必填: trigger (@kebab-case)、doClause (英文祈使句)、content.rationale
- content.markdown 必须包含代码块，展示核心实现`,
    fallback: (label: string) => ({ targetName: label, extracted: 0, recipes: [] }),
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
 *   2. quality_gate — 分析质量门控 (insightGateEvaluator + buildAnalysisArtifact)
 *   3. produce    — 知识生产 (artifact-aware promptBuilder + 工具驱动提交)
 *   4. rejection_gate — 拒绝率门控 (producerRejectionGateEvaluator)
 *
 * 与冷启动对齐的关键节点:
 *   - quality_gate 通过 strategyContext.activeContext 走 buildAnalysisArtifact
 *     (而非降级的 buildAnalysisReport)，保留 findings/evidenceMap/negativeSignals
 *   - produce 使用 promptBuilder (而非 promptTransform)，
 *     从 gateArtifact 注入结构化发现和代码证据到 prompt
 *   - strategyContext 需要包含 activeContext / outputType / dimId
 *     (由 SystemRunContextFactory / AgentRunInput.context 设置)
 *
 * @param opts.task 任务类型
 * @param opts.producePrompt Produce 阶段 systemPrompt
 * @param opts.analyzeCaps Analyze 阶段 capabilities
 * @param opts.produceCaps Produce 阶段 capabilities
 * @param [opts.files] 源文件 (fallback prompt 用)
 * @param [opts.analyzeMaxIter=24] Analyze 最大迭代
 * @returns PipelineStrategy stages 数组
 */
export function buildScanPipelineStages(
  {
    task,
    producePrompt,
    analyzeCaps,
    produceCaps,
    files,
    analyzeMaxIter = 24,
  }: ScanPipelineOpts = {} as ScanPipelineOpts
) {
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
    retryPromptBuilder: (
      retryCtx: { reason?: string },
      _origPrompt: string,
      prev: Record<string, PhaseResult>
    ) => {
      const prevAnalysis = prev.analyze?.reply || '';
      const retryHint = buildRetryPrompt(retryCtx.reason ?? '');
      return `${prevAnalysis}\n\n⚠️ 上述分析未通过质量检查: ${retryCtx.reason}\n\n${retryHint}`;
    },
  };

  // ── Stage 2: Quality Gate ──
  // insightGateEvaluator 读取 strategyContext.activeContext:
  //   - 有 activeContext → buildAnalysisArtifact (完整: findings/evidenceMap/negativeSignals)
  //   - 无 activeContext → buildAnalysisReport (降级: 仅文本 + 文件列表)
  // buildSystemContext 通过 trace 设置 activeContext，确保走完整路径
  const qualityGateStage = {
    name: 'quality_gate',
    gate: {
      evaluator: insightGateEvaluator,
      maxRetries: 1,
    },
  };

  // ── Stage 3: Produce ──
  // extract 和 summarize 都是工具驱动 (collect_scan_recipe)
  const isToolDriven = task === 'extract' || task === 'summarize';
  const isSummarize = task === 'summarize';
  const submitToolNames = isToolDriven ? ['collect_scan_recipe'] : [];

  const produceStage = {
    name: 'produce',
    submitToolName: 'collect_scan_recipe', // 透传给 ExplorationTracker nudge 文本
    pipelineType: 'scan' as const, // 统一场景判别标识
    capabilities: produceCaps,
    budget: {
      maxIterations: isSummarize ? 12 : 24,
      temperature: 0.2,
      timeoutMs: isSummarize ? 120_000 : 180_000,
      // 显式传入 tracker 阈值，避免依赖默认值 (softSubmitLimit:8) 导致转换不触发
      maxSubmits: isSummarize ? 3 : 10,
      softSubmitLimit: isSummarize ? 2 : 8,
      idleRoundsToExit: 2,
    },
    systemPrompt: producePrompt,
    // 使用 promptBuilder (而非 promptTransform) — 与冷启动对齐
    // promptBuilder 接收 gateArtifact (来自 quality_gate 的 AnalysisArtifact)，
    // 注入结构化 findings + 代码证据到 prompt，而非仅传入 analyze.reply 纯文本
    promptBuilder: (ctx: ProducerPromptContext) => {
      return buildScanProducerPrompt(ctx, files, task);
    },
    // retry 配置 (拒绝率过高时缩减预算)
    ...(isToolDriven
      ? {
          retryBudget: {
            maxIterations: isSummarize ? 3 : 5,
            temperature: 0.3,
            timeoutMs: isSummarize ? 60_000 : 120_000,
          },
          retryPromptBuilder: (
            retryCtx: { reason?: string },
            _origPrompt: string,
            prev: Record<string, PhaseResult>
          ) => {
            const prevProduce = prev.produce;
            const submitCalls = (prevProduce?.toolCalls || []).filter((tc: ScanToolCallRecord) =>
              submitToolNames.includes((tc.tool || tc.name) as string)
            );
            const rejected = submitCalls.filter((tc: ScanToolCallRecord) => {
              const res = tc.result;
              if (!res) {
                return false;
              }
              if (typeof res === 'string') {
                return res.includes('rejected') || res.includes('error');
              }
              return res.status === 'rejected' || res.status === 'error';
            }).length;
            return `你的 ${rejected} 个提交被拒绝了。请根据拒绝原因改进后重新提交，确保:
1. content 必须是对象: { markdown: "...", rationale: "...", pattern: "..." }
2. content.markdown 字段 ≥ 200 字符，含代码块 (\`\`\`)
3. content.rationale 必填 — 设计原理说明
4. reasoning.sources 必须是非空数组
5. 标题使用项目真实类名，不以项目名开头
6. 必填: trigger (@kebab-case)、kind (rule/pattern/fact)、doClause (英文祈使句)`;
          },
          skipOnDegrade: true,
        }
      : {
          skipOnDegrade: true,
        }),
  };

  const stages: Record<string, unknown>[] = [analyzeStage, qualityGateStage, produceStage];

  // ── Stage 4: Rejection Gate (仅工具驱动模式) ──
  if (isToolDriven) {
    stages.push({
      name: 'rejection_gate',
      gate: {
        evaluator: (
          source: unknown,
          phaseResults: Record<string, unknown>,
          ctx: Record<string, unknown>
        ) =>
          producerRejectionGateEvaluator(
            source as Parameters<typeof producerRejectionGateEvaluator>[0],
            phaseResults,
            {
              ...ctx,
              submitToolNames,
            }
          ),
        maxRetries: 1,
      },
      skipOnDegrade: true,
    });
  }

  return stages;
}

// ──────────────────────────────────────────────────────────────────
// Scan Producer Prompt Builder — artifact-aware (与冷启动 buildProducerPromptV2 对齐)
// ──────────────────────────────────────────────────────────────────

/**
 * 构建 scan produce 阶段的 prompt — 从 gateArtifact 注入结构化信息
 *
 * 与冷启动 buildProducerPromptV2 对齐的关键:
 *   - 优先使用 gateArtifact 中的 findings (结构化发现)
 *   - 注入 evidenceMap (Analyst 已读取的代码证据)
 *   - 注入 negativeSignals (搜索但未找到的模式)
 *   - 当 artifact 不可用时 fallback 到 analyze.reply 纯文本
 *
 * @param ctx promptBuilder 上下文 (含 gateArtifact, phaseResults, ...)
 * @param [files] 源文件 (fallback 用)
 * @param task 任务类型
 */
function buildScanProducerPrompt(
  ctx: ProducerPromptContext,
  files: ScanSourceFile[] | undefined,
  task: 'extract' | 'summarize'
) {
  const artifact = ctx.gateArtifact;
  const analysis = ctx.phaseResults?.analyze?.reply || '';

  // ── 有完整 artifact 时 (走 buildAnalysisArtifact 路径) ──
  if (artifact?.analysisText) {
    const parts: string[] = [];

    // §1 分析文本
    parts.push(
      `将以下代码分析转化为 collect_scan_recipe 调用。\n\n---\n${artifact.analysisText}\n---`
    );

    // §2 结构化发现 (来自 ActiveContext scratchpad)
    if (artifact.findings && artifact.findings.length > 0) {
      const findingLines = ['## 关键发现 (Analyst 已确认)'];
      const sorted = [...artifact.findings].sort(
        (a, b) => (b.importance || 0) - (a.importance || 0)
      );
      for (const f of sorted) {
        const badge = (f.importance || 0) >= 8 ? '⚠️' : '📋';
        findingLines.push(`${badge} **[${f.importance || 5}/10]** ${f.finding}`);
        if (f.evidence) {
          findingLines.push(`  证据: ${f.evidence}`);
        }
      }
      findingLines.push('');
      findingLines.push('☝️ 上述每个发现都应至少转化为一个候选。');
      parts.push(findingLines.join('\n'));
    }

    // §3 代码证据 (来自 EvidenceCollector)
    if (artifact.evidenceMap && artifact.evidenceMap.size > 0) {
      const codeContext = buildCodeContextSection(artifact.evidenceMap);
      if (codeContext) {
        parts.push(codeContext);
      }
    }

    // §4 负空间信号 (搜索但未找到的模式 — 不要猜测)
    if (artifact.negativeSignals && artifact.negativeSignals.length > 0) {
      const nsLines = ['## ⛔ 不存在的模式 (不要猜测)'];
      for (const ns of artifact.negativeSignals.slice(0, 5)) {
        nsLines.push(`- "${ns.searchPattern}" — ${ns.implication}`);
      }
      parts.push(nsLines.join('\n'));
    }

    // §5 引用文件
    if (artifact.referencedFiles && artifact.referencedFiles.length > 0) {
      parts.push(`分析中引用的关键文件: ${artifact.referencedFiles.slice(0, 15).join(', ')}`);
    }

    return parts.join('\n\n');
  }

  // ── Fallback: 无 artifact 时退回纯文本 (不应该发生，但防御性保留) ──
  if (analysis.length >= 200) {
    return `将以下代码分析转化为结构化输出。\n\n## 代码分析\n${analysis}`;
  }

  // Fallback: analyze reply 不足时直接提供源代码
  const fileCtx = (files || [])
    .slice(0, 15)
    .map((f: ScanSourceFile) => {
      const body =
        (f.content || '').length > 1200
          ? `${(f.content ?? '').slice(0, 1200)}\n// ... (truncated)`
          : f.content || '';
      return `### ${f.relativePath || f.name}\n\`\`\`\n${body}\n\`\`\``;
    })
    .join('\n\n');
  const preamble = analysis ? `## 部分分析\n${analysis}\n\n` : '';
  return `${preamble}分析以下 ${files?.length || 0} 个源文件，提取知识 Recipe。\n\n${fileCtx}`;
}

// ──────────────────────────────────────────────────────────────────
// Relations Pipeline — 知识图谱关系发现（独立管线）
// ──────────────────────────────────────────────────────────────────

/** Explore 阶段: 查询知识库，分析条目间关联 */
const RELATIONS_EXPLORE_PROMPT = `你是知识图谱架构师。你的任务是探索项目知识库中的知识条目，发现它们之间的语义关系。

## 工作流程
1. 使用 search_knowledge 查询知识库中的条目分类
2. 逐组分析相关知识条目的内容、依赖、关联代码
3. 使用 read_project_file 验证跨条目的代码引用关系
4. 详细记录发现的所有关系及其代码证据

## 关系类型
- requires: A 需要 B 才能正常工作
- extends: A 扩展了 B 的功能
- enforces: A 强制规范了 B 的使用方式
- depends_on: A 依赖 B
- inherits: A 继承自 B
- implements: A 实现了 B 的接口/协议
- calls: A 调用了 B
- prerequisite: 理解 A 之前需要先了解 B

## 分析要求
- 每个关系必须有明确的代码证据（文件名 + 代码片段）
- 不要臆造不存在的关系
- 优先发现强关联（requires, implements, inherits），再发现弱关联（calls, prerequisite）
- **重要**: search_knowledge 返回的每条结果都有 id 字段（UUID 格式），你必须记录每条知识条目的 id
- 将发现以结构化文本记录: "[id:UUID] FromTitle → [id:UUID] ToTitle (type): evidence"
- 示例: "[id:a1b2c3d4-...] SnapKit布局约束 → [id:e5f6g7h8-...] UIView子类初始化 (requires): SnapKit 布局代码在 init 中调用"`;

/** Synthesize 阶段: 将探索结果转化为 JSON */
const RELATIONS_SYNTHESIZE_PROMPT = `你是结构化数据专家。将知识图谱探索结果转化为 JSON 格式的关系列表。

## 输出格式（纯 JSON，不含 markdown 包装）
{
  "analyzed": 知识条目数量,
  "relations": [
    {
      "from": "知识条目A的ID或精确标题",
      "to": "知识条目B的ID或精确标题",
      "type": "关系类型",
      "evidence": "具体代码证据描述"
    }
  ]
}

## 规则
- 严格对照探索阶段的发现，不添加未被提及的关系
- type 必须是: requires / extends / enforces / depends_on / inherits / implements / calls / prerequisite
- evidence 必须引用具体的代码或文件
- **最重要**: 如果探索结果中包含知识条目的 id（UUID 格式如 a1b2c3d4-...），from 和 to 字段必须使用该 id
- 如果探索结果中没有 id，则使用知识条目的精确标题（不得修改、截断或改写）`;

/**
 * 构建知识图谱关系发现的独立 Pipeline stages
 *
 * 与 scan pipeline 不同，relations pipeline:
 *   - 不需要源文件输入 (从知识库查询)
 *   - 2 阶段: explore (工具驱动) → synthesize (文本输出)
 *   - 无质量门控 (探索结果质量由工具返回保证)
 *
 * @param [opts.exploreCaps] Explore 阶段 capabilities
 * @param [opts.exploreMaxIter=20] Explore 最大迭代
 * @returns PipelineStrategy stages 数组
 */
export function buildRelationsPipelineStages({
  exploreCaps = ['knowledge_production', 'code_analysis'],
  exploreMaxIter = 20,
} = {}) {
  return [
    {
      name: 'explore',
      capabilities: exploreCaps,
      budget: {
        maxIterations: exploreMaxIter,
        maxTokens: 8192,
        temperature: 0.3,
        timeoutMs: 300_000,
      },
      systemPrompt: RELATIONS_EXPLORE_PROMPT,
    },
    {
      name: 'synthesize',
      capabilities: [],
      budget: {
        maxIterations: 4,
        maxTokens: 8192,
        temperature: 0.2,
        timeoutMs: 60_000,
      },
      systemPrompt: RELATIONS_SYNTHESIZE_PROMPT,
      promptTransform: (_input: string, prev: Record<string, PhaseResult>) => {
        const exploration = prev.explore?.reply || '';
        return `基于以下知识图谱探索结果，输出结构化关系 JSON。\n\n## 探索结果\n${exploration}`;
      },
    },
  ];
}

export default SCAN_TASK_CONFIGS;
