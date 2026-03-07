/**
 * StyleGuide.js — 项目特写写作指南（唯一权威来源）
 *
 * 供内部 Agent (bootstrap-producer.js) 和
 * 外部 Agent (MissionBriefing submissionSpec) 共享使用。
 *
 * @module shared/StyleGuide
 */

import { FieldLevel, V3_FIELD_SPEC } from './FieldSpec.js';

// ── 「项目特写」写作指南全文 ────────────────────────────────

export const PROJECT_SNAPSHOT_STYLE_GUIDE = `# 「项目特写」写作要求

submit_knowledge 的 content.markdown 字段必须是「项目特写」。

## 什么是「项目特写」
将一种技术的**基本用法**与**本项目的具体特征**融合为一体。

## 四大核心内容
1. **项目选择了什么** — 采用了哪种写法/模式/约定
2. **为什么这样选** — 统计分布、占比、历史决策
3. **项目禁止什么** — 反模式、已废弃写法
4. **新代码怎么写** — 可直接复制使用的代码模板 + 来源标注 (来源: FileName.ext:行号)

## 格式要求
- 标题使用项目真实类名/前缀，不用占位名
- 代码来源标注: (来源: FileName.ext:行号)
- 不要纯代码罗列，必须有项目上下文
- 标题和正文中不得出现 "Agent" 字样`;

// ── Cursor 交付字段规范（从 FieldSpec 自动生成） ────────────

/**
 * 生成 Cursor 交付字段规范文本（供 Producer STYLE_GUIDE 和 MissionBriefing 使用）
 * @returns {string}
 */
export function getCursorDeliverySpec() {
  const required: string[] = [];
  const expected: string[] = [];

  for (const field of V3_FIELD_SPEC) {
    // 跳过嵌套字段和非 Cursor 交付字段容器
    if (field.name.includes('.')) {
      continue;
    }
    if (
      [
        'content',
        'reasoning',
        'title',
        'description',
        'headers',
        'category',
        'language',
        'knowledgeType',
        'usageGuide',
      ].includes(field.name)
    ) {
      continue;
    }

    if (field.level === FieldLevel.REQUIRED) {
      required.push(`- ${field.name}: ${field.rule}`);
    } else if (field.level === FieldLevel.EXPECTED) {
      expected.push(`- ${field.name}: ${field.rule}`);
    }
  }

  const parts: string[] = [];
  if (required.length > 0) {
    parts.push('### 必填（REQUIRED）');
    parts.push(required.join('\n'));
  }
  if (expected.length > 0) {
    parts.push('### 推荐（EXPECTED）');
    parts.push(expected.join('\n'));
  }

  parts.push(`\n### 规范`);
  parts.push(`1. trigger 以 @ 开头，kebab-case，不得在同一批次重复`);
  parts.push(`2. doClause 英文祈使句，不含中文`);
  parts.push(`3. coreCode 是可直接复制到编辑器的纯代码`);
  parts.push(`4. kind 根据内容本质判断：强制约束 → rule，实现模式 → pattern，项目事实 → fact`);

  return parts.join('\n');
}

/**
 * 构建完整的 Producer STYLE_GUIDE（合并项目特写要求 + Cursor 交付字段规范）
 * @returns {string}
 */
export function buildProducerStyleGuide() {
  return [
    PROJECT_SNAPSHOT_STYLE_GUIDE,
    '',
    '## Cursor 交付字段（每个 submit_knowledge 必须附带）',
    '',
    '每个候选必须提供以下交付字段，它们直接决定在 Cursor IDE 中作为 Rules 的展示质量。',
    '注意：language / category / knowledgeType / source 由系统自动设置，无需填写。',
    '',
    getCursorDeliverySpec(),
  ].join('\n');
}

/**
 * 构建提交要求文本（Producer 复用）
 * @returns {string}
 */
export const SUBMIT_REQUIREMENTS = `要求:
1. 每个独立的知识点单独提交为一个候选 — 目标: 至少 3 个候选
2. 先使用分析中已有的代码片段直接提交候选; 仅在需要更多代码上下文时才用 read_project_file
3. filePaths 填写分析中提到的相关文件路径
4. description 中文简述 ≤80 字，引用真实类名
5. reasoning 中 sources 必须非空，填写来源文件名如 ["FileName.m"]，confidence 填 0.7~0.9
6. 不要跳过任何分析中提到的知识点
7. 如果 read_project_file 失败（文件不存在），直接用分析文本内容提交，不要重试其他路径
8. 每个候选必须有 trigger (@kebab-case)、kind (rule/pattern/fact)、doClause (英文祈使句)
9. dontClause（反向约束）、whenClause（触发场景）、coreCode（代码骨架）均为必填
10. content 必须是包含 markdown 和 rationale 的对象: { markdown: "项目特写正文", rationale: "设计原理", pattern: "可选代码片段" }。⚠️ rationale 是必填字段，解释为什么采用这种做法
11. kind 只能是 rule/pattern/fact 三选一，不要填写维度名（如 best-practice/architecture/code-standard 都不是合法 kind 值）`;
