/**
 * mock-pipeline.ts — Mock AI Bootstrap 轻量管线
 *
 * 当 AI Provider 为 mock 时，利用 Phase 1-4 已收集的真实数据
 * (AST、依赖图、文件列表、Panorama) 为每个维度生成模板化候选知识。
 *
 * 不调用 AI，但走完完整的 submit → dimension_complete 流程，
 * 使 Dashboard 能正常展示知识库、健康雷达等 UI。
 *
 * @module pipeline/mock-pipeline
 */

import path from 'node:path';
import type { McpContext } from '#external/mcp/handlers/types.js';
import Logger from '#infra/logging/Logger.js';
import { BootstrapEventEmitter } from '#service/bootstrap/BootstrapEventEmitter.js';
import type { DimensionDef } from '#types/project-snapshot.js';
import type { PipelineFillView } from '#types/snapshot-views.js';

const logger = Logger.getInstance();

// ── 类型定义 ──────────────────────────────────────────────

interface BootstrapFileEntry {
  name: string;
  path: string;
  relativePath: string;
  content: string;
  targetName?: string;
}

interface MockCandidate {
  title: string;
  description: string;
  trigger: string;
  kind: 'rule' | 'pattern' | 'fact';
  language: string;
  category: string;
  knowledgeType: string;
  topicHint: string;
  content: { markdown: string; rationale: string };
  coreCode: string;
  headers: string[];
  doClause: string;
  dontClause: string;
  whenClause: string;
  reasoning: { whyStandard: string; sources: string[]; confidence: number };
  sourceRefs: string[];
  usageGuide: string;
  tags: string[];
}

// ── 模板生成器 ────────────────────────────────────────────

/** 从 AST 指标提取代码统计 */
function extractAstStats(ast: Record<string, unknown> | null): {
  classes: number;
  protocols: number;
  functions: number;
} {
  if (!ast) {
    return { classes: 0, protocols: 0, functions: 0 };
  }
  const pm = (ast.projectMetrics ?? ast) as Record<string, unknown>;
  return {
    classes: (pm.totalClasses as number) ?? 0,
    protocols: (pm.totalProtocols as number) ?? 0,
    functions: (pm.totalFunctions as number) ?? 0,
  };
}

/** 从文件列表中按 target 分组并提取代表性文件 */
function getRepresentativeFiles(
  files: BootstrapFileEntry[] | null,
  targetFileMap: Record<string, string[]> | null
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  if (targetFileMap) {
    for (const [target, paths] of Object.entries(targetFileMap)) {
      result.set(target, paths.slice(0, 5));
    }
  } else if (files) {
    const grouped = new Map<string, string[]>();
    for (const f of files) {
      const target = f.targetName || 'default';
      const list = grouped.get(target) || [];
      list.push(f.relativePath || f.name);
      grouped.set(target, list);
    }
    for (const [target, paths] of grouped) {
      result.set(target, paths.slice(0, 5));
    }
  }
  return result;
}

/** 从文件内容中提取 import 语句（作为 headers）*/
function extractImports(content: string, lang: string): string[] {
  const imports: string[] = [];
  const lines = content.split('\n').slice(0, 30);
  for (const line of lines) {
    const trimmed = line.trim();
    if (lang === 'swift' && trimmed.startsWith('import ')) {
      imports.push(trimmed);
    } else if ((lang === 'typescript' || lang === 'javascript') && trimmed.startsWith('import ')) {
      imports.push(trimmed);
    }
  }
  return [...new Set(imports)].slice(0, 5);
}

/** 从文件内容中提取类/结构体/协议名 */
function extractTypes(content: string): string[] {
  const types: string[] = [];
  for (const m of content.matchAll(/(?:class|struct|protocol|enum|interface|type)\s+(\w+)/g)) {
    types.push(m[1]);
  }
  return [...new Set(types)].slice(0, 10);
}

/** 生成 kebab-case trigger */
function toKebab(text: string): string {
  return text
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 40);
}

// ── 维度级候选生成 ────────────────────────────────────────

/** 为单个维度生成 Mock 候选 */
function generateDimensionCandidates(
  dimId: string,
  dimLabel: string,
  files: BootstrapFileEntry[] | null,
  lang: string,
  projectName: string,
  astStats: { classes: number; protocols: number; functions: number },
  targetFiles: Map<string, string[]>
): MockCandidate[] {
  const candidates: MockCandidate[] = [];

  // 从文件中收集有代表性的类型和源文件
  const allTypes: string[] = [];
  const allSources: string[] = [];
  const allImports: string[] = [];

  const dimFiles =
    files?.filter((f) => {
      const p = f.relativePath?.toLowerCase() || f.name.toLowerCase();
      // 根据维度 ID 做简单相关性匹配
      switch (dimId) {
        case 'architecture':
          return (
            p.includes('coordinator') ||
            p.includes('delegate') ||
            p.includes('service') ||
            p.includes('manager')
          );
        case 'code-pattern':
          return p.includes('extension') || p.includes('helper') || p.includes('util');
        case 'naming-style':
          return true; // 全局适用
        case 'error-handling':
          return p.includes('error') || p.includes('result') || p.includes('handler');
        case 'networking':
          return (
            p.includes('network') ||
            p.includes('api') ||
            p.includes('request') ||
            p.includes('http')
          );
        case 'data-model':
          return p.includes('model') || p.includes('entity') || p.includes('dto');
        case 'testing-quality':
          return p.includes('test') || p.includes('spec') || p.includes('mock');
        case 'ui-patterns':
          return (
            p.includes('view') ||
            p.includes('controller') ||
            p.includes('cell') ||
            p.includes('component')
          );
        case 'concurrency':
          return (
            p.includes('actor') ||
            p.includes('async') ||
            p.includes('queue') ||
            p.includes('dispatch')
          );
        case 'storage':
          return (
            p.includes('store') ||
            p.includes('cache') ||
            p.includes('database') ||
            p.includes('persist')
          );
        default:
          return true;
      }
    }) || [];

  // 提取文件中的类型和导入
  for (const f of dimFiles.slice(0, 10)) {
    allTypes.push(...extractTypes(f.content || ''));
    allSources.push(f.relativePath || f.name);
    allImports.push(...extractImports(f.content || '', lang));
  }

  // 如果没找到相关文件，用全部文件兜底
  if (allTypes.length === 0 && files) {
    for (const f of files.slice(0, 5)) {
      allTypes.push(...extractTypes(f.content || ''));
      allSources.push(f.relativePath || f.name);
    }
  }

  const uniqueTypes = [...new Set(allTypes)].slice(0, 8);
  const uniqueSources = [...new Set(allSources)].slice(0, 5);
  const uniqueImports = [...new Set(allImports)].slice(0, 5);

  // 为每个维度生成 3 个候选
  const templates = getDimensionTemplates(
    dimId,
    dimLabel,
    uniqueTypes,
    uniqueSources,
    lang,
    projectName,
    astStats
  );

  for (const tpl of templates.slice(0, 3)) {
    candidates.push({
      ...tpl,
      headers: uniqueImports,
      sourceRefs: uniqueSources.slice(0, 3),
      reasoning: {
        whyStandard: `基于 ${projectName} 项目 ${dimFiles.length} 个相关文件的代码分析（Mock 模式自动生成）`,
        sources: uniqueSources.slice(0, 3),
        confidence: 0.7,
      },
      tags: ['mock-generated', dimId, lang],
    });
  }

  return candidates;
}

/** 根据维度 ID 返回候选模板 */
function getDimensionTemplates(
  dimId: string,
  dimLabel: string,
  types: string[],
  sources: string[],
  lang: string,
  projectName: string,
  ast: { classes: number; protocols: number; functions: number }
): Omit<MockCandidate, 'headers' | 'sourceRefs' | 'reasoning' | 'tags'>[] {
  const typeList = types.length > 0 ? types.slice(0, 3).join('、') : '核心模块';
  const typeFirst = types[0] || 'AppModule';
  const srcFirst = sources[0] || 'Sources/Main.swift';

  const base = {
    language: lang,
    knowledgeType: dimId,
  };

  switch (dimId) {
    case 'architecture':
      return [
        {
          ...base,
          title: `${projectName} 分层架构模式`,
          description: `项目采用分层架构，包含 ${ast.classes} 个类、${ast.protocols} 个协议`,
          trigger: `@${toKebab(projectName)}-layered-arch`,
          kind: 'pattern',
          category: 'Architecture',
          topicHint: 'architecture',
          content: {
            markdown: `### ${projectName} 分层架构\n\n项目基于分层架构设计，核心类型包括 ${typeList}。\n\n**层次结构**:\n- 表现层: View/Controller\n- 业务层: Service/Manager\n- 数据层: Repository/Store\n\n**来源**: \`${srcFirst}\`\n\n> ⚠️ 此条目由 Mock AI 基于代码结构自动生成`,
            rationale: `分层架构是 ${projectName} 的核心设计决策，确保模块间关注点分离`,
          },
          coreCode: `// ${lang === 'swift' ? 'protocol' : 'interface'} ${typeFirst}Service { ... }`,
          doClause: `Follow the layered architecture with ${typeFirst} as the core service boundary`,
          dontClause: 'Do not bypass service layer to access data layer directly',
          whenClause: 'When adding new features or modules to the project',
          usageGuide: `### 使用指南\n\n遵循 ${projectName} 的分层架构进行模块设计。`,
        },
        {
          ...base,
          title: `${typeFirst} 依赖注入约定`,
          description: `${typeFirst} 等核心类型通过依赖注入管理生命周期`,
          trigger: `@${toKebab(typeFirst)}-di-pattern`,
          kind: 'pattern',
          category: 'Architecture',
          topicHint: 'architecture',
          content: {
            markdown: `### 依赖注入约定\n\n${projectName} 使用依赖注入管理 ${typeList} 等组件的生命周期。\n\n**来源**: \`${srcFirst}\`\n\n> ⚠️ Mock AI 自动生成`,
            rationale: '依赖注入提高可测试性和模块解耦',
          },
          coreCode: `${lang === 'swift' ? `class ${typeFirst} {\n  init(service: Service) { }\n}` : `class ${typeFirst} {\n  constructor(private service: Service) {}\n}`}`,
          doClause: `Use constructor injection for ${typeFirst} dependencies`,
          dontClause: 'Do not use service locator or global singletons',
          whenClause: `When creating or modifying ${typeFirst} and its dependencies`,
          usageGuide: `### 使用指南\n\n通过构造器注入依赖项。`,
        },
        {
          ...base,
          title: `${projectName} 模块通信约定`,
          description: `模块间通过协议/接口进行通信，避免直接耦合`,
          trigger: `@${toKebab(projectName)}-module-comm`,
          kind: 'rule',
          category: 'Architecture',
          topicHint: 'architecture',
          content: {
            markdown: `### 模块通信\n\n${projectName} 的模块通信遵循接口隔离原则，${ast.protocols} 个协议定义了清晰的边界。\n\n> ⚠️ Mock AI 自动生成`,
            rationale: '接口隔离确保模块可独立演进和测试',
          },
          coreCode: `${lang === 'swift' ? `protocol ${typeFirst}Protocol {\n  func execute() async\n}` : `interface I${typeFirst} {\n  execute(): Promise<void>\n}`}`,
          doClause: 'Define protocols/interfaces for all cross-module communication',
          dontClause: 'Do not import concrete implementations across module boundaries',
          whenClause: 'When modules need to communicate or share data',
          usageGuide: `### 使用指南\n\n定义协议作为模块间通信契约。`,
        },
      ];

    case 'code-pattern':
      return [
        {
          ...base,
          title: `${typeFirst} 扩展方法约定`,
          description: `使用扩展方法为 ${typeFirst} 添加功能，保持核心类型精简`,
          trigger: `@${toKebab(typeFirst)}-extension-pattern`,
          kind: 'pattern',
          category: 'Tool',
          topicHint: 'conventions',
          content: {
            markdown: `### 扩展方法约定\n\n${projectName} 广泛使用扩展方法组织代码，${typeList} 等类型均采用此模式。\n\n**来源**: \`${srcFirst}\`\n\n> ⚠️ Mock AI 自动生成`,
            rationale: '扩展方法使核心类型保持精简，增强可读性',
          },
          coreCode: `${lang === 'swift' ? `extension ${typeFirst} {\n  func helper() { }\n}` : `// ${typeFirst}.extensions.ts`}`,
          doClause: `Group related functionality in ${lang === 'swift' ? 'extensions' : 'utility modules'}`,
          dontClause: 'Do not bloat core types with unrelated methods',
          whenClause: `When adding utility or convenience methods to ${typeFirst}`,
          usageGuide: `### 使用指南\n\n按功能分组创建扩展文件。`,
        },
        {
          ...base,
          title: `${projectName} 类型安全惯例`,
          description: `项目统一使用强类型和类型守卫确保安全`,
          trigger: `@${toKebab(projectName)}-type-safety`,
          kind: 'rule',
          category: 'Tool',
          topicHint: 'conventions',
          content: {
            markdown: `### 类型安全\n\n${projectName} 强制类型安全，包含 ${ast.classes} 个类和 ${ast.protocols} 个协议定义。\n\n> ⚠️ Mock AI 自动生成`,
            rationale: '类型安全减少运行时错误',
          },
          coreCode: `${lang === 'swift' ? 'guard let value = optional else { return }' : 'if (value === undefined) { return; }'}`,
          doClause: 'Use type guards and optional binding for safe access',
          dontClause: 'Do not use force unwrapping or type casting without checks',
          whenClause: 'When handling optional values or type conversions',
          usageGuide: `### 使用指南\n\n始终使用安全的类型转换。`,
        },
        {
          ...base,
          title: `${projectName} 命名约定`,
          description: `文件和类型命名遵循一致的约定`,
          trigger: `@${toKebab(projectName)}-naming-conventions`,
          kind: 'rule',
          category: 'Tool',
          topicHint: 'conventions',
          content: {
            markdown: `### 命名约定\n\n${projectName} 使用一致的命名风格。类型: PascalCase, 方法/属性: camelCase。\n\n> ⚠️ Mock AI 自动生成`,
            rationale: '统一命名提高代码可读性',
          },
          coreCode: `// ${typeFirst}.swift / ${typeFirst}.ts`,
          doClause: 'Follow PascalCase for types and camelCase for members',
          dontClause: 'Do not use abbreviations or inconsistent casing',
          whenClause: 'When naming new types, methods, or properties',
          usageGuide: `### 使用指南\n\n遵循项目既有命名风格。`,
        },
      ];

    default:
      return [
        {
          ...base,
          title: `${projectName} ${dimLabel}实践`,
          description: `${dimLabel}维度的最佳实践，基于 ${typeList} 等代码分析`,
          trigger: `@${toKebab(projectName)}-${toKebab(dimLabel)}-practice`,
          kind: 'pattern',
          category: 'Tool',
          topicHint: dimId.includes('network')
            ? 'networking'
            : dimId.includes('ui')
              ? 'ui'
              : 'conventions',
          content: {
            markdown: `### ${dimLabel}\n\n${projectName} 在 ${dimLabel} 方面的实践，涉及 ${typeList} 等核心类型。\n\n**文件统计**: ${ast.classes} 类, ${ast.protocols} 协议, ${ast.functions} 函数\n\n**来源**: \`${srcFirst}\`\n\n> ⚠️ Mock AI 自动生成`,
            rationale: `${dimLabel}是项目质量的重要维度`,
          },
          coreCode: `// See ${srcFirst}`,
          doClause: `Follow established ${dimLabel} patterns in the project`,
          dontClause: `Do not deviate from the project's ${dimLabel} conventions`,
          whenClause: `When working on ${dimLabel}-related code`,
          usageGuide: `### 使用指南\n\n遵循项目的 ${dimLabel} 约定。`,
        },
        {
          ...base,
          title: `${typeFirst} ${dimLabel}约定`,
          description: `${typeFirst} 相关的 ${dimLabel} 约定`,
          trigger: `@${toKebab(typeFirst)}-${toKebab(dimLabel)}`,
          kind: 'rule',
          category: 'Tool',
          topicHint: dimId.includes('network') ? 'networking' : 'conventions',
          content: {
            markdown: `### ${typeFirst} ${dimLabel}\n\n${typeFirst} 遵循的 ${dimLabel} 约定。\n\n> ⚠️ Mock AI 自动生成`,
            rationale: `基于 ${typeFirst} 的实际代码模式`,
          },
          coreCode: `// ${typeFirst} — ${dimLabel}`,
          doClause: `Apply ${dimLabel} patterns consistent with ${typeFirst}`,
          dontClause: `Do not introduce inconsistent ${dimLabel} approaches`,
          whenClause: `When modifying ${typeFirst} or related components`,
          usageGuide: `### 使用指南\n\n参考 ${typeFirst} 的既有实现。`,
        },
        {
          ...base,
          title: `${projectName} ${dimLabel}检查清单`,
          description: `${dimLabel}方面的代码审查清单`,
          trigger: `@${toKebab(projectName)}-${toKebab(dimLabel)}-checklist`,
          kind: 'fact',
          category: 'Tool',
          topicHint: 'conventions',
          content: {
            markdown: `### ${dimLabel} 检查清单\n\n1. 遵循项目既有模式\n2. 确保类型安全\n3. 添加适当的错误处理\n4. 保持代码一致性\n\n> ⚠️ Mock AI 自动生成`,
            rationale: `${dimLabel}检查清单帮助保持代码质量`,
          },
          coreCode: `// ${dimLabel} checklist applied`,
          doClause: `Review code against the ${dimLabel} checklist before committing`,
          dontClause: `Do not skip ${dimLabel} review for shortcuts`,
          whenClause: `During code review for ${dimLabel}-related changes`,
          usageGuide: `### 使用指南\n\n在代码审查时参考此清单。`,
        },
      ];
  }
}

// ── Mock Pipeline 入口 ────────────────────────────────────────

/**
 * fillDimensionsMock — Mock AI 轻量管线
 *
 * 利用 Phase 1-4 的真实数据（AST、文件列表、Panorama）自动生成候选知识，
 * 不调用任何 AI API，但走完 submit → dimension_complete 的完整流程。
 */
export async function fillDimensionsMock(
  view: PipelineFillView,
  dimensions: DimensionDef[]
): Promise<void> {
  const { snapshot, projectRoot } = view;
  const ctx = view.ctx as McpContext;
  const emitter = new BootstrapEventEmitter(ctx.container);

  const projectName = path.basename(projectRoot);
  const primaryLang = snapshot.language.primaryLang ?? 'unknown';
  const astStats = extractAstStats(snapshot.ast as Record<string, unknown> | null);
  const allFiles = snapshot.allFiles as unknown as BootstrapFileEntry[] | null;
  const targetFileMap = view.targetFileMap as Record<string, string[]> | null;
  const repFiles = getRepresentativeFiles(allFiles, targetFileMap);

  logger.info(
    `[MockPipeline] ═══ Starting Mock bootstrap — ${dimensions.length} dimensions, ` +
      `${allFiles?.length || 0} files, lang=${primaryLang}`
  );

  emitter.emitProgress('bootstrap:mock-mode', {
    message: '🧪 Mock AI 模式 — 基于代码结构自动生成知识候选（非 AI 深度分析）',
    mockMode: true,
  });

  let totalGenerated = 0;

  for (const dim of dimensions) {
    const dimStartTime = Date.now();

    const dimLabel = dim.label ?? dim.id;

    emitter.emitProgress('bootstrap:dimension-start', {
      dimensionId: dim.id,
      dimensionLabel: dimLabel,
      mockMode: true,
    });

    logger.info(`[MockPipeline] ── Dimension "${dim.id}" (${dimLabel}) ──`);

    // 生成候选（仅在内存中，不写入数据库）
    const candidates = generateDimensionCandidates(
      dim.id,
      dimLabel,
      allFiles,
      primaryLang,
      projectName,
      astStats,
      repFiles
    );

    totalGenerated += candidates.length;

    for (const candidate of candidates) {
      logger.info(`[MockPipeline] 📝 Generated (not persisted): "${candidate.title}"`);
    }

    const durationMs = Date.now() - dimStartTime;

    emitter.emitDimensionComplete(dim.id, {
      type: 'candidate',
      extracted: candidates.length,
      created: 0,
      status: 'mock-pipeline-complete',
      degraded: false,
      durationMs,
      toolCallCount: 0,
      source: 'mock-pipeline',
    });

    logger.info(
      `[MockPipeline] ✅ "${dim.id}": ${candidates.length} candidates generated (mock-only, not persisted), ${durationMs}ms`
    );
  }

  emitter.emitProgress('bootstrap:mock-complete', {
    message: `🧪 Mock Bootstrap 完成: ${totalGenerated} 个候选知识已生成（仅预览，未写入数据库）`,
    totalCreated: 0,
    totalGenerated,
    mockMode: true,
  });

  logger.info(
    `[MockPipeline] ═══ Mock bootstrap complete — ${totalGenerated} candidates generated (not persisted) from ${dimensions.length} dimensions`
  );
}
