/**
 * dimension-text.js — 固定文本内容注册表
 *
 * 从 MissionBriefingBuilder.js 和 bootstrap-internal.js 中抽取的
 * 可直接复用的固定文本常量和提示模板。
 *
 * 集中管理：
 *   - SUBMISSION_SCHEMA: 提交工具定义和必填字段
 *   - EXAMPLE_TEMPLATES: 语言自适应示例模板
 *   - QUALITY_GATES: 提交质量门控描述
 *   - 完成后提示文本
 *
 * 调用方:
 *   - MissionBriefingBuilder.js (外部 Agent) — 构建 Mission Briefing
 *   - bootstrap-internal.js (内部 Agent)   — 响应中的 analysisFramework
 *   - consolidated.js                      — 提交校验反馈文本
 *
 * @module bootstrap/shared/dimension-text
 */

import { getRequiredFieldNames, getRequiredFieldsDescription } from '#shared/FieldSpec.js';

// ═══════════════════════════════════════════════════════════
// 提交 Schema 定义
// ═══════════════════════════════════════════════════════════

/**
 * 知识提交的完整 Schema — 定义必填字段、内容结构、枚举值和质量门控
 */
export const SUBMISSION_SCHEMA = {
  tool: 'autosnippet_submit_knowledge',
  batchTool: 'autosnippet_submit_knowledge_batch',
  requiredFields: getRequiredFieldNames(),
  contentStructure: {
    pattern: '代码片段（可选）',
    markdown: 'Markdown 正文（必填，≥200 字符，项目特写风格）',
    rationale: '设计原理说明（必填）',
  },
  categoryEnum: ['View', 'Service', 'Tool', 'Model', 'Network', 'Storage', 'UI', 'Utility'],
  kindEnum: ['rule', 'pattern', 'fact'],
  reasoning: {
    whyStandard: '字符串 — 为什么这是标准做法',
    sources: '字符串数组 — 参考的文件名（必须非空）',
    confidence: '0.0-1.0（推荐 0.7-0.9）',
  },
  qualityGates: [
    'content.markdown ≥ 200 字符',
    '至少包含 1 个代码块 (```)',
    '包含来源标注 (来源: FileName:行号)',
    '标题使用项目真实类名',
    'trigger 必须唯一（同批次内不重复）',
  ],
};

// ═══════════════════════════════════════════════════════════
// 语言自适应示例模板
// ═══════════════════════════════════════════════════════════

/**
 * 按项目主语言提供 few-shot 示例。
 * Agent 直接模仿示例格式提交知识。
 */
export const EXAMPLE_TEMPLATES = {
  objectivec: {
    title: 'BD 前缀命名规范',
    language: 'objectivec',
    content: {
      markdown:
        '## BD 前缀命名规范\n\n项目中所有类必须使用 `BD` 前缀...\n\n### 项目选择了什么\n全部 85 个类中，83 个使用 BD 前缀...\n\n```objectivec\n// ✅ 正确\n@interface BDVideoPlayer : UIView\n// ❌ 禁止\n@interface VideoPlayer : UIView\n```\n(来源: BDVideoPlayer.h:5)\n\n### 新代码怎么写\n统一使用 BD + 模块缩写 + 功能名',
      rationale: '统一前缀便于代码导航和模块归属识别，85/85 类遵循此规范',
    },
    kind: 'rule',
    doClause: 'Prefix all class names with BD for consistent module attribution',
    dontClause: 'create classes without BD prefix in any module',
    whenClause: 'When creating new Objective-C classes or protocols',
    category: 'Tool',
    trigger: '@bd-naming-prefix',
    description: '所有类名必须使用 BD 前缀，确保模块归属一致性',
    headers: [],
    usageGuide: '### 何时使用\n创建任何新类时必须遵守\n### 规范\n类名: BD + 模块缩写 + 功能名',
    knowledgeType: 'code-standard',
    coreCode:
      '@interface BDVideoPlayer : UIView\n@end\n\n@interface BDNetworkManager : NSObject\n@end',
    reasoning: {
      whyStandard: '83/85 (97.6%) classes use BD prefix',
      sources: ['BDVideoPlayer.h', 'BDBaseRequest.h'],
      confidence: 0.95,
    },
  },

  typescript: {
    title: 'Service 类统一 Injectable 装饰器',
    language: 'typescript',
    content: {
      markdown:
        '## Service 类统一 Injectable 装饰器\n\n项目中所有 Service 类必须使用 `@Injectable()` 装饰器...\n\n### 项目选择了什么\n32 个 Service 类中，30 个使用 Injectable 装饰器...\n\n```typescript\n// ✅ 正确\n@Injectable()\nexport class UserService {\n  constructor(private readonly db: DatabaseService) {}\n}\n// ❌ 禁止\nexport class UserService {}\n```\n(来源: src/services/UserService.ts:5)\n\n### 新代码怎么写\n...',
      rationale: 'DI 容器要求所有 Service 使用 Injectable 装饰器',
    },
    kind: 'rule',
    doClause: 'Use @Injectable() decorator on all service classes',
    dontClause: 'Do not create service classes without @Injectable() decorator',
    whenClause: 'When creating new service classes in the DI container',
    category: 'Service',
    trigger: '@injectable-services',
    description: '所有 Service 类必须使用 @Injectable() 装饰器',
    headers: ["import { Injectable } from '@nestjs/common';"],
    usageGuide:
      '### 何时使用\n创建任何新 Service 类时\n### 规范\n所有 Service 类顶部添加 @Injectable()',
    knowledgeType: 'code-standard',
    coreCode: '@Injectable()\nexport class UserService {\n  constructor(private db: DB) {}\n}',
    reasoning: {
      whyStandard: '30/32 services use @Injectable()',
      sources: ['src/services/UserService.ts', 'src/services/AuthService.ts'],
      confidence: 0.9,
    },
  },

  python: {
    title: 'Service 层统一异步模式',
    language: 'python',
    content: {
      markdown:
        '## Service 层统一异步模式\n\n项目中所有 Service 层函数使用 `async def`...\n\n### 项目选择了什么\n全部 28 个 Service 函数中，26 个使用 async def...\n\n```python\n# ✅ 正确\nasync def get_user(db: AsyncSession, user_id: int) -> User:\n    result = await db.execute(select(User).filter_by(id=user_id))\n    return result.scalar_one_or_none()\n\n# ❌ 禁止\ndef get_user(db, user_id):\n    ...\n```\n(来源: services/user_service.py:15)\n\n### 新代码怎么写\n...',
      rationale: 'FastAPI 框架要求所有 I/O 操作使用 async/await',
    },
    kind: 'rule',
    doClause: 'Use async def for all service layer functions',
    dontClause: 'Do not use synchronous def for service layer I/O operations',
    whenClause: 'When creating or modifying service layer functions with I/O',
    category: 'Service',
    trigger: '@async-service-pattern',
    description: '所有 Service 层函数使用 async def',
    headers: ['from sqlalchemy.ext.asyncio import AsyncSession'],
    usageGuide: '### 何时使用\n创建任何新 Service 函数时\n### 规范\n统一使用 async def + await',
    knowledgeType: 'code-standard',
    coreCode:
      'async def get_user(db: AsyncSession, user_id: int) -> User:\n    result = await db.execute(select(User).filter_by(id=user_id))\n    return result.scalar_one_or_none()',
    reasoning: {
      whyStandard: '26/28 service functions use async def',
      sources: ['services/user_service.py', 'services/auth_service.py'],
      confidence: 0.9,
    },
  },

  // 通用 fallback
  _default: {
    title: '项目命名规范示例',
    language: 'text',
    content: {
      markdown:
        '## 项目命名规范\n\n分析项目中的命名约定...\n\n### 项目选择了什么\n描述项目中使用的命名约定...\n\n```\n// ✅ 正确\n示例代码\n// ❌ 禁止\n反面示例\n```\n(来源: path/to/file:行号)\n\n### 新代码怎么写\n...',
      rationale: '统一命名便于代码导航',
    },
    kind: 'rule',
    doClause: 'Follow the project naming convention',
    dontClause: 'Do not deviate from the established naming pattern',
    whenClause: 'When creating new files, classes, functions, or variables',
    category: 'Tool',
    trigger: '@naming-convention',
    description: '遵循项目命名规范',
    headers: [],
    usageGuide: '### 何时使用\n创建任何新代码时\n### 规范\n遵循已有命名约定',
    knowledgeType: 'code-standard',
    coreCode: '// 示例代码',
    reasoning: {
      whyStandard: 'Consistent naming across codebase',
      sources: ['example.file'],
      confidence: 0.8,
    },
  },
};

// ═══════════════════════════════════════════════════════════
// 提交必填字段列表 (供拒绝反馈使用)
// ═══════════════════════════════════════════════════════════

/**
 * 提交被拒绝时返回的必填字段说明列表
 * —— 由 FieldSpec 驱动自动生成
 */
export const REQUIRED_FIELDS_DESCRIPTION = getRequiredFieldsDescription();

// ═══════════════════════════════════════════════════════════
// 完成后提示文本
// ═══════════════════════════════════════════════════════════

/**
 * 内部 Agent 完成后的 nextSteps 提示
 *
 * @param {Array} dimensions 激活的维度列表
 * @returns {string[]}
 */
export function buildInternalNextSteps(
  dimensions: ReadonlyArray<{ id: string; skillWorthy?: boolean }>
) {
  return [
    `✅ Bootstrap 骨架已创建，${dimensions.length} 个维度的 AI 分析任务已在后台启动。`,
    '',
    '== 后台自动执行中 ==',
    '后台 AI pipeline 正在逐维度分析代码并创建候选（Analyst → Producer 双 Agent 模式）。',
    '进度通过 Dashboard 实时展示，无需手动操作。',
    '',
    '== 完成后可执行的后续操作 ==',
    '1. 调用 autosnippet_enrich_candidates(candidateIds) 补全候选缺失字段',
    '2. 使用 autosnippet_submit_knowledge_batch 手动提交更多知识条目',
    '3. 使用 autosnippet_submit_knowledge 逐条提交高质量知识',
    '4. 使用 autosnippet_skill({ operation: "load", name }) 加载自动生成的 Project Skills',
    '',
    '== 宏观维度 → Project Skills ==',
    `宏观维度（${dimensions
      .filter((d) => d.skillWorthy)
      .map((d) => d.id)
      .join('/')}）`,
    '自动生成 Project Skill 到 AutoSnippet/skills/，可通过 autosnippet_skill({ operation: "load" }) 加载。',
  ];
}

/**
 * Bootstrap 全部维度完成后的 nextActions（供外部 Agent 使用）
 */
export const BOOTSTRAP_COMPLETE_ACTIONS = [
  {
    action: 'cursor_delivery',
    prompt:
      '知识库初始化完成！Cursor Rules 已自动生成到 .cursor/rules/ 目录。如果生成失败，你可以手动触发 Cursor Delivery。',
    tool: 'autosnippet_cursor_delivery',
    auto: true, // R4: 已自动触发，此条仅为通知
  },
  {
    action: 'wiki_generate',
    prompt:
      '知识库初始化完成！是否继续生成项目 Wiki 文档？Wiki 将基于刚建立的知识库和项目分析数据自动生成结构化文档。',
    tool: 'autosnippet_wiki_plan',
  },
];
