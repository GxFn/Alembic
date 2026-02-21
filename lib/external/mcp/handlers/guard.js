/**
 * MCP Handlers — Guard 审计 & 项目扫描
 * guardCheck, guardAuditFiles, scanProject
 */

import fs from 'node:fs';
import path from 'node:path';
import { envelope } from '../envelope.js';

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

  const db = ctx.container.get('database');
  const engine = new GuardCheckEngine(db);

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
  const db = ctx.container.get('database');
  const engine = new GuardCheckEngine(db);

  // 注入 Enhancement Pack Guard 规则
  await _injectEnhancementGuardRules(engine, ctx);

  // 补充缺失的 content（从磁盘读取）
  const filesToAudit = args.files.map((f) => ({
    path: f.path,
    content: f.content || (fs.existsSync(f.path) ? fs.readFileSync(f.path, 'utf8') : ''),
  }));

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
    const db = ctx.container.get('database');
    const engine = new GuardCheckEngine(db);

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
 * 将 Enhancement Pack 的 Guard 规则注入 GuardCheckEngine
 * 静默失败 — Enhancement Pack 不可用不应阻断 Guard 审计
 */
async function _injectEnhancementGuardRules(engine, ctx) {
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
  } catch {
    /* Enhancement registry not available — non-critical */
  }
}
