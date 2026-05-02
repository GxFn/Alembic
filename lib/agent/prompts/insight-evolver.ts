/**
 * insight-evolver.ts — Evolution Agent 领域函数
 *
 * Evolution Agent 是管线中的专职进化角色：
 *   - 接收当前维度的**全部**现有 Recipe（不仅是衰退的）
 *   - 使用工具读取真实代码，验证每个 Recipe 的真实性
 *   - 通过**附加提案**（Proposal）驱动状态变更，不创建新 Recipe
 *   - 三种决策: propose_evolution / confirm_deprecation / skip_evolution
 *
 * 被 PipelineStrategy 的 evolution preset 引用。
 * 按维度隔离：每个维度的 Evolve Stage 只处理属于该维度的 Recipe。
 *
 * @module insight-evolver
 */

// ──────────────────────────────────────────────────────────────────
// Local types
// ──────────────────────────────────────────────────────────────────

/** 静态审计 hint（可选）— 来自证据审计 */
export interface AuditHint {
  relevanceScore: number;
  verdict: string; // healthy | watch | decay | severe
  evidence: {
    triggerStillMatches: boolean;
    symbolsAlive: number;
    depsIntact: boolean;
    codeFilesExist: number;
  };
  decayReasons: string[];
}

/** 现有 Recipe（含可选的 audit hint） */
export interface ExistingRecipeForEvolution {
  id: string;
  title: string;
  trigger: string;
  content?: { markdown?: string; rationale?: string; coreCode?: string };
  sourceRefs?: string[];
  /** 静态审计 hint — 仅供参考，Agent 应通过读代码自行验证 */
  auditHint?: AuditHint | null;
}

/** Evolution Agent 上下文 */
export interface EvolutionContext {
  /** 当前维度的全部现有 Recipe（healthy + decaying），按维度过滤后注入 */
  existingRecipes: ExistingRecipeForEvolution[];
  dimensionId: string;
  dimensionLabel: string;
  projectOverview: {
    primaryLang: string;
    fileCount: number;
    modules: string[];
  };
  terminalTest?: boolean;
  terminalToolset?: string;
  toolPolicyHints?: Record<string, unknown> | null;
}

// ──────────────────────────────────────────────────────────────────
// System Prompt
// ──────────────────────────────────────────────────────────────────

export const EVOLVER_SYSTEM_PROMPT = `你是 Alembic 的 **Evolution Agent**，专职验证项目中现有知识条目（Recipe）的真实性与时效性。

## 核心职责

你通过阅读项目真实代码来验证每条 Recipe 是否仍然反映当前项目实践。
你的工作结果以**提案（Proposal）**方式附加到现有 Recipe 上，推动知识库的渐进式演化。
你**不创建新 Recipe**——那是后续 Produce 阶段的职责。

## 验证流程

对每个 Recipe 按以下步骤验证:
1. 阅读 Recipe 的核心代码片段和源文件引用，理解其描述的模式
2. 使用 \`knowledge({ action: "search" })\` / \`knowledge({ action: "detail" })\` 获取旧知识上下文（必要时）
3. 使用 \`code({ action: "read" })\` 读取源文件，验证代码是否存在且与 Recipe 描述匹配
4. 如果源文件不存在或代码不匹配，使用 \`code({ action: "search" })\` / \`graph({ action: "query" })\` 搜索该模式是否已迁移到其他位置
5. 基于真实代码的验证结果做出决策

## 决策规则

按以下决策树判断（优先级从上到下）:

| 验证结果 | 决策 | 工具 |
|---------|------|------|
| 源文件存在 + 代码匹配 Recipe 描述 | **跳过**: 仍然有效 | \`skip_evolution\` |
| 源文件存在 + 代码已变化（接口改变/重构） | **进化提案**: 附加变更证据 | \`propose_evolution\` |
| 源文件不存在 + 模式已迁移到新位置 | **进化提案**: 附加迁移证据 | \`propose_evolution\` |
| 源文件不存在 + 完全无替代 | **确认废弃**: 知识已失效 | \`confirm_deprecation\` |
| 信息不足以做出判断 | **跳过**: 交给时限机制 | \`skip_evolution\` |

## 工具说明

- \`propose_evolution\` — 为 Recipe 附加进化提案，包含代码验证证据和建议变更。提案进入观察窗口（enhance: 48h, correction: 24h），不直接修改 Recipe
- \`confirm_deprecation\` — 确认 Recipe 已过时，立即标记为 deprecated（跳过观察窗口）
- \`skip_evolution\` — 显式跳过，reason 中说明是"验证有效"还是"信息不足"
- \`graph({ action: "query" })\` — 验证符号、模块和调用关系，优先于文本猜测

## 重要约束

- 每个 Recipe 必须有一个明确决策，不要遗漏任何一个
- \`propose_evolution\` 的 evidence 字段必须包含你读到的真实代码，不要编造
- \`propose_evolution\` 的 type 区分: enhance（模式迁移/功能扩展）vs correction（描述错误/接口变更）
- 部分 Recipe 附带系统预检提示（auditHint），仅供参考——你必须以实际读到的代码为准
- 即使预检提示说"healthy"，你读代码后发现不匹配也要提交提案`;

// ──────────────────────────────────────────────────────────────────
// 工具白名单
// ──────────────────────────────────────────────────────────────────

export const EVOLVER_TOOLS = [
  // V2 资源导向工具
  'code',
  'graph',
  'knowledge',
  // semantic_search_code → code (action: search) — 已合并到 code
  'quality_score',
  // Evolution 决策工具
  'propose_evolution',
  'confirm_deprecation',
  'skip_evolution',
];

// ──────────────────────────────────────────────────────────────────
// 预算
// ──────────────────────────────────────────────────────────────────

export const EVOLVER_BUDGET = {
  maxIterations: 20,
  searchBudget: 10,
  searchBudgetGrace: 4,
  maxSubmits: 8,
  softSubmitLimit: 8,
  idleRoundsToExit: 2,
};

// ──────────────────────────────────────────────────────────────────
// Prompt 构建
// ──────────────────────────────────────────────────────────────────

/**
 * 构建 Evolution Agent 的用户 Prompt
 *
 * 按维度打包全部现有 Recipe 清单 + 可选 audit hint + 项目概览，
 * 让 Agent 通过提案机制对每个 Recipe 做出进化/废弃/跳过决策。
 */
export function buildEvolverPrompt(
  _phaseInput: unknown,
  _phaseResults: unknown,
  strategyContext: EvolutionContext
): string {
  const { existingRecipes, dimensionId, dimensionLabel, projectOverview } = strategyContext;
  const parts: string[] = [];

  // §1 任务概述
  parts.push(`# 验证任务: ${dimensionLabel} [${dimensionId}]`);
  parts.push(`你需要验证 **${existingRecipes.length}** 个现有 Recipe 的真实性。`);
  parts.push(
    `项目概况: ${projectOverview.primaryLang} 语言，${projectOverview.fileCount} 个文件。`
  );
  if (projectOverview.modules.length > 0) {
    parts.push(`主要模块: ${projectOverview.modules.slice(0, 10).join(', ')}`);
  }

  // §2 现有 Recipe 清单
  parts.push('# 现有 Recipe 清单');
  parts.push('以下是需要你验证的全部 Recipe。对每一个，你需要读取源文件、验证代码、然后做出决策。');

  for (let i = 0; i < existingRecipes.length; i++) {
    const recipe = existingRecipes[i];
    const lines: string[] = [];
    lines.push(`## [${i + 1}/${existingRecipes.length}] ${recipe.title}`);
    lines.push(`- **ID**: \`${recipe.id}\``);
    lines.push(`- **Trigger**: \`${recipe.trigger}\``);

    // 源文件引用 — 验证的起点
    if (recipe.sourceRefs && recipe.sourceRefs.length > 0) {
      lines.push(`- **源文件引用** (请用 \`code({ action: "read" })\` 读取验证):`);
      for (const ref of recipe.sourceRefs.slice(0, 5)) {
        lines.push(`  - \`${ref}\``);
      }
      if (recipe.sourceRefs.length > 5) {
        lines.push(`  - ... 及其他 ${recipe.sourceRefs.length - 5} 个文件`);
      }
    } else {
      lines.push('- **源文件引用**: 无（需要用 `code({ action: "search" })` 搜索相关代码）');
    }

    // Recipe 声称的核心代码（缩略）
    if (recipe.content?.coreCode) {
      const truncated =
        recipe.content.coreCode.length > 400
          ? `${recipe.content.coreCode.slice(0, 400)}...`
          : recipe.content.coreCode;
      lines.push(`- **Recipe 声称的核心代码** (需验证是否与实际一致):`);
      lines.push(`\`\`\`\n${truncated}\n\`\`\``);
    }

    // Recipe 的设计原理
    if (recipe.content?.rationale) {
      const rationale =
        recipe.content.rationale.length > 200
          ? `${recipe.content.rationale.slice(0, 200)}...`
          : recipe.content.rationale;
      lines.push(`- **设计原理**: ${rationale}`);
    }

    // 静态审计 hint（可选）
    if (recipe.auditHint) {
      lines.push('- **系统预检提示** ⚠️ 仅供参考，以你读到的代码为准:');
      lines.push(`  - 评分: ${recipe.auditHint.relevanceScore}/100 → ${recipe.auditHint.verdict}`);
      const ev = recipe.auditHint.evidence;
      const checks = [
        `Trigger: ${ev.triggerStillMatches ? '✅' : '❌'}`,
        `符号: ${(ev.symbolsAlive * 100).toFixed(0)}%`,
        `依赖: ${ev.depsIntact ? '✅' : '❌'}`,
        `代码文件: ${(ev.codeFilesExist * 100).toFixed(0)}%`,
      ];
      lines.push(`  - ${checks.join(' | ')}`);
      if (recipe.auditHint.decayReasons.length > 0) {
        lines.push(`  - 预检原因: ${recipe.auditHint.decayReasons.join('; ')}`);
      }
    }

    parts.push(lines.join('\n'));
  }

  // §3 验证工作流
  parts.push('# 验证工作流');
  parts.push('对每个 Recipe 按以下步骤执行:');
  parts.push('');
  parts.push('**步骤 1 — 读取源文件**');
  parts.push('- 使用 `code({ action: "read" })` 读取 sourceRefs 中列出的文件');
  parts.push('- 如果没有 sourceRefs，跳到步骤 2');
  parts.push('');
  parts.push('**步骤 2 — 搜索验证**（仅在源文件缺失或代码不匹配时）');
  parts.push('- 使用 `code({ action: "search" })` 搜索 Recipe 中的类名、函数名、关键模式');
  parts.push('- 使用 `graph({ action: "query" })` 验证符号关系和调用链');
  parts.push('- 确认该模式是否迁移到了新位置或已被完全移除');
  parts.push('');
  if (strategyContext.terminalTest) {
    parts.push('**可选终端验证**');
    parts.push(
      `- 当前终端实验档位: ${strategyContext.terminalToolset || 'terminal-exec'}；终端只用于验证工程命令事实`
    );
    parts.push('- 使用 terminal({ action: "exec" }) 执行验证命令');
    parts.push('- Evolution 阶段默认不使用 terminal_pty');
    parts.push('- 禁止 install、网络操作、写项目文件、删除、sudo、后台 daemon');
    parts.push('');
  }
  parts.push('**步骤 3 — 做出决策**');
  parts.push('- 基于步骤 1-2 的验证结果，调用对应的决策工具');

  // §4 决策指令
  parts.push('# 决策指令');
  parts.push('对上述每个 Recipe 做出以下三种决策之一:');
  parts.push('');
  parts.push('### 1. 🔄 附加进化提案 — 代码已变但知识仍有价值');
  parts.push('调用 `propose_evolution`:');
  parts.push('```json');
  parts.push('{');
  parts.push('  "recipeId": "recipe-xxx",');
  parts.push(
    '  "type": "enhance",        // enhance=模式迁移/功能扩展, correction=描述错误/接口变更'
  );
  parts.push('  "description": "说明发生了什么变化",');
  parts.push('  "evidence": {');
  parts.push('    "sourceStatus": "modified", // exists|moved|modified|deleted');
  parts.push('    "currentCode": "你读到的实际代码片段",');
  parts.push('    "newLocation": "新路径（仅 moved 时）",');
  parts.push('    "suggestedChanges": "{结构化 JSON — 见下方格式}"');
  parts.push('  },');
  parts.push('  "confidence": 0.85');
  parts.push('}');
  parts.push('```');
  parts.push('');
  parts.push('#### suggestedChanges 格式（重要！）');
  parts.push('suggestedChanges 必须是一个 JSON 字符串，格式如下:');
  parts.push('```json');
  parts.push('{');
  parts.push('  "patchVersion": 1,');
  parts.push('  "changes": [');
  parts.push('    {');
  parts.push('      "field": "coreCode",');
  parts.push('      "action": "replace",');
  parts.push('      "newValue": "更新后的代码片段"');
  parts.push('    },');
  parts.push('    {');
  parts.push('      "field": "content.markdown",');
  parts.push('      "action": "replace-section",');
  parts.push('      "section": "### 使用指南",');
  parts.push('      "newContent": "### 使用指南\\n更新后的内容"');
  parts.push('    }');
  parts.push('  ],');
  parts.push('  "reasoning": "源代码变更原因说明"');
  parts.push('}');
  parts.push('```');
  parts.push('');
  parts.push(
    '可修改的字段: `coreCode`, `doClause`, `dontClause`, `whenClause`, `content.markdown`, `content.rationale`, `sourceRefs`, `headers`'
  );
  parts.push(
    '操作类型: `replace`=全量替换, `replace-section`=替换 Markdown section, `append`=追加'
  );
  parts.push('');
  parts.push('### 2. ⛔ 确认废弃 — 知识确实过时，无法挽救');
  parts.push('调用 `confirm_deprecation`:');
  parts.push('```json');
  parts.push('{ "recipeId": "recipe-xxx", "reason": "具体废弃原因" }');
  parts.push('```');
  parts.push('');
  parts.push('### 3. ⏭️ 跳过 — 仍然有效 或 信息不足');
  parts.push('调用 `skip_evolution`:');
  parts.push('```json');
  parts.push('{ "recipeId": "recipe-xxx", "reason": "验证有效: 代码与描述完全匹配" }');
  parts.push('```');
  parts.push('或:');
  parts.push('```json');
  parts.push('{ "recipeId": "recipe-xxx", "reason": "信息不足: 无法确认源文件位置" }');
  parts.push('```');

  return parts.join('\n\n');
}
