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

import { TierScheduler } from './pipeline/tier-scheduler.js';
import { SUBMISSION_SCHEMA, EXAMPLE_TEMPLATES } from './shared/dimension-text.js';
import { getDimensionSOP, sopToCompactText, PRE_SUBMIT_CHECKLIST } from './shared/dimension-sop.js';
import { PROJECT_SNAPSHOT_STYLE_GUIDE } from '../../../../shared/StyleGuide.js';
import { getCursorDeliverySpec } from '../../../../shared/FieldSpec.js';

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
 * @param {object} dim - base-dimensions.js 中的维度定义
 * @param {number} tier 维度所在 tier 编号 (1/2/3)
 * @returns {object} - Mission Briefing 维度任务对象
 */
function enrichDimensionTask(dim, tier) {
  // ── analysisGuide: SOP 化 — 优先使用维度专属 SOP，否则回退通用指引 ──
  const sop = getDimensionSOP(dim.id);
  let analysisGuide;

  if (sop) {
    // SOP 结构化模式: steps + timeEstimate + commonMistakes
    analysisGuide = {
      goal: `分析项目的${dim.label}`,
      focus: dim.guide,
      steps: sop.steps,
      timeEstimate: sop.timeEstimate || '1-5 min',
      commonMistakes: sop.commonMistakes || [],
    };
  } else {
    // 无显式 SOP 的维度 (Enhancement Pack 等): 自动生成结构化 SOP
    // 保持 analysisGuide 为对象格式，确保 SOP 覆盖率
    analysisGuide = {
      goal: `分析项目的${dim.label}`,
      focus: dim.guide,
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
          action: '按项目特写格式提交 3-5 个知识候选',
          qualityChecklist: [
            '每个 content ≥200 字符',
            '每个候选引用 ≥3 个文件路径',
            'coreCode 提供可复制的完整代码骨架',
          ],
        },
      ],
      timeEstimate: '1-5 min',
      commonMistakes: [
        '不要只扫描 1 个文件就提交 — 至少读 5+ 个文件验证模式一致性',
        'content 中必须有 (来源: FileName.ext:行号) 标注具体出处',
      ],
    };
  }

  // ── submissionSpec: 嵌入 Quality Checklist ──
  const submissionSpec = {
    knowledgeTypes: dim.knowledgeTypes || [],
    targetCandidateCount: '3-5',
    contentStyle: PROJECT_SNAPSHOT_STYLE_GUIDE.split('\n')
      .filter(l => !l.startsWith('#') || l.startsWith('##'))
      .filter(l => l.trim())
      .slice(0, 12)
      .join('\n'),
    contentQuality:
      'content.markdown 必须 ≥200 字符，包含: (1) ## 标题 (2) 正文说明 (3) 至少一个 ```代码块``` (4) 来源标注「(来源: FileName.ext:行号)」。短于 200 字符的提交会被拒绝。\n【禁止】标题和正文中不得出现 "Agent" 字样 — 所有候选必须以项目规范/开发规范的视角撰写，描述的是项目规则而非 AI Agent 指南。',
    cursorFields: getCursorDeliverySpec(),
    dimensionCompleteGuide:
      '调用 dimension_complete 时必须传递: referencedFiles=[本维度分析过的全部文件路径], keyFindings=[3-5条关键发现摘要], analysisText=详细分析报告(≥500字符,含##标题+列表+代码块)',
    preSubmitChecklist: PRE_SUBMIT_CHECKLIST,
  };

  // ── skillMeta ──
  const skillMeta = dim.skillWorthy
    ? {
        name: dim.skillMeta?.name || `project-${dim.id}`,
        description: dim.skillMeta?.description || `${dim.label} skill (auto-generated)`,
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
 * @param {object} dim 维度定义
 * @param {object} opts
 * @param {object} [opts.astData] - analyzeProject() 结果
 * @param {object} [opts.guardAudit] - GuardCheckEngine.auditFiles() 结果
 * @param {object} [opts.depGraphData] 依赖图
 * @returns {object|undefined} - evidenceStarters 对象，为空则返回 undefined
 */
function buildEvidenceStarters(dim, { astData, guardAudit, depGraphData }) {
  const starters = {};
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
    if (dimId === 'naming-conventions' || dimId === 'code-standard' || dimKeywords.includes('命名') || dimKeywords.includes('naming')) {
      const prefixStats = {};
      for (const cls of classes) {
        const prefix = (cls.name || '').match(/^[A-Z]{2,4}/)?.[0];
        if (prefix) {
          prefixStats[prefix] = (prefixStats[prefix] || 0) + 1;
        }
      }
      // 函数式代码: 统计顶层函数命名模式 (useXxx, handleXxx, getXxx, etc.)
      if (classes.length === 0) {
        const funcPrefixes = {};
        for (const fs of fileSummaries) {
          for (const m of fs.methods || []) {
            if (!m.className) {
              const fp = (m.name || '').match(/^(use|handle|get|set|create|make|fetch|on|is|has|with|to)[A-Z]/)?.[1];
              if (fp) funcPrefixes[fp] = (funcPrefixes[fp] || 0) + 1;
            }
          }
        }
        const topFuncPrefixes = Object.entries(funcPrefixes)
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
          data: Object.entries(prefixStats)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([prefix, count]) => `${prefix}* (${count} classes)`),
        };
      }
    }

    // patterns-architecture → 设计模式 + 继承链 + 函数式模式
    if (dimId === 'patterns-architecture' || dimId === 'architecture' || dimId === 'code-pattern' ||
        dimKeywords.includes('架构') || dimKeywords.includes('pattern') || dimKeywords.includes('模式')) {
      if (Object.keys(patterns).length > 0) {
        // 压缩 patterns: 只保留顶层 key → 计数/类型摘要
        const compactPatterns = {};
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
      const baseClasses = {};
      for (const cls of classes) {
        if (cls.superclass) {
          baseClasses[cls.superclass] = (baseClasses[cls.superclass] || 0) + 1;
        }
      }
      const topBases = Object.entries(baseClasses)
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
    if (dimKeywords.includes('protocol') || dimKeywords.includes('协议') || dimKeywords.includes('interface')) {
      if (protocols.length > 0) {
        starters.protocolSummary = {
          hint: `项目定义了 ${protocols.length} 个协议/接口`,
          data: protocols.slice(0, 8).map((p) => ({
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
      const exportCount = fileSummaries.reduce((s, f) => s + (f.exports?.length || 0), 0);
      const asyncCount = fileSummaries.reduce((s, f) =>
        s + (f.methods || []).filter(m => m.isAsync).length, 0);
      const complexMethods = astData.projectMetrics?.complexMethods || [];

      if (dimId === 'code-pattern' || dimId === 'best-practice' || dimId === 'event-and-data-flow' ||
          dimKeywords.includes('模式') || dimKeywords.includes('实践') || dimKeywords.includes('事件')) {
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
    const dimRelatedViolations = [];
    for (const fileResult of guardAudit.files) {
      for (const v of fileResult.violations || []) {
        // 粗略匹配: ruleId / message 是否与维度话题相关
        const ruleText = `${v.ruleId || ''} ${v.message || ''}`.toLowerCase();
        if (dimId.split('-').some((word) => word.length > 3 && ruleText.includes(word))) {
          dimRelatedViolations.push({
            file: fileResult.filePath,
            rule: v.ruleId,
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
  }

  // §3: 依赖图关联 (扩大到所有架构/模块相关维度)
  if (depGraphData?.nodes) {
    const nodeCount = (depGraphData.nodes || []).length;
    const edgeCount = (depGraphData.edges || []).length;
    if (nodeCount > 0 && (
      dimId === 'patterns-architecture' || dimId === 'architecture' || dimId === 'data-flow-patterns' ||
      dimId === 'project-profile' || dimId === 'module-export-scan' ||
      dimKeywords.includes('架构') || dimKeywords.includes('模块') || dimKeywords.includes('依赖')
    )) {
      starters.dependencyOverview = {
        hint: `依赖图包含 ${nodeCount} 个模块、${edgeCount} 条依赖 — 分析模块间耦合关系`,
        data: {
          totalModules: nodeCount,
          totalEdges: edgeCount,
          topModules: (depGraphData.nodes || [])
            .slice(0, 5)
            .map((n) => (typeof n === 'string' ? n : n.label || n.id)),
        },
      };
    }
  }

  // §4: ObjC Category 关联 — 为 category-scan 和相关维度提供分类证据
  if (astData) {
    const categories = astData.categories || [];
    if (categories.length > 0 && (
      dimId === 'category-scan' || dimId === 'category-extension' ||
      dimKeywords.includes('category') || dimKeywords.includes('分类') || dimKeywords.includes('extension')
    )) {
      // 按 baseClass 聚合分类
      const catByBase = {};
      for (const cat of categories) {
        const base = cat.baseClass || cat.extendedClass || 'Unknown';
        if (!catByBase[base]) catByBase[base] = [];
        catByBase[base].push(cat.name || '(anonymous)');
      }
      const topBases = Object.entries(catByBase)
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
  if (astData && (
    dimId === 'event-and-data-flow' || dimId === 'data-flow-patterns' ||
    dimKeywords.includes('事件') || dimKeywords.includes('event') || dimKeywords.includes('数据流')
  )) {
    const protocols = astData.protocols || [];
    // 查找 Delegate/DataSource 协议 — ObjC/Swift 的典型事件/数据流模式
    const delegateProtocols = protocols.filter(p => {
      const name = (p.name || '').toLowerCase();
      return name.includes('delegate') || name.includes('datasource');
    });
    if (delegateProtocols.length > 0) {
      starters.delegatePatterns = {
        hint: `发现 ${delegateProtocols.length} 个 Delegate/DataSource 协议 — 项目的核心事件/数据传递通道`,
        data: delegateProtocols.slice(0, 8).map(p => ({
          name: p.name,
          methods: p.methodCount || p.methods?.length || 0,
        })),
      };
    }
    // 查找 Notification/Observer 相关类
    const classes = astData.classes || [];
    const observerClasses = classes.filter(c => {
      const name = (c.name || '').toLowerCase();
      return name.includes('observer') || name.includes('notification') || name.includes('event');
    });
    if (observerClasses.length > 0) {
      starters.observerPatterns = {
        hint: `发现 ${observerClasses.length} 个 Observer/Notification/Event 类`,
        data: observerClasses.slice(0, 5).map(c => c.name),
      };
    }
  }

  return Object.keys(starters).length > 0 ? starters : undefined;
}

// ── AST 压缩 ────────────────────────────────────────────────

/**
 * 压缩 AST 数据以控制 Mission Briefing 体积
 *
 * @param {object|null} astProjectSummary - analyzeProject() 返回值
 * @param {number} fileCount 项目文件数
 * @returns {object} 压缩后的 AST 数据
 */
function compressAstForBriefing(astProjectSummary, fileCount) {
  if (!astProjectSummary) {
    return { available: false, classes: [], protocols: [], categories: [], patterns: {} };
  }

  const classes = astProjectSummary.classes || [];
  const protocols = astProjectSummary.protocols || [];
  const categories = astProjectSummary.categories || [];

  // 确定压缩级别
  let topN;
  let compressionLevel;
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
      for (const p of (c.protocols || c.conformedProtocols || [])) {
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

  const compressedProtocols = protocols.slice(0, topN).map((p) => ({
    name: p.name,
    file: p.file || p.relativePath || null,
    methodCount: p.methodCount || p.methods?.length || 0,
    conformers: p.conformers || [],
  }));

  const compressedCategories = categories.slice(0, topN).map((cat) => ({
    baseClass: cat.baseClass || cat.extendedClass,
    name: cat.name,
    file: cat.file || cat.relativePath || null,
    methods: (cat.methods || []).map((m) => (typeof m === 'string' ? m : m.name)).slice(0, 10),
  }));

  const summary = `${classes.length} classes, ${protocols.length} protocols, ${categories.length} categories, ${astProjectSummary.projectMetrics?.totalMethods || 0} methods`;

  // 压缩 patternStats: 保留计数，移除详细列表
  const rawPatterns = astProjectSummary.patternStats || {};
  const compressedPatterns = {};
  for (const [key, val] of Object.entries(rawPatterns)) {
    if (typeof val === 'number' || typeof val === 'string' || typeof val === 'boolean') {
      compressedPatterns[key] = val;
    } else if (Array.isArray(val)) {
      compressedPatterns[key] = val.length; // 数组 → 计数
    } else if (val && typeof val === 'object') {
      // 嵌套对象: 保留 count/总数，或递归压缩为浅层概要
      const sub = {};
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

/**
 * 压缩 Code Entity Graph
 */
function summarizeEntityGraph(codeEntityResult) {
  if (!codeEntityResult) return null;
  return {
    totalEntities: codeEntityResult.entitiesUpserted || 0,
    totalEdges: codeEntityResult.edgesCreated || 0,
  };
}

/**
 * 压缩 Call Graph 结果
 * @param {object|null} callGraphResult - CodeEntityGraph.populateCallGraph() 返回值
 * @returns {object|null}
 */
function summarizeCallGraph(callGraphResult) {
  if (!callGraphResult) return null;
  return {
    methodEntities: callGraphResult.entitiesUpserted || 0,
    callEdges: callGraphResult.edgesCreated || 0,
    durationMs: callGraphResult.durationMs || 0,
  };
}

/**
 * 压缩 Guard 审计结果
 */
function summarizeGuardFindings(guardAudit) {
  if (!guardAudit) return null;

  // 按 ruleId 聚合 violations
  const ruleMap = {};

  // helper: 将单个 violation 累加到 ruleMap
  const addViolation = (v, examplePrefix) => {
    if (!ruleMap[v.ruleId]) {
      ruleMap[v.ruleId] = { ruleId: v.ruleId, count: 0, example: null };
    }
    ruleMap[v.ruleId].count++;
    if (!ruleMap[v.ruleId].example) {
      ruleMap[v.ruleId].example = `${examplePrefix} — ${v.message}`;
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

  return {
    totalViolations,
    errors: totalErrors,
    warnings: totalViolations - totalErrors,
    topViolations,
  };
}

// ── 执行计划构建 ─────────────────────────────────────────────

/**
 * 根据激活的维度构建执行计划
 * @param {Array} activeDimensions 激活的维度定义
 * @returns {object} - executionPlan 对象
 */
function buildExecutionPlan(activeDimensions) {
  const scheduler = new TierScheduler();
  const tiers = scheduler.getTiers();
  const activeDimIds = new Set(activeDimensions.map((d) => d.id));

  const tierLabels = ['基础数据层', '规范 + 架构 + 模式', '流转 + 实践 + 总结'];
  const tierNotes = [
    '这些维度相互独立，可以任意顺序分析。产出的上下文将帮助后续维度。',
    '建议利用 Tier 1 中了解到的项目结构和代码特征。',
    'agent-guidelines 应在最后分析 — 综合前序所有维度的发现。',
  ];

  const plan = tiers
    .map((tierDimIds, index) => {
      const filteredDims = tierDimIds.filter((id) => activeDimIds.has(id));
      if (filteredDims.length === 0) return null;
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
  const unscheduled = activeDimensions.filter((d) => !scheduledIds.has(d.id));
  if (unscheduled.length > 0 && plan.length > 0) {
    for (const dim of unscheduled) {
      const hint = typeof dim.tierHint === 'number' ? dim.tierHint : 1;
      const targetIdx = Math.max(0, Math.min(hint - 1, plan.length - 1));
      plan[targetIdx].dimensions.push(dim.id);
    }
  }

  return {
    tiers: plan,
    totalDimensions: activeDimensions.length,
    workflow:
      '对每个维度: (1) 用你的原生能力阅读代码分析 → (2) 调用 autosnippet_submit_knowledge_batch 批量提交 3-5 条候选 → (3) 调用 autosnippet_dimension_complete 完成维度（必须传 referencedFiles=[分析过的文件路径] 和 keyFindings=[3-5条关键发现]）',
  };
}

// ── Mission Briefing 主构建函数 ──────────────────────────────

/**
 * 构建 Mission Briefing
 *
 * @param {object} opts
 * @param {object} opts.projectMeta     项目元数据
 * @param {object} opts.astData         - analyzeProject() 原始结果
 * @param {object} opts.codeEntityResult - CodeEntityGraph.populateFromAst() 结果
 * @param {object} opts.depGraphData    - discoverer.getDependencyGraph() 结果
 * @param {object} opts.guardAudit      - GuardCheckEngine.auditFiles() 结果
 * @param {Array}  opts.targets         - allTargets 列表
 * @param {Array}  opts.activeDimensions - resolveActiveDimensions() 结果
 * @param {object[]} opts.skills        已加载的 bootstrap skills
 * @param {object} opts.session         - BootstrapSession 实例
 * @returns {object} - Mission Briefing 响应数据
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
  languageExtension,  // §7.1: 语言扩展（反模式、Guard 规则、Agent 注意事项）
  incrementalPlan,    // §7.3: 增量 Bootstrap 评估结果
  languageStats,      // §7.4: 完整语言分布统计
}) {
  const scheduler = new TierScheduler();

  // ── 构建维度任务列表 (v2: 附带 evidenceStarters) ──
  const dimensions = activeDimensions.map((dim) => {
    const tierIndex = scheduler.getTierIndex(dim.id);
    // 优先使用 DEFAULT_TIERS 定义；未定义则取 tierHint；兜底 Tier 1
    const tier = tierIndex >= 0 ? tierIndex + 1 : (typeof dim.tierHint === 'number' ? dim.tierHint : 1);
    const task = enrichDimensionTask(dim, tier);

    // §7.3: 增量 Bootstrap — 标记维度状态
    if (incrementalPlan) {
      const dimPlan = incrementalPlan.dimensions?.find(d => d.id === dim.id);
      if (dimPlan?.status) {
        task.status = dimPlan.status; // 'pending' | 'skipped-incremental' | 'completed-checkpoint'
      }
    }

    // v2: 从 Phase 1-4 数据中提取维度相关的证据启发
    const evidenceStarters = buildEvidenceStarters(dim, { astData, guardAudit, depGraphData });
    if (evidenceStarters) {
      task.evidenceStarters = evidenceStarters;
    }

    return task;
  });

  // ── 选择语言自适应的 example ──
  const lang = projectMeta.primaryLanguage || 'text';
  const example =
    EXAMPLE_TEMPLATES[lang] || EXAMPLE_TEMPLATES[lang.toLowerCase()] || EXAMPLE_TEMPLATES._default;

  // ── 组装 ──
  const briefing = {
    projectMeta,

    ast: compressAstForBriefing(astData, projectMeta.fileCount || 0),

    codeEntityGraph: summarizeEntityGraph(codeEntityResult),

    callGraph: summarizeCallGraph(callGraphResult),

    dependencyGraph: depGraphData
      ? {
          nodes: (depGraphData.nodes || []).map((n) => ({
            id: typeof n === 'string' ? n : n.id,
            label: typeof n === 'string' ? n : n.label,
            fileCount: n.fileCount || undefined,
          })),
          edges: (depGraphData.edges || []).slice(0, 100), // 限制边数
        }
      : null,

    guardFindings: summarizeGuardFindings(guardAudit),

    targets: (targets || []).map((t) => ({
      name: typeof t === 'string' ? t : t.name,
      type: t.type || 'target',
      inferredRole: t.inferredRole || undefined,
      fileCount: t.fileCount || undefined,
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
    if (briefing.dependencyGraph?.edges?.length > 30) {
      briefing.dependencyGraph.edges = briefing.dependencyGraph.edges.slice(0, 30);
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
      if (cls.protocols?.length > 3) cls.protocols = cls.protocols.slice(0, 3);
      delete cls.file; // 文件路径可省略
    }
    for (const p of briefing.ast.protocols) {
      if (p.conformers?.length > 3) p.conformers = p.conformers.slice(0, 3);
      delete p.file;
    }
    if (briefing.ast.categories?.length > 5) {
      briefing.ast.categories = briefing.ast.categories.slice(0, 5);
    }
    // 删除 metrics 中的详细列表
    if (briefing.ast.metrics?.complexMethods) delete briefing.ast.metrics.complexMethods;
    if (briefing.ast.metrics?.longMethods) delete briefing.ast.metrics.longMethods;

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
