/**
 * noAiFallback.js — AI 不可用时的规则化降级知识提取
 *
 * 当 AgentRuntime / AI Provider 不可用时，从 Phase 1-4 的结构化数据中
 * 提取基础知识候选和 Project Skill，覆盖以下维度：
 *
 *   ✅ project-profile     — 从 langStats + depGraph + targets 构建项目技术画像
 *   ✅ architecture         — 从 depGraph + targets 推断层级/模块关系
 *   ✅ code-standard        — 从 AST 统计推断命名约定和代码风格
 *   ✅ best-practice        — 从 Guard 违规推断反模式
 *   ✅ agent-guidelines     — 从 Guard 高频违规 + 语言特性生成 Agent 注意事项
 *
 * 产出质量标注为 `source: 'rule-based-fallback'`，区别于 AI 分析产出。
 */

import Logger from '#infra/logging/Logger.js';

const logger = Logger.getInstance();

// ─── Local Types ──────────────────────────────────────────

interface FallbackDimension {
  id: string;
  label?: string;
  [key: string]: unknown;
}

interface DepGraphEdge {
  from?: string;
  to?: string;
  source?: string;
  target?: string;
}

interface DepGraphData {
  edges: DepGraphEdge[];
  nodes?: unknown[];
}

interface GuardViolation {
  ruleId: string;
  message: string;
  severity: string;
  fixSuggestion?: string | null;
  line?: number;
}

interface GuardAuditFile {
  filePath: string;
  violations: GuardViolation[];
}

interface GuardAuditData {
  files: GuardAuditFile[];
  summary?: { totalViolations?: number; totalErrors?: number };
}

interface AstMethodInfo {
  name: string;
  className?: string;
  isAsync?: boolean;
  complexity?: number;
  file?: string;
  line?: number;
  lines?: number;
  bodyLines?: number;
  [key: string]: unknown;
}

interface AstFileSummary {
  methods?: AstMethodInfo[];
  exports?: unknown[];
  [key: string]: unknown;
}

interface ProjectMetrics {
  totalMethods?: number;
  avgMethodsPerClass?: number;
  maxNestingDepth?: number;
  complexMethods?: AstMethodInfo[];
  longMethods?: AstMethodInfo[];
}

interface AstCategory {
  name?: string;
  baseClass?: string;
  className?: string;
  categoryName?: string;
  file?: string;
  [key: string]: unknown;
}

interface AstProjectSummary {
  classes?: Array<{ name: string; superclass?: string; file?: string; [key: string]: unknown }>;
  protocols?: Array<{ name: string; [key: string]: unknown }>;
  categories?: AstCategory[];
  files?: AstFileSummary[];
  projectMetrics?: ProjectMetrics;
  fileCount?: number;
}

interface TaskManagerLike {
  markTaskCompleted(dimId: string, opts: { type: string; reason: string }): void;
}

interface FileEntry {
  targetName?: string;
  name?: string;
  path?: string;
  [key: string]: unknown;
}

interface FillContext {
  dimensions: FallbackDimension[];
  depGraphData: DepGraphData | null;
  guardAudit: GuardAuditData | null;
  langStats: Record<string, number>;
  primaryLang: string;
  astProjectSummary: AstProjectSummary | null;
  taskManager: TaskManagerLike | null;
  sessionId: string | null;
  allFiles?: FileEntry[];
  targetFileMap?: Record<string, unknown>;
  [key: string]: unknown;
}

interface FallbackCandidate {
  title: string;
  content: { pattern: string; markdown: string; rationale: string };
  language: string;
  category: string;
  knowledgeType: string;
  source: string;
  difficulty: string;
  scope: string;
  trigger: string;
  doClause: string;
  dontClause: string;
  whenClause: string;
  coreCode: string;
  reasoning: { whyStandard: string; sources: string[]; confidence: number };
}

interface FallbackSkill {
  dimId: string;
  name: string;
  description: string;
  content: string;
}

interface CandidateParams {
  title: string;
  knowledgeType: string;
  category: string;
  language: string;
  markdown: string;
  rationale: string;
  coreCode: string;
  trigger: string;
  doClause: string;
  dontClause: string;
  whenClause: string;
  sources: string[];
}

/**
 * 主入口 — 当 AI 不可用时调用
 *
 * @param {object} fillContext 与 fillDimensionsV3 相同的上下文
 * @returns {Promise<{ candidates: object[], skills: object[], report: object }>}
 */
export async function runNoAiFallback(fillContext: FillContext) {
  const {
    // ctx and projectRoot are part of fillContext API but unused in fallback path
    dimensions,
    depGraphData,
    guardAudit,
    langStats,
    primaryLang,
    astProjectSummary,
    taskManager,
    sessionId,
  } = fillContext;

  const t0 = Date.now();
  logger.info('[Bootstrap-fallback] Starting rule-based fallback (no AI)');

  const candidates: FallbackCandidate[] = [];
  const skills: FallbackSkill[] = [];
  const report = {
    dimensionsProcessed: 0,
    candidatesCreated: 0,
    skillsCreated: 0,
    errors: [] as Array<{ dim: string; error: string }>,
  };

  // ── 收集原始数据 ──
  const allFiles = fillContext.allFiles || [];
  const targetFileMap = fillContext.targetFileMap || {};
  const allTargets = Object.keys(targetFileMap);

  // ── 1. Project Profile ──
  try {
    const profile = _buildProjectProfile({
      langStats,
      primaryLang,
      depGraphData,
      allTargets,
      allFiles,
      astProjectSummary,
    });
    if (profile) {
      candidates.push(profile);
      skills.push(_wrapAsSkill('project-profile', '项目技术画像', profile.content.markdown));
      report.candidatesCreated++;
      report.skillsCreated++;
    }
    _markDimDone(taskManager, sessionId, 'project-profile', 'fallback');
  } catch (e: unknown) {
    report.errors.push({
      dim: 'project-profile',
      error: e instanceof Error ? e.message : String(e),
    });
    _markDimDone(taskManager, sessionId, 'project-profile', 'error');
  }

  // ── 2. Architecture ──
  try {
    const arch = _buildArchitecture({
      depGraphData,
      allTargets,
      targetFileMap,
      primaryLang,
      astProjectSummary,
    });
    if (arch) {
      candidates.push(arch);
      skills.push(_wrapAsSkill('architecture', '模块架构', arch.content.markdown));
      report.candidatesCreated++;
      report.skillsCreated++;
    }
    _markDimDone(taskManager, sessionId, 'architecture', 'fallback');
  } catch (e: unknown) {
    report.errors.push({ dim: 'architecture', error: e instanceof Error ? e.message : String(e) });
    _markDimDone(taskManager, sessionId, 'architecture', 'error');
  }

  // ── 3. Code Standard ──
  try {
    const standard = _buildCodeStandard({ astProjectSummary, primaryLang, allFiles });
    if (standard) {
      candidates.push(standard);
      skills.push(_wrapAsSkill('code-standard', '代码规范', standard.content.markdown));
      report.candidatesCreated++;
      report.skillsCreated++;
    }
    _markDimDone(taskManager, sessionId, 'code-standard', 'fallback');
  } catch (e: unknown) {
    report.errors.push({ dim: 'code-standard', error: e instanceof Error ? e.message : String(e) });
    _markDimDone(taskManager, sessionId, 'code-standard', 'error');
  }

  // ── 4. Best Practice (from Guard violations) ──
  try {
    const bp = _buildBestPractice({ guardAudit, primaryLang });
    if (bp) {
      candidates.push(bp);
      skills.push(_wrapAsSkill('best-practice', '最佳实践', bp.content.markdown));
      report.candidatesCreated++;
      report.skillsCreated++;
    }
    _markDimDone(taskManager, sessionId, 'best-practice', 'fallback');
  } catch (e: unknown) {
    report.errors.push({ dim: 'best-practice', error: e instanceof Error ? e.message : String(e) });
    _markDimDone(taskManager, sessionId, 'best-practice', 'error');
  }

  // ── 5. Agent Guidelines ──
  try {
    const guidelines = _buildAgentGuidelines({ guardAudit, primaryLang, astProjectSummary });
    if (guidelines) {
      candidates.push(guidelines);
      skills.push(
        _wrapAsSkill('agent-guidelines', '项目开发强制规范', guidelines.content.markdown)
      );
      report.candidatesCreated++;
      report.skillsCreated++;
    }
    _markDimDone(taskManager, sessionId, 'agent-guidelines', 'fallback');
  } catch (e: unknown) {
    report.errors.push({
      dim: 'agent-guidelines',
      error: e instanceof Error ? e.message : String(e),
    });
    _markDimDone(taskManager, sessionId, 'agent-guidelines', 'error');
  }

  // ── 标记剩余未处理维度 ──
  const processedDims = new Set([
    'project-profile',
    'architecture',
    'code-standard',
    'best-practice',
    'agent-guidelines',
  ]);
  for (const dim of dimensions) {
    if (!processedDims.has(dim.id)) {
      _markDimDone(taskManager, sessionId, dim.id, 'skipped-no-ai');
    }
  }

  report.dimensionsProcessed = processedDims.size;
  const elapsed = Date.now() - t0;
  logger.info(
    `[Bootstrap-fallback] Complete: ${report.candidatesCreated} candidates, ${report.skillsCreated} skills in ${elapsed}ms`
  );

  return { candidates, skills, report };
}

// ═══════════════════════════════════════════════════════════
// 维度构建器
// ═══════════════════════════════════════════════════════════

function _buildProjectProfile({
  langStats,
  primaryLang,
  depGraphData,
  allTargets,
  allFiles,
  astProjectSummary,
}: {
  langStats: Record<string, number>;
  primaryLang: string;
  depGraphData: DepGraphData | null;
  allTargets: string[];
  allFiles: FileEntry[];
  astProjectSummary: AstProjectSummary | null;
}): FallbackCandidate | null {
  const lines = ['## 项目技术画像', ''];

  // 语言统计
  const sortedLangs = (Object.entries(langStats || {}) as [string, number][])
    .sort(([, a], [, b]) => b - a)
    .slice(0, 8);
  if (sortedLangs.length > 0) {
    lines.push('### 语言分布', '');
    lines.push('| 语言 | 文件数 | 占比 |');
    lines.push('|------|--------|------|');
    const total = sortedLangs.reduce((s, [, c]) => s + c, 0);
    for (const [lang, count] of sortedLangs) {
      lines.push(`| ${lang} | ${count} | ${((count / total) * 100).toFixed(1)}% |`);
    }
    lines.push('');
  }

  // 模块结构
  if (allTargets.length > 0) {
    lines.push(`### 模块结构`, '');
    lines.push(`项目包含 **${allTargets.length}** 个模块/Target：`, '');
    for (const t of allTargets.slice(0, 15)) {
      const tName = t;
      const fileCount = Array.isArray(allFiles)
        ? allFiles.filter((f) => f.targetName === tName).length
        : 0;
      lines.push(`- \`${tName}\` (${fileCount} files)`);
    }
    if (allTargets.length > 15) {
      lines.push(`- ...及 ${allTargets.length - 15} 个其他模块`);
    }
    lines.push('');
  }

  // 依赖关系
  if (depGraphData && depGraphData.edges.length > 0) {
    lines.push('### 依赖关系', '');
    lines.push(`共 ${depGraphData.edges.length} 条模块间依赖关系。`, '');
  }

  // AST 统计
  if (astProjectSummary) {
    lines.push('### 代码结构统计', '');
    const m = astProjectSummary.projectMetrics || {};
    lines.push(`- 类/结构体: ${astProjectSummary.classes?.length || 0}`);
    lines.push(`- 协议/接口: ${astProjectSummary.protocols?.length || 0}`);
    lines.push(`- 方法总数: ${m.totalMethods || 0}`);
    if (m.maxNestingDepth) {
      lines.push(`- 最大嵌套深度: ${m.maxNestingDepth}`);
    }
    if (m.complexMethods && m.complexMethods.length > 0) {
      lines.push(`- 高复杂度方法: ${m.complexMethods.length}`);
    }
    if (m.longMethods && m.longMethods.length > 0) {
      lines.push(`- 过长方法 (>50 行): ${m.longMethods.length}`);
    }
    lines.push('');
  }

  // 生成 coreCode (P3): 技术栈摘要
  const codeParts: string[] = [];
  if (sortedLangs.length > 0) {
    codeParts.push('// 语言分布');
    for (const [lang, count] of sortedLangs.slice(0, 5)) {
      codeParts.push(`//   ${lang}: ${count} files`);
    }
  }
  if (astProjectSummary) {
    codeParts.push(
      `// 类: ${astProjectSummary.classes?.length || 0}, 协议: ${astProjectSummary.protocols?.length || 0}, 方法: ${astProjectSummary.projectMetrics?.totalMethods || 0}`
    );
  }
  if (allTargets.length > 0) {
    codeParts.push(
      `// Target: ${allTargets
        .slice(0, 8)
        .map((t: string) => t)
        .join(', ')}`
    );
  }

  const markdown = lines.join('\n');
  if (markdown.length < 50) {
    return null;
  }

  return _makeCandidate({
    title: `项目技术画像 — ${primaryLang}`,
    knowledgeType: 'architecture',
    category: 'Architecture',
    language: primaryLang,
    markdown,
    rationale: '基于 Bootstrap 扫描的文件统计、AST 分析和依赖图谱自动生成',
    coreCode: codeParts.join('\n'),
    trigger: '项目技术画像',
    doClause: '了解项目技术栈和模块结构后再开始编码',
    dontClause: '',
    whenClause: '初次接触项目或需要了解全局架构时',
    sources: ['bootstrap-scan'],
  });
}

function _buildArchitecture({
  depGraphData,
  allTargets,
  targetFileMap,
  primaryLang,
  astProjectSummary,
}: {
  depGraphData: DepGraphData | null;
  allTargets: string[];
  targetFileMap: Record<string, unknown>;
  primaryLang: string;
  astProjectSummary: AstProjectSummary | null;
}): FallbackCandidate | null {
  if (!(depGraphData && depGraphData.edges.length) && allTargets.length < 2) {
    return null;
  }

  const lines = ['## 模块架构', ''];

  // 依赖图
  if (depGraphData && depGraphData.edges.length > 0) {
    lines.push('### 模块依赖关系', '');
    lines.push('```');
    const seen = new Set();
    for (const e of depGraphData.edges.slice(0, 30)) {
      const from = typeof e.from === 'string' ? e.from : e.source;
      const to = typeof e.to === 'string' ? e.to : e.target;
      if (from && to) {
        const key = `${from} → ${to}`;
        if (!seen.has(key)) {
          lines.push(key);
          seen.add(key);
        }
      }
    }
    lines.push('```');
    lines.push('');

    // 入度/出度分析
    const inDeg: Record<string, number> = {};
    const outDeg: Record<string, number> = {};
    for (const e of depGraphData.edges) {
      const from = typeof e.from === 'string' ? e.from : e.source;
      const to = typeof e.to === 'string' ? e.to : e.target;
      if (from) {
        outDeg[from] = (outDeg[from] || 0) + 1;
      }
      if (to) {
        inDeg[to] = (inDeg[to] || 0) + 1;
      }
    }

    // 核心模块（被依赖最多）
    const coreModules = Object.entries(inDeg)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5);
    if (coreModules.length > 0) {
      lines.push('### 核心模块（被依赖最多）', '');
      for (const [mod, deg] of coreModules) {
        lines.push(`- \`${mod}\` — 被 ${deg} 个模块依赖`);
      }
      lines.push('');
    }

    // 叶子模块（不被任何模块依赖）
    const leafModules = allTargets.filter((t: string) => !inDeg[t] && outDeg[t]);
    if (leafModules.length > 0) {
      lines.push('### 叶子模块（仅依赖他人）', '');
      for (const mod of leafModules.slice(0, 8)) {
        lines.push(`- \`${mod}\``);
      }
      lines.push('');
    }
  }

  // P5: ObjC Category 信息
  const categories = astProjectSummary?.categories || [];
  if (categories.length > 0) {
    lines.push('### ObjC Category 扩展', '');
    // 按基类分组
    const byBase: Record<string, AstCategory[]> = {};
    for (const cat of categories) {
      const base = cat.className || cat.baseClass || cat.name?.split('(')[0] || 'Unknown';
      if (!byBase[base]) {
        byBase[base] = [];
      }
      byBase[base].push(cat);
    }
    const sortedBases = Object.entries(byBase).sort(([, a], [, b]) => b.length - a.length);
    lines.push(
      `共 **${categories.length}** 个 Category，分布在 **${sortedBases.length}** 个基类上：`,
      ''
    );
    for (const [base, cats] of sortedBases.slice(0, 10)) {
      const catNames = cats
        .map((c) => c.categoryName || c.name || '')
        .filter(Boolean)
        .slice(0, 5)
        .join(', ');
      const loc = cats[0]?.file ? ` (来源: ${_basename(cats[0].file)})` : '';
      lines.push(
        `- \`${base}\` — ${cats.length} 个 Category${catNames ? `: ${catNames}` : ''}${loc}`
      );
    }
    if (sortedBases.length > 10) {
      lines.push(`- ...及 ${sortedBases.length - 10} 个其他基类`);
    }
    lines.push('');
  }

  // 生成代码块 (P3)
  const codeLines: string[] = [];
  if (depGraphData && depGraphData.edges.length > 0) {
    codeLines.push(`// 模块依赖关系 (共 ${depGraphData.edges.length} 条)`);
    const seen = new Set();
    for (const e of depGraphData.edges.slice(0, 15)) {
      const from = typeof e.from === 'string' ? e.from : e.source;
      const to = typeof e.to === 'string' ? e.to : e.target;
      if (from && to) {
        const key = `${from} -> ${to}`;
        if (!seen.has(key)) {
          codeLines.push(key);
          seen.add(key);
        }
      }
    }
  }

  const markdown = lines.join('\n');
  if (markdown.length < 80) {
    return null;
  }

  return _makeCandidate({
    title: '模块架构与依赖关系',
    knowledgeType: 'architecture',
    category: 'Architecture',
    language: primaryLang,
    markdown,
    rationale: '基于项目依赖图谱和模块扫描自动生成',
    coreCode: codeLines.length > 1 ? codeLines.join('\n') : '',
    trigger: '模块架构',
    doClause: '遵循现有模块边界，新功能放入对应模块',
    dontClause: '',
    whenClause: '新建文件或模块时',
    sources: ['bootstrap-scan'],
  });
}

function _buildCodeStandard({
  astProjectSummary,
  primaryLang,
  allFiles,
}: {
  astProjectSummary: AstProjectSummary | null;
  primaryLang: string;
  allFiles: FileEntry[];
}): FallbackCandidate | null {
  if (!astProjectSummary) {
    return null;
  }

  const lines = ['## 代码规范发现', ''];

  const classes = astProjectSummary.classes || [];
  const methods: AstMethodInfo[] = [];
  // 从 file 级聚合方法
  if (astProjectSummary.files) {
    for (const f of astProjectSummary.files) {
      if (f.methods) {
        methods.push(...f.methods);
      }
    }
  }

  // 命名模式分析
  let usedSuffixes: [string, number][] = [];
  if (classes.length > 0) {
    lines.push('### 类命名模式', '');

    // 检测常见后缀
    const suffixCounts: Record<string, number> = {};
    const COMMON_SUFFIXES = [
      'Service',
      'Manager',
      'Controller',
      'Handler',
      'Provider',
      'Repository',
      'Factory',
      'Helper',
      'Utils',
      'ViewModel',
      'View',
      'Model',
      'Store',
      'Client',
      'Adapter',
      'Impl',
    ];
    for (const cls of classes) {
      for (const sfx of COMMON_SUFFIXES) {
        if (cls.name?.endsWith(sfx)) {
          suffixCounts[sfx] = (suffixCounts[sfx] || 0) + 1;
        }
      }
    }
    usedSuffixes = Object.entries(suffixCounts)
      .filter(([, c]) => c > 0)
      .sort(([, a], [, b]) => b - a);
    if (usedSuffixes.length > 0) {
      lines.push('| 后缀约定 | 类数量 | 推断角色 |');
      lines.push('|----------|--------|----------|');
      const roleMap = {
        Service: '业务服务',
        Manager: '管理器',
        Controller: '控制器/路由',
        Handler: '事件/请求处理',
        Provider: '数据/功能提供者',
        Repository: '数据访问',
        Factory: '工厂',
        Helper: '辅助工具',
        Utils: '工具类',
        ViewModel: '视图模型',
        View: '视图/UI',
        Model: '数据模型',
        Store: '状态存储',
        Client: 'API 客户端',
        Adapter: '适配器',
        Impl: '接口实现',
      };
      for (const [sfx, count] of usedSuffixes) {
        lines.push(`| *${sfx} | ${count} | ${(roleMap as Record<string, string>)[sfx] || sfx} |`);
      }
      lines.push('');
    }

    lines.push(`共发现 **${classes.length}** 个类/结构体。`, '');
  }

  // 代码质量指标
  const metrics = astProjectSummary.projectMetrics;
  if (metrics) {
    lines.push('### 代码质量指标', '');
    if (metrics.avgMethodsPerClass) {
      lines.push(`- 平均方法数/类: ${metrics.avgMethodsPerClass.toFixed(1)}`);
    }
    if (metrics.complexMethods && metrics.complexMethods.length > 0) {
      lines.push(`- 高圈复杂度方法: ${metrics.complexMethods.length} 个`);
      for (const m of metrics.complexMethods.slice(0, 5)) {
        const loc = m.file ? ` (来源: ${_basename(m.file)}${m.line ? `:${m.line}` : ''})` : '';
        lines.push(
          `  - \`${m.className ? `${m.className}.` : ''}${m.name}\` — complexity ${m.complexity}${loc}`
        );
      }
    }
    if (metrics.longMethods && metrics.longMethods.length > 0) {
      lines.push(`- 过长方法: ${metrics.longMethods.length} 个`);
      for (const m of metrics.longMethods.slice(0, 5)) {
        const bodyLen = m.lines || m.bodyLines || '?';
        const loc = m.file ? ` (来源: ${_basename(m.file)}${m.line ? `:${m.line}` : ''})` : '';
        lines.push(
          `  - \`${m.className ? `${m.className}.` : ''}${m.name}\` — ${bodyLen} 行${loc}`
        );
      }
    }
    lines.push('');
  }

  // 收集源文件引用 (P4)
  const sourceFiles = new Set<string>();
  if (metrics) {
    for (const m of (metrics.longMethods || []).concat(metrics.complexMethods || [])) {
      if (m.file) {
        sourceFiles.add(m.file);
      }
    }
  }

  // 生成 coreCode (P3): 命名规范摘要
  const codeLines: string[] = [];
  if (usedSuffixes?.length > 0) {
    codeLines.push('// 命名约定示例');
    for (const [sfx, count] of usedSuffixes.slice(0, 6)) {
      codeLines.push(`// *${sfx} → ${count} 个类使用此后缀`);
    }
  }
  if (metrics && metrics.longMethods && metrics.longMethods.length > 0) {
    codeLines.push('');
    codeLines.push('// 过长方法示例 (应重构)');
    for (const m of metrics.longMethods.slice(0, 3)) {
      const bodyLen = m.lines || m.bodyLines || '?';
      codeLines.push(`// ${m.className ? `${m.className}.` : ''}${m.name} — ${bodyLen} 行`);
    }
  }

  const markdown = lines.join('\n');
  if (markdown.length < 80) {
    return null;
  }

  return _makeCandidate({
    title: '代码规范与命名约定',
    knowledgeType: 'code-standard',
    category: 'Architecture',
    language: primaryLang,
    markdown,
    rationale: '基于 AST 分析的类名、方法统计和代码复杂度指标自动生成',
    coreCode: codeLines.join('\n'),
    trigger: '代码规范',
    doClause: '遵循项目现有命名约定，新类名使用已有后缀模式',
    dontClause: '不要写超过 50 行的方法，不要超过 4 层嵌套',
    whenClause: '新建类或方法时',
    sources: sourceFiles.size > 0 ? [...sourceFiles].slice(0, 10) : ['bootstrap-scan'],
  });
}

function _buildBestPractice({
  guardAudit,
  primaryLang,
}: {
  guardAudit: GuardAuditData | null;
  primaryLang: string;
}): FallbackCandidate | null {
  if (!guardAudit?.files?.length) {
    return null;
  }

  // 聚合所有违规
  const ruleStats: Record<
    string,
    {
      count: number;
      severity: string;
      message: string;
      files: Set<string>;
      fixSuggestion: string | null;
    }
  > = {};
  for (const f of guardAudit.files) {
    for (const v of f.violations || []) {
      if (!ruleStats[v.ruleId]) {
        ruleStats[v.ruleId] = {
          count: 0,
          severity: v.severity,
          message: v.message,
          files: new Set(),
          fixSuggestion: v.fixSuggestion || null,
        };
      }
      ruleStats[v.ruleId].count++;
      ruleStats[v.ruleId].files.add(f.filePath);
    }
  }

  const sortedRules = Object.entries(ruleStats).sort(([, a], [, b]) => b.count - a.count);

  if (sortedRules.length === 0) {
    return null;
  }

  const lines = ['## 最佳实践（基于 Guard 审计）', ''];
  lines.push(
    `Bootstrap 扫描发现 **${guardAudit.summary?.totalViolations || 0}** 个违规，` +
      `涉及 **${sortedRules.length}** 条规则：`,
    ''
  );

  lines.push('### 高频违规（应优先修复）', '');
  lines.push('| 规则 | 严重性 | 违规数 | 影响文件数 | 说明 |');
  lines.push('|------|--------|--------|-----------|------|');
  for (const [ruleId, stat] of sortedRules.slice(0, 15)) {
    lines.push(
      `| \`${ruleId}\` | ${stat.severity} | ${stat.count} | ${stat.files.size} | ${stat.message} |`
    );
  }
  lines.push('');

  // 修复建议
  const withFix = sortedRules.filter(([, s]) => s.fixSuggestion);
  if (withFix.length > 0) {
    lines.push('### 修复建议', '');
    for (const [ruleId, stat] of withFix.slice(0, 10)) {
      lines.push(`- **${ruleId}**: ${stat.fixSuggestion}`);
    }
    lines.push('');
  }

  // 收集违规文件路径 (P4)
  const violationFiles = new Set<string>();
  for (const f of guardAudit.files) {
    if (f.violations?.length > 0 && f.filePath) {
      violationFiles.add(f.filePath);
    }
  }

  // 生成 coreCode (P3): Guard 规则摘要
  const codeLines = ['// Guard 高频违规规则'];
  for (const [ruleId, stat] of sortedRules.slice(0, 5)) {
    codeLines.push(`// ${ruleId}: ${stat.message} (${stat.count}次)`);
  }

  const markdown = lines.join('\n');
  return _makeCandidate({
    title: '最佳实践与常见问题',
    knowledgeType: 'best-practice',
    category: 'Service',
    language: primaryLang,
    markdown,
    rationale: '基于 Guard 静态审计发现的违规模式和修复建议自动生成',
    coreCode: codeLines.join('\n'),
    trigger: 'Guard 审计结果',
    doClause: '修复 Guard 标记的违规，特别是 error 级别',
    dontClause: '不要忽略 Guard 警告，不要引入已知反模式',
    whenClause: '修改现有代码或新建文件时',
    sources: violationFiles.size > 0 ? [...violationFiles].slice(0, 10) : ['bootstrap-scan'],
  });
}

function _buildAgentGuidelines({
  guardAudit,
  primaryLang,
  astProjectSummary,
}: {
  guardAudit: GuardAuditData | null;
  primaryLang: string;
  astProjectSummary: AstProjectSummary | null;
}): FallbackCandidate | null {
  const lines = ['## Agent 开发注意事项', ''];
  lines.push('> 以下规则基于项目静态分析自动生成，AI Agent 在本项目中编写代码时应遵守。', '');

  // 从 Guard 高频违规推断
  if (guardAudit?.files?.length) {
    const ruleStats: Record<string, { count: number; message: string; severity: string }> = {};
    for (const f of guardAudit.files) {
      for (const v of f.violations || []) {
        ruleStats[v.ruleId] = ruleStats[v.ruleId] || {
          count: 0,
          message: v.message,
          severity: v.severity,
        };
        ruleStats[v.ruleId].count++;
      }
    }
    const topErrors = Object.entries(ruleStats)
      .filter(([, s]) => s.severity === 'error')
      .sort(([, a], [, b]) => b.count - a.count)
      .slice(0, 8);
    const topWarnings = Object.entries(ruleStats)
      .filter(([, s]) => s.severity === 'warning')
      .sort(([, a], [, b]) => b.count - a.count)
      .slice(0, 8);

    if (topErrors.length > 0) {
      lines.push('### 必须（must）- 基于 error 级违规', '');
      for (const [ruleId, stat] of topErrors) {
        lines.push(`- ❌ **${ruleId}**: ${stat.message} (项目中出现 ${stat.count} 次)`);
      }
      lines.push('');
    }
    if (topWarnings.length > 0) {
      lines.push('### 建议（should）- 基于 warning 级违规', '');
      for (const [ruleId, stat] of topWarnings) {
        lines.push(`- ⚠️ **${ruleId}**: ${stat.message} (${stat.count} 处)`);
      }
      lines.push('');
    }
  }

  // 从 AST 复杂度推断
  if (astProjectSummary?.projectMetrics) {
    const m = astProjectSummary.projectMetrics;
    lines.push('### 代码质量约束', '');
    if (m.maxNestingDepth != null && m.maxNestingDepth >= 5) {
      lines.push(`- 当前项目最大嵌套深度 ${m.maxNestingDepth} — 新代码应避免超过 4 层嵌套`);
    }
    if (m.complexMethods && m.complexMethods.length > 0) {
      const avgComplexity =
        m.complexMethods.reduce((s: number, c: AstMethodInfo) => s + (c.complexity ?? 0), 0) /
        m.complexMethods.length;
      lines.push(
        `- 已有 ${m.complexMethods.length} 个高复杂度方法 (avg ${avgComplexity.toFixed(1)}) — 新方法圈复杂度应 <10`
      );
    }
    if (m.longMethods && m.longMethods.length > 0) {
      lines.push(`- 已有 ${m.longMethods.length} 个过长方法 — 新方法建议 <50 行`);
    }
    lines.push('');
  }

  const markdown = lines.join('\n');
  if (markdown.length < 100) {
    return null;
  }

  // 生成 coreCode (P3)
  const codeLines = ['// Agent 强制规则'];
  if (
    astProjectSummary?.projectMetrics &&
    (astProjectSummary.projectMetrics.maxNestingDepth ?? 0) >= 5
  ) {
    codeLines.push(
      `// 最大嵌套: ${astProjectSummary.projectMetrics.maxNestingDepth} → 新代码应 <4`
    );
  }
  if (
    astProjectSummary?.projectMetrics?.longMethods &&
    astProjectSummary.projectMetrics.longMethods.length > 0
  ) {
    codeLines.push(
      `// 过长方法: ${astProjectSummary.projectMetrics.longMethods.length} 个 → 新方法应 <50行`
    );
  }

  return _makeCandidate({
    title: 'Agent 开发注意事项',
    knowledgeType: 'boundary-constraint',
    category: 'Architecture',
    language: primaryLang,
    markdown,
    rationale: '基于 Guard 错误级违规和 AST 复杂度指标自动生成的 Agent 约束',
    coreCode: codeLines.join('\n'),
    trigger: 'Agent 开发规范',
    doClause: '新代码嵌套不超过 4 层，方法不超过 50 行，圈复杂度 <10',
    dontClause: '不要引入 Guard 已标记的反模式',
    whenClause: '在本项目中编写任何代码时',
    sources: ['bootstrap-scan'],
  });
}

// ═══════════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════════

/** 从绝对/相对路径取文件名 */
function _basename(fp: string | undefined | null): string {
  if (!fp) {
    return '';
  }
  const idx = fp.lastIndexOf('/');
  return idx >= 0 ? fp.slice(idx + 1) : fp;
}

function _makeCandidate({
  title,
  knowledgeType,
  category,
  language,
  markdown,
  rationale,
  coreCode,
  trigger,
  doClause,
  dontClause,
  whenClause,
  sources,
}: CandidateParams): FallbackCandidate {
  return {
    title,
    content: { pattern: coreCode || '', markdown, rationale },
    language: language || '',
    category,
    knowledgeType,
    source: 'bootstrap-fallback',
    difficulty: 'beginner',
    scope: 'project-specific',
    trigger: trigger || title,
    doClause: doClause || '',
    dontClause: dontClause || '',
    whenClause: whenClause || '',
    coreCode: coreCode || '',
    reasoning: {
      whyStandard: rationale,
      sources: sources || ['bootstrap-scan'],
      confidence: 0.6,
    },
  };
}

function _wrapAsSkill(dimId: string, label: string, markdown: string): FallbackSkill {
  return {
    dimId,
    name: `project-${dimId}`,
    description: `Auto-generated from bootstrap scan (no-AI fallback): ${label}`,
    content: [
      `# ${label}`,
      '',
      '> Auto-generated by Bootstrap fallback (rule-based, no AI). Quality: basic.',
      '',
      markdown,
    ].join('\n'),
  };
}

function _markDimDone(
  taskManager: TaskManagerLike | null,
  sessionId: string | null,
  dimId: string,
  type: string
) {
  try {
    if (taskManager && sessionId) {
      taskManager.markTaskCompleted(dimId, { type, reason: type });
    }
  } catch {
    /* non-critical */
  }
}
