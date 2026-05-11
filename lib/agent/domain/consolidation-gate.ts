/**
 * consolidation-gate.ts — 候选融合门控 Agent 领域函数
 *
 * Pipeline 内置的 ConsolidationGate Stage，在 Produce → RejectionGate 之间执行。
 * Agent 对 Producer 产出的候选逐条做语义融合判断：create / merge / reject。
 *
 * @module consolidation-gate
 */

// ──────────────────────────────────────────────────────────────────
// System Prompt
// ──────────────────────────────────────────────────────────────────

export const CONSOLIDATION_GATE_SYSTEM_PROMPT = `你是 Alembic 的 **Consolidation Gate Agent**，专职判断新产出的候选知识条目（Candidate）是否与现有 Recipe 存在语义重叠。

## 核心职责

对每个 Candidate，你需要：
1. 阅读候选内容和相关的现有 Recipe
2. 判断候选是否是全新知识、是否应合并到现有 Recipe、还是应被拒绝
3. 通过结构化工具输出判断结果

## 判断规则

| 情况 | 决策 | 工具 |
|------|------|------|
| 候选描述全新模式，与现有 Recipe 无语义重叠 | **创建** | \`approve_create\` |
| 候选与某个现有 Recipe 描述同一模式的不同方面 | **合并** | \`merge_into_existing\` |
| 候选是现有 Recipe 的子集或完全重复 | **拒绝** | \`reject_candidate\` |
| 无法确定 | **创建** | \`approve_create\`（默认放行，后续观察窗口兜底） |

## 合并策略

当使用 \`merge_into_existing\` 时，指定合并策略:
- \`append_evidence\`: 候选提供了额外的代码示例或来源，追加到现有 Recipe
- \`extend_scope\`: 候选扩展了模式的适用范围（如更多场景/更多约束）
- \`update_code\`: 候选提供了更新版本的核心代码

## 重要约束

- 你不修改 Recipe 内容——只做判断，实际操作由系统执行
- 每个 Candidate 必须有一个明确决策
- 合并目标必须是已有 Recipe ID，不能是另一个候选
- 如果系统预检提示两者"疑似重叠"，你需要阅读代码确认——预检基于文本特征，可能误判`;

// ──────────────────────────────────────────────────────────────────
// 工具白名单
// ──────────────────────────────────────────────────────────────────

export const CONSOLIDATION_GATE_TOOLS = [
  'code',
  'merge_into_existing',
  'approve_create',
  'reject_candidate',
];

// ──────────────────────────────────────────────────────────────────
// 预算
// ──────────────────────────────────────────────────────────────────

export const CONSOLIDATION_GATE_BUDGET = {
  maxIterations: 5,
  searchBudget: 3,
  searchBudgetGrace: 1,
  maxSubmits: 5,
  softSubmitLimit: 5,
  idleRoundsToExit: 1,
};

// ──────────────────────────────────────────────────────────────────
// 候选条目 & 现有 Recipe 最小接口
// ──────────────────────────────────────────────────────────────────

interface CandidateInfo {
  title: string;
  trigger: string;
  doClause?: string;
  coreCode?: string;
  content?: { markdown?: string; rationale?: string };
}

interface ExistingRecipeForGate {
  id: string;
  title: string;
  trigger: string;
  doClause?: string;
  content?: { markdown?: string; rationale?: string; coreCode?: string };
  sourceRefs?: string[];
}

interface PrescreenOverlap {
  existingId: string;
  existingTitle: string;
  similarity: number;
  fieldAnalysis?: {
    triggerConflict: boolean;
    doClauseSubset: boolean;
    coreCodeOverlap: number;
    categoryMatch: boolean;
  };
}

// ──────────────────────────────────────────────────────────────────
// Prompt 构建
// ──────────────────────────────────────────────────────────────────

/**
 * 构建 Consolidation Gate 的用户 Prompt。
 *
 * @param candidates - Producer 产出的候选列表
 * @param relatedRecipes - 与候选疑似重叠的现有 Recipe
 * @param prescreenOverlaps - 预筛查的重叠信息（来自 Layer 1 / Layer 1.5）
 */
export function buildConsolidationGatePrompt(
  candidates: CandidateInfo[],
  relatedRecipes: ExistingRecipeForGate[],
  prescreenOverlaps?: Array<{ candidateIndex: number; overlaps: PrescreenOverlap[] }>
): string {
  const parts: string[] = [];

  parts.push(`# 融合判断任务`);
  parts.push(`你需要对 **${candidates.length}** 个新候选做语义融合判断。`);
  parts.push(`当前维度有 **${relatedRecipes.length}** 个相关的现有 Recipe。`);
  parts.push('');

  // §1 现有 Recipe 列表
  if (relatedRecipes.length > 0) {
    parts.push('## 现有 Recipe');
    for (const recipe of relatedRecipes) {
      parts.push(`### ${recipe.title} (\`${recipe.id}\`)`);
      parts.push(`- Trigger: \`${recipe.trigger}\``);
      if (recipe.doClause) {
        parts.push(`- Do: ${recipe.doClause}`);
      }
      if (recipe.content?.coreCode) {
        const code =
          recipe.content.coreCode.length > 300
            ? `${recipe.content.coreCode.slice(0, 300)}...`
            : recipe.content.coreCode;
        parts.push(`- 核心代码:\n\`\`\`\n${code}\n\`\`\``);
      }
      if (recipe.sourceRefs && recipe.sourceRefs.length > 0) {
        parts.push(`- 源文件: ${recipe.sourceRefs.slice(0, 3).join(', ')}`);
      }
      parts.push('');
    }
  }

  // §2 候选列表
  parts.push('## 候选列表');
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    parts.push(`### [${i + 1}/${candidates.length}] ${c.title}`);
    parts.push(`- Trigger: \`${c.trigger}\``);
    if (c.doClause) {
      parts.push(`- Do: ${c.doClause}`);
    }
    if (c.coreCode) {
      const code = c.coreCode.length > 300 ? `${c.coreCode.slice(0, 300)}...` : c.coreCode;
      parts.push(`- 核心代码:\n\`\`\`\n${code}\n\`\`\``);
    }

    // 预筛查重叠提示
    const overlap = prescreenOverlaps?.find((o) => o.candidateIndex === i);
    if (overlap && overlap.overlaps.length > 0) {
      parts.push('- **系统预检** ⚠️ 以下现有 Recipe 疑似重叠（需你阅读代码确认）:');
      for (const o of overlap.overlaps) {
        const hints: string[] = [`相似度=${(o.similarity * 100).toFixed(0)}%`];
        if (o.fieldAnalysis) {
          if (o.fieldAnalysis.triggerConflict) {
            hints.push('trigger 冲突');
          }
          if (o.fieldAnalysis.doClauseSubset) {
            hints.push('doClause 疑似子集');
          }
          if (o.fieldAnalysis.coreCodeOverlap >= 0.6) {
            hints.push(`代码重叠=${(o.fieldAnalysis.coreCodeOverlap * 100).toFixed(0)}%`);
          }
        }
        parts.push(`  - \`${o.existingId}\` "${o.existingTitle}" — ${hints.join(', ')}`);
      }
    }
    parts.push('');
  }

  // §3 决策指令
  parts.push('## 决策指令');
  parts.push('对每个候选调用以下工具之一:');
  parts.push('');
  parts.push('### approve_create — 确认新建');
  parts.push('候选描述的是全新模式，与现有 Recipe 不重叠。');
  parts.push('```json\n{ "candidateIndex": 0, "reason": "..." }\n```');
  parts.push('');
  parts.push('### merge_into_existing — 合并到现有 Recipe');
  parts.push('候选与某个现有 Recipe 描述同一模式。');
  parts.push('```json');
  parts.push('{ "candidateIndex": 0, "targetRecipeId": "existing-xxx",');
  parts.push('  "mergeStrategy": "append_evidence|extend_scope|update_code",');
  parts.push('  "reason": "..." }');
  parts.push('```');
  parts.push('');
  parts.push('### reject_candidate — 拒绝');
  parts.push('候选是完全重复或低价值。');
  parts.push('```json\n{ "candidateIndex": 0, "reason": "..." }\n```');

  return parts.join('\n');
}
