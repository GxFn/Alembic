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
 * 取自 AnalystAgent.buildAnalystPrompt() + DIMENSION_CONFIGS_V3 + ProducerAgent.STYLE_GUIDE
 *
 * @param {object} dim — base-dimensions.js 中的维度定义
 * @param {object[]} skills — 已加载的 bootstrap skills
 * @param {number} tier — 维度所在 tier 编号 (1/2/3)
 * @returns {object} — Mission Briefing 维度任务对象
 */
function enrichDimensionTask(dim, skills, tier) {
  // ── analysisGuide: SOP 化 — 优先使用维度专属 SOP，否则回退通用指引 ──
  const sop = getDimensionSOP(dim.id);
  let analysisGuide;

  if (sop) {
    // SOP 结构化模式: steps + timeEstimate + commonMistakes
    analysisGuide = {
      goal: `分析项目的${dim.label}`,
      focus: dim.guide,
      steps: sop.steps,
      timeEstimate: sop.timeEstimate || '10-15 min',
      commonMistakes: sop.commonMistakes || [],
    };
  } else {
    // 无 SOP 的维度: 保留原始文本指引（兼容新增维度未定义 SOP 的情况）
    analysisGuide = `分析项目的${dim.label}。\n\n重点关注:\n${dim.guide}\n\n分析要求:\n1. 在具体文件/类中验证发现（引用 ≥3 个文件路径）\n2. 说明具体实现方式和代码特征\n3. 解释设计意图\n4. 提供统计数据（数量、占比）\n5. 每个知识点独立描述，目标 3-5 个发现`;
  }

  // 如果有相关 skill，注入到 analysisGuide 中
  const relatedSkill = skills?.find(
    (s) => s.relatedDimension === dim.id || s.name === dim.skillMeta?.name
  );
  if (relatedSkill) {
    const skillHint = `参考已有 Skill (${relatedSkill.name}):\n${relatedSkill.content?.substring(0, 500) || ''}`;
    if (typeof analysisGuide === 'string') {
      analysisGuide += `\n\n${skillHint}`;
    } else {
      analysisGuide.referenceSkill = skillHint;
    }
  }

  // ── submissionSpec: 嵌入 Quality Checklist ──
  const submissionSpec = {
    knowledgeTypes: dim.knowledgeTypes || [],
    targetCandidateCount: '3-5',
    contentStyle:
      '融合基本用法与项目特征的「项目特写」。\n四大核心内容:\n1. 项目选择了什么 — 采用了哪种写法/模式/约定\n2. 为什么这样选 — 统计分布、占比、历史决策\n3. 项目禁止什么 — 反模式、已废弃写法\n4. 新代码怎么写 — 可直接复制的代码模板 + 来源标注',
    contentQuality:
      'content.markdown 必须 ≥200 字符，包含: (1) ## 标题 (2) 正文说明 (3) 至少一个 ```代码块``` (4) 来源标注「(来源: FileName.ext:行号)」。短于 200 字符的提交会被拒绝。\n【禁止】标题和正文中不得出现 "Agent" 字样 — 所有候选必须以项目规范/开发规范的视角撰写，描述的是项目规则而非 AI Agent 指南。',
    cursorFields: {
      trigger: '@前缀-kebab-case（每个候选唯一）',
      kind: 'rule=强制约束 | pattern=实现模式 | fact=项目事实',
      doClause: '【必填】英文祈使句 ≤60 tokens（以动词开头，概括正向规则）',
      dontClause: '【必填】英文反向约束（描述禁止的做法，如 Do not use raw alloc/init for Manager singletons）',
      whenClause: '【必填】英文触发场景（如 When creating or accessing singleton Manager instances）',
      coreCode: '【必填】3-8行纯代码骨架（语法完整、括号配对、可直接复制）',
    },
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
 * @param {object} dim — 维度定义
 * @param {object} opts
 * @param {object} [opts.astData] — analyzeProject() 结果
 * @param {object} [opts.guardAudit] — GuardCheckEngine.auditFiles() 结果
 * @param {object} [opts.depGraphData] — 依赖图
 * @returns {object|undefined} — evidenceStarters 对象，为空则返回 undefined
 */
function buildEvidenceStarters(dim, { astData, guardAudit, depGraphData }) {
  const starters = {};
  const dimId = dim.id;

  // §1: AST 相关发现
  if (astData) {
    const classes = astData.classes || [];
    const protocols = astData.protocols || [];
    const patterns = astData.patternStats || {};

    // 按维度话题匹配 AST 数据
    const dimLabel = (dim.label || '').toLowerCase();
    const dimGuide = (dim.guide || '').toLowerCase();
    const dimKeywords = `${dimLabel} ${dimGuide}`;

    // naming-conventions → 前缀/后缀统计
    if (dimId === 'naming-conventions' || dimKeywords.includes('命名') || dimKeywords.includes('naming')) {
      const prefixStats = {};
      for (const cls of classes) {
        const prefix = (cls.name || '').match(/^[A-Z]{2,4}/)?.[0];
        if (prefix) {
          prefixStats[prefix] = (prefixStats[prefix] || 0) + 1;
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

    // patterns-architecture → 设计模式 + 继承链
    if (dimId === 'patterns-architecture' || dimKeywords.includes('架构') || dimKeywords.includes('pattern')) {
      if (Object.keys(patterns).length > 0) {
        starters.detectedPatterns = {
          hint: 'AST 自动检测到的设计模式 — 作为架构分析起点',
          data: patterns,
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

  // §3: 依赖图关联 (针对特定维度)
  if (depGraphData?.nodes && (dimId === 'patterns-architecture' || dimId === 'data-flow-patterns')) {
    const nodeCount = (depGraphData.nodes || []).length;
    const edgeCount = (depGraphData.edges || []).length;
    if (nodeCount > 0) {
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

  return Object.keys(starters).length > 0 ? starters : undefined;
}

// ── AST 压缩 ────────────────────────────────────────────────

/**
 * 压缩 AST 数据以控制 Mission Briefing 体积
 *
 * @param {object|null} astProjectSummary — analyzeProject() 返回值
 * @param {number} fileCount — 项目文件数
 * @returns {object} — 压缩后的 AST 数据
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

  // 按 methodCount 降序排序，取 top-N
  const sortedClasses = [...classes]
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

  return {
    available: true,
    compressionLevel,
    summary,
    classes: compressedClasses,
    protocols: compressedProtocols,
    categories: compressedCategories,
    patterns: astProjectSummary.patternStats || {},
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
 * 压缩 Guard 审计结果
 */
function summarizeGuardFindings(guardAudit) {
  if (!guardAudit) return null;

  // 按 ruleId 聚合 violations
  const ruleMap = {};
  for (const fileResult of guardAudit.files || []) {
    for (const v of fileResult.violations || []) {
      if (!ruleMap[v.ruleId]) {
        ruleMap[v.ruleId] = { ruleId: v.ruleId, count: 0, example: null };
      }
      ruleMap[v.ruleId].count++;
      if (!ruleMap[v.ruleId].example) {
        ruleMap[v.ruleId].example = `${fileResult.filePath}:${v.line || '?'} — ${v.message}`;
      }
    }
  }

  // 取 top-5 violations
  const topViolations = Object.values(ruleMap)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  return {
    totalViolations: guardAudit.summary?.totalViolations || 0,
    errors: guardAudit.summary?.errors || 0,
    warnings: guardAudit.summary?.warnings || 0,
    topViolations,
  };
}

// ── 执行计划构建 ─────────────────────────────────────────────

/**
 * 根据激活的维度构建执行计划
 * @param {Array} activeDimensions — 激活的维度定义
 * @returns {object} — executionPlan 对象
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
 * @param {object} opts.projectMeta     — 项目元数据
 * @param {object} opts.astData         — analyzeProject() 原始结果
 * @param {object} opts.codeEntityResult — CodeEntityGraph.populateFromAst() 结果
 * @param {object} opts.depGraphData    — discoverer.getDependencyGraph() 结果
 * @param {object} opts.guardAudit      — GuardCheckEngine.auditFiles() 结果
 * @param {Array}  opts.targets         — allTargets 列表
 * @param {Array}  opts.activeDimensions — resolveActiveDimensions() 结果
 * @param {object[]} opts.skills        — 已加载的 bootstrap skills
 * @param {object} opts.session         — BootstrapSession 实例
 * @returns {object} — Mission Briefing 响应数据
 */
export function buildMissionBriefing({
  projectMeta,
  astData,
  codeEntityResult,
  depGraphData,
  guardAudit,
  targets,
  activeDimensions,
  skills,
  session,
}) {
  const scheduler = new TierScheduler();

  // ── 构建维度任务列表 (v2: 附带 evidenceStarters) ──
  const dimensions = activeDimensions.map((dim) => {
    const tierIndex = scheduler.getTierIndex(dim.id);
    // 优先使用 DEFAULT_TIERS 定义；未定义则取 tierHint；兜底 Tier 1
    const tier = tierIndex >= 0 ? tierIndex + 1 : (typeof dim.tierHint === 'number' ? dim.tierHint : 1);
    const task = enrichDimensionTask(dim, skills, tier);

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

    submissionSchema: {
      ...SUBMISSION_SCHEMA,
      example,
    },

    executionPlan: buildExecutionPlan(activeDimensions),

    session: session.toJSON(),
  };

  // ── 体积检测 + 降级 ──
  const json = JSON.stringify(briefing);
  const sizeKB = Math.round(json.length / 1024);

  briefing.meta = {
    responseSizeKB: sizeKB,
    compressionLevel: briefing.ast.compressionLevel || 'none',
  };

  // 如果超过 100KB，进一步压缩
  if (json.length > RESPONSE_SIZE_LIMIT) {
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
    // 更新 meta
    const newSize = JSON.stringify(briefing).length;
    briefing.meta.responseSizeKB = Math.round(newSize / 1024);
    briefing.meta.compressionLevel = 'aggressive';
    briefing.meta.warnings = briefing.meta.warnings || [];
    briefing.meta.warnings.push(
      `Response compressed from ${sizeKB}KB to ${briefing.meta.responseSizeKB}KB`
    );
  }

  return briefing;
}
