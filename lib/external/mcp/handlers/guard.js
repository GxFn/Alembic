/**
 * MCP Handlers — Guard 审计 & 项目扫描
 *
 * 统一入口：autosnippet_guard
 *   无参数         → review 模式（自动 git diff 增量文件 + inline recipe）
 *   files: string[] → 指定文件检查（+ inline recipe）
 *   code: string    → 单文件内联检查
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { envelope } from '../envelope.js';

// ═══ Review 轮次追踪（模块私有） ═══════════════════

const _reviewRounds = new Map();      // projectRoot → round count
const _lastReviewPassed = new Map();  // projectRoot → boolean
const MAX_REVIEW_ROUNDS = 5;

export async function guardCheck(ctx, args) {
  const { GuardCheckEngine, detectLanguage } = await import(
    '../../../service/guard/GuardCheckEngine.js'
  );

  // 输入校验：空代码直接返回
  if (!args.code || !args.code.trim()) {
    return envelope({
      success: true,
      data: {
        language: args.language || 'unknown',
        violations: [],
        summary: { total: 0, errors: 0, warnings: 0 },
      },
      meta: { tool: 'autosnippet_guard', note: 'Empty code — skipped' },
    });
  }

  const engine = _getOrCreateEngine(ctx, GuardCheckEngine);

  // 注入 Enhancement Pack Guard 规则
  await _injectEnhancementGuardRules(engine, ctx);

  const language = args.language || detectLanguage(args.filePath || '');
  const violations = engine.checkCode(args.code, language);

  // ── SkillHooks: onGuardCheck — 允许 hooks 修改 violations ──
  try {
    const skillHooks = ctx.container.get('skillHooks');
    if (skillHooks.has('onGuardCheck')) {
      for (let i = 0; i < violations.length; i++) {
        const modified = await skillHooks.run('onGuardCheck', violations[i], { language });
        if (modified && typeof modified === 'object') {
          violations[i] = modified;
        }
      }
    }
  } catch {
    /* skillHooks not available */
  }

  const warnings = [];
  if (language === 'unknown') {
    warnings.push('未能识别语言，部分语言相关规则可能未执行。建议提供 language 或 filePath 参数。');
  }

  return envelope({
    success: true,
    data: {
      language,
      violations,
      summary: {
        total: violations.length,
        errors: violations.filter((v) => v.severity === 'error').length,
        warnings: violations.filter((v) => v.severity === 'warning').length,
      },
      ...(warnings.length ? { warnings } : {}),
    },
    meta: { tool: 'autosnippet_guard' },
  });
}

export async function guardAuditFiles(ctx, args) {
  if (!Array.isArray(args.files) || args.files.length === 0) {
    throw new Error('files array is required and must not be empty');
  }
  const scope = args.scope || 'project';

  const { GuardCheckEngine } = await import('../../../service/guard/GuardCheckEngine.js');
  const engine = _getOrCreateEngine(ctx, GuardCheckEngine);

  // 注入 Enhancement Pack Guard 规则
  await _injectEnhancementGuardRules(engine, ctx);

  // 解析项目根路径（用于相对路径转绝对路径）
  const projectRoot =
    ctx.container?.singletons?._projectRoot ||
    process.env.ASD_PROJECT_DIR ||
    process.cwd();

  // 补充缺失的 content（从磁盘读取）
  // 相对路径自动转绝对路径，避免 MCP 进程 cwd 不在项目目录时读不到文件
  const filesToAudit = args.files.map((f) => {
    const absPath = path.isAbsolute(f.path) ? f.path : path.resolve(projectRoot, f.path);
    return {
      path: absPath,
      content: f.content || (fs.existsSync(absPath) ? fs.readFileSync(absPath, 'utf8') : ''),
    };
  });

  const result = engine.auditFiles(filesToAudit, { scope });

  // 写入 ViolationsStore + GuardFeedbackLoop
  try {
    const violationsStore = ctx.container.get('violationsStore');
    for (const fileResult of result.files || []) {
      if (fileResult.violations.length > 0) {
        violationsStore.appendRun({
          filePath: fileResult.filePath,
          violations: fileResult.violations,
          summary: `MCP audit (${scope}): ${fileResult.summary.errors}E ${fileResult.summary.warnings}W`,
        });
      }

      // Guard ↔ Recipe 闭环：检测修复并自动确认使用
      try {
        const feedbackLoop = ctx.container.get('guardFeedbackLoop');
        feedbackLoop.processFixDetection(fileResult, fileResult.filePath);
      } catch {
        /* guardFeedbackLoop not available */
      }
    }
  } catch {
    /* ViolationsStore not available */
  }

  return envelope({
    success: true,
    data: {
      summary: result.summary,
      files: result.files.map((f) => ({
        filePath: f.filePath,
        language: f.language,
        violations: f.violations,
        summary: f.summary,
      })),
      ...(result.crossFileViolations?.length
        ? { crossFileViolations: result.crossFileViolations }
        : {}),
    },
    meta: { tool: 'autosnippet_guard' },
  });
}

// ═══ Review 模式 — 编码后质量门禁（无参数 = 自动检测） ═══

/**
 * Guard Review — 编码后的代码质量检查
 *
 * 设计要点:
 *   1. 无参数 → 自动从 git diff 检测增量文件（staged + unstaged + untracked）
 *   2. files: string[] → 指定文件路径（简化，不再要求对象数组）
 *   3. violations 内联 recipe 修复指南（doClause + coreCode）
 *   4. 防无限循环：reviewRound 计数 + MAX_REVIEW_ROUNDS 限制
 *   5. 不绑定 task ID — 代码检查独立于任务系统
 *
 * @param {object} ctx — MCP context with container
 * @param {object} args — { files?: string[] }
 */
export async function guardReview(ctx, args) {
  const { GuardCheckEngine, detectLanguage } = await import(
    '../../../service/guard/GuardCheckEngine.js'
  );

  const projectRoot = _getProjectRoot(ctx);

  // 轮次追踪（基于 projectRoot，不绑定 task）
  const round = (_reviewRounds.get(projectRoot) || 0) + 1;
  _reviewRounds.set(projectRoot, round);

  if (round > MAX_REVIEW_ROUNDS) {
    _reviewRounds.delete(projectRoot);
    _lastReviewPassed.set(projectRoot, true); // 强制通过
    return envelope({
      success: true,
      data: { passed: true, files: [], totalViolations: 0, reviewRound: round, maxRoundsReached: true },
      message: `⚠️ Guard review round ${round} exceeds max ${MAX_REVIEW_ROUNDS}. Force-passing. Remaining issues should be tracked as follow-up.`,
      meta: { tool: 'autosnippet_guard', mode: 'review' },
    });
  }

  // 1. 确定待检查文件
  let filePaths = [];
  let fileSource = 'git-diff';

  if (args.files && Array.isArray(args.files) && args.files.length > 0) {
    // files 参数: string[] — 简化版，自动读取文件内容
    filePaths = args.files
      .map(f => typeof f === 'string' ? f : (f.path || f))
      .map(f => path.isAbsolute(f) ? f : path.resolve(projectRoot, f))
      .filter(f => fs.existsSync(f));
    fileSource = 'explicit';
  } else {
    // 无参数 → 自动检测 git 变更文件
    filePaths = _detectChangedFiles(projectRoot);
  }

  if (!filePaths.length) {
    _reviewRounds.delete(projectRoot);
    _lastReviewPassed.set(projectRoot, true);
    return envelope({
      success: true,
      data: { passed: true, files: [], totalViolations: 0, reviewRound: round, fileSource },
      message: '✅ No changed source files detected. Guard review passed.',
      meta: { tool: 'autosnippet_guard', mode: 'review' },
    });
  }

  // 2. 预加载 rule recipe 缓存
  const recipeMap = _loadRuleRecipes(ctx);

  // 3. 创建引擎，注入 Enhancement Pack
  const engine = _getOrCreateEngine(ctx, GuardCheckEngine);
  await _injectEnhancementGuardRules(engine, ctx);

  // 4. 逐文件检查
  const results = [];
  let totalViolations = 0;
  let totalErrors = 0;
  let totalWarnings = 0;

  for (const fp of filePaths) {
    try {
      const code = fs.readFileSync(fp, 'utf8');
      const lang = detectLanguage(fp);
      const violations = engine.checkCode(code, lang, { filePath: fp });

      const fileSummary = {
        total: violations.length,
        errors: violations.filter(v => v.severity === 'error').length,
        warnings: violations.filter(v => v.severity === 'warning').length,
      };

      totalViolations += violations.length;
      totalErrors += fileSummary.errors;
      totalWarnings += fileSummary.warnings;

      // 内联 recipe 修复指南
      const enriched = violations.map(v => {
        const base = {
          ruleId: v.ruleId,
          message: v.message,
          severity: v.severity,
          line: v.line,
          snippet: v.snippet,
          fixSuggestion: v.fixSuggestion || null,
        };
        const recipe = recipeMap.get(v.ruleId);
        if (recipe) {
          base.recipe = {
            title: recipe.title,
            doClause: recipe.doClause || null,
            dontClause: recipe.dontClause || null,
            coreCode: recipe.coreCode || null,
          };
        }
        return base;
      });

      results.push({ filePath: fp, language: lang, violations: enriched, summary: fileSummary });
    } catch (err) {
      results.push({
        filePath: fp, error: `Cannot read: ${err.message}`,
        violations: [], summary: { total: 0, errors: 0, warnings: 0 },
      });
    }
  }

  const passed = totalViolations === 0;

  // 5. 更新共享状态
  if (passed) {
    _reviewRounds.delete(projectRoot);
    _lastReviewPassed.set(projectRoot, true);
  } else {
    _lastReviewPassed.set(projectRoot, false);
  }

  // 6. 写入 ViolationsStore
  try {
    const violationsStore = ctx.container.get('violationsStore');
    for (const r of results) {
      if (r.violations.length > 0) {
        violationsStore.appendRun({
          filePath: r.filePath, violations: r.violations,
          summary: `guard review round ${round}: ${r.summary.errors}E ${r.summary.warnings}W`,
        });
      }
    }
  } catch { /* optional */ }

  // 7. 构造消息
  let message;
  if (passed) {
    message = `✅ Guard review passed (round ${round}). ${filePaths.length} file(s) checked, 0 violations.`;
  } else {
    const violatingFiles = results.filter(r => r.violations.length > 0);
    const details = violatingFiles.map(f =>
      `  ${path.basename(f.filePath)}: ${f.violations.map(v => `L${v.line} ${v.ruleId}`).join(', ')}`
    ).join('\n');

    message = [
      `⚠️ Guard review round ${round}: ${totalViolations} violation(s) in ${violatingFiles.length} file(s).`,
      details,
      '',
      'Each violation includes inline `recipe` with doClause + coreCode — apply fixes directly.',
      round >= MAX_REVIEW_ROUNDS - 1
        ? `⚠️ Next round is the last (max ${MAX_REVIEW_ROUNDS}). Unresolved issues will be force-passed.`
        : `Fix and call autosnippet_guard again (round ${round + 1}).`,
    ].join('\n');
  }

  return envelope({
    success: true,
    data: {
      passed,
      reviewRound: round,
      fileSource,
      files: results,
      totalViolations,
      summary: { total: totalViolations, errors: totalErrors, warnings: totalWarnings, filesChecked: filePaths.length },
    },
    message,
    meta: { tool: 'autosnippet_guard', mode: 'review' },
  });
}

// ═══ Recipe 缓存 ═════════════════════════════════════════

/**
 * 预加载所有 rule 类型 recipe 的修复字段
 * 构建 guardId → recipe 映射
 */
function _loadRuleRecipes(ctx) {
  const map = new Map();
  try {
    const db = typeof ctx.container.get('database')?.getDb === 'function'
      ? ctx.container.get('database').getDb()
      : ctx.container.get('database');

    const rows = db.prepare(`
      SELECT id, title, doClause, dontClause, coreCode, constraints
      FROM knowledge_entries
      WHERE (kind = 'rule' OR knowledgeType = 'boundary-constraint')
        AND lifecycle = 'active'
    `).all();

    for (const row of rows) {
      try {
        const constraints = JSON.parse(row.constraints || '{}');
        const guards = constraints.guards || [];
        for (const g of guards) {
          if (g.id) {
            map.set(g.id, { title: row.title, doClause: row.doClause, dontClause: row.dontClause, coreCode: row.coreCode });
          }
        }
      } catch { /* skip */ }
      map.set(row.id, { title: row.title, doClause: row.doClause, dontClause: row.dontClause, coreCode: row.coreCode });
    }
  } catch { /* DB not available */ }
  return map;
}

// ═══ Git Diff 检测 ═══════════════════════════════════════

function _getProjectRoot(ctx) {
  const root = ctx.container?.singletons?._projectRoot;
  if (root) return root;
  return process.env.ASD_PROJECT_DIR || process.cwd();
}

const SOURCE_EXTS = new Set([
  '.m', '.mm', '.h', '.swift',
  '.js', '.ts', '.jsx', '.tsx',
  '.py', '.rb', '.java', '.kt', '.go', '.rs',
  '.c', '.cpp', '.cc', '.cs',
  '.vue', '.svelte',
]);

function _detectChangedFiles(projectRoot) {
  const root = projectRoot || process.env.ASD_PROJECT_DIR || process.cwd();
  try {
    const diffOutput = execSync(
      'git diff --name-only HEAD 2>/dev/null; git diff --staged --name-only 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null',
      { cwd: root, encoding: 'utf8', timeout: 5000 }
    );
    const files = [...new Set(
      diffOutput.split('\n')
        .map(f => f.trim())
        .filter(f => f && SOURCE_EXTS.has(path.extname(f).toLowerCase()))
    )];
    return files
      .map(f => path.isAbsolute(f) ? f : path.resolve(root, f))
      .filter(f => fs.existsSync(f));
  } catch {
    return [];
  }
}

// ═══ 项目扫描 ════════════════════════════════════════════

export async function scanProject(ctx, args) {
  const maxFiles = args.maxFiles || 200;
  const includeContent = args.includeContent || false;
  const contentMaxLines = args.contentMaxLines || 100;

  const projectRoot = process.env.ASD_PROJECT_DIR || process.cwd();

  // 优先使用 ModuleService（多语言统一入口），回退到 SpmService
  let service;
  try {
    const { ModuleService } = await import('../../../service/module/ModuleService.js');
    service = new ModuleService(projectRoot);
  } catch {
    const { SpmService } = await import('../../../platform/ios/spm/SpmService.js');
    service = new SpmService(projectRoot);
  }
  await service.load();
  const allTargets = await service.listTargets();

  if (!allTargets || allTargets.length === 0) {
    return envelope({
      success: true,
      data: { targets: [], files: [], guardAudit: null, message: 'No module targets found' },
      meta: { tool: 'autosnippet_bootstrap' },
    });
  }

  // 收集所有文件（去重）
  const seenPaths = new Set();
  const allFiles = [];
  for (const t of allTargets) {
    try {
      const fileList = await service.getTargetFiles(t);
      for (const f of fileList) {
        const fp = typeof f === 'string' ? f : f.path;
        if (seenPaths.has(fp)) {
          continue;
        }
        seenPaths.add(fp);
        const entry = {
          name: f.name || path.basename(fp),
          path: fp,
          relativePath: f.relativePath || path.basename(fp),
          targetName: t.name,
        };
        if (includeContent) {
          try {
            const raw = fs.readFileSync(fp, 'utf8');
            const lines = raw.split('\n');
            entry.content = lines.slice(0, contentMaxLines).join('\n');
            entry.totalLines = lines.length;
            entry.truncated = lines.length > contentMaxLines;
          } catch {
            entry.content = '';
            entry.totalLines = 0;
          }
        }
        allFiles.push(entry);
        if (allFiles.length >= maxFiles) {
          break;
        }
      }
    } catch {
      /* skip target */
    }
    if (allFiles.length >= maxFiles) {
      break;
    }
  }

  // Guard 审计
  let guardAudit = null;
  try {
    const { GuardCheckEngine } = await import('../../../service/guard/GuardCheckEngine.js');
    const engine = _getOrCreateEngine(ctx, GuardCheckEngine);

    // 注入 Enhancement Pack Guard 规则
    await _injectEnhancementGuardRules(engine, ctx);

    const filesToAudit = allFiles.map((f) => {
      const content = f.content || (fs.existsSync(f.path) ? fs.readFileSync(f.path, 'utf8') : '');
      return { path: f.path, content };
    });
    guardAudit = engine.auditFiles(filesToAudit, { scope: 'project' });

    // 写入 ViolationsStore
    try {
      const violationsStore = ctx.container.get('violationsStore');
      for (const fileResult of guardAudit.files || []) {
        if (fileResult.violations.length > 0) {
          violationsStore.appendRun({
            filePath: fileResult.filePath,
            violations: fileResult.violations,
            summary: `MCP project scan: ${fileResult.summary.errors}E ${fileResult.summary.warnings}W`,
          });
        }
      }
    } catch {
      /* store not available */
    }
  } catch (e) {
    ctx.logger.warn(`[MCP] Guard audit in scanProject failed: ${e.message}`);
  }

  // 构建文件列表摘要
  const fileSummary = allFiles.map((f) => {
    const base = { name: f.name, path: f.relativePath, targetName: f.targetName };
    if (includeContent) {
      base.content = f.content;
      base.totalLines = f.totalLines;
      base.truncated = f.truncated;
    }
    return base;
  });

  return envelope({
    success: true,
    data: {
      targets: allTargets.map((t) => ({ name: t.name, type: t.type, packageName: t.packageName })),
      files: fileSummary,
      fileCount: allFiles.length,
      guardAudit: guardAudit
        ? {
            summary: guardAudit.summary,
            filesWithViolations: (guardAudit.files || [])
              .filter((f) => f.violations.length > 0)
              .map((f) => ({
                filePath: f.filePath,
                language: f.language,
                violations: f.violations,
                summary: f.summary,
              })),
            ...(guardAudit.crossFileViolations?.length
              ? { crossFileViolations: guardAudit.crossFileViolations }
              : {}),
          }
        : null,
    },
    meta: { tool: 'autosnippet_bootstrap' },
  });
}

// ─── 内部辅助 ─────────────────────────────────────────────

/**
 * 获取 DI 容器中的 GuardCheckEngine 单例，回退到新建实例
 * 优先复用 DI 单例以保持 externalRules / cache 的跨调用一致性
 * @param {object} ctx - MCP context with container
 * @param {Function} GuardCheckEngine - 引擎构造函数（用于回退）
 * @returns {import('../../../service/guard/GuardCheckEngine.js').GuardCheckEngine}
 */
function _getOrCreateEngine(ctx, GuardCheckEngine) {
  try {
    const engine = ctx.container.get('guardCheckEngine');
    if (engine) {
      return engine;
    }
  } catch {
    /* DI not registered — fall back to new instance */
  }
  const db = ctx.container.get('database');
  return new GuardCheckEngine(db);
}

/**
 * 将 Enhancement Pack 的 Guard 规则注入 GuardCheckEngine
 * 幂等 — 已注入的引擎直接跳过，避免每次请求重复加载 EnhancementRegistry
 * 静默失败 — Enhancement Pack 不可用不应阻断 Guard 审计
 */
async function _injectEnhancementGuardRules(engine, ctx) {
  // 幂等保护: 已注入则跳过
  if (engine.isEpInjected?.()) {
    return;
  }
  try {
    const { initEnhancementRegistry } = await import('../../../core/enhancement/index.js');
    const enhReg = await initEnhancementRegistry();
    // 使用空语言+空框架列表获取所有已注册的 Pack（不过滤）
    // 这里我们注入 ALL 规则，让 GuardCheckEngine 按 languages 字段自行过滤
    const allPacks = enhReg.all();
    const allGuardRules = [];
    for (const pack of allPacks) {
      try {
        const rules = pack.getGuardRules();
        if (rules.length > 0) {
          allGuardRules.push(...rules);
        }
      } catch {
        /* graceful degradation per pack */
      }
    }
    if (allGuardRules.length > 0) {
      engine.injectExternalRules(allGuardRules);
    }
    engine.markEpInjected?.();
  } catch {
    /* Enhancement registry not available — non-critical */
  }
}
