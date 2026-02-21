/**
 * GuardHandler — 处理 // as:a (audit/guard/lint) 指令
 *
 * 用法:
 *   // as:a          — 检查当前文件 (scope=file)
 *   // as:a file     — 同上，显式 file scope
 *   // as:a target   — 检查当前文件所在目录树 (scope=target)
 *   // as:a project  — 检查整个项目所有源文件 (scope=project)
 *   // as:a <keyword> — 检查当前文件 + 搜索相关规范
 */

import { readFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { LanguageService } from '../../../shared/LanguageService.js';

/** 已知的 scope 关键词 */
const SCOPE_KEYWORDS = new Set(['file', 'target', 'project', 'all']);

/** 支持审计的源文件扩展名 — 委托给 LanguageService */
const SOURCE_EXTS = LanguageService.sourceExts;

/**
 * 递归收集目录下所有源文件路径
 */
async function collectSourceFiles(dir) {
  const { readdir } = await import('node:fs/promises');
  const files = [];

  // 跳过的目录
  const SKIP_DIRS = new Set([
    'node_modules',
    '.git',
    'build',
    'DerivedData',
    'Pods',
    '.build',
    'vendor',
    'dist',
    '.next',
    'Carthage',
    'xcuserdata',
    '__pycache__',
  ]);

  async function walk(currentDir) {
    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      return; // 权限不足等情况跳过
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.') {
        continue;
      }
      const fullPath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          await walk(fullPath);
        }
      } else if (entry.isFile() && SOURCE_EXTS.has(extname(entry.name).toLowerCase())) {
        files.push(fullPath);
      }
    }
  }

  await walk(dir);
  return files;
}

/**
 * @param {import('../FileWatcher').default} watcher  FileWatcher 实例
 * @param {string} fullPath  当前文件绝对路径
 * @param {string} code      当前文件内容
 * @param {string} guardLine 触发行原文
 */
export async function handleGuard(watcher, fullPath, code, guardLine) {
  const rest = guardLine.replace(/^\/\/\s*as:(?:audit|a|lint|l|guard|g)\s*/, '').trim();
  const scopeArg = rest.toLowerCase();
  const isScope = SCOPE_KEYWORDS.has(scopeArg);
  // 确定 scope：无参数或 'file' → file；'target' → target；'project'/'all' → project
  const scope =
    !rest || scopeArg === 'file'
      ? 'file'
      : scopeArg === 'target'
        ? 'target'
        : scopeArg === 'project' || scopeArg === 'all'
          ? 'project'
          : 'file'; // 非 scope 关键词回退到 file

  try {
    const { detectLanguage } = await import('../../guard/GuardCheckEngine.js');
    const { ServiceContainer } = await import('../../../injection/ServiceContainer.js');
    const container = ServiceContainer.getInstance();
    const engine = container.get('guardCheckEngine');

    /* ── 多文件审计 (target / project) ── */
    if (scope === 'project' || scope === 'target') {
      let scanRoot;
      if (scope === 'project') {
        scanRoot = watcher?.projectRoot;
      } else {
        // target: 扫描当前文件所在目录树
        scanRoot = dirname(fullPath);
      }

      if (!scanRoot) {
        console.warn('  ⚠️ 无法确定扫描根目录，回退到单文件检查');
        return _auditSingleFile(watcher, engine, fullPath, code, detectLanguage, 'file');
      }

      const scopeLabel = scope === 'project' ? '整个项目' : '当前目录';
      console.log(`\n🔍 Guard 审计 — ${scopeLabel} (${scanRoot})`);
      const sourcePaths = await collectSourceFiles(scanRoot);

      if (sourcePaths.length === 0) {
        console.log('  ℹ️ 未找到可审计的源文件');
        watcher._notify?.('未找到可审计的源文件');
        return;
      }
      console.log(`  📁 扫描到 ${sourcePaths.length} 个源文件`);

      // 读取所有文件内容
      const fileEntries = [];
      let readErrors = 0;
      for (const p of sourcePaths) {
        try {
          const content = await readFile(p, 'utf-8');
          fileEntries.push({ path: p, content });
        } catch {
          readErrors++;
        }
      }
      if (readErrors > 0) {
        console.warn(`  ⚠️ ${readErrors} 个文件读取失败，已跳过`);
      }

      // 批量审计（传递 scope 以启用对应维度规则）
      const report = engine.auditFiles(fileEntries, { scope });
      const { summary } = report;

      if (summary.totalViolations === 0) {
        console.log(`\n  ✅ 审计通过 — ${fileEntries.length} 个文件，无违规`);
        watcher._notify?.(`${scopeLabel}审计通过 ✅ ${fileEntries.length} 个文件，无违规`);
      } else {
        // 按文件输出详情（限制输出前 10 个有问题的文件）
        console.log(`\n  ❌ 审计发现 ${summary.totalViolations} 个问题 (${summary.errors ?? 0} 错误, ${summary.warnings ?? 0} 警告)`);
        watcher._notify?.(`${scopeLabel}审计: ${summary.totalViolations} 个问题 (${summary.errors ?? 0} 错误, ${summary.warnings ?? 0} 警告)`);
        const filesWithIssues = report.files.filter((f) => f.summary.total > 0);
        for (const file of filesWithIssues.slice(0, 10)) {
          const rel = file.filePath.replace(`${scanRoot}/`, '');
          const errors = file.violations.filter((v) => v.severity === 'error');
          const warnings = file.violations.filter((v) => v.severity === 'warning');
          console.log(`\n  📄 ${rel} (${errors.length} 错误, ${warnings.length} 警告)`);
          for (const v of errors.slice(0, 5)) {
            console.log(`    🔴 [${v.ruleId || 'unknown'}] ${v.message}${v.line ? ` (行 ${v.line})` : ''}`);
          }
          if (errors.length > 5) {
            console.log(`    ... 还有 ${errors.length - 5} 个错误`);
          }
          for (const v of warnings.slice(0, 3)) {
            console.log(`    🟡 [${v.ruleId || 'unknown'}] ${v.message}${v.line ? ` (行 ${v.line})` : ''}`);
          }
          if (warnings.length > 3) {
            console.log(`    ... 还有 ${warnings.length - 3} 个警告`);
          }
        }
        if (filesWithIssues.length > 10) {
          console.log(`\n  ... 还有 ${filesWithIssues.length - 10} 个文件有问题`);
        }

        // 跨文件问题汇总
        if (report.crossFileViolations?.length > 0) {
          console.log(`\n  🔗 跨文件问题 (${report.crossFileViolations.length} 个):`);
          for (const v of report.crossFileViolations.slice(0, 10)) {
            console.log(`    ⚠️ [${v.ruleId || 'cross-file'}] ${v.message}`);
            if (v.locations) {
              for (const loc of v.locations.slice(0, 5)) {
                const relLoc = loc.filePath.replace(`${scanRoot}/`, '');
                console.log(`      📍 ${relLoc}${loc.line ? `:${loc.line}` : ''}`);
              }
              if (v.locations.length > 5) {
                console.log(`      ... 还有 ${v.locations.length - 5} 个位置`);
              }
            }
          }
        }
      }
      return;
    }
    _auditSingleFile(watcher, engine, fullPath, code, detectLanguage, scope);

    // 如果有非 scope 关键词，也做语义搜索
    if (rest && !isScope) {
      try {
        const searchEngine = container.get('searchEngine');
        const results = await searchEngine.search(rest, { limit: 3, mode: 'keyword' });
        const items = Array.isArray(results) ? results : results.items || [];
        if (items.length > 0) {
          console.log(`\n  📚 相关规范 ("${rest}"):`);
          for (const r of items) {
            console.log(`    • ${r.title || r.name || r.id}`);
          }
        }
      } catch {
        // 搜索失败不阻塞
      }
    }
  } catch (err) {
    console.warn(`  ⚠️ Guard 检查失败: ${err.message}`);
  }
}

/**
 * 检查单个文件并打印结果
 */
function _auditSingleFile(watcher, engine, fullPath, code, detectLanguage, scope = 'file') {
  const language = detectLanguage(fullPath);
  const violations = engine.checkCode(code, language, { scope });

  if (violations.length === 0) {
    console.log(`\n  ✅ Guard 审计通过 — 无违规 (${fullPath.split('/').pop()})`);
    watcher._notify?.('审计通过 ✅ 无违规');
  } else {
    const errors = violations.filter((v) => v.severity === 'error');
    const warnings = violations.filter((v) => v.severity === 'warning');
    console.log(`\n  ❌ 发现 ${violations.length} 个问题 (${errors.length} 错误, ${warnings.length} 警告)`);
    watcher._notify?.(`审计: ${violations.length} 个问题 (${errors.length} 错误, ${warnings.length} 警告)`);
    for (const v of errors) {
      console.log(`    🔴 [${v.ruleId || 'unknown'}] ${v.message}${v.line ? ` (行 ${v.line})` : ''}`);
      if (v.fixSuggestion) {
        console.log(`       💡 建议: ${v.fixSuggestion}`);
      }
    }
    for (const v of warnings.slice(0, 5)) {
      console.log(`    🟡 [${v.ruleId || 'unknown'}] ${v.message}${v.line ? ` (行 ${v.line})` : ''}`);
      if (v.fixSuggestion) {
        console.log(`       💡 建议: ${v.fixSuggestion}`);
      }
    }
    if (warnings.length > 5) {
      console.log(`    ... 还有 ${warnings.length - 5} 个警告`);
    }
  }

  // Guard ↔ Recipe 闭环：检测修复并自动确认使用（fire-and-forget）
  import('../../../injection/ServiceContainer.js')
    .then(({ ServiceContainer }) => {
      try {
        const container = ServiceContainer.getInstance();
        const feedbackLoop = container.get('guardFeedbackLoop');
        feedbackLoop.processFixDetection({ violations }, fullPath);
      } catch {
        /* guardFeedbackLoop not available */
      }
    })
    .catch(() => {
      /* ignored */
    });
}
