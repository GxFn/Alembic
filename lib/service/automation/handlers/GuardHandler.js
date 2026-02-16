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

import { basename, join, extname, dirname } from 'node:path';
import { readFile } from 'node:fs/promises';

/** 已知的 scope 关键词 */
const SCOPE_KEYWORDS = new Set(['file', 'target', 'project', 'all']);

/** 支持审计的源文件扩展名 */
const SOURCE_EXTS = new Set([
  '.m', '.mm', '.h', '.swift',
  '.c', '.cpp', '.cc', '.cxx', '.hpp',
  '.js', '.ts', '.jsx', '.tsx',
  '.java', '.kt', '.py', '.rb', '.go', '.rs',
]);

/**
 * 递归收集目录下所有源文件路径
 */
async function collectSourceFiles(dir) {
  const { readdir } = await import('node:fs/promises');
  const files = [];

  // 跳过的目录
  const SKIP_DIRS = new Set([
    'node_modules', '.git', 'build', 'DerivedData',
    'Pods', '.build', 'vendor', 'dist', '.next',
    'Carthage', 'xcuserdata', '__pycache__',
  ]);

  async function walk(currentDir) {
    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      return; // 权限不足等情况跳过
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.') continue;
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
  const scope = !rest || scopeArg === 'file' ? 'file'
    : scopeArg === 'target' ? 'target'
    : (scopeArg === 'project' || scopeArg === 'all') ? 'project'
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
        return _auditSingleFile(engine, fullPath, code, detectLanguage, 'file');
      }

      const scopeLabel = scope === 'project' ? '整个项目' : '当前目录';
      console.log(`\n🛡️  [Guard] 正在扫描${scopeLabel}: ${scanRoot}`);
      const sourcePaths = await collectSourceFiles(scanRoot);
      console.log(`  📁 找到 ${sourcePaths.length} 个源文件`);

      if (sourcePaths.length === 0) {
        console.log('  ✅ 未找到源文件');
        return;
      }

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
        console.log(`  ⚠️ ${readErrors} 个文件无法读取，已跳过`);
      }

      // 批量审计（传递 scope 以启用对应维度规则）
      const report = engine.auditFiles(fileEntries, { scope });
      const { summary } = report;

      if (summary.totalViolations === 0) {
        console.log(`  ✅ ${summary.filesChecked} 个文件全部通过，无违规`);
      } else {
        console.log(`  🛡️ 扫描 ${summary.filesChecked} 个文件:`);
        console.log(`     ${summary.totalErrors} errors, ${summary.totalViolations - summary.totalErrors} warnings`);
        console.log(`     ${summary.filesWithViolations} 个文件存在问题\n`);

        // 按文件输出详情（限制输出前 10 个有问题的文件）
        const filesWithIssues = report.files.filter(f => f.summary.total > 0);
        for (const file of filesWithIssues.slice(0, 10)) {
          const rel = file.filePath.replace(scanRoot + '/', '');
          console.log(`  📄 ${rel}  (${file.summary.errors}E / ${file.summary.warnings}W)`);
          const errors = file.violations.filter(v => v.severity === 'error');
          const warnings = file.violations.filter(v => v.severity === 'warning');
          for (const v of errors.slice(0, 5)) {
            console.log(`     ❌ L${v.line} [${v.ruleId}] ${v.message}`);
          }
          if (errors.length > 5) console.log(`     ... 还有 ${errors.length - 5} 个 errors`);
          for (const v of warnings.slice(0, 3)) {
            console.log(`     ⚠️  L${v.line} [${v.ruleId}] ${v.message}`);
          }
          if (warnings.length > 3) console.log(`     ... 还有 ${warnings.length - 3} 个 warnings`);
        }
        if (filesWithIssues.length > 10) {
          console.log(`\n  ... 还有 ${filesWithIssues.length - 10} 个文件有问题，已省略`);
        }

        // 跨文件问题汇总
        if (report.crossFileViolations?.length > 0) {
          console.log(`\n  🔗 跨文件问题 (${report.crossFileViolations.length}):`);
          for (const v of report.crossFileViolations.slice(0, 10)) {
            console.log(`     ⚠️  [${v.ruleId}] ${v.message}`);
            if (v.locations) {
              for (const loc of v.locations.slice(0, 5)) {
                const relLoc = loc.filePath.replace(scanRoot + '/', '');
                console.log(`        📄 ${relLoc}:L${loc.line}`);
              }
              if (v.locations.length > 5) console.log(`        ... 还有 ${v.locations.length - 5} 处`);
            }
          }
        }
      }
      return;
    }

    /* ── 单文件审计 (file scope) ── */
    console.log(`\n🛡️  [Guard] 正在检查文件: ${basename(fullPath)}`);
    _auditSingleFile(engine, fullPath, code, detectLanguage, scope);

    // 如果有非 scope 关键词，也做语义搜索
    if (rest && !isScope) {
      try {
        const searchEngine = container.get('searchEngine');
        const results = await searchEngine.search(rest, { limit: 3, mode: 'keyword' });
        if (results.length > 0) {
          console.log(`  🧠 相关规范 (${results.length}条):`);
          for (const r of results) {
            console.log(`     - ${r.title || r.id}`);
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
function _auditSingleFile(engine, fullPath, code, detectLanguage, scope = 'file') {
  const language = detectLanguage(fullPath);
  const violations = engine.checkCode(code, language, { scope });

  if (violations.length === 0) {
    console.log(`  ✅ 无违规`);
  } else {
    const errors = violations.filter((v) => v.severity === 'error');
    const warnings = violations.filter((v) => v.severity === 'warning');
    console.log(`  🛡️ ${errors.length} errors, ${warnings.length} warnings`);
    for (const v of errors) {
      console.log(`  ❌ L${v.line} [${v.ruleId}] ${v.message}`);
    }
    for (const v of warnings.slice(0, 5)) {
      console.log(`  ⚠️  L${v.line} [${v.ruleId}] ${v.message}`);
    }
  }
}
