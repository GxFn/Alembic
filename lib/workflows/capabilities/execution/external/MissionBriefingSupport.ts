/**
 * MissionBriefingSupport — Mission Briefing 配置、文本模板与辅助构建器
 *
 * 包含 Briefing 构建过程中的配置档案、维度文本常量、
 * 响应压缩策略、执行指令构建和 Rescan 证据投影。
 * 由 MissionBriefingBuilder 统一调用。
 */

import { sopToCompactText } from '#domain/dimension/DimensionSop.js';
import {
  getRequiredFieldNames,
  getRequiredFieldsDescription,
} from '#domain/knowledge/FieldSpec.js';
import type { DimensionDef } from '#types/project-snapshot.js';
import { TierScheduler } from '#workflows/capabilities/planning/dimensions/TierScheduler.js';
import type { ExternalRescanEvidencePlan } from '#workflows/capabilities/planning/knowledge/KnowledgeRescanPlanner.js';

// ═══════════════════════════════════════════════════════════
// §1 — MissionBriefingProfiles
// ═══════════════════════════════════════════════════════════

export type BriefingProfile = 'cold-start-external' | 'rescan-external';

export interface ResponseBudget {
  limitBytes: number;
}

export interface RescanBriefingPrescreen {
  needsVerification: unknown[];
  autoResolved: unknown[];
  dimensionGaps: unknown;
}

export interface RescanBriefingInput {
  evidencePlan: ExternalRescanEvidencePlan;
  prescreen: RescanBriefingPrescreen;
}

export interface BriefingProfileInput {
  profile?: BriefingProfile;
  rescan?: RescanBriefingInput;
  responseBudget?: Partial<ResponseBudget>;
}

export interface BriefingPlan {
  profile: BriefingProfile;
  rescan?: RescanBriefingInput;
  responseBudget: ResponseBudget;
}

export const DEFAULT_BRIEFING_PROFILE: BriefingProfile = 'cold-start-external';
export const DEFAULT_RESPONSE_BUDGET: ResponseBudget = { limitBytes: 100 * 1024 };

export function createBriefingPlan(input: BriefingProfileInput = {}): BriefingPlan {
  const profile = input.profile ?? (input.rescan ? 'rescan-external' : DEFAULT_BRIEFING_PROFILE);

  if (profile === 'rescan-external' && !input.rescan) {
    throw new Error('[MissionBriefing] rescan-external profile requires rescan evidence input');
  }
  if (profile === 'cold-start-external' && input.rescan) {
    throw new Error('[MissionBriefing] cold-start-external profile cannot accept rescan evidence');
  }

  return {
    profile,
    rescan: input.rescan,
    responseBudget: {
      limitBytes: input.responseBudget?.limitBytes ?? DEFAULT_RESPONSE_BUDGET.limitBytes,
    },
  };
}

// ═══════════════════════════════════════════════════════════
// §2 — BootstrapDimensionText
// ═══════════════════════════════════════════════════════════

/** 知识提交的完整 Schema — 定义必填字段、内容结构、枚举值和质量门控 */
export const SUBMISSION_SCHEMA = {
  tool: 'alembic_submit_knowledge',
  batchTool: 'alembic_submit_knowledge_batch',
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
    '标题使用项目真实类名（不以项目名开头）',
    'trigger 必须唯一（同批次内不重复）',
  ],
};

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

export const REQUIRED_FIELDS_DESCRIPTION = getRequiredFieldsDescription();

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
    '1. 调用 alembic_enrich_candidates(candidateIds) 补全候选缺失字段',
    '2. 使用 alembic_submit_knowledge_batch 手动提交更多知识条目',
    '3. 使用 alembic_submit_knowledge 逐条提交高质量知识',
    '4. 使用 alembic_skill({ operation: "load", name }) 加载自动生成的 Project Skills',
    '',
    '== 宏观维度 → Project Skills ==',
    `宏观维度（${dimensions
      .filter((d) => d.skillWorthy)
      .map((d) => d.id)
      .join('/')}）`,
    '自动生成 Project Skill 到 Alembic/skills/，可通过 alembic_skill({ operation: "load" }) 加载。',
  ];
}

/** Bootstrap 全部维度完成后的 nextActions（供外部 Agent 使用） */
export const BOOTSTRAP_COMPLETE_ACTIONS = [
  {
    action: 'cursor_delivery',
    prompt:
      '知识库初始化完成！Cursor Rules 已自动生成到 .cursor/rules/ 目录。如果生成失败，你可以手动触发 Cursor Delivery。',
    tool: 'alembic_cursor_delivery',
    auto: true,
  },
  {
    action: 'wiki_generate',
    prompt:
      '知识库初始化完成！是否继续生成项目 Wiki 文档？Wiki 将基于刚建立的知识库和项目分析数据自动生成结构化文档。',
    tool: 'alembic_wiki_plan',
  },
];

// ═══════════════════════════════════════════════════════════
// §3 — BriefingCompressionPolicy
// ═══════════════════════════════════════════════════════════

interface CompressibleAstClass {
  file?: string | null;
  protocols?: string[];
}

interface CompressibleAstProtocol {
  name?: string;
  methodCount?: number;
  file?: string | null;
  conformers?: string[];
}

interface CompressibleDimensionTask {
  evidenceStarters?: unknown;
  analysisGuide?: unknown;
  submissionSpec?: {
    preSubmitChecklist?: Record<string, unknown>;
    [key: string]: unknown;
  };
}

export interface CompressibleBriefing {
  ast: {
    compressionLevel?: string;
    classes: CompressibleAstClass[];
    protocols: CompressibleAstProtocol[];
    categories?: unknown[];
    metrics?: {
      complexMethods?: unknown;
      longMethods?: unknown;
      [key: string]: unknown;
    } | null;
  };
  dependencyGraph?: { edges: unknown[] } | null;
  dimensions: CompressibleDimensionTask[];
  technologyStack?: unknown;
  meta?: {
    responseSizeKB?: number;
    compressionLevel?: string;
    warnings?: string[];
    [key: string]: unknown;
  };
}

export function applyBriefingCompressionPolicy<T extends CompressibleBriefing>(
  briefing: T,
  responseBudget: ResponseBudget
): T {
  const originalJson = JSON.stringify(briefing);
  const originalSizeKB = Math.round(originalJson.length / 1024);
  briefing.meta = {
    ...briefing.meta,
    responseSizeKB: originalSizeKB,
    compressionLevel: briefing.ast.compressionLevel || 'none',
  };

  if (originalJson.length <= responseBudget.limitBytes) {
    return briefing;
  }

  const dependencyGraph = briefing.dependencyGraph;
  if (dependencyGraph && dependencyGraph.edges.length > 30) {
    dependencyGraph.edges = dependencyGraph.edges.slice(0, 30);
  }
  if (briefing.ast.classes.length > 20) {
    briefing.ast.classes = briefing.ast.classes.slice(0, 20);
  }
  if (briefing.ast.protocols.length > 10) {
    briefing.ast.protocols = briefing.ast.protocols.slice(0, 10).map((protocol) => ({
      name: protocol.name,
      methodCount: protocol.methodCount,
    }));
  }

  for (const cls of briefing.ast.classes) {
    if ((cls.protocols?.length ?? 0) > 3) {
      cls.protocols = cls.protocols?.slice(0, 3);
    }
    delete cls.file;
  }
  for (const protocol of briefing.ast.protocols) {
    if ((protocol.conformers?.length ?? 0) > 3) {
      protocol.conformers = protocol.conformers?.slice(0, 3);
    }
    delete protocol.file;
  }
  if ((briefing.ast.categories?.length ?? 0) > 5) {
    briefing.ast.categories = briefing.ast.categories?.slice(0, 5);
  }
  if (briefing.ast.metrics?.complexMethods) {
    delete briefing.ast.metrics.complexMethods;
  }
  if (briefing.ast.metrics?.longMethods) {
    delete briefing.ast.metrics.longMethods;
  }

  const midSize = JSON.stringify(briefing).length;
  if (midSize <= responseBudget.limitBytes) {
    briefing.meta.responseSizeKB = Math.round(midSize / 1024);
    briefing.meta.compressionLevel = 'moderate';
  } else {
    for (const dimension of briefing.dimensions) {
      delete dimension.evidenceStarters;
    }
    briefing.technologyStack = null;
    for (const dimension of briefing.dimensions) {
      if (isRecord(dimension.analysisGuide)) {
        dimension.analysisGuide = sopToCompactText(dimension.analysisGuide);
      }
      if (dimension.submissionSpec?.preSubmitChecklist?.FAIL_EXAMPLES) {
        delete dimension.submissionSpec.preSubmitChecklist.FAIL_EXAMPLES;
      }
    }
    const newSize = JSON.stringify(briefing).length;
    briefing.meta.responseSizeKB = Math.round(newSize / 1024);
    briefing.meta.compressionLevel = 'aggressive';
  }

  briefing.meta.warnings = briefing.meta.warnings || [];
  briefing.meta.warnings.push(
    `Response compressed from ${originalSizeKB}KB to ${briefing.meta.responseSizeKB}KB`
  );

  return briefing;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// ═══════════════════════════════════════════════════════════
// §4 — ExecutionInstructionBuilder
// ═══════════════════════════════════════════════════════════

export interface ExecutionPlanTier {
  tier: number;
  label: string;
  dimensions: string[];
  note: string;
}

export interface ExecutionInstructions {
  tiers: ExecutionPlanTier[];
  totalDimensions: number;
  workflow: string;
}

export function buildExecutionInstructions({
  activeDimensions,
  profile,
  rescan,
}: {
  activeDimensions: DimensionDef[];
  profile: BriefingProfile;
  rescan?: RescanBriefingInput;
}): ExecutionInstructions {
  return {
    tiers: buildExecutionTiers(activeDimensions),
    totalDimensions: activeDimensions.length,
    workflow: buildWorkflowInstruction({ profile, rescan }),
  };
}

function buildExecutionTiers(activeDimensions: DimensionDef[]): ExecutionPlanTier[] {
  const scheduler = new TierScheduler();
  const tiers = scheduler.getTiers();
  const activeDimIds = new Set(activeDimensions.map((dimension) => dimension.id));

  const tierLabels = [
    '基础数据层',
    '规范 + 设计 + 网络',
    '核心质量',
    '领域专项',
    '终端优化 + 总结',
  ];
  const tierNotes = [
    '这些维度相互独立，可以任意顺序分析。产出的上下文将帮助后续维度。',
    '建议利用 Tier 1 中了解到的项目结构和代码特征。',
    '利用前两层建立的架构和规范上下文深入分析。',
    '各维度相对独立，可充分利用并行能力。',
    'agent-guidelines 应综合前序所有维度的发现。',
  ];

  const plan = tiers
    .map((tierDimIds, index) => {
      const filteredDims = tierDimIds.filter((id) => activeDimIds.has(id));
      if (filteredDims.length === 0) {
        return null;
      }
      return {
        tier: index + 1,
        label: tierLabels[index] || `Tier ${index + 1}`,
        dimensions: filteredDims,
        note: tierNotes[index] || '',
      };
    })
    .filter((tier): tier is ExecutionPlanTier => tier !== null);

  const scheduledIds = new Set(tiers.flat());
  const unscheduled = activeDimensions.filter((dimension) => !scheduledIds.has(dimension.id));
  if (unscheduled.length > 0 && plan.length > 0) {
    for (const dimension of unscheduled) {
      const hint = typeof dimension.tierHint === 'number' ? dimension.tierHint : 1;
      const targetIdx = Math.max(0, Math.min(hint - 1, plan.length - 1));
      plan[targetIdx]?.dimensions.push(dimension.id);
    }
  }

  return plan;
}

function buildWorkflowInstruction({
  profile,
  rescan,
}: {
  profile: BriefingProfile;
  rescan?: RescanBriefingInput;
}): string {
  if (profile === 'rescan-external') {
    const needsVerification = rescan?.prescreen.needsVerification.length ?? 0;
    const autoResolved = rescan?.prescreen.autoResolved.length ?? 0;
    return (
      '【增量扫描模式 — 进化前置 + 按维度 Gap-Fill】 ' +
      'Step 0 — 自动前置过滤 (已完成): ' +
      `healthy 无修改的 Recipe 已自动 skip (${autoResolved} 条)，` +
      `仅 ${needsVerification} 条需要验证。 ` +
      '对每个维度 (按 tiers 顺序): ' +
      'Step 1 — Evolve (仅 needsVerification 中的 Recipe): ' +
      '读 sourceRefs 源码验证 → 调用 alembic_evolve({ decisions: [本维度决策] }) → ' +
      'Step 2 — Gap-Fill: ' +
      '分析代码发现新模式 → 调用 alembic_submit_knowledge 提交 (数量参考 gap 值) → ' +
      'Step 3 — Complete: 调用 alembic_dimension_complete 完成维度'
    );
  }

  return '对每个维度: (1) 用你的原生能力阅读代码分析 → (2) 调用 alembic_submit_knowledge_batch 批量提交候选（**每维度最少 3 条，目标 5 条**，将不同关注点拆分为独立候选，1-2 条视为不合格） → (3) 调用 alembic_dimension_complete 完成维度（必须传 referencedFiles=[分析过的文件路径] 和 keyFindings=[3-5条关键发现]）';
}

// ═══════════════════════════════════════════════════════════
// §5 — RescanEvidenceProjector
// ═══════════════════════════════════════════════════════════

export interface RescanEvidenceHints {
  allRecipes: ExternalRescanEvidencePlan['allRecipes'];
  rescanMode: true;
  dimensionGaps: ExternalRescanEvidencePlan['dimensionGaps'];
  executionReasons: ExternalRescanEvidencePlan['executionReasons'];
  evolutionPrescreen: {
    needsVerification: unknown[];
    autoResolved: unknown[];
    dimensionGapsByPrescreen: unknown;
  };
  evolutionGuide: {
    decayCount: number;
    totalCount: number;
    instructions: string;
  };
  constraints: {
    occupiedTriggers: string[];
    rules: string[];
  };
}

export function projectRescanEvidenceHints({
  evidencePlan,
  prescreen,
}: RescanBriefingInput): RescanEvidenceHints {
  return {
    allRecipes: evidencePlan.allRecipes,
    rescanMode: true,
    dimensionGaps: evidencePlan.dimensionGaps,
    executionReasons: evidencePlan.executionReasons,
    evolutionPrescreen: {
      needsVerification: prescreen.needsVerification,
      autoResolved: prescreen.autoResolved,
      dimensionGapsByPrescreen: prescreen.dimensionGaps,
    },
    evolutionGuide: {
      decayCount: evidencePlan.decayCount,
      totalCount: evidencePlan.allRecipes.length,
      instructions:
        evidencePlan.decayCount > 0
          ? `${evidencePlan.decayCount} 个 Recipe 标记为衰退，需优先验证。每个维度内先 evolve 再补齐。`
          : '所有 Recipe 状态健康，快速确认后补齐新知识。',
    },
    constraints: {
      occupiedTriggers: evidencePlan.occupiedTriggers,
      rules: [
        '禁止提交 occupiedTriggers 列表中已存在的 trigger',
        '每个维度的补齐数量参考 dimensionGaps[].gap，gap=0 的维度可以跳过或只提交真正的新发现',
        '专注于尚未覆盖的新模式，不要重复已有知识的内容',
      ],
    },
  };
}
