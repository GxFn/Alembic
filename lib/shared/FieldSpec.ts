/**
 * FieldSpec.js — V3 知识条目字段规范（唯一权威来源）
 *
 * 字段分级:
 *   REQUIRED  — 缺少则立即拒绝（19 个顶层字段 + 4 个嵌套字段）
 *   EXPECTED  — 缺少则 warning + suggestions，不阻塞入库
 *   OPTIONAL  — 缺少不报任何问题
 *
 * 判决依据: 从 6 条交付管线 (Channel A/B/F, Search, Guard, Quality) 反推，
 * 以「缺少时的实际损害」为唯一标准。
 *
 * 消费方:
 *   - UnifiedValidator.js       → 字段完整性检查
 *   - dimension-text.js         → SUBMISSION_SCHEMA / REQUIRED_FIELDS_DESCRIPTION
 *   - bootstrap-producer.js      → STYLE_GUIDE 字段列表
 *   - MissionBriefingBuilder.js → submissionSpec 字段描述
 *   - lifecycle.js              → JSON Schema required 数组
 *   - consolidated.js           → 前置校验
 *
 * @module shared/FieldSpec
 */

// ── 字段级别枚举 ────────────────────────────────────────────

export const FieldLevel = Object.freeze({
  REQUIRED: 'required',
  EXPECTED: 'expected',
  OPTIONAL: 'optional',
});

// ── V3 字段规范 ─────────────────────────────────────────────

/**
 * @typedef {object} FieldDef
 * @property {string}  name              字段名（支持点号嵌套: 'content.markdown'）
 * @property {string}  level             - 'required' | 'expected' | 'optional'
 * @property {string}  rule              人类友好的填写规则
 * @property {string}  [pipeline]        下游管线消费说明
 * @property {string}  [type]            - 'string' | 'object' | 'array' | 'number'
 * @property {boolean} [systemInjected]  - true = 内部 Agent 路径由系统注入，AI 不必填
 * @property {*}       [defaultValue]    默认值（用于 save_document 等特殊路径）
 */

/** @type {FieldDef[]} */
export const V3_FIELD_SPEC = [
  // ── 核心内容 (5) ──────────────────────────────────────────
  {
    name: 'title',
    level: FieldLevel.REQUIRED,
    type: 'string',
    rule: '中文 ≤20 字，引用项目真实类名',
    pipeline: 'identity + dedup + search + QualityScorer(completeness 0.25)',
  },
  {
    name: 'content',
    level: FieldLevel.REQUIRED,
    type: 'object',
    rule: 'JSON 对象 { markdown, pattern?, rationale }',
    pipeline: 'knowledge body container',
  },
  {
    name: 'content.markdown',
    level: FieldLevel.REQUIRED,
    type: 'string',
    rule: '≥200 字符的「项目特写」，含代码块+来源标注',
    pipeline: 'search + Skill content + display',
  },
  {
    name: 'content.rationale',
    level: FieldLevel.REQUIRED,
    type: 'string',
    rule: '设计原理说明',
    pipeline: 'Channel B **Why** line (via _extractFirstSentence)',
  },
  {
    name: 'description',
    level: FieldLevel.REQUIRED,
    type: 'string',
    rule: '中文简述 ≤80 字',
    pipeline: 'search result display + QualityScorer(metadata 0.3 as summary)',
  },

  // ── Cursor 交付字段 (6) — 直接决定 .mdc 产出 ────────────
  {
    name: 'trigger',
    level: FieldLevel.REQUIRED,
    type: 'string',
    rule: '@前缀 kebab-case 唯一标识符',
    pipeline: 'Channel B ### 标题 + filter 硬依赖 + QualityScorer(completeness 0.25 + format 0.5)',
  },
  {
    name: 'kind',
    level: FieldLevel.REQUIRED,
    type: 'string',
    rule: 'rule | pattern | fact',
    pipeline: 'CursorDeliveryPipeline._classify() 路由: rule→A, pattern→B',
  },
  {
    name: 'doClause',
    level: FieldLevel.REQUIRED,
    type: 'string',
    rule: '英文祈使句 ≤60 tokens，以动词开头',
    pipeline: '⚠️ Channel A + B 双通道 filter 硬依赖，缺少 → 所有 .mdc 产出为零',
  },
  {
    name: 'dontClause',
    level: FieldLevel.REQUIRED,
    type: 'string',
    rule: '英文反向约束（描述禁止的做法）',
    pipeline: 'Channel A "Do NOT" 后缀 + Channel B **Don\'t** 行。知识「禁止」维度',
  },
  {
    name: 'whenClause',
    level: FieldLevel.REQUIRED,
    type: 'string',
    rule: '英文触发场景描述',
    pipeline: 'Channel B **When** 行 + filter 硬依赖，缺少 → Channel B 产出为零',
  },
  {
    name: 'coreCode',
    level: FieldLevel.REQUIRED,
    type: 'string',
    rule: '3-8 行纯代码骨架，语法完整可复制',
    pipeline: 'Channel B 代码模板块 (via _skeletonize)。最直接可复制的内容',
  },

  // ── 分类与推理 (5) ────────────────────────────────────────
  {
    name: 'category',
    level: FieldLevel.REQUIRED,
    type: 'string',
    rule: 'View/Service/Tool/Model/Network/Storage/UI/Utility',
    pipeline: 'QualityScorer(metadata 0.35) + 标准分类',
    systemInjected: true, // 内部路径系统注入
  },
  {
    name: 'headers',
    level: FieldLevel.REQUIRED,
    type: 'array',
    rule: 'import 语句数组，无 import 时传 []',
    pipeline: 'QualityScorer(metadata 0.35 alongside tags)',
  },
  {
    name: 'reasoning',
    level: FieldLevel.REQUIRED,
    type: 'object',
    rule: '{ whyStandard: string, sources: string[], confidence: number }',
    pipeline: 'provenance container',
  },
  {
    name: 'reasoning.whyStandard',
    level: FieldLevel.REQUIRED,
    type: 'string',
    rule: '为什么这是标准做法',
    pipeline: 'lifecycle.js → aiInsight 注入',
  },
  {
    name: 'reasoning.sources',
    level: FieldLevel.REQUIRED,
    type: 'array',
    rule: '非空文件路径数组',
    pipeline: '来源证据链 + lifecycle.js → sourceFile 推断',
  },

  // ── 类型与语言 (3) ────────────────────────────────────────
  {
    name: 'knowledgeType',
    level: FieldLevel.REQUIRED,
    type: 'string',
    rule: 'code-pattern / architecture / best-practice 等',
    pipeline: '知识维度分类',
    systemInjected: true,
  },
  {
    name: 'language',
    level: FieldLevel.REQUIRED,
    type: 'string',
    rule: '编程语言标识 (swift/typescript/python/...)',
    pipeline: 'Channel A [language] 前缀 + QualityScorer(format 0.5)',
    systemInjected: true,
  },
  {
    name: 'usageGuide',
    level: FieldLevel.REQUIRED,
    type: 'string',
    rule: '### 章节格式使用指南',
    pipeline: 'QualityScorer(completeness 0.2) → 影响排名 → 影响 token 预算裁剪',
  },

  // ── 推荐字段 (EXPECTED) ───────────────────────────────────
  {
    name: 'topicHint',
    level: FieldLevel.EXPECTED,
    type: 'string',
    rule: 'networking / ui / data / architecture / conventions',
    pipeline: 'TopicClassifier._classifyEntry() 路由。缺少 → "general" 优雅降级',
  },

  // ── 可选字段 (OPTIONAL) ───────────────────────────────────
  {
    name: 'scope',
    level: FieldLevel.OPTIONAL,
    type: 'string',
    rule: 'universal / project-specific / team-convention',
  },
  {
    name: 'complexity',
    level: FieldLevel.OPTIONAL,
    type: 'string',
    rule: 'basic / intermediate / advanced',
  },
  {
    name: 'content.pattern',
    level: FieldLevel.OPTIONAL,
    type: 'string',
    rule: '代码片段（markdown 已含时可省略）',
  },
  {
    name: 'sourceFile',
    level: FieldLevel.OPTIONAL,
    type: 'string',
    rule: '来源文件相对路径',
  },
  {
    name: 'tags',
    level: FieldLevel.OPTIONAL,
    type: 'array',
    rule: '标签数组',
  },
];

// ── 字段统计 ────────────────────────────────────────────────
// REQUIRED:  19 个顶层字段 + 4 个嵌套字段
//   顶层: title, content, description, trigger, kind, doClause, dontClause,
//         whenClause, coreCode, category, headers, reasoning, knowledgeType,
//         language, usageGuide
//   嵌套: content.markdown, content.rationale, reasoning.whyStandard, reasoning.sources
// EXPECTED:  1 (topicHint)
// OPTIONAL:  5 (scope, complexity, content.pattern, sourceFile, tags)

// ── 标准枚举 ────────────────────────────────────────────────

export const STANDARD_CATEGORIES = [
  'View',
  'Service',
  'Tool',
  'Model',
  'Network',
  'Storage',
  'UI',
  'Utility',
];

/** category 白名单 — Bootstrap 维度展示分组 + 特殊流程中的合法 category */
export const WHITELISTED_CATEGORIES = [
  // Bootstrap 维度展示分组 (DIMENSION_DISPLAY_GROUP 输出值)
  'architecture',
  'best-practice',
  'event-and-data-flow',
  'objc-deep-scan',
  'agent-guidelines',
  // 维度原始 ID (当 DIMENSION_DISPLAY_GROUP 无映射时作为 fallback)
  'code-pattern',
  'code-standard',
  'project-profile',
  'category-scan',
  'module-export-scan',
  'framework-convention-scan',
  'python-package-scan',
  'jvm-annotation-scan',
  // 特殊来源
  'bootstrap',
  'knowledge',
  'general',
  'documentation',
];

export const VALID_KINDS = ['rule', 'pattern', 'fact'];

export const VALID_TOPIC_HINTS = ['networking', 'ui', 'data', 'architecture', 'conventions'];

// ── 查询辅助函数 ────────────────────────────────────────────

/** 获取所有 REQUIRED 级别的顶层字段名 */
export function getRequiredFieldNames() {
  return V3_FIELD_SPEC.filter((f) => f.level === FieldLevel.REQUIRED && !f.name.includes('.')).map(
    (f) => f.name
  );
}

/** 获取所有 REQUIRED 级别的字段名（含嵌套） */
export function getAllRequiredFieldNames() {
  return V3_FIELD_SPEC.filter((f) => f.level === FieldLevel.REQUIRED).map((f) => f.name);
}

/** 获取 EXPECTED 级别字段名 */
export function getExpectedFieldNames() {
  return V3_FIELD_SPEC.filter((f) => f.level === FieldLevel.EXPECTED).map((f) => f.name);
}

/** 获取 AI 在外部路径必须提供的字段（= REQUIRED 全集，因无系统注入） */
export function getExternalAgentRequiredFields() {
  return getRequiredFieldNames();
}

/** 获取 AI 在内部路径必须提供的字段（排除系统注入的 language/category/knowledgeType） */
export function getInternalAgentRequiredFields() {
  return V3_FIELD_SPEC.filter(
    (f) => f.level === FieldLevel.REQUIRED && !f.name.includes('.') && !f.systemInjected
  ).map((f) => f.name);
}

/** 获取系统注入的字段名列表 */
export function getSystemInjectedFields() {
  return V3_FIELD_SPEC.filter((f) => f.systemInjected).map((f) => f.name);
}

/**
 * 生成人类友好的字段说明列表（供拒绝反馈使用）
 * @returns {string[]}
 */
export function getRequiredFieldsDescription() {
  return V3_FIELD_SPEC.filter((f) => f.level === FieldLevel.REQUIRED).map((f) => {
    if (f.name.includes('.')) {
      return `${f.name} (${f.rule})`;
    }
    return `${f.name} (${f.rule})`;
  });
}

/**
 * 根据字段名获取规范定义
 * @param {string} name
 * @returns {FieldDef|undefined}
 */
export function getFieldDef(name: any) {
  return V3_FIELD_SPEC.find((f) => f.name === name);
}

/**
 * 生成 Cursor 交付字段描述对象（供 MissionBriefingBuilder.submissionSpec.cursorFields）
 *
 * 从 V3_FIELD_SPEC 中提取 trigger/kind/doClause/dontClause/whenClause/coreCode 的 rule，
 * 并标记 REQUIRED 级别为【必填】前缀。
 *
 * @returns {Record<string, string>}
 */
export function getCursorDeliverySpec() {
  const CURSOR_FIELD_NAMES = [
    'trigger',
    'kind',
    'doClause',
    'dontClause',
    'whenClause',
    'coreCode',
  ];
  const result: Record<string, any> = {};
  for (const name of CURSOR_FIELD_NAMES) {
    const def = V3_FIELD_SPEC.find((f) => f.name === name);
    if (def) {
      const prefix = def.level === FieldLevel.REQUIRED ? '【必填】' : '';
      result[name] = `${prefix}${def.rule}`;
    }
  }
  return result;
}

/**
 * 按 level 分组返回字段
 * @returns {{ required: FieldDef[], expected: FieldDef[], optional: FieldDef[] }}
 */
export function getFieldsByLevel() {
  return {
    required: V3_FIELD_SPEC.filter((f) => f.level === FieldLevel.REQUIRED),
    expected: V3_FIELD_SPEC.filter((f) => f.level === FieldLevel.EXPECTED),
    optional: V3_FIELD_SPEC.filter((f) => f.level === FieldLevel.OPTIONAL),
  };
}
