/**
 * Mission Briefing 构建器 — 外部 Agent 驱动 Bootstrap 的核心数据构建
 *
 * 将 Phase 1-4 的分析结果（AST / EntityGraph / DepGraph / Guard）
 * + 维度定义 + 提交规范 + 执行计划 整合为一站式 Mission Briefing，
 * 让外部 Agent (Cursor/Copilot) 拥有全部必要上下文来完成代码分析。
 *
 * 设计原则：
 *   - 100KB 响应硬上限，大项目自动降级压缩
 *   - 文件内容永远不包含 → Agent 自己读更快
 *   - Example 按项目主语言自适应
 *   - Tier 编号使用 1/2/3（与 tier-scheduler.js 一致）
 *
 * @module bootstrap/MissionBriefingBuilder
 */

import { getDimensionSOP, PRE_SUBMIT_CHECKLIST } from '#domain/dimension/DimensionSop.js';
import { getCursorDeliverySpec } from '#domain/knowledge/FieldSpec.js';
import { PROJECT_SNAPSHOT_STYLE_GUIDE } from '#domain/knowledge/StyleGuide.js';
import type {
  AstCategoryInfo,
  AstProtocolInfo,
  AstSummary,
  CallGraphResult,
  CodeEntityGraphResult,
  DependencyGraph,
  DimensionDef,
  GuardAudit,
  GuardViolation,
  IncrementalPlan,
  LocalPackageModule,
} from '#types/project-snapshot.js';
import {
  EXAMPLE_TEMPLATES,
  SUBMISSION_SCHEMA,
} from '#workflows/capabilities/execution/external-agent/mission-briefing/BootstrapDimensionText.js';
import { applyBriefingCompressionPolicy } from '#workflows/capabilities/execution/external-agent/mission-briefing/BriefingCompressionPolicy.js';
import { buildEvidenceStarters } from '#workflows/capabilities/execution/external-agent/mission-briefing/EvidenceStarterBuilder.js';
import { buildExecutionInstructions } from '#workflows/capabilities/execution/external-agent/mission-briefing/ExecutionInstructionBuilder.js';
import {
  type BriefingProfile,
  createBriefingPlan,
  type RescanBriefingInput,
  type ResponseBudget,
} from '#workflows/capabilities/execution/external-agent/mission-briefing/MissionBriefingProfiles.js';
import { projectRescanEvidenceHints } from '#workflows/capabilities/execution/external-agent/mission-briefing/RescanEvidenceProjector.js';
import { TierScheduler } from '#workflows/capabilities/planning/dimensions/TierScheduler.js';

// ── 本地类型定义 ────────────────────────────────────────────

/** Guard rule 聚合条目 */
interface RuleMapEntry {
  ruleId: string;
  count: number;
  example: string | null;
}

/** 维度任务 (enrichDimensionTask 返回值) */
interface DimensionTask {
  id: string;
  label?: string;
  tier: number;
  outputType: string;
  status: string;
  analysisGuide: string | Record<string, unknown>;
  submissionSpec: { preSubmitChecklist?: Record<string, unknown>; [key: string]: unknown };
  skillMeta?: { name: string; description: string; format: string };
  evidenceStarters?: Record<string, { hint: string; data: unknown }>;
}

/** Target 信息 */
interface TargetInfo {
  name: string;
  type?: string;
  inferredRole?: string;
  fileCount?: number;
}

type PatternValue = number | string | boolean | Record<string, number | string | boolean>;

/** 压缩后的协议 */
interface CompressedProtocol {
  name: string;
  file?: string | null;
  methodCount: number;
  conformers?: string[];
}

/** 压缩后的 AST 类 */
interface CompressedAstClass {
  name: string;
  kind?: string;
  superclass?: string | null;
  file?: string | null;
  methodCount: number;
  protocols?: string[];
}

/** Mission Briefing 结构 */
interface MissionBriefing {
  projectMeta: Record<string, unknown>;
  ast: {
    available: boolean;
    compressionLevel?: string;
    summary?: string | { text: string; kindDistribution: Record<string, number>; insight: string };
    classes: CompressedAstClass[];
    protocols: CompressedProtocol[];
    categories?: { baseClass?: string; name: string; file?: string | null; methods: string[] }[];
    patterns?: Record<string, unknown>;
    metrics?: {
      totalMethods?: number;
      avgMethodsPerClass?: number;
      maxNestingDepth?: number;
      complexMethods?: number;
      longMethods?: number;
    } | null;
  };
  architectureOverview?: {
    style: string;
    layers: { name: string; modules: string[]; fileCount: number; role: string }[];
    externalDeps: { name: string; role: string }[];
    keyInsights: string[];
  } | null;
  technologyStack?: { name: string; role: string; usedBy: string[] }[] | null;
  keyAbstractions?:
    | {
        name: string;
        kind: string;
        module: string;
        significance: string;
        detail: string;
      }[]
    | null;
  codeEntityGraph: { totalEntities: number; totalEdges: number } | null;
  callGraph: { methodEntities: number; callEdges: number; durationMs: number } | null;
  dependencyGraph: {
    nodes: { id: string; label: string; fileCount?: number; dependentCount?: number }[];
    edges: unknown[];
  } | null;
  guardFindings: {
    totalViolations: number;
    errors: number;
    warnings: number;
    topViolations: RuleMapEntry[];
  } | null;
  targets: { name: string; type: string; inferredRole?: string; fileCount?: number }[];
  dimensions: DimensionTask[];
  languageExtension: unknown;
  submissionSchema: Record<string, unknown>;
  languageStats: Record<string, number> | null;
  executionPlan: { tiers: unknown[]; totalDimensions: number; workflow: string };
  panorama: {
    layers: Array<{ level: number; name: string; modules: string[] }>;
    couplingHotspots: Array<{ module: string; fanIn: number; fanOut: number }>;
    cyclicDependencies: Array<{ cycle: string[]; severity: string }>;
    knowledgeGaps: Array<{
      dimension: string;
      dimensionName: string;
      recipeCount: number;
      status: string;
      priority: string;
    }>;
  } | null;
  mustCoverModules: {
    totalLocalPackages: number;
    modules: {
      name: string;
      packageName: string;
      fileCount: number;
      inferredRole?: string;
      keyFiles: string[];
    }[];
    instruction: string;
  } | null;
  session: Record<string, unknown>;
  meta?: {
    responseSizeKB?: number;
    compressionLevel?: string;
    warnings?: string[];
    profile?: BriefingProfile;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** buildMissionBriefing 参数 */
interface MissionBriefingParams {
  projectMeta: Record<string, unknown>;
  astData?: AstSummary | null;
  codeEntityResult?: CodeEntityGraphResult | null;
  callGraphResult?: CallGraphResult | null;
  depGraphData?: DependencyGraph | null;
  guardAudit?: GuardAudit | null;
  targets?: (string | TargetInfo)[];
  activeDimensions: DimensionDef[];
  session: { toJSON(): Record<string, unknown> };
  languageExtension?: unknown;
  incrementalPlan?: IncrementalPlan | null;
  languageStats?: Record<string, number> | null;
  panoramaResult?: Record<string, unknown> | null;
  localPackageModules?: LocalPackageModule[];
  profile?: BriefingProfile;
  rescan?: RescanBriefingInput;
  responseBudget?: Partial<ResponseBudget>;
}

// ── 常量 ────────────────────────────────────────────────────

/** 分级压缩阈值 */
const SIZE_THRESHOLDS = {
  S: 100, // <100 files → 完整 AST
  M: 500, // 100-500 files → top-50 classes
  L: Infinity, // 500+ files → top-30 classes 摘要模式
};

// ── 维度指引构建 ────────────────────────────────────────────

/**
 * 将 base-dimensions 中的维度定义转换为 Mission Briefing 中的维度任务对象
 *
 * 取自 bootstrap-analyst.buildAnalystPrompt() + DIMENSION_CONFIGS_V3 + StyleGuide
 *
 * @param dim base-dimensions.js 中的维度定义
 * @param tier 维度所在 tier 编号 (1/2/3)
 * @returns Mission Briefing 维度任务对象
 */
function enrichDimensionTask(dim: DimensionDef, tier: number): DimensionTask {
  // ── analysisGuide: SOP 化 — 优先使用维度专属 SOP，否则回退通用指引 ──
  const sop = getDimensionSOP(dim.id);
  let analysisGuide: {
    goal: string;
    focus: string;
    steps: Array<Record<string, unknown>>;
    timeEstimate: string;
    commonMistakes: string[];
  };

  if (sop) {
    // SOP 结构化模式: steps + timeEstimate + commonMistakes
    analysisGuide = {
      goal: `分析项目的${dim.label}`,
      focus: dim.guide || '',
      steps: sop.steps,
      timeEstimate: sop.timeEstimate || '1-5 min',
      commonMistakes: sop.commonMistakes || [],
    };
  } else {
    // 无显式 SOP 的维度 (Enhancement Pack 等): 自动生成结构化 SOP
    // 保持 analysisGuide 为对象格式，确保 SOP 覆盖率
    analysisGuide = {
      goal: `分析项目的${dim.label}`,
      focus: dim.guide || '',
      steps: [
        {
          phase: '1. 全局扫描',
          action: `搜索项目中与 ${dim.label} 相关的核心文件和关键模式`,
          expectedOutput: '识别 3-5 个核心文件和主要模式',
          tools: ['grep_search 搜索关键词', '浏览核心目录结构'],
        },
        {
          phase: '2. 深度验证',
          action: `阅读 5+ 个核心文件，验证 ${dim.label} 的实现方式是否一致`,
          expectedOutput: '每个模式至少有 3 个文件证据，含具体行号',
          tools: ['read_file 逐个阅读核心文件'],
        },
        {
          phase: '3. 异常检测',
          action: '搜索不符合主流模式的例外，确认是否为历史遗留或特殊例外',
          expectedOutput: '识别例外模式及其原因',
        },
        {
          phase: '4. 提交',
          action:
            '按项目特写格式提交知识候选（**最少 3 条，目标 5 条**，将不同关注点拆为独立候选）',
          qualityChecklist: [
            '候选数量 ≥3（1-2 条是不合格的，不同关注点必须拆分为独立候选）',
            '每个 content ≥200 字符',
            '每个候选引用 ≥3 个文件路径',
            'coreCode 提供可复制的完整代码骨架',
          ],
        },
      ],
      timeEstimate: '1-5 min',
      commonMistakes: [
        '不要只扫描 1 个文件就提交 — 至少读 5+ 个文件验证模式一致性',
        'content 中必须有 (来源: Full/Path/FileName.ext:行号) 标注具体出处，必须是从项目根开始的完整相对路径',
        '【跨维度去重】每条候选必须属于当前维度的独有视角 — 禁止将同一知识点换个角度重复提交到多个维度来充数，宁可少提交也不要重复',
        '【本地子包覆盖】如果项目有本地子包/模块（如 Packages/ 下的包），必须同时分析其内部实现，不得只看主项目对其的调用',
      ],
    };
  }

  // ── submissionSpec: 嵌入 Quality Checklist ──
  const submissionSpec = {
    knowledgeTypes: dim.knowledgeTypes || [],
    targetCandidateCount:
      '每维度最少 3 条，目标 5 条（1-2 条不合格）。将不同关注点（如命名规范 vs 文件组织 vs 注释风格）拆分为独立候选，不要合并到一条中。',
    contentStyle: PROJECT_SNAPSHOT_STYLE_GUIDE.split('\n')
      .filter((l) => !l.startsWith('#') || l.startsWith('##'))
      .filter((l) => l.trim())
      .slice(0, 12)
      .join('\n'),
    contentQuality:
      'content.markdown 必须 ≥200 字符，包含: (1) ## 标题 (2) 正文说明 (3) 至少一个 ```代码块``` (4) 来源标注「(来源: Full/Relative/Path/FileName.ext:行号)」。\n【最高优先级 — 源码位置】每个候选必须包含完整相对路径（从项目根目录开始）+ 行号。禁止只写文件名（如 NetworkClient.swift:42），必须写完整路径（如 Packages/AOXNetworkKit/Sources/AOXNetworkKit/Client/NetworkClient.swift:42）。reasoning.sources 中也必须是完整相对路径。\n【模块归属】每个候选必须标注所属模块（如「所属模块: AOXNetworkKit」）。\n短于 200 字符的提交会被拒绝。\n【禁止】标题和正文中不得出现 "Agent" 字样 — 所有候选必须以项目规范/开发规范的视角撰写，描述的是项目规则而非 AI Agent 指南。',
    crossDimensionDedup:
      '【跨维度去重 — 系统强制拒绝】每条候选必须属于且仅属于当前维度的视角。禁止将同一知识点换个角度/换个说法重复提交到多个维度。' +
      '例如: BaseViewController 的继承规则只应出现在 code-pattern（设计模式）中，不应同时出现在 architecture（分层架构）和 code-standard（命名规范）中。' +
      '如果某个发现与多个维度相关，只在最核心的维度提交，其他维度用不同的独立知识点填充。' +
      '宁可少提交也不要重复充数 — 与前序维度标题相同的候选会被系统自动拒绝（硬去重）。',
    cursorFields: getCursorDeliverySpec(),
    dimensionCompleteGuide:
      '调用 dimension_complete 时必须传递: referencedFiles=[本维度分析过的全部文件路径], keyFindings=[3-5条关键发现摘要], analysisText=详细分析报告(≥500字符,含##标题+列表+代码块)',
    preSubmitChecklist: PRE_SUBMIT_CHECKLIST,
  };

  // ── skillMeta ──
  const sm = dim.skillMeta as { name?: string; description?: string } | null | undefined;
  const skillMeta = dim.skillWorthy
    ? {
        name: sm?.name || `project-${dim.id}`,
        description: sm?.description || `${dim.label} skill (auto-generated)`,
        format: 'Markdown 正文，需包含 # 标题、列表、代码块等结构化内容，≥100 字符',
      }
    : undefined;

  return {
    id: dim.id,
    label: dim.label,
    tier, // 1/2/3 与 tier-scheduler.js 一致
    outputType: dim.dualOutput ? 'dual' : dim.skillWorthy ? 'skill' : 'candidate',
    status: 'pending',
    analysisGuide,
    submissionSpec,
    skillMeta,
  };
}

export { buildEvidenceStarters } from '#workflows/capabilities/execution/external-agent/mission-briefing/EvidenceStarterBuilder.js';

// ── AST 压缩 ────────────────────────────────────────────────

/**
 * 压缩 AST 数据以控制 Mission Briefing 体积
 *
 * @param astProjectSummary analyzeProject() 返回值
 * @param fileCount 项目文件数
 * @returns 压缩后的 AST 数据
 */
function compressAstForBriefing(astProjectSummary: AstSummary | null, fileCount: number) {
  if (!astProjectSummary) {
    return { available: false, classes: [], protocols: [], categories: [], patterns: {} };
  }

  const classes = astProjectSummary.classes || [];
  const protocols = astProjectSummary.protocols || [];
  const categories = astProjectSummary.categories || [];

  // 确定压缩级别
  let topN: number;
  let compressionLevel: string;
  if (fileCount < SIZE_THRESHOLDS.S) {
    topN = classes.length; // 完整返回
    compressionLevel = 'none';
  } else if (fileCount < SIZE_THRESHOLDS.M) {
    topN = 50;
    compressionLevel = 'medium';
  } else {
    topN = 30;
    compressionLevel = 'high';
  }

  // ObjC 去重: @interface/@implementation/@extension 会产生同名 class 条目
  // 合并策略: 保留 methodCount 最高的条目，合并 protocols 和 superclass
  const classMap = new Map();
  for (const c of classes) {
    const existing = classMap.get(c.name);
    if (!existing) {
      classMap.set(c.name, { ...c });
    } else {
      // 保留更大的 methodCount
      if ((c.methodCount || 0) > (existing.methodCount || 0)) {
        existing.methodCount = c.methodCount;
      }
      // 合并 superclass（优先非空值）
      if (!existing.superclass && c.superclass) {
        existing.superclass = c.superclass;
      }
      // 合并 protocols
      const existProtos = new Set(existing.protocols || existing.conformedProtocols || []);
      for (const p of c.protocols || c.conformedProtocols || []) {
        existProtos.add(p);
      }
      existing.protocols = [...existProtos];
      // 合并 file（保留第一个）
      if (!existing.file && (c.file || c.relativePath)) {
        existing.file = c.file || c.relativePath;
      }
    }
  }
  const dedupedClasses = [...classMap.values()];

  // 按 methodCount 降序排序，取 top-N
  const sortedClasses = dedupedClasses
    .sort((a, b) => (b.methodCount || 0) - (a.methodCount || 0))
    .slice(0, topN);

  const compressedClasses = sortedClasses.map((c) => ({
    name: c.name,
    kind: c.kind || 'class',
    superclass: c.superclass || null,
    file: c.file || c.relativePath || null,
    methodCount: c.methodCount || c.methods?.length || 0,
    protocols: c.protocols || c.conformedProtocols || [],
  }));

  const compressedProtocols = protocols.slice(0, topN).map((p: AstProtocolInfo) => ({
    name: p.name,
    file: p.file || p.relativePath || null,
    methodCount: p.methodCount || p.methods?.length || 0,
    conformers: p.conformers || [],
  }));

  const compressedCategories = categories.slice(0, topN).map((cat: AstCategoryInfo) => ({
    baseClass: cat.baseClass || cat.extendedClass,
    name: cat.name || '',
    file: cat.file || cat.relativePath || null,
    methods: (cat.methods || [])
      .map((m: string | { name: string }) => (typeof m === 'string' ? m : m.name))
      .slice(0, 10),
  }));

  // ── 结构化 summary: 含 kindDistribution + insight ──
  const kindDist: Record<string, number> = {};
  for (const c of dedupedClasses) {
    const k = (c.kind as string) || 'class';
    kindDist[k] = (kindDist[k] || 0) + 1;
  }
  const totalTypes = dedupedClasses.length;
  const kindParts = Object.entries(kindDist)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${v} ${k}`);
  const summaryText = `${totalTypes} types (${kindParts.join(', ')}), ${protocols.length} protocols, ${categories.length} ${categories.length > 0 && categories[0]?.baseClass ? 'categories' : 'extensions'}, ${astProjectSummary.projectMetrics?.totalMethods || 0} methods`;

  // 生成 insight
  const valueTypeCount = (kindDist.struct || 0) + (kindDist.enum || 0);
  const refTypeCount = kindDist.class || 0;
  const actorCount = kindDist.actor || 0;
  let insight = '';
  if (totalTypes > 0) {
    const vtRatio = Math.round((valueTypeCount / totalTypes) * 100);
    if (vtRatio >= 60) {
      insight = `Value types (struct+enum) account for ${vtRatio}% — project favors value semantics`;
    } else if (refTypeCount > valueTypeCount) {
      insight = `Reference types (class) account for ${Math.round((refTypeCount / totalTypes) * 100)}% — OOP-heavy codebase`;
    } else {
      insight = `Balanced mix of value types (${vtRatio}%) and reference types (${Math.round((refTypeCount / totalTypes) * 100)}%)`;
    }
    if (actorCount > 0) {
      insight += `; ${actorCount} actors indicate structured concurrency adoption`;
    }
  }

  const summary = {
    text: summaryText,
    kindDistribution: kindDist,
    insight,
  };

  // ── 压缩 patternStats: 保留计数 + 代表性类名 ──
  const rawPatterns = astProjectSummary.patternStats || {};
  const compressedPatterns: Record<string, PatternValue> = {};
  for (const [key, val] of Object.entries(rawPatterns)) {
    if (typeof val === 'number' || typeof val === 'string' || typeof val === 'boolean') {
      compressedPatterns[key] = val;
    } else if (Array.isArray(val)) {
      compressedPatterns[key] = val.length; // 数组 → 计数
    } else if (val && typeof val === 'object') {
      const sub: Record<string, number | string | boolean> = {};
      for (const [sk, sv] of Object.entries(val)) {
        if (typeof sv === 'number' || typeof sv === 'string' || typeof sv === 'boolean') {
          sub[sk] = sv;
        } else if (Array.isArray(sv)) {
          // instances 数组: 提取 top-3 类名作为 representatives
          if (sk === 'instances' && sv.length > 0 && typeof sv[0] === 'object') {
            sub[sk] = sv.length;
            const classNames = sv
              .map((inst: Record<string, unknown>) => inst.className || '')
              .filter(Boolean) as string[];
            const unique = [...new Set(classNames)].slice(0, 3);
            if (unique.length > 0) {
              sub.representatives = unique.join(', ');
            }
          } else {
            sub[sk] = sv.length;
          }
        } else if (sv && typeof sv === 'object') {
          sub[sk] = Object.keys(sv).length;
        }
      }
      compressedPatterns[key] = sub;
    }
  }

  return {
    available: true,
    compressionLevel,
    summary,
    classes: compressedClasses,
    protocols: compressedProtocols,
    categories: compressedCategories,
    patterns: compressedPatterns,
    metrics: astProjectSummary.projectMetrics
      ? {
          totalMethods: astProjectSummary.projectMetrics.totalMethods,
          avgMethodsPerClass: astProjectSummary.projectMetrics.avgMethodsPerClass,
          maxNestingDepth: astProjectSummary.projectMetrics.maxNestingDepth,
          complexMethods: astProjectSummary.projectMetrics.complexMethods?.length || 0,
          longMethods: astProjectSummary.projectMetrics.longMethods?.length || 0,
        }
      : null,
  };
}

/** 压缩 Code Entity Graph */
function summarizeEntityGraph(codeEntityResult: CodeEntityGraphResult | null) {
  if (!codeEntityResult) {
    return null;
  }
  return {
    totalEntities: codeEntityResult.entitiesUpserted || 0,
    totalEdges: codeEntityResult.edgesCreated || 0,
  };
}

/**
 * 压缩 Call Graph 结果
 * @param callGraphResult CodeEntityGraph.populateCallGraph() 返回值
 */
function summarizeCallGraph(callGraphResult: CallGraphResult | null) {
  if (!callGraphResult) {
    return null;
  }
  return {
    methodEntities: callGraphResult.entitiesUpserted || 0,
    callEdges: callGraphResult.edgesCreated || 0,
    durationMs: callGraphResult.durationMs || 0,
  };
}

/** 压缩 Guard 审计结果 */
function summarizeGuardFindings(guardAudit: GuardAudit | null) {
  if (!guardAudit) {
    return null;
  }

  // 按 ruleId 聚合 violations
  const ruleMap: Record<string, RuleMapEntry> = {};

  // helper: 将单个 violation 累加到 ruleMap
  const addViolation = (v: GuardViolation, examplePrefix: string) => {
    const ruleId = v.ruleId || 'unknown';
    if (!ruleMap[ruleId]) {
      ruleMap[ruleId] = { ruleId, count: 0, example: null };
    }
    ruleMap[ruleId].count++;
    if (!ruleMap[ruleId].example) {
      ruleMap[ruleId].example = `${examplePrefix} — ${v.message}`;
    }
  };

  // 1) Per-file violations
  for (const fileResult of guardAudit.files || []) {
    for (const v of fileResult.violations || []) {
      addViolation(v, `${fileResult.filePath}:${v.line || '?'}`);
    }
  }

  // 2) Cross-file violations（之前被遗漏）
  for (const v of guardAudit.crossFileViolations || []) {
    const loc = v.locations?.[0];
    const prefix = loc ? `${loc.filePath}:${loc.line || '?'}` : '(cross-file)';
    addViolation(v, prefix);
  }

  // 取 top-5 violations
  const topViolations = Object.values(ruleMap)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  const totalErrors = guardAudit.summary?.totalErrors || 0;
  const totalViolations = guardAudit.summary?.totalViolations || 0;

  // §V2: 单独高亮跨文件违规 — 这类违规通常涉及架构层级或模块边界问题
  const crossFileIssues = (guardAudit.crossFileViolations || []).map((v: GuardViolation) => ({
    ruleId: v.ruleId,
    message: v.message,
    locations: v.locations?.slice(0, 3),
    severity: (v as unknown as Record<string, unknown>).severity || 'warning',
  }));

  return {
    totalViolations,
    errors: totalErrors,
    warnings: totalViolations - totalErrors,
    topViolations,
    ...(crossFileIssues.length > 0 ? { crossFileIssues } : {}),
  };
}

// ── Architecture Overview 自动推断 ────────────────────────

/** 知名外部依赖的角色映射 */
const KNOWN_DEPENDENCIES: Record<string, string> = {
  // Swift / iOS
  alamofire: 'HTTP networking',
  moya: 'Network abstraction over Alamofire',
  rxswift: 'Reactive programming (ReactiveX)',
  rxcocoa: 'RxSwift UIKit bindings',
  combine: 'Apple reactive framework',
  kingfisher: 'Image downloading & caching',
  sdwebimage: 'Image downloading & caching',
  snapkit: 'Auto Layout DSL',
  lottie: 'Animation rendering',
  realm: 'Mobile database',
  coredata: 'Apple persistence framework',
  swiftui: 'Declarative UI framework',
  // JavaScript / TypeScript
  react: 'UI component framework',
  vue: 'Progressive UI framework',
  angular: 'Full-featured UI framework',
  express: 'HTTP server framework',
  nestjs: 'Enterprise Node.js framework',
  axios: 'HTTP client',
  prisma: 'Database ORM',
  sequelize: 'SQL ORM',
  mongoose: 'MongoDB ODM',
  tailwindcss: 'Utility-first CSS',
  webpack: 'Module bundler',
  vite: 'Frontend build tool',
  jest: 'Testing framework',
  vitest: 'Vite-native testing',
  redux: 'State management',
  zustand: 'Lightweight state management',
  // Go
  gin: 'HTTP web framework',
  echo: 'HTTP web framework',
  gorm: 'Go ORM',
  cobra: 'CLI framework',
  // Python
  django: 'Full-stack web framework',
  flask: 'Micro web framework',
  fastapi: 'Async web framework',
  sqlalchemy: 'SQL toolkit & ORM',
  pytorch: 'Deep learning framework',
  tensorflow: 'Machine learning framework',
  pandas: 'Data analysis library',
  numpy: 'Numerical computing',
};

/**
 * 从 targets + depGraph + localPackageModules 自动推断架构概览
 */
function buildArchitectureOverview(
  targets: MissionBriefing['targets'],
  depGraphData: DependencyGraph | null,
  localPackageModules?: LocalPackageModule[]
): MissionBriefing['architectureOverview'] {
  if (!targets || targets.length === 0) {
    return null;
  }

  // ── 分层: 按 inferredRole 分组 ──
  const roleGroups: Record<string, { modules: string[]; fileCount: number }> = {};
  for (const t of targets) {
    const role = t.inferredRole || 'unknown';
    if (!roleGroups[role]) {
      roleGroups[role] = { modules: [], fileCount: 0 };
    }
    roleGroups[role].modules.push(t.name);
    roleGroups[role].fileCount += t.fileCount || 0;
  }

  // 层级命名映射
  const ROLE_LAYER_MAP: Record<string, { name: string; priority: number; role: string }> = {
    app: {
      name: 'App Shell',
      priority: 0,
      role: 'Application entry point, coordinators, DI assembly',
    },
    core: {
      name: 'Core Infrastructure',
      priority: 2,
      role: 'Shared infrastructure libraries, base classes, utilities',
    },
    networking: {
      name: 'Networking',
      priority: 2,
      role: 'Network client, middleware, API definitions',
    },
    feature: {
      name: 'Feature Modules',
      priority: 1,
      role: 'Per-feature UI, view models, business logic',
    },
    ui: { name: 'UI Components', priority: 2, role: 'Shared UI components, themes, extensions' },
    test: { name: 'Tests', priority: 3, role: 'Unit tests, integration tests, mocks' },
    unknown: { name: 'Other', priority: 3, role: 'Uncategorized modules' },
  };

  const layers: { name: string; modules: string[]; fileCount: number; role: string }[] = [];
  for (const [role, group] of Object.entries(roleGroups)) {
    if (role === 'test') {
      continue;
    } // 测试模块不加入架构层
    const layerDef = ROLE_LAYER_MAP[role] || ROLE_LAYER_MAP.unknown;
    // 合并同优先级的层
    const existing = layers.find((l) => l.name === layerDef.name);
    if (existing) {
      existing.modules.push(...group.modules);
      existing.fileCount += group.fileCount;
    } else {
      layers.push({
        name: layerDef.name,
        modules: [...group.modules],
        fileCount: group.fileCount,
        role: layerDef.role,
      });
    }
  }
  // 按 priority 排序 (App Shell → Features → Core → Other)
  layers.sort((a, b) => {
    const pa = Object.values(ROLE_LAYER_MAP).find((v) => v.name === a.name)?.priority ?? 99;
    const pb = Object.values(ROLE_LAYER_MAP).find((v) => v.name === b.name)?.priority ?? 99;
    return pa - pb;
  });

  // ── 外部依赖识别 ──
  const externalDeps: { name: string; role: string }[] = [];
  const localModuleNames = new Set(targets.map((t) => t.name));
  if (depGraphData?.nodes) {
    for (const n of depGraphData.nodes) {
      const id = typeof n === 'string' ? n : n.id || '';
      const label = typeof n === 'string' ? n : n.label || id;
      if (!localModuleNames.has(id) && !localModuleNames.has(label)) {
        const knownRole = KNOWN_DEPENDENCIES[label.toLowerCase()];
        externalDeps.push({
          name: label,
          role: knownRole || 'third-party dependency',
        });
      }
    }
  }

  // ── 关键洞察 ──
  const insights: string[] = [];
  const totalFiles = targets.reduce((s, t) => s + (t.fileCount || 0), 0);
  const featureGroup = roleGroups.feature;
  const coreGroup = roleGroups.core;
  const networkGroup = roleGroups.networking;

  // 本地子包占比
  if (localPackageModules && localPackageModules.length > 0) {
    const pkgFiles = localPackageModules.reduce((s, m) => s + m.fileCount, 0);
    const pct = totalFiles > 0 ? Math.round((pkgFiles / totalFiles) * 100) : 0;
    insights.push(
      `${localPackageModules.length} local packages provide ${pct}% of the codebase (${pkgFiles}/${totalFiles} files)`
    );
  }

  // Feature 模块特征
  if (featureGroup) {
    const avgFiles = Math.round(featureGroup.fileCount / featureGroup.modules.length);
    if (avgFiles <= 5) {
      insights.push(
        `Feature modules are thin (avg ${avgFiles} files) — business logic likely concentrates in core infrastructure`
      );
    } else {
      insights.push(
        `Feature modules average ${avgFiles} files each — self-contained feature architecture`
      );
    }
  }

  // 最大基础设施模块
  if (coreGroup || networkGroup) {
    const infraModules = [...(coreGroup?.modules || []), ...(networkGroup?.modules || [])];
    const heaviest = targets
      .filter((t) => infraModules.includes(t.name))
      .sort((a, b) => (b.fileCount || 0) - (a.fileCount || 0));
    if (heaviest.length > 0 && heaviest[0].fileCount) {
      insights.push(
        `${heaviest[0].name} (${heaviest[0].fileCount} files) is the heaviest infrastructure module`
      );
    }
  }

  // 推断架构风格
  let style = 'Monolithic application';
  if (localPackageModules && localPackageModules.length >= 2) {
    style = 'Modular monolith (local packages)';
  } else if (targets.length >= 5 && featureGroup && featureGroup.modules.length >= 3) {
    style = 'Feature-modular architecture';
  }

  return { style, layers, externalDeps, keyInsights: insights };
}

/**
 * 从外部依赖图中提取技术栈信息
 */
function buildTechnologyStack(
  depGraphData: DependencyGraph | null,
  targets: MissionBriefing['targets']
): MissionBriefing['technologyStack'] {
  if (!depGraphData?.nodes || !depGraphData?.edges) {
    return null;
  }

  const localModuleNames = new Set(targets.map((t) => t.name));
  const stack: { name: string; role: string; usedBy: string[] }[] = [];

  for (const n of depGraphData.nodes) {
    const id = typeof n === 'string' ? n : n.id || '';
    const label = typeof n === 'string' ? n : n.label || id;
    if (localModuleNames.has(id) || localModuleNames.has(label)) {
      continue;
    }
    const role = KNOWN_DEPENDENCIES[label.toLowerCase()] || 'third-party dependency';
    // 找出哪些模块依赖它
    const usedBy = (depGraphData.edges || [])
      .filter((e) => {
        const edge = e as { to?: string; from?: string };
        return edge.to === id || edge.to === label;
      })
      .map((e) => (e as { from: string }).from)
      .filter((f) => localModuleNames.has(f))
      .slice(0, 5);
    stack.push({ name: label, role, usedBy });
  }

  return stack.length > 0 ? stack : null;
}

/**
 * 提取项目关键抽象 — 从继承热点、协议遵从数、模块入口类中识别
 */
function buildKeyAbstractions(
  astData: AstSummary | null,
  targets: MissionBriefing['targets']
): MissionBriefing['keyAbstractions'] {
  if (!astData) {
    return null;
  }

  const classes = astData.classes || [];
  const protocols = astData.protocols || [];
  const abstractions: {
    name: string;
    kind: string;
    module: string;
    significance: string;
    detail: string;
  }[] = [];

  // §1: 高继承热点 — 被多个子类继承的基类
  const subclassCount: Record<string, number> = {};
  for (const cls of classes) {
    if (cls.superclass) {
      subclassCount[cls.superclass] = (subclassCount[cls.superclass] || 0) + 1;
    }
  }
  const topBases = Object.entries(subclassCount)
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  for (const [baseName, count] of topBases) {
    const baseCls = classes.find((c) => c.name === baseName);
    const module =
      baseCls?.targetName || _inferModule(baseCls?.file || baseCls?.relativePath, targets);
    abstractions.push({
      name: baseName,
      kind: (baseCls?.kind as string) || 'class',
      module,
      significance: `Base class with ${count} subclasses`,
      detail: `Subclasses: ${classes
        .filter((c) => c.superclass === baseName)
        .map((c) => c.name)
        .slice(0, 5)
        .join(', ')}`,
    });
  }

  // §2: 高方法数类 — 复杂度热点
  const methodHeavy = classes
    .filter((c) => (c.methodCount || 0) >= 15)
    .sort((a, b) => (b.methodCount || 0) - (a.methodCount || 0))
    .slice(0, 3);
  for (const cls of methodHeavy) {
    // 跳过已在继承热点中出现的
    if (abstractions.some((a) => a.name === cls.name)) {
      continue;
    }
    const module = cls.targetName || _inferModule(cls.file || cls.relativePath, targets);
    abstractions.push({
      name: cls.name,
      kind: (cls.kind as string) || 'class',
      module,
      significance: `Complexity hotspot (${cls.methodCount} methods)`,
      detail: cls.superclass ? `extends ${cls.superclass}` : 'root class',
    });
  }

  // §3: 高遵从协议 — 核心抽象接口
  const protoWithConformers = protocols
    .filter((p) => (p.conformers?.length || 0) >= 2 || (p.methodCount || 0) >= 3)
    .sort((a, b) => (b.conformers?.length || 0) - (a.conformers?.length || 0))
    .slice(0, 5);
  for (const proto of protoWithConformers) {
    const module = proto.targetName || _inferModule(proto.file || proto.relativePath, targets);
    const conformerCount = proto.conformers?.length || 0;
    abstractions.push({
      name: proto.name,
      kind: 'protocol',
      module,
      significance:
        conformerCount > 0
          ? `Protocol with ${conformerCount} conformers`
          : `Protocol with ${proto.methodCount || 0} method requirements`,
      detail:
        conformerCount > 0
          ? `Conformers: ${(proto.conformers ?? []).slice(0, 5).join(', ')}`
          : `${proto.methodCount || 0} required methods`,
    });
  }

  return abstractions.length > 0 ? abstractions.slice(0, 10) : null;
}

/** 从文件路径推断模块名 */
function _inferModule(filePath: string | undefined, targets: MissionBriefing['targets']): string {
  if (!filePath) {
    return 'unknown';
  }
  for (const t of targets) {
    if (filePath.includes(t.name)) {
      return t.name;
    }
  }
  return filePath.split('/')[0] || 'unknown';
}

// ── Panorama 摘要构建 ──────────────────────────────────────

/**
 * 从 PanoramaResult 提取 layers / couplingHotspots / cycles / gaps
 * 用于注入 MissionBriefing，使外部 Agent 获得项目全景视野
 */
// ── 本地子包/模块 — mustCoverModules ────────────────────────

/**
 * 构建 mustCoverModules 段落 — 标记来自本地子包的基础设施模块
 *
 * 语言无关：只依赖 Discoverer 返回的 target metadata 中的 isLocalPackage 标记。
 * 无论 SPM (Swift)、monorepo (TS)、Gradle subproject (Java/Kotlin)，
 * 只要某 target 来自非主 projectRoot 的子目录，就被视为本地子包。
 *
 * @param localPackageModules Phase 1 收集的子包信息
 * @returns mustCoverModules 段落
 */
function buildMustCoverModules(
  localPackageModules?: LocalPackageModule[]
): MissionBriefing['mustCoverModules'] {
  if (!localPackageModules || localPackageModules.length === 0) {
    return null;
  }
  return {
    totalLocalPackages: localPackageModules.length,
    modules: localPackageModules.map((m) => ({
      name: m.name,
      packageName: m.packageName,
      fileCount: m.fileCount,
      inferredRole: m.inferredRole,
      keyFiles: m.keyFiles || [],
    })),
    instruction:
      '【强制覆盖】以下本地子包/模块是项目的基础设施层，包含核心抽象和共享服务。' +
      '每个维度分析时必须同时覆盖主项目代码和这些子包代码。' +
      '提交的知识候选中必须包含子包源码的完整相对路径和行号（如 Packages/AOXNetworkKit/Sources/.../NetworkClient.swift:42），' +
      '不得仅引用主项目中对子包的调用，而忽略子包内部的实现细节。' +
      '对于 architecture、code-pattern、best-practice 维度，至少要有 1 条候选直接引用子包的核心实现文件。',
  };
}

function summarizePanorama(
  panoramaResult: Record<string, unknown> | null
): MissionBriefing['panorama'] {
  if (!panoramaResult) {
    return null;
  }
  try {
    // PanoramaResult.layers: LayerHierarchy { levels: LayerLevel[] }
    const layerHierarchy = panoramaResult.layers as
      | { levels?: Array<{ level: number; name: string; modules: string[] }> }
      | undefined;
    const layers = layerHierarchy?.levels ?? [];

    // PanoramaResult.modules: Map<string, PanoramaModule>
    const modules = panoramaResult.modules as
      | Map<string, { name: string; fanIn: number; fanOut: number }>
      | undefined;
    const couplingHotspots: Array<{ module: string; fanIn: number; fanOut: number }> = [];
    if (modules instanceof Map) {
      for (const [, mod] of modules) {
        if (mod.fanIn >= 10 || mod.fanOut >= 10) {
          couplingHotspots.push({ module: mod.name, fanIn: mod.fanIn, fanOut: mod.fanOut });
        }
      }
      couplingHotspots.sort((a, b) => b.fanIn + b.fanOut - (a.fanIn + a.fanOut));
    }

    // PanoramaResult.cycles: CyclicDependency[]
    const cycles = (panoramaResult.cycles as Array<{ cycle: string[]; severity: string }>) ?? [];

    // PanoramaResult.gaps: KnowledgeGap[] (dimension-based)
    const gaps =
      (panoramaResult.gaps as Array<{
        dimension: string;
        dimensionName: string;
        recipeCount: number;
        status: string;
        priority: string;
      }>) ?? [];

    return {
      layers: layers.slice(0, 10),
      couplingHotspots: couplingHotspots.slice(0, 10),
      cyclicDependencies: cycles.slice(0, 10),
      knowledgeGaps: gaps.slice(0, 20),
    };
  } catch {
    return null;
  }
}

// ── Mission Briefing 主构建函数 ──────────────────────────────

/**
 * 构建 Mission Briefing
 *
 * @param opts.projectMeta 项目元数据
 * @param opts.astData analyzeProject() 原始结果
 * @param opts.codeEntityResult CodeEntityGraph.populateFromAst() 结果
 * @param opts.depGraphData discoverer.getDependencyGraph() 结果
 * @param opts.guardAudit GuardCheckEngine.auditFiles() 结果
 * @param opts.targets allTargets 列表
 * @param opts.activeDimensions resolveActiveDimensions() 结果
 * @param opts.skills 已加载的 bootstrap skills
 * @param opts.session BootstrapSession 实例
 * @returns Mission Briefing 响应数据
 */
export function buildMissionBriefing({
  projectMeta,
  astData,
  codeEntityResult,
  callGraphResult,
  depGraphData,
  guardAudit,
  targets,
  activeDimensions,
  session,
  languageExtension, // §7.1: 语言扩展（反模式、Guard 规则、Agent 注意事项）
  incrementalPlan, // §7.3: 增量 Bootstrap 评估结果
  languageStats, // §7.4: 完整语言分布统计
  panoramaResult, // §M1: Phase 1.8 全景数据
  localPackageModules, // 本地子包模块信息
  profile,
  rescan,
  responseBudget,
}: MissionBriefingParams) {
  const briefingPlan = createBriefingPlan({ profile, rescan, responseBudget });
  const scheduler = new TierScheduler();

  // ── 构建维度任务列表 (v2: 附带 evidenceStarters) ──
  const dimensions = activeDimensions.map((dim: DimensionDef) => {
    const tierIndex = scheduler.getTierIndex(dim.id);
    // 优先使用 DEFAULT_TIERS 定义；未定义则取 tierHint；兜底 Tier 1
    const tier =
      tierIndex >= 0 ? tierIndex + 1 : typeof dim.tierHint === 'number' ? dim.tierHint : 1;
    const task: DimensionTask = enrichDimensionTask(dim, tier);

    // §7.3: 增量 Bootstrap — 标记维度状态
    if (incrementalPlan) {
      if (incrementalPlan.skippedDimensions.includes(dim.id)) {
        task.status = 'skipped-incremental';
      } else if (incrementalPlan.affectedDimensions.includes(dim.id)) {
        task.status = 'pending';
      }
    }

    // v2: 从 Phase 1-4 数据中提取维度相关的证据启发
    const evidenceStarters = buildEvidenceStarters(dim, {
      astData,
      guardAudit,
      depGraphData,
      callGraphResult,
      panoramaResult,
    });
    if (evidenceStarters) {
      task.evidenceStarters = evidenceStarters;
    }

    return task;
  });

  // ── 选择语言自适应的 example ──
  const lang = String(projectMeta.primaryLanguage || 'text');
  const example =
    (EXAMPLE_TEMPLATES as Record<string, unknown>)[lang] ||
    (EXAMPLE_TEMPLATES as Record<string, unknown>)[lang.toLowerCase()] ||
    EXAMPLE_TEMPLATES._default;

  // ── 组装 ──

  // ── 依赖图节点去重 ──
  const dedupedDepNodes: {
    id: string;
    label: string;
    fileCount?: number;
    dependentCount?: number;
  }[] = [];
  if (depGraphData?.nodes) {
    const nodeMap = new Map<
      string,
      { id: string; label: string; fileCount?: number; dependentCount: number }
    >();
    for (const n of depGraphData.nodes) {
      const id = typeof n === 'string' ? n : n.id || '';
      const label = typeof n === 'string' ? n : n.label || id;
      const fileCount = typeof n === 'string' ? undefined : n.fileCount;
      if (!nodeMap.has(id)) {
        nodeMap.set(id, { id, label, fileCount, dependentCount: 0 });
      } else {
        const existingNode = nodeMap.get(id);
        if (fileCount && existingNode && !existingNode.fileCount) {
          existingNode.fileCount = fileCount;
        }
      }
    }
    // 计算每个节点被多少模块依赖（fan-in）
    for (const e of depGraphData.edges || []) {
      const edge = e as { to?: string };
      if (edge.to && nodeMap.has(edge.to)) {
        const targetNode = nodeMap.get(edge.to);
        if (targetNode) {
          targetNode.dependentCount++;
        }
      }
    }
    for (const node of nodeMap.values()) {
      dedupedDepNodes.push(node);
    }
  }

  // ── targets 构建 ──
  const builtTargets = (targets || []).map((t: string | TargetInfo) => ({
    name: typeof t === 'string' ? t : t.name,
    type: typeof t === 'string' ? 'target' : t.type || 'target',
    inferredRole: typeof t === 'string' ? undefined : t.inferredRole,
    fileCount: typeof t === 'string' ? undefined : t.fileCount,
  }));

  const briefing: MissionBriefing = {
    projectMeta,

    ast: compressAstForBriefing(astData ?? null, (projectMeta.fileCount as number) || 0),

    // 高层次架构概览 — Agent 一目了然项目结构
    architectureOverview: buildArchitectureOverview(
      builtTargets,
      depGraphData ?? null,
      localPackageModules
    ),

    // 技术栈 — 外部依赖的角色识别
    technologyStack: buildTechnologyStack(depGraphData ?? null, builtTargets),

    // 关键抽象 — Agent 优先分析的核心类/协议
    keyAbstractions: buildKeyAbstractions(astData ?? null, builtTargets),

    codeEntityGraph: summarizeEntityGraph(codeEntityResult ?? null),

    callGraph: summarizeCallGraph(callGraphResult ?? null),

    dependencyGraph:
      dedupedDepNodes.length > 0
        ? {
            nodes: dedupedDepNodes,
            edges: (depGraphData?.edges || []).slice(0, 100),
          }
        : null,

    guardFindings: summarizeGuardFindings(guardAudit ?? null),

    targets: builtTargets,

    dimensions,

    // §7.1: 语言扩展信息 (反模式、Guard 规则、Agent 注意事项)
    languageExtension: languageExtension || null,

    submissionSchema: {
      ...SUBMISSION_SCHEMA,
      example,
    },

    // 完整语言统计（按文件扩展名计数）
    languageStats: languageStats || null,

    executionPlan: buildExecutionInstructions({
      activeDimensions,
      profile: briefingPlan.profile,
      rescan: briefingPlan.rescan,
    }),

    panorama: summarizePanorama(panoramaResult ?? null),

    // 本地子包/模块 — 必须覆盖的基础设施模块
    mustCoverModules: buildMustCoverModules(localPackageModules),

    session: session.toJSON(),
  };

  if (briefingPlan.profile === 'rescan-external' && briefingPlan.rescan) {
    briefing.evidenceHints = projectRescanEvidenceHints(briefingPlan.rescan);
  }

  applyBriefingCompressionPolicy(briefing, briefingPlan.responseBudget);
  briefing.meta = { ...briefing.meta, profile: briefingPlan.profile };

  return briefing;
}
