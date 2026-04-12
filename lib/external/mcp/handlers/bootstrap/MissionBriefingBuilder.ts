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

import {
  getDimensionSOP,
  PRE_SUBMIT_CHECKLIST,
  sopToCompactText,
} from '#domain/dimension/DimensionSop.js';
import { getCursorDeliverySpec } from '#domain/knowledge/FieldSpec.js';
import { PROJECT_SNAPSHOT_STYLE_GUIDE } from '#domain/knowledge/StyleGuide.js';
import type {
  AstCategoryInfo,
  AstClassInfo,
  AstFileSummary,
  AstProtocolInfo,
  AstSummary,
  CallGraphResult,
  CodeEntityGraphResult,
  DependencyGraph,
  DependencyNode,
  DimensionDef,
  GuardAudit,
  GuardAuditFileEntry,
  GuardViolation,
  IncrementalPlan,
  LocalPackageModule,
  PanoramaResult,
  ProjectMetrics,
} from '#types/project-snapshot.js';
import { TierScheduler } from './pipeline/tier-scheduler.js';
import { EXAMPLE_TEMPLATES, SUBMISSION_SCHEMA } from './shared/dimension-text.js';

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

/** Evidence starters 选项 */
interface EvidenceStarterOpts {
  astData?: AstSummary | null;
  guardAudit?: GuardAudit | null;
  depGraphData?: DependencyGraph | null;
  callGraphResult?: CallGraphResult | null;
  panoramaResult?: Record<string, unknown> | null;
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
    summary?: string;
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
  codeEntityGraph: { totalEntities: number; totalEdges: number } | null;
  callGraph: { methodEntities: number; callEdges: number; durationMs: number } | null;
  dependencyGraph: {
    nodes: { id: string; label: string; fileCount?: number }[];
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
  meta?: { responseSizeKB: number; compressionLevel: string; warnings?: string[] };
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
}

// ── 常量 ────────────────────────────────────────────────────

/** 响应体积硬上限 (bytes) */
const RESPONSE_SIZE_LIMIT = 100 * 1024; // 100KB

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

// ── 维度级证据启发构建 (v2) ─────────────────────────────────

/**
 * 从 Phase 1-4 数据中为维度提取证据启发
 *
 * 将原本的"原始 AST / Guard 数据"转化为维度关联的结构化引导，
 * 让外部 Agent 更有方向性地开始分析：
 * - 与维度相关的 AST 类/协议/模式
 * - Guard 违规中与维度话题相关的发现
 * - 依赖图中与维度相关的模块关系
 *
 * 设计对标: 内部 Agent 的 buildProducerPromptV2 提供结构化 findings 和 code evidence，
 * 外部 Agent 的 evidenceStarters 从 Phase 1-4 数据中提供类似的结构化起点。
 *
 * @param dim 维度定义
 * @param [opts.astData] analyzeProject() 结果
 * @param [opts.guardAudit] GuardCheckEngine.auditFiles() 结果
 * @param [opts.depGraphData] 依赖图
 * @returns evidenceStarters 对象，为空则返回 undefined
 */
export function buildEvidenceStarters(
  dim: DimensionDef,
  { astData, guardAudit, depGraphData, callGraphResult, panoramaResult }: EvidenceStarterOpts
) {
  const starters: Record<string, { hint: string; data: unknown }> = {};
  const dimId = dim.id;
  const dimLabel = (dim.label || '').toLowerCase();
  const dimGuide = (dim.guide || '').toLowerCase();
  const dimKeywords = `${dimLabel} ${dimGuide}`;

  // §1: AST 相关发现
  if (astData) {
    const classes = astData.classes || [];
    const protocols = astData.protocols || [];
    const patterns = astData.patternStats || {};
    const fileSummaries = astData.fileSummaries || [];

    // naming-conventions → 前缀/后缀统计 (类名 + 顶层函数名)
    if (
      dimId === 'naming-conventions' ||
      dimId === 'code-standard' ||
      dimKeywords.includes('命名') ||
      dimKeywords.includes('naming')
    ) {
      const prefixStats: Record<string, number> = {};
      for (const cls of classes) {
        const prefix = (cls.name || '').match(/^[A-Z]{2,4}/)?.[0];
        if (prefix) {
          prefixStats[prefix] = (prefixStats[prefix] || 0) + 1;
        }
      }
      // 函数式代码: 统计顶层函数命名模式 (useXxx, handleXxx, getXxx, etc.)
      if (classes.length === 0) {
        const funcPrefixes: Record<string, number> = {};
        for (const fs of fileSummaries) {
          for (const m of fs.methods || []) {
            if (!m.className) {
              const fp = (m.name || '').match(
                /^(use|handle|get|set|create|make|fetch|on|is|has|with|to)[A-Z]/
              )?.[1];
              if (fp) {
                funcPrefixes[fp] = (funcPrefixes[fp] || 0) + 1;
              }
            }
          }
        }
        const topFuncPrefixes = (Object.entries(funcPrefixes) as [string, number][])
          .sort(([, a], [, b]) => b - a)
          .slice(0, 5);
        if (topFuncPrefixes.length > 0) {
          starters.functionNamingPatterns = {
            hint: '顶层函数命名前缀分布 — 用于分析函数式代码命名约定',
            data: topFuncPrefixes.map(([prefix, count]) => `${prefix}Xxx (${count} functions)`),
          };
        }
      }
      if (Object.keys(prefixStats).length > 0) {
        starters.namingPatterns = {
          hint: '项目类名前缀分布 — 用于分析命名约定',
          data: (Object.entries(prefixStats) as [string, number][])
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([prefix, count]) => `${prefix}* (${count} classes)`),
        };
      }
    }

    // patterns-architecture → 设计模式 + 继承链 + 函数式模式
    if (
      dimId === 'patterns-architecture' ||
      dimId === 'architecture' ||
      dimId === 'code-pattern' ||
      dimKeywords.includes('架构') ||
      dimKeywords.includes('pattern') ||
      dimKeywords.includes('模式')
    ) {
      if (Object.keys(patterns).length > 0) {
        // 压缩 patterns: 只保留顶层 key → 计数/类型摘要
        const compactPatterns: Record<string, string | number | boolean> = {};
        for (const [key, val] of Object.entries(patterns)) {
          if (typeof val === 'number' || typeof val === 'string' || typeof val === 'boolean') {
            compactPatterns[key] = val;
          } else if (Array.isArray(val)) {
            compactPatterns[key] = `${val.length} items`;
          } else if (val && typeof val === 'object') {
            compactPatterns[key] = Object.keys(val).slice(0, 10).join(', ');
          }
        }
        starters.detectedPatterns = {
          hint: 'AST 自动检测到的设计模式 — 作为架构分析起点',
          data: compactPatterns,
        };
      }
      // 继承关系分析
      const baseClasses: Record<string, number> = {};
      for (const cls of classes) {
        if (cls.superclass) {
          baseClasses[cls.superclass] = (baseClasses[cls.superclass] || 0) + 1;
        }
      }
      const topBases = (Object.entries(baseClasses) as [string, number][])
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);
      if (topBases.length > 0) {
        starters.inheritanceHotspots = {
          hint: '最常被继承的基类 — 关注其设计模式和扩展约定',
          data: topBases.map(([cls, count]) => `${cls} (${count} subclasses)`),
        };
      }
    }

    // 协议/接口相关维度
    if (
      dimKeywords.includes('protocol') ||
      dimKeywords.includes('协议') ||
      dimKeywords.includes('interface')
    ) {
      if (protocols.length > 0) {
        starters.protocolSummary = {
          hint: `项目定义了 ${protocols.length} 个协议/接口`,
          data: protocols.slice(0, 8).map((p: AstProtocolInfo) => ({
            name: p.name,
            methods: p.methodCount || p.methods?.length || 0,
            conformers: (p.conformers || []).length,
          })),
        };
      }
    }

    // §1.2: 代码规模摘要 — 任何维度都可以从文件/函数统计中获取证据
    const totalMethods = astData.projectMetrics?.totalMethods || 0;
    const fileCount = astData.fileCount || 0;
    if (classes.length === 0 && totalMethods > 0) {
      // 函数式/模块化代码: 提供函数和导出统计
      const exportCount = fileSummaries.reduce(
        (s: number, f: AstFileSummary) => s + (f.exports?.length || 0),
        0
      );
      const asyncCount = fileSummaries.reduce(
        (s: number, f: AstFileSummary) =>
          s + (f.methods || []).filter((m: { isAsync?: boolean }) => m.isAsync).length,
        0
      );
      const complexMethods = astData.projectMetrics?.complexMethods || [];

      if (
        dimId === 'code-pattern' ||
        dimId === 'best-practice' ||
        dimId === 'event-and-data-flow' ||
        dimKeywords.includes('模式') ||
        dimKeywords.includes('实践') ||
        dimKeywords.includes('事件')
      ) {
        const summary = [
          `${totalMethods} functions across ${fileCount} files`,
          exportCount > 0 ? `${exportCount} exports` : null,
          asyncCount > 0 ? `${asyncCount} async functions` : null,
          complexMethods.length > 0 ? `${complexMethods.length} high-complexity functions` : null,
        ].filter(Boolean);
        if (summary.length > 0) {
          starters.codeSummary = {
            hint: '函数式代码结构统计 — 用于分析代码模式和最佳实践',
            data: summary,
          };
        }
      }
    }
  }

  // §2: Guard 违规关联
  if (guardAudit?.files) {
    const dimRelatedViolations: { file: string; rule: string; message: string }[] = [];
    for (const fileResult of guardAudit.files) {
      for (const v of fileResult.violations || []) {
        // 粗略匹配: ruleId / message 是否与维度话题相关
        const ruleText = `${v.ruleId || ''} ${v.message || ''}`.toLowerCase();
        if (dimId.split('-').some((word: string) => word.length > 3 && ruleText.includes(word))) {
          dimRelatedViolations.push({
            file: fileResult.filePath,
            rule: v.ruleId || '',
            message: (v.message || '').substring(0, 100),
          });
        }
      }
    }
    if (dimRelatedViolations.length > 0) {
      starters.guardViolations = {
        hint: `Guard 审计发现 ${dimRelatedViolations.length} 条与本维度相关的违规 — 可作为分析切入点`,
        data: dimRelatedViolations.slice(0, 5),
      };
    }

    // §2.5: 跨文件违规单独高亮 — architecture / best-practice 维度重点关注
    const crossFileViolations = guardAudit.crossFileViolations || [];
    if (
      crossFileViolations.length > 0 &&
      (dimId === 'architecture' ||
        dimId === 'best-practice' ||
        dimId === 'code-standard' ||
        dimKeywords.includes('架构') ||
        dimKeywords.includes('层级') ||
        dimKeywords.includes('依赖方向'))
    ) {
      starters.crossFileViolations = {
        hint: `Guard 检测到 ${crossFileViolations.length} 条跨文件违规（如层级穿透、循环引用） — 这是架构分析的关键信号`,
        data: crossFileViolations.slice(0, 5).map((v: GuardViolation) => ({
          rule: v.ruleId,
          message: (v.message || '').substring(0, 120),
          files: v.locations?.slice(0, 2).map((l) => l.filePath) || [],
        })),
      };
    }
  }

  // §3: 依赖图关联 (扩大到所有架构/模块相关维度)
  if (depGraphData?.nodes) {
    const nodeCount = (depGraphData.nodes || []).length;
    const edgeCount = (depGraphData.edges || []).length;
    if (
      nodeCount > 0 &&
      (dimId === 'patterns-architecture' ||
        dimId === 'architecture' ||
        dimId === 'data-flow-patterns' ||
        dimId === 'project-profile' ||
        dimId === 'module-export-scan' ||
        dimKeywords.includes('架构') ||
        dimKeywords.includes('模块') ||
        dimKeywords.includes('依赖'))
    ) {
      starters.dependencyOverview = {
        hint: `依赖图包含 ${nodeCount} 个模块、${edgeCount} 条依赖 — 分析模块间耦合关系`,
        data: {
          totalModules: nodeCount,
          totalEdges: edgeCount,
          topModules: (depGraphData.nodes || [])
            .slice(0, 5)
            .map((n: string | DependencyNode) => (typeof n === 'string' ? n : n.label || n.id)),
        },
      };
    }
  }

  // §4: ObjC Category 关联 — 为 category-scan 和相关维度提供分类证据
  if (astData) {
    const categories = astData.categories || [];
    if (
      categories.length > 0 &&
      (dimId === 'category-scan' ||
        dimId === 'category-extension' ||
        dimKeywords.includes('category') ||
        dimKeywords.includes('分类') ||
        dimKeywords.includes('extension'))
    ) {
      // 按 baseClass 聚合分类
      const catByBase: Record<string, string[]> = {};
      for (const cat of categories) {
        const base = cat.baseClass || cat.extendedClass || 'Unknown';
        if (!catByBase[base]) {
          catByBase[base] = [];
        }
        catByBase[base].push(cat.name || '(anonymous)');
      }
      const topBases = (Object.entries(catByBase) as [string, string[]][])
        .sort((a, b) => b[1].length - a[1].length)
        .slice(0, 8);
      starters.categorySummary = {
        hint: `项目定义了 ${categories.length} 个 Category — 关注命名前缀、功能归类、与基类的关系`,
        data: topBases.map(([base, cats]) => ({
          baseClass: base,
          categoryCount: cats.length,
          categories: cats.slice(0, 5),
        })),
      };
    }
  }

  // §5: 事件/数据流关联 — 为 event-and-data-flow 提供起始证据
  if (
    astData &&
    (dimId === 'event-and-data-flow' ||
      dimId === 'data-flow-patterns' ||
      dimKeywords.includes('事件') ||
      dimKeywords.includes('event') ||
      dimKeywords.includes('数据流'))
  ) {
    const protocols = astData.protocols || [];
    // 查找 Delegate/DataSource 协议 — ObjC/Swift 的典型事件/数据流模式
    const delegateProtocols = protocols.filter((p: AstProtocolInfo) => {
      const name = (p.name || '').toLowerCase();
      return name.includes('delegate') || name.includes('datasource');
    });
    if (delegateProtocols.length > 0) {
      starters.delegatePatterns = {
        hint: `发现 ${delegateProtocols.length} 个 Delegate/DataSource 协议 — 项目的核心事件/数据传递通道`,
        data: delegateProtocols.slice(0, 8).map((p: AstProtocolInfo) => ({
          name: p.name,
          methods: p.methodCount || p.methods?.length || 0,
        })),
      };
    }
    // 查找 Notification/Observer 相关类
    const classes = astData.classes || [];
    const observerClasses = classes.filter((c: AstClassInfo) => {
      const name = (c.name || '').toLowerCase();
      return name.includes('observer') || name.includes('notification') || name.includes('event');
    });
    if (observerClasses.length > 0) {
      starters.observerPatterns = {
        hint: `发现 ${observerClasses.length} 个 Observer/Notification/Event 类`,
        data: observerClasses.slice(0, 5).map((c: AstClassInfo) => c.name),
      };
    }
  }

  // §6: 调用图证据 — 为 best-practice / event-and-data-flow / code-pattern 提供热点方法
  if (callGraphResult) {
    const callEdges = (callGraphResult as Record<string, unknown>).edgesCreated as
      | number
      | undefined;
    const methodEntities = (callGraphResult as Record<string, unknown>).entitiesUpserted as
      | number
      | undefined;
    if (
      callEdges &&
      callEdges > 0 &&
      (dimId === 'best-practice' ||
        dimId === 'event-and-data-flow' ||
        dimId === 'code-pattern' ||
        dimKeywords.includes('并发') ||
        dimKeywords.includes('concurrency') ||
        dimKeywords.includes('事件') ||
        dimKeywords.includes('flow'))
    ) {
      starters.callGraphSummary = {
        hint: `调用图包含 ${methodEntities || 0} 个方法实体、${callEdges} 条调用边 — 关注高扇入/扇出方法和异步调用链`,
        data: {
          methodEntities: methodEntities || 0,
          callEdges,
          durationMs: (callGraphResult as Record<string, unknown>).durationMs || 0,
          analysisHint:
            dimId === 'best-practice'
              ? '关注扇入最高的方法（核心抽象）和扇出最高的方法（协调者），以及 async/await 调用链'
              : dimId === 'event-and-data-flow'
                ? '关注数据流边和事件传播路径，特别是跨模块的观察者和回调链'
                : '关注方法调用模式中的设计模式（如 Template Method、Chain of Responsibility）',
        },
      };
    }
  }

  // §7: Panorama 热点模块 — 为 architecture / project-profile 提供耦合分析起点
  if (panoramaResult) {
    const panoramaModules = panoramaResult.modules as
      | Map<string, { name: string; fanIn: number; fanOut: number }>
      | undefined;
    const panoramaCycles =
      (panoramaResult.cycles as Array<{ cycle: string[]; severity: string }>) ?? [];

    if (
      panoramaModules instanceof Map &&
      (dimId === 'architecture' ||
        dimId === 'project-profile' ||
        dimId === 'best-practice' ||
        dimKeywords.includes('架构') ||
        dimKeywords.includes('模块') ||
        dimKeywords.includes('耦合'))
    ) {
      // 提取高耦合模块（fanIn+fanOut 排序）
      const hotspots: { module: string; fanIn: number; fanOut: number }[] = [];
      for (const [, mod] of panoramaModules) {
        if (mod.fanIn >= 5 || mod.fanOut >= 5) {
          hotspots.push({ module: mod.name, fanIn: mod.fanIn, fanOut: mod.fanOut });
        }
      }
      hotspots.sort((a, b) => b.fanIn + b.fanOut - (a.fanIn + a.fanOut));
      if (hotspots.length > 0) {
        starters.couplingHotspots = {
          hint: `全景分析发现 ${hotspots.length} 个高耦合模块 — 优先分析其架构边界和依赖方向`,
          data: hotspots
            .slice(0, 8)
            .map((h) => `${h.module} (fanIn=${h.fanIn}, fanOut=${h.fanOut})`),
        };
      }
    }

    // 循环依赖 → architecture / best-practice
    if (
      panoramaCycles.length > 0 &&
      (dimId === 'architecture' ||
        dimId === 'best-practice' ||
        dimKeywords.includes('架构') ||
        dimKeywords.includes('依赖'))
    ) {
      starters.cyclicDependencies = {
        hint: `全景分析检测到 ${panoramaCycles.length} 组循环依赖 — 需要在分析中识别并记录`,
        data: panoramaCycles.slice(0, 5).map((c) => ({
          cycle: c.cycle.join(' → '),
          severity: c.severity,
        })),
      };
    }
  }

  if (Object.keys(starters).length === 0) {
    return undefined;
  }

  // §8: 信号强度评估 — 根据数据显著性为每个 starter 附加 strength (0-100)
  const withStrength: Record<string, { hint: string; data: unknown; strength: number }> = {};
  for (const [key, value] of Object.entries(starters)) {
    let strength = 50; // 默认中等
    const dataArr = Array.isArray(value.data) ? value.data : null;
    const dataCount = dataArr ? dataArr.length : 0;

    // 统计类 starters — 数据量越大信号越强
    if (key === 'namingPrefixSuffix' || key === 'patternStats' || key === 'inheritanceChains') {
      strength = Math.min(90, 40 + dataCount * 10);
    } else if (key === 'guardViolations') {
      // Guard 违规 — 越多越值得关注
      const violations = (value.data as { totalViolations?: number })?.totalViolations || dataCount;
      strength = Math.min(95, 50 + violations * 5);
    } else if (key === 'crossFileViolations') {
      // 跨文件违规 — 高优先级信号（涉及架构边界）
      strength = Math.min(95, 75 + dataCount * 8);
    } else if (key === 'callGraphSummary') {
      const edges = (value.data as { callEdges?: number })?.callEdges ?? 0;
      strength = edges > 50 ? 85 : edges > 10 ? 70 : 55;
    } else if (key === 'couplingHotspots') {
      strength = Math.min(90, 60 + dataCount * 8);
    } else if (key === 'cyclicDependencies') {
      strength = Math.min(95, 70 + dataCount * 10); // 循环依赖是高优先级信号
    } else if (key === 'delegatePatterns' || key === 'observerPatterns') {
      strength = Math.min(85, 45 + dataCount * 8);
    } else if (key === 'depGraph') {
      strength = 60;
    }

    withStrength[key] = { ...value, strength };
  }

  // 按 strength 降序排列（通过 entries+sort 重构对象键顺序）
  const sorted = Object.fromEntries(
    Object.entries(withStrength).sort(([, a], [, b]) => b.strength - a.strength)
  );

  return sorted;
}

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

  const summary = `${classes.length} classes, ${protocols.length} protocols, ${categories.length} categories, ${astProjectSummary.projectMetrics?.totalMethods || 0} methods`;

  // 压缩 patternStats: 保留计数，移除详细列表
  const rawPatterns = astProjectSummary.patternStats || {};
  const compressedPatterns: Record<string, PatternValue> = {};
  for (const [key, val] of Object.entries(rawPatterns)) {
    if (typeof val === 'number' || typeof val === 'string' || typeof val === 'boolean') {
      compressedPatterns[key] = val;
    } else if (Array.isArray(val)) {
      compressedPatterns[key] = val.length; // 数组 → 计数
    } else if (val && typeof val === 'object') {
      // 嵌套对象: 保留 count/总数，或递归压缩为浅层概要
      const sub: Record<string, number | string | boolean> = {};
      for (const [sk, sv] of Object.entries(val)) {
        if (typeof sv === 'number' || typeof sv === 'string' || typeof sv === 'boolean') {
          sub[sk] = sv;
        } else if (Array.isArray(sv)) {
          sub[sk] = sv.length;
        } else if (sv && typeof sv === 'object') {
          sub[sk] = Object.keys(sv).length; // 深层对象 → key 计数
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

// ── 执行计划构建 ─────────────────────────────────────────────

/**
 * 根据激活的维度构建执行计划
 * @param activeDimensions 激活的维度定义
 * @returns executionPlan 对象
 */
function buildExecutionPlan(activeDimensions: DimensionDef[]) {
  const scheduler = new TierScheduler();
  const tiers = scheduler.getTiers();
  const activeDimIds = new Set(activeDimensions.map((d: DimensionDef) => d.id));

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
        tier: index + 1, // 1-based, 与 tier-scheduler.js 一致
        label: tierLabels[index] || `Tier ${index + 1}`,
        dimensions: filteredDims,
        note: tierNotes[index] || '',
      };
    })
    .filter(Boolean);

  // 处理不在任何 tier 中的维度（Enhancement Pack 追加的）— 按 tierHint 归入
  const scheduledIds = new Set(tiers.flat());
  const unscheduled = activeDimensions.filter((d: DimensionDef) => !scheduledIds.has(d.id));
  if (unscheduled.length > 0 && plan.length > 0) {
    for (const dim of unscheduled) {
      const hint = typeof dim.tierHint === 'number' ? dim.tierHint : 1;
      const targetIdx = Math.max(0, Math.min(hint - 1, plan.length - 1));
      plan[targetIdx]?.dimensions.push(dim.id);
    }
  }

  return {
    tiers: plan,
    totalDimensions: activeDimensions.length,
    workflow:
      '对每个维度: (1) 用你的原生能力阅读代码分析 → (2) 调用 autosnippet_submit_knowledge_batch 批量提交候选（**每维度最少 3 条，目标 5 条**，将不同关注点拆分为独立候选，1-2 条视为不合格） → (3) 调用 autosnippet_dimension_complete 完成维度（必须传 referencedFiles=[分析过的文件路径] 和 keyFindings=[3-5条关键发现]）',
  };
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
}: MissionBriefingParams) {
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
      const dimPlan = incrementalPlan.dimensions?.find((d) => d.id === dim.id);
      if (dimPlan?.status) {
        task.status = dimPlan.status; // 'pending' | 'skipped-incremental' | 'completed-checkpoint'
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
  const briefing: MissionBriefing = {
    projectMeta,

    ast: compressAstForBriefing(astData ?? null, (projectMeta.fileCount as number) || 0),

    codeEntityGraph: summarizeEntityGraph(codeEntityResult ?? null),

    callGraph: summarizeCallGraph(callGraphResult ?? null),

    dependencyGraph: depGraphData
      ? {
          nodes: (depGraphData.nodes || []).map((n: string | DependencyNode) => ({
            id: typeof n === 'string' ? n : n.id || '',
            label: typeof n === 'string' ? n : n.label || '',
            fileCount: typeof n === 'string' ? undefined : n.fileCount,
          })),
          edges: (depGraphData.edges || []).slice(0, 100), // 限制边数
        }
      : null,

    guardFindings: summarizeGuardFindings(guardAudit ?? null),

    targets: (targets || []).map((t: string | TargetInfo) => ({
      name: typeof t === 'string' ? t : t.name,
      type: typeof t === 'string' ? 'target' : t.type || 'target',
      inferredRole: typeof t === 'string' ? undefined : t.inferredRole,
      fileCount: typeof t === 'string' ? undefined : t.fileCount,
    })),

    dimensions,

    // §7.1: 语言扩展信息 (反模式、Guard 规则、Agent 注意事项)
    languageExtension: languageExtension || null,

    submissionSchema: {
      ...SUBMISSION_SCHEMA,
      example,
    },

    // 完整语言统计（按文件扩展名计数）
    languageStats: languageStats || null,

    executionPlan: buildExecutionPlan(activeDimensions),

    panorama: summarizePanorama(panoramaResult ?? null),

    // 本地子包/模块 — 必须覆盖的基础设施模块
    mustCoverModules: buildMustCoverModules(localPackageModules),

    session: session.toJSON(),
  };

  // ── 体积检测 + 渐进式压缩 ──
  const json = JSON.stringify(briefing);
  const sizeKB = Math.round(json.length / 1024);

  briefing.meta = {
    responseSizeKB: sizeKB,
    compressionLevel: briefing.ast.compressionLevel || 'none',
  };

  // 渐进式压缩: 先做低代价压缩 (Level 1-3)，重新检测后再决定是否做高代价压缩 (Level 4-5)
  if (json.length > RESPONSE_SIZE_LIMIT) {
    // ── Level 1-3: 低代价压缩 (裁剪数据量，保留结构) ──
    // Level 1: 裁剪 dependencyGraph edges
    if ((briefing.dependencyGraph?.edges?.length ?? 0) > 30) {
      briefing.dependencyGraph!.edges = briefing.dependencyGraph!.edges.slice(0, 30);
    }
    // Level 2: 减少 AST classes
    if (briefing.ast.classes.length > 20) {
      briefing.ast.classes = briefing.ast.classes.slice(0, 20);
    }
    // Level 3: 压缩 protocols
    if (briefing.ast.protocols.length > 10) {
      briefing.ast.protocols = briefing.ast.protocols.slice(0, 10).map((p) => ({
        name: p.name,
        methodCount: p.methodCount,
      }));
    }
    // Level 3.5: 进一步压缩 AST 数据 (裁剪 conformers/protocols 列表、categories)
    for (const cls of briefing.ast.classes) {
      if ((cls.protocols?.length ?? 0) > 3) {
        cls.protocols = cls.protocols!.slice(0, 3);
      }
      delete cls.file; // 文件路径可省略
    }
    for (const p of briefing.ast.protocols) {
      if ((p.conformers?.length ?? 0) > 3) {
        p.conformers = p.conformers!.slice(0, 3);
      }
      delete p.file;
    }
    if ((briefing.ast.categories?.length ?? 0) > 5) {
      briefing.ast.categories = briefing.ast.categories!.slice(0, 5);
    }
    // 删除 metrics 中的详细列表
    if (briefing.ast.metrics?.complexMethods) {
      delete briefing.ast.metrics.complexMethods;
    }
    if (briefing.ast.metrics?.longMethods) {
      delete briefing.ast.metrics.longMethods;
    }

    // 检查 Level 1-3 后体积是否已达标
    const midSize = JSON.stringify(briefing).length;
    if (midSize <= RESPONSE_SIZE_LIMIT) {
      // Level 1-3 已充分 — 保留 SOP 和 evidenceStarters
      briefing.meta.responseSizeKB = Math.round(midSize / 1024);
      briefing.meta.compressionLevel = 'moderate';
    } else {
      // ── Level 4-5: 高代价压缩 (移除辅助数据) ──
      // Level 4: 移除 evidenceStarters (体积优先)
      for (const dim of briefing.dimensions) {
        delete dim.evidenceStarters;
      }
      // Level 5: SOP 降级为紧凑文本 + 移除 FAIL_EXAMPLES
      for (const dim of briefing.dimensions) {
        if (dim.analysisGuide && typeof dim.analysisGuide === 'object') {
          dim.analysisGuide = sopToCompactText(dim.analysisGuide);
        }
        if (dim.submissionSpec?.preSubmitChecklist?.FAIL_EXAMPLES) {
          delete dim.submissionSpec.preSubmitChecklist.FAIL_EXAMPLES;
        }
      }
      const newSize = JSON.stringify(briefing).length;
      briefing.meta.responseSizeKB = Math.round(newSize / 1024);
      briefing.meta.compressionLevel = 'aggressive';
    }

    briefing.meta.warnings = briefing.meta.warnings || [];
    briefing.meta.warnings.push(
      `Response compressed from ${sizeKB}KB to ${briefing.meta.responseSizeKB}KB`
    );
  }

  return briefing;
}
