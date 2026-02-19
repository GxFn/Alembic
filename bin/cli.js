#!/usr/bin/env node

/**
 * AutoSnippet V2 CLI
 * 
 * Usage:
 *   asd setup           - 初始化项目
 *   asd coldstart       - 冷启动知识库（9 维度分析 + AI 填充）
 *   asd ais [Target]    - AI 扫描 Target → 直接发布 Recipes
 *   asd search <query>  - 搜索知识库
 *   asd guard <file>    - Guard 检查
 *   asd watch           - 文件监控
 *   asd compliance      - 合规评估
 *   asd server          - 启动 API 服务
 *   asd status          - 环境状态
 *   asd ui              - 启动 Dashboard UI
 */

import { Command } from 'commander';
import { readFileSync, existsSync } from 'fs';
import { join, resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkgPath = join(__dirname, '..', 'package.json');
const pkg = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, 'utf8')) : { version: '2.0.0' };

// ─── 进程级错误兜底 ────────────────────────────────────
process.on('uncaughtException', (error) => {
  process.stderr.write(`[asd] Uncaught Exception: ${error.message}\n`);
  if (error.stack) process.stderr.write(`${error.stack}\n`);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  process.stderr.write(`[asd] Unhandled Rejection: ${msg}\n`);
  process.exit(1);
});

// 优雅关闭 — 防止 SIGINT/SIGTERM 时资源泄漏
const handleSignal = (signal) => {
  process.stderr.write(`[asd] Received ${signal}, exiting…\n`);
  process.exit(0);
};
process.on('SIGTERM', () => handleSignal('SIGTERM'));
process.on('SIGINT',  () => handleSignal('SIGINT'));

const program = new Command();
program
  .name('asd')
  .description('AutoSnippet V2 - AI 知识库管理工具')
  .version(pkg.version);

// ─────────────────────────────────────────────────────
// setup 命令
// ─────────────────────────────────────────────────────
program
  .command('setup')
  .description('初始化项目工作空间：目录结构、数据库、IDE 集成、模板')
  .option('-d, --dir <path>', '项目目录', '.')
  .option('--force', '强制覆盖已有配置')
  .option('--seed', '预置示例 Recipe（冷启动推荐）')
  .action(async (opts) => {
    const { SetupService } = await import('../lib/cli/SetupService.js');
    const service = new SetupService({ projectRoot: resolve(opts.dir), force: opts.force, seed: opts.seed });

    console.log(`\n🚀 AutoSnippet V2 — 初始化工作空间`);
    console.log(`   项目: ${service.projectName}`);
    console.log(`   路径: ${service.projectRoot}\n`);

    await service.run();
    service.printSummary();
  });

// ─────────────────────────────────────────────────────
// coldstart 命令 (Knowledge Bootstrap)
// ─────────────────────────────────────────────────────
program
  .command('coldstart')
  .description('冷启动知识库：9 维度项目分析 + AI 异步填充（与 Dashboard 点击冷启动流程一致）')
  .option('-d, --dir <path>', '项目目录', '.')
  .option('-m, --max-files <n>', '最大扫描文件数', '500')
  .option('--skip-guard', '跳过 Guard 审计')
  .option('--no-skills', '禁用 Skill 加载')
  .option('--wait', '等待 AI 异步填充完成（默认骨架完成即退出）')
  .option('--json', '以 JSON 格式输出结果')
  .action(async (opts) => {
    const projectRoot = resolve(opts.dir);
    console.log(`\n🚀 AutoSnippet — 冷启动知识库`);
    console.log(`   项目: ${basename(projectRoot)}`);
    console.log(`   路径: ${projectRoot}`);
    console.log(`   最大文件数: ${opts.maxFiles}`);
    if (opts.skipGuard) console.log('   Guard 审计: 跳过');
    console.log('');

    try {
      const { bootstrap, container } = await initContainer({ projectRoot });

      // 使用与前端 POST /spm/bootstrap 完全相同的入口: chatAgent.executeTool('bootstrap_knowledge')
      const chatAgent = container.get('chatAgent');

      const ora = (await import('ora')).default;
      const spinner = ora('Phase 1-4: 收集文件、AST 分析、SPM 依赖、Guard 审计...').start();

      const result = await chatAgent.executeTool('bootstrap_knowledge', {
        maxFiles: parseInt(opts.maxFiles, 10),
        skipGuard: opts.skipGuard || false,
        contentMaxLines: 120,
        loadSkills: opts.skills !== false,
      });

      spinner.stop();

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        // 输出骨架报告
        const report = result.report || {};
        const targets = result.targets || [];
        const langStats = result.languageStats || {};
        const guardSummary = result.guardSummary;
        const astSummary = result.astSummary;
        const bootstrapCandidates = result.bootstrapCandidates || {};
        const framework = result.analysisFramework || {};

        console.log('✅ 冷启动骨架已创建\n');

        // 项目概况
        console.log('📊 项目概况');
        console.log(`   Targets: ${targets.length}`);
        console.log(`   文件: ${report.totals?.files || 0}`);
        console.log(`   主语言: ${result.primaryLanguage || 'unknown'}`);
        if (Object.keys(langStats).length > 0) {
          const langParts = Object.entries(langStats)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([ext, count]) => `${ext}(${count})`);
          console.log(`   语言分布: ${langParts.join(', ')}`);
        }

        // AST 分析
        if (astSummary) {
          console.log(`\n🔬 AST 分析`);
          console.log(`   类: ${astSummary.classes}, 协议: ${astSummary.protocols}, Category: ${astSummary.categories}`);
          if (astSummary.metrics) {
            console.log(`   方法总数: ${astSummary.metrics.totalMethods}, 复杂方法: ${astSummary.metrics.complexMethods}`);
          }
        }

        // SPM 依赖
        if (report.phases?.spmDependencyGraph) {
          console.log(`\n📦 SPM 依赖`);
          console.log(`   依赖边: ${report.phases.spmDependencyGraph.edgesWritten}`);
        }

        // Guard 审计
        if (guardSummary) {
          console.log(`\n🛡️  Guard 审计`);
          console.log(`   违规: ${guardSummary.totalViolations} (${guardSummary.errors} errors, ${guardSummary.warnings} warnings)`);
        }

        // 维度分析框架
        if (framework.dimensions) {
          console.log(`\n📋 分析维度: ${framework.dimensions.length} 个`);
          for (const dim of framework.dimensions) {
            const type = dim.skillWorthy ? (dim.dualOutput ? 'Dual' : 'Skill') : 'Candidate';
            console.log(`   • ${dim.label} [${type}]`);
          }
        }

        // AI 异步填充状态
        console.log(`\n🤖 AI 异步填充: ${result.asyncFill ? '已启动' : '未启用'}`);
        if (result.bootstrapSession) {
          const session = result.bootstrapSession;
          console.log(`   会话: ${session.id}`);
          console.log(`   任务: ${session.tasks?.length || 0} 个维度`);
        }

        console.log('');
      }

      // 等待模式: 轮询 BootstrapTaskManager 直到所有维度完成
      if (opts.wait && result.bootstrapSession) {
        const ora2 = (await import('ora')).default;
        const waitSpinner = ora2('Phase 5: AI 正在逐维度填充知识...').start();
        let lastStatus = '';
        let attempts = 0;
        const maxAttempts = 600; // 最多等 10 分钟（每秒轮询）

        while (attempts < maxAttempts) {
          await new Promise(r => setTimeout(r, 1000));
          attempts++;

          try {
            const taskManager = container.get('bootstrapTaskManager');
            const sessionStatus = taskManager.getSessionStatus();

            if (!sessionStatus || !sessionStatus.tasks) break;

            const total = sessionStatus.tasks.length;
            const done = sessionStatus.tasks.filter(t => t.status === 'done' || t.status === 'error').length;
            const current = sessionStatus.tasks.find(t => t.status === 'running');
            const statusText = current
              ? `[${done}/${total}] 正在处理: ${current.meta?.label || current.id}`
              : `[${done}/${total}] 等待中...`;

            if (statusText !== lastStatus) {
              waitSpinner.text = statusText;
              lastStatus = statusText;
            }

            if (done >= total) {
              waitSpinner.succeed(`AI 填充完成: ${total} 个维度`);

              // 输出各维度结果
              if (!opts.json) {
                const succeeded = sessionStatus.tasks.filter(t => t.status === 'done').length;
                const failed = sessionStatus.tasks.filter(t => t.status === 'error').length;
                console.log(`   ✅ 成功: ${succeeded}, ❌ 失败: ${failed}`);
                for (const t of sessionStatus.tasks) {
                  const icon = t.status === 'done' ? '✅' : '❌';
                  console.log(`   ${icon} ${t.meta?.label || t.id}`);
                }
                console.log('');
              }
              break;
            }
          } catch {
            // bootstrapTaskManager 可能还没就绪
          }
        }

        if (attempts >= maxAttempts) {
          waitSpinner.warn('AI 填充超时（10 分钟），可通过 asd ui 查看进度');
        }
      } else if (!opts.json) {
        console.log('💡 后台 AI 正在逐维度填充知识，可通过以下方式查看进度:');
        console.log('   • asd ui -d .    → Dashboard 实时查看');
        console.log('   • 再次运行 asd coldstart --wait 等待完成');
        console.log('');
      }

      await bootstrap.shutdown();
    } catch (err) {
      console.error(`\n❌ ${err.message}`);
      if (process.env.ASD_DEBUG === '1') console.error(err.stack);
      process.exit(1);
    }
  });

// ─────────────────────────────────────────────────────
// ais 命令 (AI Scan)
// ─────────────────────────────────────────────────────
program
  .command('ais [target]')
  .description('AI 扫描 Target 源码 → 提取并发布 Recipes（需配置 AI Provider）')
  .option('-d, --dir <path>', '项目目录', '.')
  .option('-m, --max-files <n>', '最大扫描文件数', '200')
  .option('--dry-run', '仅预览，不发布 Recipe')
  .option('--json', '以 JSON 格式输出')
  .action(async (target, opts) => {
    const projectRoot = resolve(opts.dir);
    console.log(`\n🔬 AutoSnippet AI Scan`);
    console.log(`   项目: ${basename(projectRoot)}`);
    if (target) console.log(`   Target: ${target}`);
    console.log(`   最大文件数: ${opts.maxFiles}`);
    if (opts.dryRun) console.log('   模式: dry-run（仅预览）');
    console.log('');

    try {
      const { bootstrap, container } = await initContainer({ projectRoot });

      const { AiScanService } = await import('../lib/cli/AiScanService.js');
      const scanner = new AiScanService({ container, projectRoot });

      const ora = (await import('ora')).default;
      const spinner = ora('正在扫描源文件并提取 Recipe...').start();

      const report = await scanner.scan(target || null, {
        maxFiles: parseInt(opts.maxFiles, 10),
        dryRun: opts.dryRun,
      });

      spinner.stop();

      if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(`\n✅ AI 扫描完成`);
        console.log(`   扫描文件: ${report.files}`);
        console.log(`   跳过: ${report.skipped}`);
        console.log(`   发布 Recipe: ${report.published}`);
        if (report.errors.length > 0) {
          console.log(`\n⚠️  ${report.errors.length} 个错误：`);
          for (const err of report.errors.slice(0, 10)) {
            console.log(`   - ${err}`);
          }
          if (report.errors.length > 10) console.log(`   ... 及其他 ${report.errors.length - 10} 个`);
        }
        if (!opts.dryRun && report.published > 0) {
          console.log(`\n📋 Recipe 已发布，可通过 asd search 或 Cursor Rules 使用`);
        }
      }

      await bootstrap.shutdown();
    } catch (err) {
      console.error(`\n❌ ${err.message}`);
      if (process.env.ASD_DEBUG === '1') console.error(err.stack);
      process.exit(1);
    }
  });

// ─────────────────────────────────────────────────────
// search 命令
// ─────────────────────────────────────────────────────
program
  .command('search <query>')
  .description('搜索知识库')
  .option('-t, --type <type>', '搜索类型: all, recipe, solution, rule', 'all')
  .option('-m, --mode <mode>', '搜索模式: keyword, bm25, semantic', 'bm25')
  .option('-l, --limit <n>', '结果数量', '10')
  .action(async (query, opts) => {
    try {
      const { bootstrap, container } = await initContainer();
      const engine = container.get('searchEngine');
      const results = await engine.search(query, {
        type: opts.type,
        mode: opts.mode,
        limit: parseInt(opts.limit, 10),
      });

      if (results.items.length === 0) {
        console.log('No results found.');
      } else {
        console.log(`\n🔍 Found ${results.total} results (${results.mode} mode):\n`);
        for (const item of results.items) {
          const badge = item.type === 'recipe' ? '📘' : item.type === 'solution' ? '💡' : '🛡️';
          const score = item.score ? ` [${item.score}]` : '';
          console.log(`  ${badge} ${item.title || item.id}${score}`);
          if (item.description) console.log(`     ${item.description.slice(0, 80)}`);
        }
      }

      await bootstrap.shutdown();
    } catch (err) {
      console.error('Error:', err.message);
      process.exit(1);
    }
  });

// ─────────────────────────────────────────────────────
// guard 命令
// ─────────────────────────────────────────────────────
program
  .command('guard <file>')
  .description('对文件运行 Guard 规则检查')
  .option('-s, --scope <scope>', '审查维度: file, target, project', 'file')
  .option('--json', '以 JSON 格式输出')
  .action(async (file, opts) => {
    try {
      const filePath = resolve(file);
      if (!existsSync(filePath)) {
        console.error(`File not found: ${filePath}`);
        process.exit(1);
      }

      const code = readFileSync(filePath, 'utf8');
      const { bootstrap, container } = await initContainer();

      const { detectLanguage } = await import('../lib/service/guard/GuardCheckEngine.js');
      const engine = container.get('guardCheckEngine');
      const language = detectLanguage(filePath);
      const violations = engine.checkCode(code, language, { scope: opts.scope });

      if (opts.json) {
        console.log(JSON.stringify({ file: filePath, language, violations }, null, 2));
      } else if (violations.length === 0) {
        console.log(`✅ No violations found in ${file} (${language})`);
      } else {
        const errors = violations.filter(v => v.severity === 'error');
        const warnings = violations.filter(v => v.severity === 'warning');
        console.log(`\n🛡️  ${file} (${language}): ${violations.length} violations`);
        console.log(`   ${errors.length} errors, ${warnings.length} warnings\n`);
        for (const v of violations) {
          const icon = v.severity === 'error' ? '❌' : '⚠️';
          console.log(`  ${icon} L${v.line} [${v.ruleId}] ${v.message}`);
          if (v.snippet) console.log(`     ${v.snippet}`);
        }
      }

      await bootstrap.shutdown();
      process.exit(violations.some(v => v.severity === 'error') ? 1 : 0);
    } catch (err) {
      console.error('Error:', err.message);
      process.exit(1);
    }
  });

// ─────────────────────────────────────────────────────
// guard:ci 命令
// ─────────────────────────────────────────────────────
program
  .command('guard:ci [path]')
  .description('CI/CD 模式运行全项目 Guard 检查')
  .option('--fail-on-error', '有 error 级违规时 exit 1', true)
  .option('--fail-on-warning', '超过 warning 阈值时 exit 2')
  .option('--max-warnings <n>', 'warning 阈值', '20')
  .option('--report <format>', '报告格式: json | text | markdown', 'text')
  .option('--output <file>', '报告输出文件')
  .option('--min-score <n>', 'Quality Gate 最低分', '70')
  .option('--max-files <n>', '最大扫描文件数', '500')
  .action(async (scanPath, opts) => {
    try {
      const projectRoot = resolve(scanPath || '.');
      const { bootstrap, container } = await initContainer({ projectRoot });
      const reporter = container.get('complianceReporter');

      const report = await reporter.generate(projectRoot, {
        qualityGate: {
          maxErrors: 0,
          maxWarnings: parseInt(opts.maxWarnings, 10),
          minScore: parseInt(opts.minScore, 10),
        },
        maxFiles: parseInt(opts.maxFiles, 10),
      });

      // 输出报告
      if (opts.report === 'json') {
        const output = JSON.stringify(report, null, 2);
        if (opts.output) {
          const { writeFileSync } = await import('fs');
          writeFileSync(opts.output, output, 'utf8');
          console.log(`Report written to ${opts.output}`);
        } else {
          console.log(output);
        }
      } else {
        reporter.printReport(report, { format: opts.report });
      }

      // 如果也要写文件（非 JSON 格式）
      if (opts.output && opts.report !== 'json') {
        const { writeFileSync } = await import('fs');
        writeFileSync(opts.output, JSON.stringify(report, null, 2), 'utf8');
        console.log(`Report data written to ${opts.output}`);
      }

      await bootstrap.shutdown();

      // Exit code
      if (report.qualityGate.status === 'FAIL') {
        process.exit(report.summary.errors > 0 ? 1 : 2);
      }
      process.exit(0);
    } catch (err) {
      console.error('Error:', err.message);
      if (process.env.ASD_DEBUG === '1') console.error(err.stack);
      process.exit(1);
    }
  });

// ─────────────────────────────────────────────────────
// guard:staged 命令
// ─────────────────────────────────────────────────────
program
  .command('guard:staged')
  .description('检查 git staged 文件')
  .option('--fail-on-error', '有 error 时 exit 1', true)
  .option('--json', '以 JSON 格式输出')
  .action(async (opts) => {
    try {
      const { execSync } = await import('child_process');

      // 获取 staged 文件列表
      let stagedFiles;
      try {
        stagedFiles = execSync('git diff --cached --name-only --diff-filter=ACM', { encoding: 'utf8' })
          .trim().split('\n').filter(Boolean);
      } catch (err) {
        console.error('❌ 无法获取 git staged 文件（是否在 git 仓库中？）');
        process.exit(1);
      }

      if (stagedFiles.length === 0) {
        console.log('✅ No staged files');
        process.exit(0);
      }

      // 过滤源文件
      const { SOURCE_EXTS } = await import('../lib/service/guard/SourceFileCollector.js');
      const { extname: _extname } = await import('path');
      const sourceFiles = stagedFiles.filter(f => SOURCE_EXTS.has(_extname(f).toLowerCase()));

      if (sourceFiles.length === 0) {
        console.log('✅ No source files in staged changes');
        process.exit(0);
      }

      const { bootstrap, container } = await initContainer();
      const engine = container.get('guardCheckEngine');
      const { detectLanguage } = await import('../lib/service/guard/GuardCheckEngine.js');

      // 读取文件内容并检查
      const files = [];
      for (const f of sourceFiles) {
        const filePath = resolve(f);
        if (existsSync(filePath)) {
          files.push({ path: filePath, content: readFileSync(filePath, 'utf8') });
        }
      }

      const result = engine.auditFiles(files, { scope: 'file' });
      const { summary } = result;

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else if (summary.totalViolations === 0) {
        console.log(`✅ ${summary.filesChecked} staged files passed Guard check`);
      } else {
        console.log(`\n🛡️  Guard check on ${summary.filesChecked} staged files:`);
        console.log(`   ${summary.totalErrors} errors, ${summary.totalViolations - summary.totalErrors} warnings\n`);

        const filesWithIssues = result.files.filter(f => f.summary.total > 0);
        for (const file of filesWithIssues.slice(0, 10)) {
          console.log(`  📄 ${basename(file.filePath)}  (${file.summary.errors}E / ${file.summary.warnings}W)`);
          for (const v of file.violations.slice(0, 5)) {
            const icon = v.severity === 'error' ? '❌' : '⚠️';
            console.log(`     ${icon} L${v.line} [${v.ruleId}] ${v.message}`);
          }
          if (file.violations.length > 5) console.log(`     ... ${file.violations.length - 5} more`);
        }
      }

      await bootstrap.shutdown();
      process.exit(summary.totalErrors > 0 ? 1 : 0);
    } catch (err) {
      console.error('Error:', err.message);
      if (process.env.ASD_DEBUG === '1') console.error(err.stack);
      process.exit(1);
    }
  });

// ─────────────────────────────────────────────────────
// watch 命令
// ─────────────────────────────────────────────────────
program
  .command('watch')
  .description('启动文件监控（支持 // as:c、// as:s、// as:a 等指令）')
  .option('-d, --dir <path>', '监控目录', '.')
  .option('-e, --ext <exts>', '文件扩展名（逗号分隔）', '.swift,.m,.h')
  .option('--guard', '自动运行 Guard 检查', true)
  .action(async (opts) => {
    try {
      const dir = resolve(opts.dir);
      console.log(`👁️  Watching ${dir} for changes...`);
      console.log(`   Extensions: ${opts.ext}`);
      console.log(`   Directives: // as:c (create), // as:s (search), // as:a (audit)`);
      console.log('   Press Ctrl+C to stop\n');

      let bootstrap;
      try {
        const result = await initContainer({ projectRoot: dir });
        bootstrap = result.bootstrap;
      } catch {
        // ServiceContainer 初始化失败不阻塞 watch（HTTP fallback 仍可用）
        bootstrap = await initBootstrap();
      }

      const Paths = await import('../lib/infrastructure/config/Paths.js');
      const specPath = Paths.getProjectSpecPath(dir);

      const { FileWatcher } = await import('../lib/service/automation/FileWatcher.js');
      const exts = opts.ext.split(',').map(e => e.trim());
      const watcher = new FileWatcher(specPath, dir, {
        quiet: false,
        exts,
      });
      watcher.start();

      // 优雅退出
      process.on('SIGINT', async () => {
        console.log('\n🛑 Stopping watcher...');
        await watcher.stop();
        await bootstrap.shutdown();
        process.exit(0);
      });
    } catch (err) {
      console.error('Error:', err.message);
      if (process.env.ASD_DEBUG === '1') console.error(err.stack);
      process.exit(1);
    }
  });

// ─────────────────────────────────────────────────────
// server 命令
// ─────────────────────────────────────────────────────
program
  .command('server')
  .description('启动 API 服务器')
  .option('-p, --port <port>', '端口', '3000')
  .option('-H, --host <host>', '绑定地址', '127.0.0.1')
  .action(async (opts) => {
    console.log(`🚀 Starting AutoSnippet V2 API server on ${opts.host}:${opts.port}...`);
    // 设置环境变量后启动 api-server
    process.env.PORT = opts.port;
    process.env.HOST = opts.host;
    await import('./api-server.js');
  });

// ─────────────────────────────────────────────────────
// ui 命令 (Dashboard)
// ─────────────────────────────────────────────────────
program
  .command('ui')
  .description('启动 Dashboard UI（API 服务 + 前端开发服务器）')
  .option('-p, --port <port>', 'API 服务端口', '3000')
  .option('-b, --browser', '自动打开浏览器')
  .option('--no-open', '禁止自动打开浏览器（CI/CD 环境适用）')
  .option('-d, --dir <directory>', '指定 AutoSnippet 项目目录（默认：当前目录）')
  .option('--api-only', '仅启动 API 服务（不启动前端）')
  .action(async (opts) => {
    const { spawn } = await import('child_process');

    // 项目根目录：-d 选项 > 环境变量 ASD_CWD > 当前目录
    const projectRoot = opts.dir || process.env.ASD_CWD || process.cwd();
    console.log(`📂 Project root: ${projectRoot}`);

    // 1. 内联启动 API Server（不用 import api-server.js，避免其 process.exit 影响整个进程）
    console.log(`🚀 Starting API server on port ${opts.port}...`);
    const port = opts.port;
    const host = '127.0.0.1';
    process.env.PORT = port;
    process.env.HOST = host;

    let httpServer;
    try {
      const { default: HttpServer } = await import('../lib/http/HttpServer.js');

      const { bootstrap, container } = await initContainer({ projectRoot });

      // 连接 EventBus → Gateway（供 SignalCollector 监听事件）
      try {
        const eventBus = container.get('eventBus');
        const gateway = container.get('gateway');
        gateway.eventBus = eventBus;
      } catch { /* EventBus 不可用不阻塞启动 */ }

      httpServer = new HttpServer({ port, host });
      await httpServer.initialize();
      await httpServer.start();

      console.log(`✅ API server running at http://${host}:${port}`);

      // 启动 SignalCollector 后台 AI 分析服务
      try {
        const { SignalCollector } = await import('../lib/service/skills/SignalCollector.js');
        const { getRealtimeService } = await import('../lib/infrastructure/realtime/RealtimeService.js');
        const db = container.get('database');
        const chatAgent = container.get('chatAgent');

        const signalCollector = new SignalCollector({
          projectRoot,
          database: db,
          chatAgent,
          mode: process.env.ASD_SIGNAL_MODE || 'auto',
          intervalMs: parseInt(process.env.ASD_SIGNAL_INTERVAL || '3600000', 10),
          onSuggestions: (suggestions) => {
            try {
              const realtime = getRealtimeService();
              realtime.broadcastEvent('skill:suggestions', { suggestions });
            } catch { /* realtime 未就绪 */ }
          },
        });
        signalCollector.start();
        global._signalCollector = signalCollector;
        console.log(`🧠 SignalCollector started (mode=${signalCollector.getMode()}, AI-driven)`);
      } catch (scErr) {
        console.warn(`⚠️  SignalCollector failed to start: ${scErr.message}`);
        if (process.env.ASD_DEBUG === '1') console.error(scErr.stack);
      }

      // 3. 启动文件监听器（监控 // as:c // as:s // as:a 等指令）
      try {
        const Paths = await import('../lib/infrastructure/config/Paths.js');
        const specPath = Paths.getProjectSpecPath(projectRoot);
        const isDebugMode = process.env.ASD_DEBUG === '1';

        // 设置 Dashboard URL 供 watcher 跳转浏览器使用
        // 生产模式用 API 同端口，开发模式用 vite dev 5173
        const dashDirCheck = join(__dirname, '..', 'dashboard');
        const isProductionDashboard = existsSync(join(dashDirCheck, 'dist', 'index.html')) && !existsSync(join(dashDirCheck, 'src'));
        if (!opts.apiOnly) {
          process.env.ASD_DASHBOARD_URL = isProductionDashboard
            ? `http://127.0.0.1:${port}`
            : `http://localhost:5173`;
        } else {
          process.env.ASD_DASHBOARD_URL = process.env.ASD_DASHBOARD_URL || `http://${host}:${port}`;
        }

        const { FileWatcher } = await import('../lib/service/automation/FileWatcher.js');
        const watcher = new FileWatcher(specPath, projectRoot, { quiet: !isDebugMode });
        watcher.start();
        console.log(`👁️  File watcher started for: ${projectRoot}`);
        if (isDebugMode) {
          console.log(`   Spec path: ${specPath}`);
          console.log(`   Dashboard URL: ${process.env.ASD_DASHBOARD_URL}`);
        }
      } catch (watchErr) {
        console.warn(`⚠️  File watcher failed to start: ${watchErr.message}`);
        if (process.env.ASD_DEBUG === '1') {
          console.error(watchErr.stack);
        }
      }

    } catch (err) {
      console.error(`❌ API server failed to start: ${err.message}`);
      if (err.code === 'EADDRINUSE') {
        console.error(`   Port ${port} is already in use. Kill it with: lsof -ti:${port} | xargs kill -9`);
      }
      process.exit(1);
    }

    if (opts.apiOnly) {
      console.log(`   Docs: http://127.0.0.1:${port}/api-spec`);
      return;
    }

    // 2. 启动 Dashboard UI
    const dashboardDir = join(__dirname, '..', 'dashboard');
    const distDir = join(dashboardDir, 'dist');
    const hasPrebuilt = existsSync(join(distDir, 'index.html'));
    const hasSrc = existsSync(join(dashboardDir, 'src'));

    if (hasPrebuilt && !hasSrc) {
      // ── 生产模式：npm 安装的包，在 API 服务器上直接托管预构建产物 ──
      // 同端口同 origin → /api 路由自然可达，无跨域问题
      httpServer.mountDashboard(distDir);
      console.log(`🎨 Dashboard UI ready at http://127.0.0.1:${port}/`);

      if (opts.browser) {
        const open = (await import('open')).default;
        open(`http://127.0.0.1:${port}/`);
      }

    } else {
      // ── 开发模式：有源码，启动 Vite Dev Server ──
      if (!existsSync(join(dashboardDir, 'node_modules'))) {
        console.log('📦 Installing dashboard dependencies...');
        const install = spawn('npm', ['install'], { cwd: dashboardDir, stdio: 'inherit' });
        await new Promise((resolve, reject) => {
          install.on('close', code => code === 0 ? resolve() : reject(new Error(`npm install exited with ${code}`)));
        });
      }

      console.log('🎨 Starting Dashboard (dev mode)...');
      const viteArgs = ['--host'];
      if (opts.browser) {
        viteArgs.push('--open');
      }
      const vite = spawn('npx', ['vite', ...viteArgs], {
        cwd: dashboardDir,
        stdio: 'inherit',
        env: { ...process.env, VITE_API_URL: `http://127.0.0.1:${port}` },
      });

      vite.on('error', (err) => {
        console.error(`❌ Vite failed to start: ${err.message}`);
      });

      process.on('SIGINT', () => {
        console.log('\n🛑 Stopping Dashboard...');
        vite.kill();
        process.exit(0);
      });
    }
  });

// ─────────────────────────────────────────────────────
// status 命令
// ─────────────────────────────────────────────────────
program
  .command('status')
  .description('检查环境状态')
  .action(async () => {
    console.log('\n📋 AutoSnippet V2 Status\n');
    console.log(`   Version: ${pkg.version}`);
    console.log(`   Node: ${process.version}`);
    console.log(`   Platform: ${process.platform} ${process.arch}`);

    // AI 配置
    const { getAiConfigInfo } = await import('../lib/external/ai/AiFactory.js');
    const aiInfo = getAiConfigInfo();
    console.log(`\n   AI Provider: ${aiInfo.provider}`);
    console.log(`   AI Keys: ${Object.entries(aiInfo.keys).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'}`);

    // 检查数据库
    const dbPath = join(process.cwd(), '.autosnippet', 'autosnippet.db');
    console.log(`\n   Database: ${existsSync(dbPath) ? '✅ ' + dbPath : '❌ Not found'}`);

    // 检查依赖
    for (const dep of ['better-sqlite3', 'commander', 'express']) {
      try {
        await import(dep);
        console.log(`   ${dep}: ✅`);
      } catch {
        console.log(`   ${dep}: ❌ not installed`);
      }
    }

    console.log('');
  });

// ─────────────────────────────────────────────────────
// upgrade 命令
// ─────────────────────────────────────────────────────
program
  .command('upgrade')
  .description('升级 IDE 集成：MCP 配置、Skills、Cursor Rules、Copilot Instructions')
  .option('-d, --dir <path>', '项目目录', '.')
  .option('--skills-only', '仅更新 Skills')
  .option('--mcp-only', '仅更新 MCP 配置')
  .action(async (opts) => {
    const { UpgradeService } = await import('../lib/cli/UpgradeService.js');
    const service = new UpgradeService({ projectRoot: resolve(opts.dir) });

    console.log(`\n🔄 AutoSnippet V2 — 升级 IDE 集成`);
    console.log(`   项目: ${service.projectName}`);
    console.log(`   路径: ${service.projectRoot}\n`);

    await service.run({
      skillsOnly: opts.skillsOnly,
      mcpOnly: opts.mcpOnly,
    });
  });

// ─────────────────────────────────────────────────────
// cursor-rules 命令
// ─────────────────────────────────────────────────────
program
  .command('cursor-rules')
  .description('生成 Cursor 4 通道交付物料（Rules + Skills → .cursor/）')
  .option('-d, --dir <path>', '项目目录', '.')
  .option('--verbose', '详细输出')
  .action(async (opts) => {
    const projectRoot = resolve(opts.dir);

    console.log(`\n🚀 AutoSnippet — Cursor Delivery Pipeline`);
    console.log(`   项目: ${basename(projectRoot)}`);
    console.log(`   路径: ${projectRoot}\n`);

    const { bootstrap, container } = await initContainer({ projectRoot });
    try {
      const pipeline = container.get('cursorDeliveryPipeline');
      const result = await pipeline.deliver();

      console.log(`✅ Cursor 交付物料生成完成\n`);
      console.log(`   Channel A (Always-On Rules): ${result.channelA.rulesCount} 条规则 (${result.channelA.tokensUsed} tokens)`);
      console.log(`   Channel B (Smart Rules):     ${result.channelB.topicCount} 个主题, ${result.channelB.patternsCount} 个模式 (${result.channelB.totalTokens} tokens)`);
      console.log(`   Channel C (Agent Skills):    ${result.channelC.synced} 个 Skills 已同步`);
      console.log(`   Channel D (Dev Documents):   ${result.channelD?.documentsCount || 0} 篇文档`);
      if (result.channelC.errors > 0) {
        console.log(`   ⚠️  ${result.channelC.errors} 个错误`);
      }
      console.log(`\n   总耗时: ${result.stats.duration}ms`);

      if (opts.verbose && result.channelB.topics) {
        console.log(`\n   Channel B 主题明细:`);
        for (const [topic, info] of Object.entries(result.channelB.topics)) {
          console.log(`     - ${topic}: ${info.patternsCount} patterns (${info.tokensUsed} tokens)`);
        }
      }
      console.log('');
    } finally {
      await bootstrap.shutdown?.();
    }
  });

// ─────────────────────────────────────────────────────
// sync 命令
// ─────────────────────────────────────────────────────
program
  .command('sync')
  .description('增量同步 recipes/*.md + candidates/*.md → DB（.md = Source of Truth）')
  .option('-d, --dir <path>', '项目目录', '.')
  .option('--dry-run', '只报告不写入')
  .option('--force', '忽略 hash 强制覆盖')
  .action(async (opts) => {
    const projectRoot = resolve(opts.dir);
    const { KnowledgeSyncService } = await import('../lib/cli/KnowledgeSyncService.js');
    const syncService = new KnowledgeSyncService(projectRoot);

    console.log(`\n🔄 AutoSnippet V3 — 同步 knowledge entries`);
    console.log(`   项目: ${basename(projectRoot)}`);
    console.log(`   路径: ${projectRoot}`);
    if (opts.dryRun) console.log('   模式: dry-run（仅报告）');
    console.log('');

    // 通过 Bootstrap 打开目标项目的 DB
    const dbPath = join(projectRoot, '.autosnippet', 'autosnippet.db');
    const ConfigLoader = (await import('../lib/infrastructure/config/ConfigLoader.js')).default;
    const env = process.env.NODE_ENV || 'development';
    ConfigLoader.load(env);
    ConfigLoader.set('database.path', dbPath);

    const { bootstrap, container } = await initContainer({ projectRoot });
    const db = container.get('database')?.getDb?.();
    if (!db) {
      console.error('❌ 无法打开数据库，请先运行 asd setup');
      process.exit(1);
    }

    try {
      const report = syncService.sync(db, {
        dryRun: opts.dryRun,
        force: opts.force,
      });

      // 输出报告
      console.log(`✅ Knowledge 同步完成`);
      console.log(`   扫描: ${report.synced + report.skipped} 文件`);
      console.log(`   新增: ${report.created}`);
      console.log(`   更新: ${report.updated}`);
      console.log(`   跳过: ${report.skipped}`);

      if (report.violations.length > 0) {
        console.log(`\n⚠️  检测到 ${report.violations.length} 个手动编辑（已记入违规统计）：`);
        for (const v of report.violations) {
          console.log(`   - ${v}`);
        }
      }

      if (report.orphaned.length > 0) {
        console.log(`\n🗑️  ${report.orphaned.length} 个孤儿条目已标记 deprecated：`);
        for (const id of report.orphaned) {
          console.log(`   - ${id}`);
        }
      }

      console.log('');
    } finally {
      await bootstrap.shutdown?.();
    }
  });

// ─────────────────────────────────────────────────────
// 辅助函数
// ─────────────────────────────────────────────────────
async function initBootstrap() {
  const { default: Bootstrap } = await import('../lib/bootstrap.js');
  const bootstrap = new Bootstrap();
  await bootstrap.initialize();
  return bootstrap;
}

/**
 * Bootstrap → ServiceContainer 统一初始化
 * 所有需要服务层的 CLI 命令共用此入口，保证依赖注入一致性
 * @param {object}  [opts]
 * @param {string}  [opts.projectRoot]  项目根目录（默认 cwd）
 * @returns {{ bootstrap, container }}
 */
async function initContainer(opts = {}) {
  const projectRoot = opts.projectRoot || process.cwd();

  // 切换工作目录到项目根 — 确保 DB 等相对路径正确解析
  if (resolve(projectRoot) !== resolve(process.cwd())) {
    process.chdir(projectRoot);
  }

  // 配置路径安全守卫 — 阻止写操作逃逸到项目外
  const { default: Bootstrap } = await import('../lib/bootstrap.js');
  Bootstrap.configurePathGuard(projectRoot);

  const bootstrap = await initBootstrap();
  const { getServiceContainer } = await import('../lib/injection/ServiceContainer.js');
  const container = getServiceContainer();
  await container.initialize({
    db: bootstrap.components.db,
    auditLogger: bootstrap.components.auditLogger,
    gateway: bootstrap.components.gateway,
    constitution: bootstrap.components.constitution,
    projectRoot,
  });
  return { bootstrap, container };
}

program.parse(process.argv);
