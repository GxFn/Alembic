import { buildDimensionSop } from "./sop-builder.js";
import { COMPACT_SOPS } from "./sop-data.js";
import type { FullSop } from "./sop-types.js";

export type { CompactSop, FullSop, FullSopStep, SopPhase } from "./sop-types.js";

const DIMENSION_SOP: Readonly<Record<string, FullSop>> = Object.fromEntries(
  Object.entries(COMPACT_SOPS).map(([id, def]) => [id, buildDimensionSop(def)]),
);

export const PRE_SUBMIT_CHECKLIST = {
  MUST: [
    "title: 中文 ≤20 字，引用项目真实类名或模式名（不以项目名开头）",
    "description: 中文简述 ≤80 字",
    "trigger: @前缀 kebab-case 唯一标识符",
    "kind: rule | pattern | fact（必须选一）",
    "content.markdown: ≥200 字符的项目特写，含代码块+来源标注 (来源: FileName.ext:行号)",
    "content.rationale: 设计原理说明",
    "coreCode: 3-8 行纯代码骨架，语法完整可复制",
    "headers: import 语句数组（无则 []）",
    "doClause: 英文祈使句 ≤60 tokens，以动词开头",
    "dontClause: 英文反向约束",
    "whenClause: 英文触发场景描述",
    "reasoning.whyStandard + reasoning.sources（非空文件列表）",
    "sourceRefs: 引用的源文件列表",
    "usageGuide: ### 使用指南 格式",
  ],
  SHOULD: [
    "每个候选只聚焦单一知识点 — 不要合并不同模式",
    "content 中使用 ✅ / ❌ 对比正确写法和禁止写法",
    "coreCode 使用项目实际的代码而非伪代码",
    "description 提及影响范围（全局 / 某层 / 某模块）",
    "tags 包含有意义的搜索关键词",
    "confidence ≥0.85 才提交",
  ],
  FAIL_EXAMPLES: [
    {
      bad: "title: '项目使用了 MVVM 模式'",
      good: "title: 'ViewModel 的 Output 必须通过 Driver 转换'",
      why: "title 必须具体到可执行的规则，不能是泛泛的描述",
    },
    {
      bad: "content.markdown: '本项目使用 RxSwift 进行响应式编程。'",
      good: "content.markdown: '## ViewModel Output 转换规范\\n\\n所有 ViewModel 的 Output 统一使用...(来源: HomeViewModel.swift:45)'",
      why: "content 必须 ≥200 字符，包含项目特有的实现细节和代码引用",
    },
  ],
} as const;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Query Functions
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 获取指定维度的完整 SOP
 * @returns FullSop | undefined
 */
export function getDimensionSOP(dimId: string): FullSop | undefined {
  return DIMENSION_SOP[dimId];
}

/**
 * 获取维度的关注关键词（用于 EpisodicMemory 跨维度匹配）
 * 优先使用 SOP 中定义的 focusKeywords，fallback 到从 guideText 解析
 */
export function getDimensionFocusKeywords(dimId: string, guideText = ""): string[] {
  const sop = DIMENSION_SOP[dimId];
  if (sop?.focusKeywords && sop.focusKeywords.length > 0) {
    return sop.focusKeywords;
  }

  // fallback: 从 guideText 中提取关键词
  if (!guideText) {
    return [];
  }
  const keywords: string[] = [];
  // 提取中文关键词（2-6字）
  const zhMatches = guideText.match(/[\u4E00-\u9FFF]{2,6}/g);
  if (zhMatches) {
    keywords.push(...zhMatches.slice(0, 8));
  }
  // 提取英文关键词（大写开头或全大写）
  const enMatches = guideText.match(/\b[A-Z][a-zA-Z]{2,}\b/g);
  if (enMatches) {
    keywords.push(...enMatches.slice(0, 5));
  }
  return keywords;
}

/**
 * 将 SOP / analysisGuide 压缩为纯文本（用于 Level 5 极致压缩模式）
 * 接受 analysisGuide 对象（含 steps + commonMistakes 字段）
 */
export function sopToCompactText(guide: Record<string, unknown>): string {
  if (!guide || typeof guide !== "object") {
    return "";
  }

  const lines: string[] = [];
  const steps = Array.isArray(guide.steps) ? guide.steps : [];
  for (const step of steps) {
    if (typeof step === "object" && step !== null) {
      const s = step as Record<string, unknown>;
      const phase = typeof s.phase === "string" ? s.phase : "";
      const action = typeof s.action === "string" ? s.action : "";
      lines.push(`${phase}: ${action}`);
      if (typeof s.expectedOutput === "string") {
        lines.push(`  → ${s.expectedOutput}`);
      }
    }
  }
  const mistakes = Array.isArray(guide.commonMistakes) ? guide.commonMistakes : [];
  if (mistakes.length > 0) {
    lines.push("⚠️ 常见错误:");
    for (const m of mistakes) {
      if (typeof m === "string") {
        lines.push(`  - ${m}`);
      }
    }
  }
  return lines.join("\n");
}
