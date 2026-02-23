/**
 * noAiFallback.js — AI 不可用时的规则化降级知识提取
 *
 * 当 ChatAgent / AI Provider 不可用时，从 Phase 1-4 的结构化数据中
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

import Logger from '../../../../../infrastructure/logging/Logger.js';

const logger = Logger.getInstance();

/**
 * 主入口 — 当 AI 不可用时调用
 *
 * @param {object} fillContext - 与 fillDimensionsV3 相同的上下文
 * @returns {{ candidates: object[], skills: object[], report: object }}
 */
export async function runNoAiFallback(fillContext) {
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

  const candidates = [];
  const skills = [];
  const report = { dimensionsProcessed: 0, candidatesCreated: 0, skillsCreated: 0, errors: [] };

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
  } catch (e) {
    report.errors.push({ dim: 'project-profile', error: e.message });
    _markDimDone(taskManager, sessionId, 'project-profile', 'error');
  }

  // ── 2. Architecture ──
  try {
    const arch = _buildArchitecture({ depGraphData, allTargets, targetFileMap, primaryLang });
    if (arch) {
      candidates.push(arch);
      skills.push(_wrapAsSkill('architecture', '模块架构', arch.content.markdown));
      report.candidatesCreated++;
      report.skillsCreated++;
    }
    _markDimDone(taskManager, sessionId, 'architecture', 'fallback');
  } catch (e) {
    report.errors.push({ dim: 'architecture', error: e.message });
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
  } catch (e) {
    report.errors.push({ dim: 'code-standard', error: e.message });
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
  } catch (e) {
    report.errors.push({ dim: 'best-practice', error: e.message });
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
  } catch (e) {
    report.errors.push({ dim: 'agent-guidelines', error: e.message });
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
}) {
  const lines = ['## 项目技术画像', ''];

  // 语言统计
  const sortedLangs = Object.entries(langStats || {})
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
      const fileCount = Array.isArray(allFiles) ? allFiles.filter((f) => f.target === t).length : 0;
      lines.push(`- \`${t}\` (${fileCount} files)`);
    }
    if (allTargets.length > 15) {
      lines.push(`- ...及 ${allTargets.length - 15} 个其他模块`);
    }
    lines.push('');
  }

  // 依赖关系
  if (depGraphData?.edges?.length > 0) {
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
    if (m.complexMethods?.length > 0) {
      lines.push(`- 高复杂度方法: ${m.complexMethods.length}`);
    }
    if (m.longMethods?.length > 0) {
      lines.push(`- 过长方法 (>50 行): ${m.longMethods.length}`);
    }
    lines.push('');
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
  });
}

function _buildArchitecture({ depGraphData, allTargets, targetFileMap, primaryLang }) {
  if (!depGraphData?.edges?.length && allTargets.length < 2) {
    return null;
  }

  const lines = ['## 模块架构', ''];

  // 依赖图
  if (depGraphData?.edges?.length > 0) {
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
    const inDeg = {};
    const outDeg = {};
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
    const leafModules = allTargets.filter((t) => !inDeg[t] && outDeg[t]);
    if (leafModules.length > 0) {
      lines.push('### 叶子模块（仅依赖他人）', '');
      for (const mod of leafModules.slice(0, 8)) {
        lines.push(`- \`${mod}\``);
      }
      lines.push('');
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
  });
}

function _buildCodeStandard({ astProjectSummary, primaryLang, allFiles }) {
  if (!astProjectSummary) {
    return null;
  }

  const lines = ['## 代码规范发现', ''];

  const classes = astProjectSummary.classes || [];
  const methods = [];
  // 从 file 级聚合方法
  if (astProjectSummary.files) {
    for (const f of astProjectSummary.files) {
      if (f.methods) {
        methods.push(...f.methods);
      }
    }
  }

  // 命名模式分析
  if (classes.length > 0) {
    lines.push('### 类命名模式', '');

    // 检测常见后缀
    const suffixCounts = {};
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
    const usedSuffixes = Object.entries(suffixCounts)
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
        lines.push(`| *${sfx} | ${count} | ${roleMap[sfx] || sfx} |`);
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
    if (metrics.complexMethods?.length > 0) {
      lines.push(`- 高圈复杂度方法: ${metrics.complexMethods.length} 个`);
      for (const m of metrics.complexMethods.slice(0, 5)) {
        lines.push(
          `  - \`${m.className ? `${m.className}.` : ''}${m.name}\` — complexity ${m.complexity}`
        );
      }
    }
    if (metrics.longMethods?.length > 0) {
      lines.push(`- 过长方法: ${metrics.longMethods.length} 个`);
      for (const m of metrics.longMethods.slice(0, 5)) {
        lines.push(`  - \`${m.className ? `${m.className}.` : ''}${m.name}\` — ${m.bodyLines} 行`);
      }
    }
    lines.push('');
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
  });
}

function _buildBestPractice({ guardAudit, primaryLang }) {
  if (!guardAudit?.files?.length) {
    return null;
  }

  // 聚合所有违规
  const ruleStats = {};
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

  const markdown = lines.join('\n');
  return _makeCandidate({
    title: '最佳实践与常见问题',
    knowledgeType: 'best-practice',
    category: 'Service',
    language: primaryLang,
    markdown,
    rationale: '基于 Guard 静态审计发现的违规模式和修复建议自动生成',
  });
}

function _buildAgentGuidelines({ guardAudit, primaryLang, astProjectSummary }) {
  const lines = ['## Agent 开发注意事项', ''];
  lines.push('> 以下规则基于项目静态分析自动生成，AI Agent 在本项目中编写代码时应遵守。', '');

  // 从 Guard 高频违规推断
  if (guardAudit?.files?.length) {
    const ruleStats = {};
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
    if (m.maxNestingDepth >= 5) {
      lines.push(`- 当前项目最大嵌套深度 ${m.maxNestingDepth} — 新代码应避免超过 4 层嵌套`);
    }
    if (m.complexMethods?.length > 0) {
      const avgComplexity =
        m.complexMethods.reduce((s, c) => s + c.complexity, 0) / m.complexMethods.length;
      lines.push(
        `- 已有 ${m.complexMethods.length} 个高复杂度方法 (avg ${avgComplexity.toFixed(1)}) — 新方法圈复杂度应 <10`
      );
    }
    if (m.longMethods?.length > 0) {
      lines.push(`- 已有 ${m.longMethods.length} 个过长方法 — 新方法建议 <50 行`);
    }
    lines.push('');
  }

  const markdown = lines.join('\n');
  if (markdown.length < 100) {
    return null;
  }

  return _makeCandidate({
    title: 'Agent 开发注意事项',
    knowledgeType: 'boundary-constraint',
    category: 'Architecture',
    language: primaryLang,
    markdown,
    rationale: '基于 Guard 错误级违规和 AST 复杂度指标自动生成的 Agent 约束',
  });
}

// ═══════════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════════

function _makeCandidate({ title, knowledgeType, category, language, markdown, rationale }) {
  return {
    title,
    content: { markdown, rationale },
    language: language || '',
    category,
    knowledgeType,
    source: 'rule-based-fallback',
    difficulty: 'beginner',
    scope: 'project-specific',
    reasoning: {
      whyStandard: rationale,
      sources: ['bootstrap-scan'],
      confidence: 0.6,
    },
  };
}

function _wrapAsSkill(dimId, label, markdown) {
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

function _markDimDone(taskManager, sessionId, dimId, type) {
  try {
    if (taskManager && sessionId) {
      taskManager.markTaskCompleted(dimId, { type, reason: type });
    }
  } catch {
    /* non-critical */
  }
}
