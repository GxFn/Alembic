/**
 * insight-evolver.ts — Evolution Agent 领域函数
 *
 * Evolution Agent 是管线中的专职进化角色：
 *   - 审查衰退 Recipe 的 audit evidence
 *   - 使用工具验证代码是否仍然存在或已迁移
 *   - 做出三选一决策: evolve / confirm-deprecation / skip
 *
 * 被 PipelineStrategy 的 evolution preset 引用。
 *
 * @module insight-evolver
 */

// ──────────────────────────────────────────────────────────────────
// Local types
// ──────────────────────────────────────────────────────────────────

/** 衰退 Recipe 的 audit 证据 */
interface DecayedRecipeAudit {
  relevanceScore: number;
  verdict: 'decay' | 'severe';
  evidence: {
    sourceFileExists: boolean;
    triggerStillMatches: boolean;
    symbolsAlive: number;
    depsIntact: boolean;
    codeFilesExist: number;
  };
  decayReasons: string[];
}

/** 衰退 Recipe（含 audit 信息） */
interface DecayedRecipeEntry {
  id: string;
  title: string;
  trigger: string;
  content?: { markdown?: string; rationale?: string; coreCode?: string };
  sourceRefs?: string[];
  audit: DecayedRecipeAudit;
  existingProposal?: {
    id: string;
    type: string;
    status: string;
    expiresAt: number;
  };
}

/** Evolution Agent 上下文 */
export interface EvolutionContext {
  decayedRecipes: DecayedRecipeEntry[];
  dimensionId: string;
  dimensionLabel: string;
  projectOverview: {
    primaryLang: string;
    fileCount: number;
    modules: string[];
  };
}

// ──────────────────────────────────────────────────────────────────
// System Prompt
// ──────────────────────────────────────────────────────────────────

export const EVOLVER_SYSTEM_PROMPT = `你是 AutoSnippet 的 **Evolution Agent**，专职审查衰退中的知识条目。

你的目标不是发现新知识，而是对已有的衰退知识做出**进化决策**。

工作流程:
1. 阅读每个衰退 Recipe 的 audit evidence，理解哪些证据因素失败
2. 使用 read_project_file 检查源文件是否仍存在或已迁移
3. 如果原始源文件不存在，使用 search_project_code 寻找模式是否迁移到新位置
4. 对每个 Recipe 做出明确决策（不要遗漏任何一个）

决策准则:
- symbolsAlive < 0.3 且 sourceFileExists=false → 高度可能需要确认废弃
- sourceFileExists=true 但 symbolsAlive < 0.5 → 可能需要进化（符号改名/重构）
- triggerStillMatches=false → 检查是否有替代 trigger 模式
- 进化时: 新 Recipe 必须引用**当前**的源文件和代码，不要复制旧内容

注意:
- 每个 Recipe 必须有明确决策（进化/废弃/跳过），不要忽略任何一个
- 进化不是简单复制——你必须验证代码后用新内容提交
- submit_knowledge 的 supersedes 参数会创建 EvolutionProposal 进入观察窗口
- 确认废弃使用 confirm_deprecation，系统会自动跳过观察窗口直接 deprecate
- 如果信息不足以判断，使用 skip_evolution 显式跳过，交给时限机制处理`;

// ──────────────────────────────────────────────────────────────────
// 工具白名单
// ──────────────────────────────────────────────────────────────────

export const EVOLVER_TOOLS = [
  'read_project_file',
  'search_project_code',
  'submit_knowledge',
  'confirm_deprecation',
  'skip_evolution',
];

// ──────────────────────────────────────────────────────────────────
// 预算
// ──────────────────────────────────────────────────────────────────

export const EVOLVER_BUDGET = {
  maxIterations: 16,
  searchBudget: 8,
  searchBudgetGrace: 4,
  maxSubmits: 5,
  softSubmitLimit: 5,
  idleRoundsToExit: 2,
};

// ──────────────────────────────────────────────────────────────────
// Prompt 构建
// ──────────────────────────────────────────────────────────────────

/**
 * 构建 Evolution Agent 的用户 Prompt
 *
 * 按维度打包衰退 Recipe 清单 + audit evidence + 项目概览，
 * 让 Agent 有足够上下文做出进化/废弃/跳过决策。
 */
export function buildEvolverPrompt(
  _phaseInput: unknown,
  _phaseResults: unknown,
  strategyContext: EvolutionContext
): string {
  const { decayedRecipes, dimensionId, dimensionLabel, projectOverview } = strategyContext;
  const parts: string[] = [];

  // §1 任务概述
  parts.push(
    `你将审查 **${decayedRecipes.length}** 个处于衰退状态的 Recipe（维度: ${dimensionLabel} [${dimensionId}]）。`
  );
  parts.push(`项目: ${projectOverview.primaryLang} 语言，${projectOverview.fileCount} 个文件。`);
  if (projectOverview.modules.length > 0) {
    parts.push(`主要模块: ${projectOverview.modules.slice(0, 10).join(', ')}`);
  }

  // §2 衰退 Recipe 清单
  parts.push('## 衰退 Recipe 清单');

  for (const recipe of decayedRecipes) {
    const lines: string[] = [];
    lines.push(`### [${recipe.audit.verdict.toUpperCase()}] ${recipe.title}`);
    lines.push(`- **ID**: \`${recipe.id}\``);
    lines.push(`- **Trigger**: \`${recipe.trigger}\``);
    lines.push(`- **审计分数**: ${recipe.audit.relevanceScore}/100`);

    // Evidence 明细
    const ev = recipe.audit.evidence;
    lines.push('- **证据**:');
    lines.push(`  - 源文件存在: ${ev.sourceFileExists ? '✅' : '❌'}`);
    lines.push(`  - Trigger 仍匹配: ${ev.triggerStillMatches ? '✅' : '❌'}`);
    lines.push(`  - 符号存活率: ${(ev.symbolsAlive * 100).toFixed(0)}%`);
    lines.push(`  - 依赖完整: ${ev.depsIntact ? '✅' : '❌'}`);
    lines.push(`  - 代码文件存在率: ${(ev.codeFilesExist * 100).toFixed(0)}%`);

    // 衰退原因
    if (recipe.audit.decayReasons.length > 0) {
      lines.push(`- **衰退原因**: ${recipe.audit.decayReasons.join('; ')}`);
    }

    // 原始源文件引用
    if (recipe.sourceRefs && recipe.sourceRefs.length > 0) {
      lines.push(`- **原始源文件**: ${recipe.sourceRefs.slice(0, 5).join(', ')}`);
    }

    // 旧 Recipe 核心代码（缩略）
    if (recipe.content?.coreCode) {
      const truncated =
        recipe.content.coreCode.length > 300
          ? `${recipe.content.coreCode.slice(0, 300)}...`
          : recipe.content.coreCode;
      lines.push(`- **旧核心代码**:\n\`\`\`\n${truncated}\n\`\`\``);
    }

    // 已有 proposal
    if (recipe.existingProposal) {
      lines.push(
        `- **已有 Proposal**: ${recipe.existingProposal.type} (${recipe.existingProposal.status})`
      );
    }

    parts.push(lines.join('\n'));
  }

  // §3 决策指令
  parts.push('## 决策指令');
  parts.push('对上述每个 Recipe，请做出以下三种决策之一:');
  parts.push('');
  parts.push('1. 🔄 **进化** — 知识仍有价值但代码已变:');
  parts.push('   调用 `submit_knowledge({ ...newRecipe, supersedes: "旧Recipe的ID" })`');
  parts.push('   新 Recipe 必须基于当前代码编写，不要复制旧内容。');
  parts.push('');
  parts.push('2. ⛔ **确认废弃** — 知识确实过时，无法挽救:');
  parts.push('   调用 `confirm_deprecation({ recipeId: "...", reason: "..." })`');
  parts.push('');
  parts.push('3. ⏭️ **跳过** — 信息不足以判断:');
  parts.push('   调用 `skip_evolution({ recipeId: "...", reason: "..." })`');

  return parts.join('\n\n');
}
