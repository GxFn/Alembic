/**
 * ProducerAgent.js — v3.0 生产者 Agent
 *
 * 职责:
 * - 将 Analyst 的分析文本转换为结构化的 submit_knowledge 调用
 * - 遵循 PROJECT_SNAPSHOT_STYLE_GUIDE 格式
 * - 使用 read_project_file 获取代码片段
 * - CandidateGuardrail 验证每次提交
 *
 * 设计哲学:
 * "像编辑把记者的手稿变成标准格式的文章。"
 *
 * @module ProducerAgent
 */

import Logger from '../../infrastructure/logging/Logger.js';

// ──────────────────────────────────────────────────────────────────
// System Prompt — Producer 专用 (~150 tokens)
// ──────────────────────────────────────────────────────────────────

const PRODUCER_SYSTEM_PROMPT = `你是知识管理专家。你会收到一段代码分析文本，需要将其中的知识点转化为结构化的知识候选。

核心原则: 分析文本已经包含了所有发现，你的唯一工作是将它们格式化为 submit_knowledge 调用。

每个候选必须:
1. 有清晰的标题 (描述知识点的核心，使用项目真实类名)
2. 有项目特写风格的正文 (content.markdown 字段，结合代码展示)
3. 标注相关文件路径
4. 选择正确的 kind (rule/pattern/fact)
5. 提供完整的 Cursor 交付字段 (trigger, doClause, whenClause 等)

工作流程:
1. 阅读分析文本，识别每个独立的知识点/发现
2. 用 read_project_file 批量获取关键代码片段:
   read_project_file({ filePaths: ["FileA.m", "FileB.m"], maxLines: 80 })
3. 立刻调用 submit_knowledge 提交
4. 重复直到分析中的所有知识点都已提交

关键规则:
- 分析中的每个要点/段落都应转化为至少一个候选
- read_project_file 支持 filePaths 数组批量读取多个文件，一次调用完成
- read_project_file 时读取足够多的行数（startLine + maxLines 至少 30 行）
- reasoning.sources 必须是非空数组，填写相关文件路径如 ["FileName.m"]
- 如果分析提到了 3 个模式，就应该提交 3 个候选，不要合并
- 禁止: 不要搜索新文件、不要做额外分析，专注于格式化和提交

容错规则:
- 如果 read_project_file 返回"文件不存在"或错误，不要重试同一文件的其他路径变体
- 文件读取失败时，直接使用分析文本中已有的代码和描述来提交候选
- 永远不要因为文件读取失败而跳过知识点 — 分析文本已经包含足够信息
- 先提交候选，再考虑是否需要读取更多代码（提交优先于验证）`;

// ──────────────────────────────────────────────────────────────────
// Producer 可用工具白名单 — 只做格式化和提交
// ──────────────────────────────────────────────────────────────────

const PRODUCER_TOOLS = ['submit_knowledge', 'submit_with_check', 'read_project_file'];

// ──────────────────────────────────────────────────────────────────
// Producer 预算 — 格式化任务，迭代更少
// ──────────────────────────────────────────────────────────────────

const PRODUCER_BUDGET = {
  maxIterations: 24, // was 18 — 与 Analyst 统一
  searchBudget: 4,
  searchBudgetGrace: 3,
  maxSubmits: 10,
  softSubmitLimit: 10,
  idleRoundsToExit: 3,
};

// ──────────────────────────────────────────────────────────────────
// 项目特写风格指南 (只注入一次到 Producer)
// ──────────────────────────────────────────────────────────────────

const STYLE_GUIDE = `# 「项目特写」写作要求

submit_knowledge 的 content.markdown 字段必须是「项目特写」。

## 什么是「项目特写」
将一种技术的**基本用法**与**本项目的具体特征**融合为一体。

## 四大核心内容
1. **项目选择了什么** — 采用了哪种写法/模式/约定
2. **为什么这样选** — 统计分布、占比、历史决策
3. **项目禁止什么** — 反模式、已废弃写法
4. **新代码怎么写** — 可直接复制使用的代码模板 + 来源标注 (来源: FileName.m:行号)

## 格式要求
- 标题使用项目真实类名/前缀，不用占位名
- 代码来源标注: (来源: FileName.m:行号)
- 不要纯代码罗列，必须有项目上下文

## Cursor 交付字段（每个 submit_knowledge 必须附带）

每个候选必须提供以下交付字段，它们直接决定在 Cursor IDE 中作为 Rules 的展示质量。
注意：language / category / knowledgeType / source 由系统自动设置，无需填写。

### 必填
- trigger: "@" + 核心类名 kebab-case，如 @bd-base-request。每个候选 trigger 必须唯一
- kind: 此候选的知识类型 — rule(强制约束) / pattern(实现模式) / fact(项目事实)
- doClause: 英文祈使句 ≤60 tokens，概括此知识的正向规则（以动词开头）。如 "Use dispatch_once for thread-safe singleton initialization"
- description: 中文简述 ≤80 字，引用真实类名和数字

### 推荐
- dontClause: 反向约束英文描述（不以 "Don't" 开头，调用方会加前缀）。如 "use @synchronized for singleton"
- whenClause: 触发场景英文。如 "When implementing singleton pattern or global shared instance"
- topicHint: 主题分类，取值 networking / ui / data / architecture / conventions
- coreCode: 最典型纯代码片段 3-8 行（不含 Markdown 格式、无 # 标题、无围栏、无 > 引用；必须语法完整——括号配对、不以 } 或 ) 开头、不以 { 或 ( 结尾）

### 规范
1. trigger 以 @ 开头，kebab-case，不得在同一批次重复
2. doClause 英文祈使句，不含中文
3. coreCode 是可直接复制到编辑器的纯代码
4. kind 根据内容本质判断：强制约束 → rule，实现模式 → pattern，项目事实 → fact`;

// ──────────────────────────────────────────────────────────────────
// Prompt 构建
// ──────────────────────────────────────────────────────────────────

/**
 * 构建 Producer Prompt
 *
 * @param {import('./HandoffProtocol.js').AnalysisReport} analysisReport
 * @param {object} dimConfig — { id, label, allowedKnowledgeTypes, outputType }
 * @param {object} projectInfo — { name }
 * @returns {string}
 */
function buildProducerPrompt(analysisReport, dimConfig, projectInfo) {
  const parts = [];

  // §1 任务描述
  parts.push(`将以下对 ${projectInfo.name} 项目 "${dimConfig.label}" 维度的分析，转化为知识候选:`);

  // §2 分析内容
  parts.push(`---\n${analysisReport.analysisText}\n---`);

  // §3 引用文件
  if (analysisReport.referencedFiles.length > 0) {
    parts.push(`分析中引用的关键文件: ${analysisReport.referencedFiles.join(', ')}`);
  }

  // §4 维度约束
  parts.push(`维度约束:
- dimensionId: ${dimConfig.id}
- 允许的 knowledgeType: ${(dimConfig.allowedKnowledgeTypes || []).join(', ') || '(all)'}
- category: ${dimConfig.id}`);

  // §5 写作指南 (只注入一次)
  parts.push(STYLE_GUIDE);

  // §6 提交要求
  parts.push(`要求:
1. 每个独立的知识点单独提交为一个候选 — 目标: 至少 3 个候选
2. 先使用分析中已有的代码片段直接提交候选; 仅在需要更多代码上下文时才用 read_project_file
3. filePaths 填写分析中提到的相关文件路径
4. description 中文简述 ≤80 字，引用真实类名
5. reasoning 中 sources 必须非空，填写来源文件名如 ["FileName.m"]，confidence 填 0.7~0.9
6. 不要跳过任何分析中提到的知识点
7. 如果 read_project_file 失败（文件不存在），直接用分析文本内容提交，不要重试其他路径
8. 每个候选必须有 trigger (@kebab-case)、kind (rule/pattern/fact)、doClause (英文祈使句)`);

  return parts.join('\n\n');
}

// ──────────────────────────────────────────────────────────────────
// ProducerAgent 类
// ──────────────────────────────────────────────────────────────────

export class ProducerAgent {
  /** @type {import('./ChatAgent.js').ChatAgent} */
  #chatAgent;

  /** @type {import('../../infrastructure/logging/Logger.js').default} */
  #logger;

  /**
   * @param {object} chatAgent — ChatAgent 实例
   */
  constructor(chatAgent) {
    this.#chatAgent = chatAgent;
    this.#logger = Logger.getInstance();
  }

  /**
   * 将分析报告转化为候选
   *
   * @param {import('./HandoffProtocol.js').AnalysisReport} analysisReport — Analyst 产出
   * @param {object} dimConfig — 维度配置
   * @param {object} projectInfo — { name, lang, fileCount }
   * @param {object} [options]
   * @param {string} [options.sessionId]
   * @param {object} [options.budget] — 覆盖默认预算
   * @returns {Promise<ProducerResult>}
   */
  async produce(analysisReport, dimConfig, projectInfo, options = {}) {
    const dimId = dimConfig.id;

    // 分析文本为空时直接跳过
    if (!analysisReport.analysisText || analysisReport.analysisText.length < 50) {
      this.#logger.warn(`[ProducerAgent] ⚠ empty analysis for "${dimId}" — skipping`);
      return { candidateCount: 0, toolCalls: [], reply: '' };
    }

    const prompt = buildProducerPrompt(analysisReport, dimConfig, projectInfo);
    this.#logger.info(
      `[ProducerAgent] ▶ producing candidates for "${dimId}" — prompt ${prompt.length} chars`
    );

    const budget = options.budget
      ? { ...PRODUCER_BUDGET, ...options.budget }
      : { ...PRODUCER_BUDGET };

    try {
      const result = await this.#chatAgent.execute(prompt, {
        source: 'system',
        conversationId: options.sessionId ? `producer-${options.sessionId}-${dimId}` : undefined,
        budget,
        systemPromptOverride: PRODUCER_SYSTEM_PROMPT,
        allowedTools: PRODUCER_TOOLS,
        disablePhaseRouter: true,
        temperature: 0.3,
        projectLanguage: projectInfo.lang,
        dimensionMeta: {
          id: dimId,
          outputType: dimConfig.outputType || 'candidate',
          allowedKnowledgeTypes: dimConfig.allowedKnowledgeTypes || [],
        },
      });

      // 统计提交 (区分成功/失败)
      const submitCalls = (result.toolCalls || []).filter(
        (tc) =>
          (tc.tool || tc.name) === 'submit_knowledge' ||
          (tc.tool || tc.name) === 'submit_with_check'
      );
      const successCount = submitCalls.filter((tc) => {
        const res = tc.result;
        if (!res) {
          return true; // 无结果信息默认成功
        }
        if (typeof res === 'string') {
          return !res.includes('rejected') && !res.includes('error');
        }
        return res.status !== 'rejected' && res.status !== 'error';
      }).length;
      const rejectedCount = submitCalls.length - successCount;

      // ── 拒绝率过高时追加一轮修正尝试 ──
      if (
        rejectedCount > successCount &&
        rejectedCount >= 2 &&
        options.retryOnRejection !== false
      ) {
        this.#logger.info(
          `[ProducerAgent] 高拒绝率 (${rejectedCount}/${submitCalls.length}) — 尝试修正`
        );
        try {
          const retryPrompt = `你的 ${rejectedCount} 个提交被拒绝了。请根据拒绝原因改进后重新提交，确保:\n1. content.markdown 字段 ≥ 200 字符\n2. 包含代码块 (\`\`\`)\n3. 包含来源标注 (来源: FileName.m:行号)\n4. 标题使用项目真实类名\n5. 必填: trigger (@kebab-case)、kind (rule/pattern/fact)、doClause (英文祈使句)`;
          const retryResult = await this.#chatAgent.execute(retryPrompt, {
            source: 'system',
            conversationId: options.sessionId
              ? `producer-retry-${options.sessionId}-${dimId}`
              : undefined,
            budget: { ...budget, maxIterations: 5, maxSubmits: rejectedCount },
            systemPromptOverride: PRODUCER_SYSTEM_PROMPT,
            allowedTools: PRODUCER_TOOLS,
            disablePhaseRouter: true,
            temperature: 0.3,
            projectLanguage: projectInfo.lang,
            dimensionMeta: {
              id: dimId,
              outputType: dimConfig.outputType || 'candidate',
              allowedKnowledgeTypes: dimConfig.allowedKnowledgeTypes || [],
            },
          });

          const retrySubmits = (retryResult.toolCalls || []).filter(
            (tc) =>
              (tc.tool || tc.name) === 'submit_knowledge' ||
              (tc.tool || tc.name) === 'submit_with_check'
          );
          const retrySuccess = retrySubmits.filter((tc) => {
            const res = tc.result;
            if (!res) {
              return true;
            }
            if (typeof res === 'string') {
              return !res.includes('rejected') && !res.includes('error');
            }
            return res.status !== 'rejected' && res.status !== 'error';
          }).length;

          this.#logger.info(`[ProducerAgent] 修正轮: +${retrySuccess} candidates for "${dimId}"`);

          // 合并两轮 token 用量
          const baseTokens = result.tokenUsage || { input: 0, output: 0 };
          const retryTokens = retryResult.tokenUsage || { input: 0, output: 0 };
          const mergedTokenUsage = {
            input: (baseTokens.input || 0) + (retryTokens.input || 0),
            output: (baseTokens.output || 0) + (retryTokens.output || 0),
          };

          return {
            candidateCount: successCount + retrySuccess,
            rejectedCount: rejectedCount - retrySuccess,
            toolCalls: [...(result.toolCalls || []), ...(retryResult.toolCalls || [])],
            reply: retryResult.reply || result.reply || '',
            tokenUsage: mergedTokenUsage,
            reasoningQuality: retryResult.reasoningQuality || result.reasoningQuality || null,
          };
        } catch (retryErr) {
          this.#logger.warn(`[ProducerAgent] 修正轮失败 "${dimId}": ${retryErr.message}`);
        }
      }

      this.#logger.info(
        `[ProducerAgent] ✅ dimension "${dimId}" — ${successCount} candidates created (${rejectedCount} rejected), ${result.toolCalls?.length || 0} total tool calls`
      );

      return {
        candidateCount: successCount,
        rejectedCount,
        toolCalls: result.toolCalls || [],
        reply: result.reply || '',
        tokenUsage: result.tokenUsage || null,
        reasoningQuality: result.reasoningQuality || null,
      };
    } catch (err) {
      this.#logger.error(`[ProducerAgent] ❌ dimension "${dimId}" error: ${err.message}`);
      return { candidateCount: 0, toolCalls: [], reply: '' };
    }
  }
}

/**
 * @typedef {object} ProducerResult
 * @property {number} candidateCount
 * @property {Array} toolCalls
 * @property {string} reply
 */

export default ProducerAgent;
