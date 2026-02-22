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
 *   asd mirror          - 镜像 .cursor/ → .qoder/ .trae/
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkgPath = join(__dirname, '..', 'package.json');
const pkg = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, 'utf8')) : { version: '2.0.0' };

// ─── 进程级错误兜底 ────────────────────────────────────
process.on('uncaughtException', (error) => {
  process.stderr.write(`[asd] Uncaught Exception: ${error.message}\n`);
  if (error.stack) {
    process.stderr.write(`${error.stack}\n`);
  }
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
process.on('SIGINT', () => handleSignal('SIGINT'));

const program = new Command();
program.name('asd').description('AutoSnippet V2 - AI 知识库管理工具').version(pkg.version);

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
    const service = new SetupService({
      projectRoot: resolve(opts.dir),
      force: opts.force,
      seed: opts.seed,
    });

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
    if (opts.skipGuard) {
    }

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
      } else {
        // 输出骨架报告
        const report = result.report || {};
        const _targets = result.targets || [];
        const langStats = result.languageStats || {};
        const guardSummary = result.guardSummary;
        const astSummary = result.astSummary;
        const _bootstrapCandidates = result.bootstrapCandidates || {};
        const framework = result.analysisFramework || {};
        if (Object.keys(langStats).length > 0) {
          const _langParts = Object.entries(langStats)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([ext, count]) => `${ext}(${count})`);
        }

        // AST 分析
        if (astSummary) {
          if (astSummary.metrics) {
          }
        }

        // SPM 依赖
        if (report.phases?.spmDependencyGraph) {
        }

        // Guard 审计
        if (guardSummary) {
        }

        // 维度分析框架
        if (framework.dimensions) {
          for (const dim of framework.dimensions) {
            const _type = dim.skillWorthy ? (dim.dualOutput ? 'Dual' : 'Skill') : 'Candidate';
          }
        }
        if (result.bootstrapSession) {
          const _session = result.bootstrapSession;
        }
      }

      // 等待模式: 轮询 BootstrapTaskManager 直到所有维度完成
      if (opts.wait && result.bootstrapSession) {
        const ora2 = (await import('ora')).default;
        const waitSpinner = ora2('Phase 5: AI 正在逐维度填充知识...').start();
        let lastStatus = '';
        let attempts = 0;
        const maxAttempts = 600; // 最多等 10 分钟（每秒轮询）

        while (attempts < maxAttempts) {
          await new Promise((r) => setTimeout(r, 1000));
          attempts++;

          try {
            const taskManager = container.get('bootstrapTaskManager');
            const sessionStatus = taskManager.getSessionStatus();

            if (!sessionStatus || !sessionStatus.tasks) {
              break;
            }

            const total = sessionStatus.tasks.length;
            const done = sessionStatus.tasks.filter(
              (t) => t.status === 'done' || t.status === 'error'
            ).length;
            const current = sessionStatus.tasks.find((t) => t.status === 'running');
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
                const _succeeded = sessionStatus.tasks.filter((t) => t.status === 'done').length;
                const _failed = sessionStatus.tasks.filter((t) => t.status === 'error').length;
                for (const t of sessionStatus.tasks) {
                  const _icon = t.status === 'done' ? '✅' : '❌';
                }
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
      }

      await bootstrap.shutdown();
    } catch (err) {
      console.error(`\n❌ ${err.message}`);
      if (process.env.ASD_DEBUG === '1') {
        console.error(err.stack);
      }
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
    if (target) {
    }
    if (opts.dryRun) {
    }

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
      } else {
        if (report.errors.length > 0) {
          for (const _err of report.errors.slice(0, 10)) {
          }
          if (report.errors.length > 10) {
          }
        }
        if (!opts.dryRun && report.published > 0) {
        }
      }

      await bootstrap.shutdown();
    } catch (err) {
      console.error(`\n❌ ${err.message}`);
      if (process.env.ASD_DEBUG === '1') {
        console.error(err.stack);
      }
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
      } else {
        for (const item of results.items) {
          const _badge = item.type === 'recipe' ? '📘' : item.type === 'solution' ? '💡' : '🛡️';
          const _score = item.score ? ` [${item.score}]` : '';
          if (item.description) {
          }
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
      } else if (violations.length === 0) {
      } else {
        const _errors = violations.filter((v) => v.severity === 'error');
        const _warnings = violations.filter((v) => v.severity === 'warning');
        for (const v of violations) {
          const _icon = v.severity === 'error' ? '❌' : '⚠️';
          if (v.snippet) {
          }
        }
      }

      await bootstrap.shutdown();
      process.exit(violations.some((v) => v.severity === 'error') ? 1 : 0);
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
          const { writeFileSync } = await import('node:fs');
          writeFileSync(opts.output, output, 'utf8');
        } else {
        }
      } else {
        reporter.printReport(report, { format: opts.report });
      }

      // 如果也要写文件（非 JSON 格式）
      if (opts.output && opts.report !== 'json') {
        const { writeFileSync } = await import('node:fs');
        writeFileSync(opts.output, JSON.stringify(report, null, 2), 'utf8');
      }

      await bootstrap.shutdown();

      // Exit code
      if (report.qualityGate.status === 'FAIL') {
        process.exit(report.summary.errors > 0 ? 1 : 2);
      }
      process.exit(0);
    } catch (err) {
      console.error('Error:', err.message);
      if (process.env.ASD_DEBUG === '1') {
        console.error(err.stack);
      }
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
      const { execSync } = await import('node:child_process');

      // 获取 staged 文件列表
      let stagedFiles;
      try {
        stagedFiles = execSync('git diff --cached --name-only --diff-filter=ACM', {
          encoding: 'utf8',
        })
          .trim()
          .split('\n')
          .filter(Boolean);
      } catch (_err) {
        console.error('❌ 无法获取 git staged 文件（是否在 git 仓库中？）');
        process.exit(1);
      }

      if (stagedFiles.length === 0) {
        process.exit(0);
      }

      // 过滤源文件
      const { SOURCE_EXTS } = await import('../lib/service/guard/SourceFileCollector.js');
      const { extname: _extname } = await import('node:path');
      const sourceFiles = stagedFiles.filter((f) => SOURCE_EXTS.has(_extname(f).toLowerCase()));

      if (sourceFiles.length === 0) {
        process.exit(0);
      }

      const { bootstrap, container } = await initContainer();
      const engine = container.get('guardCheckEngine');
      const { detectLanguage: _detectLanguage } = await import(
        '../lib/service/guard/GuardCheckEngine.js'
      );

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
      } else if (summary.totalViolations === 0) {
      } else {
        const filesWithIssues = result.files.filter((f) => f.summary.total > 0);
        for (const file of filesWithIssues.slice(0, 10)) {
          for (const v of file.violations.slice(0, 5)) {
            const _icon = v.severity === 'error' ? '❌' : '⚠️';
          }
          if (file.violations.length > 5) {
          }
        }
      }

      await bootstrap.shutdown();
      process.exit(summary.totalErrors > 0 ? 1 : 0);
    } catch (err) {
      console.error('Error:', err.message);
      if (process.env.ASD_DEBUG === '1') {
        console.error(err.stack);
      }
      process.exit(1);
    }
  });

// ─────────────────────────────────────────────────────
// watch 命令
// ─────────────────────────────────────────────────────
program
  .command('watch')

  .option('-d, --dir <path>', '监控目录', '.')
  .option('-e, --ext <exts>', '文件扩展名（逗号分隔，留空则自动检测）')
  .option('--guard', '自动运行 Guard 检查', true)
  .action(async (opts) => {
    try {
      const dir = resolve(opts.dir);

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

      // IDE + 扩展名自动检测
      let exts = null;
      if (opts.ext) {
        exts = opts.ext.split(',').map((e) => e.trim());
      }
      // 不指定 --ext 时，FileWatcher 内部根据 IDE 检测结果使用默认模式

      const { FileWatcher } = await import('../lib/service/automation/FileWatcher.js');
      const watcher = new FileWatcher(specPath, dir, {
        quiet: false,
        exts,
      });
      watcher.start();

      // 优雅退出
      process.on('SIGINT', async () => {
        await watcher.stop();
        await bootstrap.shutdown();
        process.exit(0);
      });
    } catch (err) {
      console.error('Error:', err.message);
      if (process.env.ASD_DEBUG === '1') {
        console.error(err.stack);
      }
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
    const { spawn } = await import('node:child_process');

    // 项目根目录：-d 选项 > 环境变量 ASD_CWD > 当前目录
    const projectRoot = opts.dir || process.env.ASD_CWD || process.cwd();
    const port = opts.port;
    const host = '127.0.0.1';
    process.env.PORT = port;
    process.env.HOST = host;

    let httpServer;
    try {
      const { default: HttpServer } = await import('../lib/http/HttpServer.js');

      const { container } = await initContainer({ projectRoot });

      // 连接 EventBus → Gateway（供 SignalCollector 监听事件）
      try {
        const eventBus = container.get('eventBus');
        const gateway = container.get('gateway');
        gateway.eventBus = eventBus;
      } catch {
        /* EventBus 不可用不阻塞启动 */
      }

      httpServer = new HttpServer({ port, host });
      await httpServer.initialize();
      await httpServer.start();

      // 启动 SignalCollector 后台 AI 分析服务
      try {
        const { SignalCollector } = await import('../lib/service/skills/SignalCollector.js');
        const { getRealtimeService } = await import(
          '../lib/infrastructure/realtime/RealtimeService.js'
        );
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
            } catch {
              /* realtime 未就绪 */
            }
          },
        });
        signalCollector.start();
        global._signalCollector = signalCollector;
      } catch (scErr) {
        console.warn(`⚠️  SignalCollector failed to start: ${scErr.message}`);
        if (process.env.ASD_DEBUG === '1') {
          console.error(scErr.stack);
        }
      }

      // 3. 启动文件监听器（仅 iOS/macOS 项目 — Xcode 工作流）
      //    VSCode 用户通过 AutoSnippet 扩展原生处理 as:s/as:c/as:a 指令
      const isAppleProject = (() => {
        try {
          const entries = readdirSync(projectRoot, { withFileTypes: true });

          // ── Level 1: 项目配置文件（确定性高）──
          const hasAppleConfig = entries.some(
            (e) =>
              e.name === 'Package.swift' || // SPM
              e.name === 'Podfile' || // CocoaPods
              e.name === 'Cartfile' || // Carthage
              e.name === 'project.yml' || // XcodeGen
              e.name.endsWith('.xcodeproj') || // Xcode project
              e.name.endsWith('.xcworkspace') // Xcode workspace
          );
          if (hasAppleConfig) {
            return true;
          }

          // ── Level 2: 目录结构特征 ──
          const hasAppleDir = entries.some(
            (e) =>
              e.isDirectory() &&
              (e.name === 'Tuist' || // Tuist 项目
                e.name === 'Pods' || // CocoaPods 产物
                e.name === 'Carthage' || // Carthage 产物
                e.name === 'DerivedData') // Xcode 构建产物
          );
          if (hasAppleDir) {
            return true;
          }

          // ── Level 3: 向下扫一层（处理 monorepo 或 Sources/ 下有 .swift 的情况）──
          const APPLE_EXTS = new Set(['.swift', '.m', '.mm', '.h']);
          const SCAN_DIRS = ['Sources', 'Source', 'src', 'App', 'Classes', 'ios', 'iOS'];
          for (const e of entries) {
            // 根目录直接有 .swift/.m 文件
            if (!e.isDirectory() && APPLE_EXTS.has(e.name.slice(e.name.lastIndexOf('.')))) {
              return true;
            }
            // 常见源码目录下有 Apple 文件
            if (e.isDirectory() && SCAN_DIRS.includes(e.name)) {
              try {
                const subEntries = readdirSync(join(projectRoot, e.name));
                if (subEntries.some((f) => APPLE_EXTS.has(f.slice(f.lastIndexOf('.'))))) {
                  return true;
                }
              } catch {
                /* 读取失败忽略 */
              }
            }
          }

          return false;
        } catch {
          return false;
        }
      })();

      if (isAppleProject) {
        try {
          const Paths = await import('../lib/infrastructure/config/Paths.js');
          const specPath = Paths.getProjectSpecPath(projectRoot);
          const isDebugMode = process.env.ASD_DEBUG === '1';

          // 设置 Dashboard URL 供 watcher 跳转浏览器使用
          // 生产模式用 API 同端口，开发模式用 vite dev 5173
          const dashDirCheck = join(__dirname, '..', 'dashboard');
          const isProductionDashboard =
            existsSync(join(dashDirCheck, 'dist', 'index.html')) &&
            !existsSync(join(dashDirCheck, 'src'));
          if (!opts.apiOnly) {
            process.env.ASD_DASHBOARD_URL = isProductionDashboard
              ? `http://127.0.0.1:${port}`
              : `http://localhost:5173`;
          } else {
            process.env.ASD_DASHBOARD_URL =
              process.env.ASD_DASHBOARD_URL || `http://${host}:${port}`;
          }

          const { FileWatcher } = await import('../lib/service/automation/FileWatcher.js');
          const watcher = new FileWatcher(specPath, projectRoot, { quiet: !isDebugMode });
          watcher.start();
          if (isDebugMode) {
          }
        } catch (watchErr) {
          console.warn(`⚠️  File watcher failed to start: ${watchErr.message}`);
          if (process.env.ASD_DEBUG === '1') {
            console.error(watchErr.stack);
          }
        }
      } else if (process.env.ASD_DEBUG === '1') {
      }
    } catch (err) {
      console.error(`❌ API server failed to start: ${err.message}`);
      if (err.code === 'EADDRINUSE') {
        console.error(
          `   Port ${port} is already in use. Kill it with: lsof -ti:${port} | xargs kill -9`
        );
      }
      process.exit(1);
    }

    if (opts.apiOnly) {
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

      if (opts.browser) {
        const open = (await import('open')).default;
        open(`http://127.0.0.1:${port}/`);
      }
    } else {
      // ── 开发模式：有源码，启动 Vite Dev Server ──
      if (!existsSync(join(dashboardDir, 'node_modules'))) {
        const install = spawn('npm', ['install'], { cwd: dashboardDir, stdio: 'inherit' });
        await new Promise((resolve, reject) => {
          install.on('close', (code) =>
            code === 0 ? resolve() : reject(new Error(`npm install exited with ${code}`))
          );
        });
      }
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
    // AI 配置
    const { getAiConfigInfo } = await import('../lib/external/ai/AiFactory.js');
    const _aiInfo = getAiConfigInfo();

    // 检查数据库
    const _dbPath = join(process.cwd(), '.autosnippet', 'autosnippet.db');

    // 检查依赖
    for (const dep of ['better-sqlite3', 'commander', 'express']) {
      try {
        await import(dep);
      } catch {}
    }
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

    const { bootstrap, container } = await initContainer({ projectRoot });
    try {
      const pipeline = container.get('cursorDeliveryPipeline');
      const result = await pipeline.deliver();
      if (result.channelC.errors > 0) {
      }

      if (opts.verbose && result.channelB.topics) {
        for (const [_topic, _info] of Object.entries(result.channelB.topics)) {
        }
      }
    } finally {
      await bootstrap.shutdown?.();
    }
  });

// ─────────────────────────────────────────────────────
// mirror 命令
// ─────────────────────────────────────────────────────
program
  .command('mirror')
  .description('镜像 .cursor/ 交付物料到其他兼容 IDE 目录（Qoder / Trae）')
  .option('-d, --dir <path>', '项目目录', '.')
  .option('--target <ide>', '目标 IDE：qoder, trae, all（默认 all）', 'all')
  .action(async (opts) => {
    const projectRoot = resolve(opts.dir);
    const targets = opts.target === 'all' ? ['.qoder', '.trae'] : [`.${opts.target}`];

    const cursorDir = join(projectRoot, '.cursor');
    if (!existsSync(cursorDir)) {
      console.error('❌ 未找到 .cursor/ 目录，请先运行 asd setup 或 asd cursor-rules');
      process.exit(1);
    }

    for (const target of targets) {
      const cursorRulesDir = join(cursorDir, 'rules');
      if (existsSync(cursorRulesDir)) {
        const targetRulesDir = join(projectRoot, target, 'rules');
        mkdirSync(targetRulesDir, { recursive: true });
        const files = readdirSync(cursorRulesDir).filter(
          (f) => f.startsWith('autosnippet-') && (f.endsWith('.mdc') || f.endsWith('.md'))
        );
        for (const file of files) {
          const destName = file.endsWith('.mdc') ? file.replace(/\.mdc$/, '.md') : file;
          copyFileSync(join(cursorRulesDir, file), join(targetRulesDir, destName));
        }
      }

      const cursorSkillsDir = join(cursorDir, 'skills');
      if (existsSync(cursorSkillsDir)) {
        const targetSkillsDir = join(projectRoot, target, 'skills');
        const skillDirs = readdirSync(cursorSkillsDir, { withFileTypes: true }).filter(
          (d) => d.isDirectory() && d.name.startsWith('autosnippet-')
        );
        for (const dir of skillDirs) {
          _copyDirRecursive(join(cursorSkillsDir, dir.name), join(targetSkillsDir, dir.name));
        }
      }
    }
  });

/** @private 递归复制目录（mirror 命令用） */
function _copyDirRecursive(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      _copyDirRecursive(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

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
    if (opts.dryRun) {
    }

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

      if (report.violations.length > 0) {
        for (const _v of report.violations) {
        }
      }

      if (report.orphaned.length > 0) {
        for (const _id of report.orphaned) {
        }
      }
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
    config: bootstrap.components.config,
    skillHooks: bootstrap.components.skillHooks,
    projectRoot,
  });
  return { bootstrap, container };
}

program.parse(process.argv);
