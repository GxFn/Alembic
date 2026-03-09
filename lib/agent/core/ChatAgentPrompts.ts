/** ChatAgentPrompts — Agent 提示词构建和文本处理方法 */

import fs from 'node:fs';
import type { ServiceContainer } from '../tools/_shared.js';

/** Options for buildNativeToolSystemPrompt */
interface NativeToolPromptOptions {
  currentSource: string;
  projectBriefingCache: string;
  memoryCoordinator?: {
    buildStaticMemoryPrompt(opts: { mode: string }): Promise<string> | string;
  } | null;
  budget?: { maxIterations?: number; [key: string]: unknown };
  soulPath?: string;
}

/** Options for buildProjectBriefing */
interface ProjectBriefingOptions {
  container?: ServiceContainer;
}

/**
 * 构建原生函数调用模式的系统提示词
 *
 * @param options.currentSource 'user' | 'system'
 * @param options.projectBriefingCache 项目概况缓存文本
 * @param [options.memoryCoordinator] MemoryCoordinator 实例
 * @param options.budget 预算配置
 * @param options.soulPath SOUL.md 文件路径
 */
export async function buildNativeToolSystemPrompt({
  currentSource,
  projectBriefingCache,
  memoryCoordinator,
  budget = {},
  soulPath,
}: NativeToolPromptOptions) {
  // 用户对话模式: 完整提示词（含 SOUL、Memory、项目概况）
  if (currentSource !== 'system') {
    let soulSection = '';
    try {
      if (soulPath && fs.existsSync(soulPath)) {
        soulSection = `\n${fs.readFileSync(soulPath, 'utf-8').trim()}\n`;
      }
    } catch {
      /* SOUL.md not available */
    }

    // v5.0: 通过 coordinator 构建静态记忆 section
    let memorySection = '';
    if (memoryCoordinator) {
      memorySection = await memoryCoordinator.buildStaticMemoryPrompt({ mode: 'user' });
    }

    return `${soulSection}
你是 AutoSnippet 项目的统一 AI 中心。项目内所有 AI 推理和分析都通过你执行。
${projectBriefingCache}${memorySection}

## 使用规则
1. 当需要查询数据时，直接调用相应工具。
2. 工具参数严格按照工具声明中的 schema 传递。
3. 对于代码分析任务，先 search_project_code 搜索，再 read_project_file 读取。
4. 当工具返回错误时，尝试不同参数或方法。`;
  }

  // Bootstrap 系统模式: LLM 以领域大脑的能力处理任务
  return `你以「领域大脑」的能力来处理任务 — 你对软件工程领域拥有深厚的专家知识。
你将分析一个真实项目，自主发现其中有价值的代码知识。
${projectBriefingCache}

## 你的能力定位
你具备深度技术洞察力，能够理解代码背后的设计意图。
你知道什么知识对开发团队最有价值 — 不是显而易见的样板代码，
而是体现项目独有设计决策、架构模式和工程智慧的知识。

## 你的工作方式
1. **全局感知** → list_project_structure 了解项目结构
2. **定向探索** → get_file_summary 快速了解文件角色
3. **深入研读** → search_project_code / read_project_file 获取真实代码
4. **语义发现** → semantic_search_code 在知识库查找相关知识
5. **知识产出** → submit_knowledge 提交有价值的发现

## 高效使用工具（节省轮次）
- **批量搜索**: search_project_code({ patterns: ["keywordA", "keywordB", "keywordC"] })
- **批量读文件**: read_project_file({ filePaths: ["path/a.m", "path/b.m"] })
- 合并同类请求为一次调用，避免逐个搜索/读取浪费轮次。

## 「项目特写」= 基本用法 + 项目特征融合
submit_knowledge 的 code 字段必须是「项目特写」— 将技术的基本用法与本项目的特征融合为一体:
1. **项目选择了什么**: 采用了哪种写法/模式/约定
2. **为什么这样选**: 统计数据（N 个文件、占比 M%）
3. **项目禁止什么**: 被放弃的写法、反模式、显式禁用标记
4. **新代码怎么写**: 可直接复制使用的代码模板

## 核心原则
- 代码必须真实，来自工具返回，不可编造
- 引用具体类名、方法名、数字，禁止「本模块」「该文件」等泛化描述
- 质量优先于数量，证据不足宁可不提交
- 高效利用步数 (≤${budget.maxIterations} 轮)

## 严禁透传指令
你会收到系统发来的进度提醒和阶段引导，这些是行为指令，不是问题。
**绝对禁止**在回复中复制、改写或引用这些系统指令的任何文字。
你的回复必须只包含你自己的分析内容或工具调用。`;
}

/**
 * 构建项目概况注入到系统提示词（每次 execute 刷新一次）
 * 单次 SQL 聚合 < 5ms，静默降级
 */
export async function buildProjectBriefing({ container }: ProjectBriefingOptions) {
  try {
    const db = container?.get?.('database');
    if (!db) {
      return '';
    }
    // knowledgeType → kind 映射:
    //   rule: code-standard, code-style, best-practice, boundary-constraint
    //   pattern: code-pattern, architecture, solution
    //   fact: code-relation, inheritance, call-chain, data-flow, module-dependency
    // V3: knowledge_entries 统一表（candidates 已合并，lifecycle 替代 status）
    const stats = db
      .prepare(`
        SELECT
          (SELECT COUNT(*) FROM knowledge_entries WHERE lifecycle = 'active') as recipeCount,
          (SELECT COUNT(*) FROM knowledge_entries WHERE lifecycle = 'active' AND knowledgeType IN ('code-standard','code-style','best-practice','boundary-constraint')) as ruleCount,
          (SELECT COUNT(*) FROM knowledge_entries WHERE lifecycle = 'active' AND knowledgeType IN ('code-pattern','architecture','solution')) as patternCount,
          (SELECT COUNT(*) FROM knowledge_entries WHERE lifecycle = 'active' AND knowledgeType IN ('code-relation','inheritance','call-chain','data-flow','module-dependency')) as factCount,
          (SELECT COUNT(*) FROM knowledge_entries WHERE lifecycle = 'active' AND knowledgeType = 'boundary-constraint') as guardRuleCount,
          (SELECT COUNT(*) FROM knowledge_entries WHERE lifecycle = 'pending') as pendingCandidates,
          (SELECT COUNT(*) FROM knowledge_entries) as totalCandidates
      `)
      .get();
    if (!stats || stats.recipeCount === 0) {
      return '\n## 项目状态\n⚠️ 知识库为空。建议先执行冷启动（bootstrap_knowledge）。\n';
    }
    let section = `\n## 项目状态\n- 知识库: ${stats.recipeCount} 条 Recipe（${stats.ruleCount || 0} rule / ${stats.patternCount || 0} pattern / ${stats.factCount || 0} fact）\n- Guard 规则: ${stats.guardRuleCount || 0} 条\n- 候选: ${stats.pendingCandidates} 条待审 / ${stats.totalCandidates} 条总计\n`;
    if (stats.pendingCandidates > 10) {
      section += `\n⚠️ 有 ${stats.pendingCandidates} 条候选积压，建议执行批量审核。\n`;
    }
    return section;
  } catch {
    return ''; // DB 不可用时静默降级
  }
}

/** 清理最终回答（去除 Thought/preamble + MEMORY 标签） */
export function cleanFinalAnswer(response: string) {
  if (!response) {
    return '';
  }
  return (
    response
      .replace(/^(Final Answer|最终回答|Answer)\s*[:：]\s*/i, '')
      .replace(/\[MEMORY:\w+\]\s*[\s\S]*?\s*\[\/MEMORY\]/g, '')
      // v5.1: 清理 AI 回显的 nudge 指令（常见于 force-exit 场景）
      .replace(
        /^>\s*(?:searchHints|remainingTasks|candidateCount|crossRefs|keyFindings|gaps)\s*[:：][^\n]*\n?/gm,
        ''
      )
      .replace(
        /^\*{0,2}(?:请在|请直接|请确保|请务必|现在开始|输出你的|不要输出|不要再|不要包含|重要\s*[：:]).*(?:分析文本|分析总结|JSON|工具|输出|文本|报告)\*{0,2}[。.]?\s*$/gm,
        ''
      )
      .replace(/^注意[：:]\s*到达第\s*\d+\s*轮时.*$/gm, '')
      .replace(/^第\s*\d+\/\d+\s*轮\s*\|[^\n]*$/gm, '')
      // v5.2: 移除 dimensionDigest JSON 剥离
      // 之前会把 SUMMARIZE 阶段 LLM 按要求产出的 dimensionDigest JSON 全部删掉 → 0 chars
      // dimensionDigest 是 SUMMARIZE 的预期输出，不应被 cleanFinalAnswer 清理
      // Analyst 策略的 SUMMARIZE 使用自然语言 Markdown（不含 dimensionDigest），不受影响
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}
