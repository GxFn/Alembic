import type { CompactSop, FullSop, FullSopStep } from "./sop-types.js";

/** Phase 4 共享质量检查项（与 PRE_SUBMIT_CHECKLIST 互补，非重复） */
const SHARED_SUBMIT_CHECKLIST: readonly string[] = [
  "**数量由证据决定** — 有几条扎实证据就提交几条，不凑数；若本维度在项目中无实质内容则跳过，提交 0 条",
  "content 包含 ✅ 正确写法 和 ❌ 禁止写法（如适用）",
  "coreCode 是可复制的完整代码骨架",
  "doClause 英文祈使句，以动词开头",
  "引用具体的文件路径和代码行",
];

/** 从紧凑定义生成消费者兼容的完整 SOP 对象。 */
export function buildDimensionSop(def: CompactSop): FullSop {
  const steps: FullSopStep[] = def.phases.map((phase, index) => ({
    phase: `${index + 1}. ${phase.name}`,
    action: phase.action,
    expectedOutput: phase.output,
    ...(phase.tools ? { tools: [...phase.tools] } : {}),
  }));

  steps.push({
    phase: `${steps.length + 1}. 提交`,
    action: def.submitAction,
    qualityChecklist: [...SHARED_SUBMIT_CHECKLIST, ...(def.submitExtras ?? [])],
  });

  return {
    ...(def.keywords ? { focusKeywords: [...def.keywords] } : {}),
    steps,
    timeEstimate: "1-5 min",
    commonMistakes: [...def.mistakes],
  };
}
