#!/usr/bin/env node

/**
 * Alembic V2 CLI
 *
 * Usage:
 *   alembic setup           - 初始化项目（--repo 指定子仓库远程地址）
 *   alembic remote <url>    - 将 recipes 目录转为独立子仓库并关联远程仓库
 *   alembic coldstart       - 冷启动知识库（9 维度分析 + AI 填充）
 *   alembic rescan          - 增量知识更新（保留 Recipe，重新扫描）
 *   alembic evolve-check    - 定向 Recipe 进化审计（轻量级）
 *   alembic ais [Target]    - AI 扫描 Target → 直接发布 Recipes
 *   alembic search <query>  - 搜索知识库
 *   alembic guard <file>    - Guard 检查
 *   alembic guard:ci [path] - CI/CD Guard 合规检查
 *   alembic server          - 启动 API 服务
 *   alembic ui              - 启动 Dashboard UI
 *   alembic upgrade         - 升级 IDE 集成
 *   alembic mirror          - 镜像 .cursor/ → .qoder/ .trae/
 *   alembic status          - 环境状态
 *   alembic health          - 综合健康报告
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Command } from 'commander';
import { cli } from '../lib/cli/CliLogger.js';
import { DASHBOARD_DIR, PACKAGE_ROOT } from '../lib/shared/package-root.js';
import { shutdown } from '../lib/shared/shutdown.js';

const pkgPath = join(PACKAGE_ROOT, 'package.json');
const pkg = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, 'utf8')) : { version: '2.0.0' };

// ─── 进程级错误兜底 ────────────────────────────────────
process.on('uncaughtException', (error) => {
  process.stderr.write(`[alembic] Uncaught Exception: ${error.message}\n`);
  if (error.stack) {
    process.stderr.write(`${error.stack}\n`);
  }
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? reason.stack : undefined;
  process.stderr.write(`[alembic] Unhandled Rejection: ${msg}\n`);
  if (stack) {
    process.stderr.write(`${stack}\n`);
  }
  process.exit(1);
});

// 优雅关闭 — 统一 shutdown 协调器
shutdown.install();

const program = new Command();
program.name('alembic').description('Alembic V2 - AI 知识库管理工具').version(pkg.version);

// ─────────────────────────────────────────────────────
// setup 命令
// ─────────────────────────────────────────────────────
program
  .command('setup')
  .description('初始化项目工作空间：目录结构、数据库、IDE 集成、模板')
  .option('-d, --dir <path>', '项目目录', '.')
  .option('--force', '强制覆盖已有配置')
  .option('--seed', '预置示例 Recipe（冷启动推荐）')
  .option('--ghost', 'Ghost 模式：零项目侵入，所有数据外置到 ~/.asd/workspaces/')
  .option('--repo <url>', 'recipes 子仓库的远程 Git 仓库地址（提供则 clone，不提供则为普通目录）')
  .action(async (opts) => {
    const { SetupService } = await import('../lib/cli/SetupService.js');
    const service = new SetupService({
      projectRoot: resolve(opts.dir),
      force: opts.force,
      seed: opts.seed,
      ghost: opts.ghost,
      subRepoUrl: opts.repo,
    });

    await service.run();
    service.printSummary();
  });

// ─────────────────────────────────────────────────────
// remote 命令 — 将 recipes 目录转为独立子仓库并关联远程仓库
// ─────────────────────────────────────────────────────
program
  .command('remote <url>')
  .description('将 recipes 目录转为独立子仓库并关联远程 Git 仓库')
  .option('-d, --dir <path>', '项目目录', '.')
  .action(async (url: string, opts: { dir: string }) => {
    const projectRoot = resolve(opts.dir);

    const { execSync: exec } = await import('node:child_process');
    const { resolveSubRepoPath, isGitRepo } = await import('../lib/shared/ProjectMarkers.js');

    const subRepoPath = resolveSubRepoPath(projectRoot);

    // 1. 校验目录存在
    if (!existsSync(subRepoPath)) {
      cli.error('recipes/ 目录不存在，请先运行 alembic setup');
      process.exit(1);
    }

    // 2. URL 格式验证
    if (!/^(https?:\/\/.+|git@.+:.+)$/.test(url)) {
      cli.error('无效的 Git 仓库地址（支持 HTTPS 和 SSH 格式）');
      process.exit(1);
    }

    const gitExec = (args: string) => {
      return exec(`git ${args}`, { cwd: subRepoPath, stdio: 'pipe', encoding: 'utf8' }).trim();
    };

    // 3. 已经是 git 仓库 → 只更新 remote
    if (isGitRepo(subRepoPath)) {
      try {
        gitExec(`remote get-url origin`);
        // origin 已存在 → set-url
        gitExec(`remote set-url origin ${url}`);
      } catch {
        // origin 不存在 → add
        gitExec(`remote add origin ${url}`);
      }

      // 更新 config.json
      _updateConfigUrl(projectRoot, url);

      cli.log('✓ 已更新 remote origin');
      cli.log(`  ${url}`);
      return;
    }

    // 4. 普通目录 → 初始化为 git 仓库（保留已有文件）
    cli.log('正在将 recipes/ 转为独立子仓库...');
    gitExec('init');
    gitExec(`remote add origin ${url}`);
    gitExec('add .');
    try {
      gitExec('commit -m "Init Alembic recipes"');
    } catch {
      /* 空目录时 commit 可能失败，无影响 */
    }

    // 5. 更新 config.json
    _updateConfigUrl(projectRoot, url);

    cli.log('✓ recipes/ 已转为独立子仓库');
    cli.log(`  remote origin → ${url}`);
    cli.log('');
    cli.log('后续步骤：');
    cli.log('  1. git push -u origin main');
    cli.log('  2. 在主仓库中选择一种方式管理 recipes/:');
    cli.log(`     • git submodule add ${url} Alembic/recipes`);
    cli.log('     • 或将 Alembic/recipes/ 加入 .gitignore');
  });

/** 更新 .asd/config.json 中的 core.subRepoUrl 字段 */
function _updateConfigUrl(projectRoot: string, url: string) {
  const configPath = join(projectRoot, '.asd', 'config.json');
  if (!existsSync(configPath)) {
    return;
  }
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw);
    if (!config.core) {
      config.core = {};
    }
    config.core.subRepoUrl = url;
    writeFileSync(configPath, JSON.stringify(config, null, 2));
  } catch {
    /* config 解析失败不阻塞主流程 */
  }
}

// ─────────────────────────────────────────────────────
// coldstart 命令 (Knowledge Bootstrap)
// ─────────────────────────────────────────────────────
program
  .command('coldstart')
  .description('冷启动知识库：9 维度项目分析 + AI 异步填充（与 Dashboard 点击冷启动流程一致）')
  .option('-d, --dir <path>', '项目目录', '.')
  .option('-m, --max-files <n>', '最大扫描文件数', '500')
  .option('--dims <ids...>', '仅运行指定维度（逗号分隔或多次指定）')
  .option('--skip-guard', '跳过 Guard 审计')
  .option('--no-skills', '禁用 Skill 加载')
  .option('--wait', '等待 AI 异步填充完成（默认骨架完成即退出）')
  .option('--json', '以 JSON 格式输出结果')
  .action(async (opts) => {
    const projectRoot = resolve(opts.dir);
    if (opts.skipGuard) {
      cli.log('ℹ️  Guard 审计已跳过');
    }

    try {
      const { bootstrap, container } = await initContainer({ projectRoot });

      const ora = (await import('ora')).default;
      const spinner = ora('Phase 1-4: 收集文件、AST 分析、SPM 依赖、Guard 审计...').start();

      // 直接调用 bootstrap-internal handler（统一编排管线）
      const { bootstrapKnowledge } = await import(
        '../lib/external/mcp/handlers/bootstrap-internal.js'
      );
      const logger = container.get('logger');
      const raw = await bootstrapKnowledge(
        { container, logger },
        {
          maxFiles: parseInt(opts.maxFiles, 10),
          skipGuard: opts.skipGuard || false,
          contentMaxLines: 120,
          loadSkills: opts.skills !== false,
          skipAsyncFill: !opts.wait,
          dimensions: opts.dims,
        }
      );
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const result = parsed?.data || parsed;

      spinner.stop();

      if (opts.json) {
        cli.json(result);
      } else {
        // 输出骨架报告
        const report = result.report || {};
        const targets = result.targets || [];
        const langStats = result.languageStats || {};
        const guardSummary = result.guardSummary;
        const astSummary = result.astSummary;
        const framework = result.analysisFramework || {};

        cli.log('\n📊 Coldstart Report');
        cli.log(`${'─'.repeat(50)}`);

        if (targets.length > 0) {
          cli.log(`\n  Targets: ${targets.map((t: any) => t.name || t).join(', ')}`);
        }

        if (Object.keys(langStats).length > 0) {
          const langParts = Object.entries(langStats)
            .sort((a, b) => (b[1] as number) - (a[1] as number))
            .slice(0, 5)
            .map(([ext, count]) => `${ext}(${count})`);
          cli.log(`  Languages: ${langParts.join(', ')}`);
        }

        // AST 分析
        if (astSummary) {
          if (astSummary.metrics) {
            cli.log(`  AST Metrics: ${JSON.stringify(astSummary.metrics)}`);
          }
        }

        // SPM 依赖
        if (report.phases?.spmDependencyGraph) {
          const spm = report.phases.spmDependencyGraph;
          cli.log(`  SPM Dependencies: ${spm.packageCount ?? '?'} packages`);
        }

        // Guard 审计
        if (guardSummary) {
          cli.log(
            `  Guard: ${guardSummary.totalViolations ?? guardSummary.total ?? '?'} violations (${guardSummary.errors ?? '?'} errors, ${guardSummary.warnings ?? '?'} warnings)`
          );
        }

        // 维度分析框架
        if (framework.dimensions) {
          cli.log('\n  Analysis Dimensions:');
          for (const dim of framework.dimensions) {
            const type = dim.skillWorthy ? (dim.dualOutput ? 'Dual' : 'Skill') : 'Candidate';
            cli.log(`    ${type.padEnd(10)} ${dim.id || dim.name || '?'}`);
          }
        }
        if (result.bootstrapSession) {
          const session = result.bootstrapSession;
          cli.log(`\n  Session: ${session.id || 'N/A'} (${session.status || 'unknown'})`);
        }
        cli.blank();
      }

      // 等待模式: 轮询 BootstrapTaskManager 直到所有维度完成
      if (opts.wait && result.bootstrapSession) {
        const ora2 = (await import('ora')).default;
        const waitSpinner = ora2('Phase 5: AI 正在逐维度填充知识...').start();
        let lastStatus = '';
        let attempts = 0;
        const maxAttempts = Infinity; // 不限时——冷启动/增量扫描本身就耗时较长

        while (attempts < maxAttempts) {
          await new Promise((r) => setTimeout(r, 1000));
          attempts++;

          try {
            const taskManager = container.get('bootstrapTaskManager');
            const sessionStatus = taskManager.getSessionStatus();

            if (!sessionStatus || !('tasks' in sessionStatus)) {
              break;
            }

            const total = sessionStatus.tasks.length;
            const done = sessionStatus.tasks.filter(
              (t: any) => t.status === 'done' || t.status === 'error'
            ).length;
            const current = sessionStatus.tasks.find((t: any) => t.status === 'running');
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
                const succeeded = ('tasks' in sessionStatus ? sessionStatus.tasks : []).filter(
                  (t: any) => t.status === 'done'
                ).length;
                const failed = ('tasks' in sessionStatus ? sessionStatus.tasks : []).filter(
                  (t: any) => t.status === 'error'
                ).length;
                cli.log(`\n  Results: ${succeeded} succeeded, ${failed} failed`);
                for (const t of 'tasks' in sessionStatus ? sessionStatus.tasks : []) {
                  const icon = t.status === 'done' ? '✅' : '❌';
                  cli.log(`    ${icon} ${t.meta?.label || t.id}`);
                }
                cli.blank();
              }
              break;
            }
          } catch {
            // bootstrapTaskManager 可能还没就绪
          }
        }
      } else if (!opts.json) {
        cli.log('');
        cli.log('  📋 下一步：打开 IDE Agent Mode，告诉它「帮我冷启动」');
        cli.log('     IDE 会自动调用 MCP 工具完成 AI 分析、提取知识模式、提交候选。');
      }

      await bootstrap.shutdown();
      // 等待 stdout 刷新完成后再退出 (避免管道输出截断)
      if (process.stdout.writableLength > 0) {
        await new Promise((resolve) => process.stdout.once('drain', resolve));
      }
      await new Promise((resolve) => setTimeout(resolve, 50)); // 确保管道缓冲区完全刷新
      process.exit(0);
    } catch (err: any) {
      cli.error(`\n❌ ${err.message}`);
      cli.debug(err.stack);
      process.exit(1);
    }
  });

// ─────────────────────────────────────────────────────
// rescan 命令 (增量知识更新)
// ─────────────────────────────────────────────────────
program
  .command('rescan')
  .description('增量知识更新：保留已审核 Recipe，清理衍生缓存，重新扫描项目 + AI 补齐')
  .option('-d, --dir <path>', '项目目录', '.')
  .option('-m, --max-files <n>', '最大扫描文件数', '500')
  .option('--dims <ids...>', '仅扫描指定维度（逗号分隔或多次指定）')
  .option('--reason <text>', '重扫原因（记录到日志）')
  .option('--wait', '等待 AI 异步填充完成（默认骨架完成即退出）')
  .option('--json', '以 JSON 格式输出')
  .action(async (opts) => {
    const projectRoot = resolve(opts.dir);

    try {
      const { bootstrap, container } = await initContainer({ projectRoot });

      const ora = (await import('ora')).default;
      const spinner = ora('Rescan: 快照 Recipe → 清理缓存 → Phase 1-4 + 证据审计...').start();

      // 直接调用 rescan-internal handler（统一编排管线）
      const { rescanInternal } = await import('../lib/external/mcp/handlers/rescan-internal.js');
      const logger = container.get('logger');
      const raw = await rescanInternal(
        { container, logger },
        {
          reason: opts.reason || 'cli-rescan',
          dimensions: opts.dims,
          skipAsyncFill: !opts.wait,
        }
      );
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const result = parsed?.data || parsed;

      spinner.stop();

      if (opts.json) {
        cli.json(result);
      } else {
        cli.log('\n📊 Rescan Report');
        cli.log(`${'─'.repeat(50)}`);
        const rescan = result.rescan || {};
        const audit = result.relevanceAudit || {};
        const gap = result.gapAnalysis || {};
        cli.log(`  保留 Recipe: ${rescan.preservedRecipes ?? '?'}`);
        cli.log(`  扫描文件: ${result.files ?? '?'}`);
        cli.log(`  维度: ${gap.totalDimensions ?? '?'} (gap: ${gap.gapDimensions ?? 0})`);
        cli.log('\n  证据审计:');
        cli.log(`    健康: ${audit.healthy ?? '?'}  观察: ${audit.watch ?? '?'}`);
        cli.log(
          `    衰退: ${audit.decay ?? '?'}  严重: ${audit.severe ?? '?'}  死亡: ${audit.dead ?? '?'}`
        );
        if (audit.proposalsCreated > 0) {
          cli.log(`    创建进化提案: ${audit.proposalsCreated}`);
        }
        if (audit.immediateDeprecated > 0) {
          cli.log(`    即时淘汰: ${audit.immediateDeprecated}`);
        }
        if (gap.gapDimensions > 0 && opts.wait) {
          cli.log(`\n  AI 正在异步填充 ${gap.gapDimensions} 个 gap 维度...`);
        } else if (gap.gapDimensions > 0) {
          cli.log(`\n  ${gap.gapDimensions} 个 gap 维度可通过 --wait 等待 AI 填充`);
        } else {
          cli.log('\n  所有维度已完全覆盖，无需 AI 补齐。');
        }
      }

      // --wait 模式: 轮询 BootstrapTaskManager
      if (opts.wait && result.asyncFill) {
        const ora2 = (await import('ora')).default;
        const waitSpinner = ora2('AI 正在逐维度填充知识...').start();
        let lastStatus = '';
        let attempts = 0;
        const maxAttempts = Infinity; // 不限时——增量扫描本身就耗时较长

        while (attempts < maxAttempts) {
          await new Promise((r) => setTimeout(r, 1000));
          attempts++;

          try {
            const taskManager = container.get('bootstrapTaskManager');
            const sessionStatus = taskManager.getSessionStatus();

            if (!sessionStatus || !('tasks' in sessionStatus)) {
              break;
            }

            const total = sessionStatus.tasks.length;
            const done = sessionStatus.tasks.filter(
              (t: any) => t.status === 'done' || t.status === 'error'
            ).length;
            const current = sessionStatus.tasks.find((t: any) => t.status === 'running');
            const statusText = current
              ? `[${done}/${total}] 正在处理: ${current.meta?.label || current.id}`
              : `[${done}/${total}] 等待中...`;

            if (statusText !== lastStatus) {
              waitSpinner.text = statusText;
              lastStatus = statusText;
            }

            if (done >= total) {
              waitSpinner.succeed(`AI 填充完成: ${total} 个维度`);
              if (!opts.json) {
                const succeeded = sessionStatus.tasks.filter(
                  (t: any) => t.status === 'done'
                ).length;
                const failed = sessionStatus.tasks.filter((t: any) => t.status === 'error').length;
                cli.log(`\n  Results: ${succeeded} succeeded, ${failed} failed`);
                for (const t of sessionStatus.tasks) {
                  const icon = t.status === 'done' ? '✅' : '❌';
                  cli.log(`    ${icon} ${t.meta?.label || t.id}`);
                }
                cli.blank();
              }
              break;
            }
          } catch {
            /* bootstrapTaskManager 可能还没就绪 */
          }
        }
      }

      await bootstrap.shutdown();
      if (process.stdout.writableLength > 0) {
        await new Promise((resolve) => process.stdout.once('drain', resolve));
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      process.exit(0);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      cli.error(`\n❌ ${msg}`);
      if (err instanceof Error && err.stack) {
        cli.debug(err.stack);
      }
      process.exit(1);
    }
  });

// ─────────────────────────────────────────────────────
// evolve-check 命令 (Agent 驱动的全量 Recipe 进化审计)
// ─────────────────────────────────────────────────────
program
  .command('evolve-check')
  .description('Agent 驱动的 Recipe 进化审计：读源码验证全部 Recipe，自动提交进化决策')
  .option('--recipes <ids>', '逗号分隔的 Recipe ID 列表（省略则审计全部活跃 Recipe）')
  .option('-d, --dir <path>', '项目目录', '.')
  .option('--json', '以 JSON 格式输出')
  .option('--dry-run', '仅输出规则审计报告，不启动 Agent')
  .action(async (opts) => {
    const projectRoot = resolve(opts.dir);

    try {
      const { bootstrap, container } = await initContainer({ projectRoot });

      const ora = (await import('ora')).default;
      const knowledgeRepo = container.get('knowledgeRepository');
      const proposalRepo = container.get('proposalRepository');

      // ── Step 1: 收集项目文件列表 ──
      const allFiles: string[] = [];
      try {
        const { readdirSync: rd } = await import('node:fs');
        const { join: jn, relative: rel } = await import('node:path');
        const walk = (dir: string, base: string): void => {
          for (const entry of rd(dir, { withFileTypes: true })) {
            if (entry.name.startsWith('.') || entry.name === 'node_modules') {
              continue;
            }
            const full = jn(dir, entry.name);
            if (entry.isDirectory()) {
              walk(full, base);
            } else {
              allFiles.push(rel(base, full));
            }
          }
        };
        walk(projectRoot, projectRoot);
      } catch {
        /* non-blocking */
      }

      // ── Step 2: 获取目标 Recipe ──
      let targetRecipes: Array<{
        id: string;
        title: string;
        trigger: string;
        category: string;
        lifecycle: string;
      }>;
      if (opts.recipes) {
        const ids = (opts.recipes as string)
          .split(',')
          .map((s: string) => s.trim())
          .filter(Boolean);
        targetRecipes = [];
        for (const id of ids) {
          const entry = await knowledgeRepo.findById(id);
          if (entry) {
            targetRecipes.push({
              id: entry.id,
              title: entry.title,
              trigger: entry.trigger ?? '',
              category: entry.category ?? '',
              lifecycle: entry.lifecycle ?? 'active',
            });
          }
        }
      } else {
        const entries = await knowledgeRepo.findAllByLifecycles(['active', 'staging', 'evolving']);
        targetRecipes = entries.map(
          (e: {
            id: string;
            title: string;
            trigger?: string;
            category?: string;
            lifecycle?: string;
          }) => ({
            id: e.id,
            title: e.title,
            trigger: e.trigger ?? '',
            category: e.category ?? '',
            lifecycle: e.lifecycle ?? 'active',
          })
        );
      }

      if (targetRecipes.length === 0) {
        cli.warn('未找到任何需要审计的 Recipe');
        await bootstrap.shutdown();
        return;
      }

      // ── Step 3: 规则引擎预审计 ──
      const spinnerAudit = ora(`预审计: ${targetRecipes.length} 条 Recipe...`).start();
      const { RelevanceAuditor } = await import('../lib/service/evolution/RelevanceAuditor.js');
      const { EvolutionGateway } = await import('../lib/service/evolution/EvolutionGateway.js');
      const { LifecycleStateMachine } = await import(
        '../lib/service/evolution/LifecycleStateMachine.js'
      );
      const { LifecycleEventRepository } = await import(
        '../lib/repository/evolution/LifecycleEventRepository.js'
      );
      const { SignalBus } = await import('../lib/infrastructure/signal/SignalBus.js');
      const db = container.get('database') as unknown as { getDrizzle(): unknown };
      const drizzle = db.getDrizzle();
      const lifecycleEventRepo = new LifecycleEventRepository(
        drizzle as ConstructorParameters<typeof LifecycleEventRepository>[0]
      );
      const signalBus = new SignalBus();
      const lifecycle = new LifecycleStateMachine(
        knowledgeRepo,
        lifecycleEventRepo,
        signalBus,
        proposalRepo
      );
      const evolutionGateway = new EvolutionGateway(proposalRepo, lifecycle, knowledgeRepo);
      const auditor = new RelevanceAuditor({ knowledgeRepo, evolutionGateway });
      const auditResult = await auditor.audit(targetRecipes, {
        fileList: allFiles,
        codeEntities: [],
        dependencyGraph: [],
      });
      spinnerAudit.stop();

      cli.log('\n📊 规则预审计结果');
      cli.log(`${'─'.repeat(50)}`);
      cli.log(
        `  总计: ${auditResult.totalAudited} | 健康: ${auditResult.healthy} | 观察: ${auditResult.watch} | 衰退: ${auditResult.decay} | 严重: ${auditResult.severe} | 死亡: ${auditResult.dead}`
      );

      if (opts.dryRun) {
        for (const r of auditResult.results) {
          const icon =
            r.verdict === 'healthy'
              ? '✅'
              : r.verdict === 'watch'
                ? '👀'
                : r.verdict === 'dead'
                  ? '💀'
                  : '⚠️';
          cli.log(`  ${icon} ${r.title} (score: ${r.relevanceScore})`);
          for (const reason of r.decayReasons) {
            cli.log(`     └─ ${reason}`);
          }
        }
        if (opts.json) {
          cli.json(auditResult);
        }
        await bootstrap.shutdown();
        return;
      }

      // ── Step 4: Agent 驱动的深度验证（evolution 管线）──
      const agentFactory = container.get('agentFactory');
      if (!agentFactory) {
        cli.error('AgentFactory not available (需要配置 AI Provider)');
        await bootstrap.shutdown();
        process.exit(1);
      }

      // 为每个 Recipe 附加 auditHint
      const auditMap = new Map(
        auditResult.results.map(
          (r: {
            recipeId: string;
            relevanceScore: number;
            verdict: string;
            evidence: {
              triggerStillMatches: boolean;
              symbolsAlive: number;
              depsIntact: boolean;
              codeFilesExist: number;
            };
            decayReasons: string[];
          }) => [r.recipeId, r]
        )
      );
      const recipesWithHints = targetRecipes.map((r) => {
        const hint = auditMap.get(r.id);
        return {
          ...r,
          auditHint: hint
            ? {
                relevanceScore: hint.relevanceScore,
                verdict: hint.verdict,
                evidence: hint.evidence,
                decayReasons: hint.decayReasons,
              }
            : null,
        };
      });

      const spinnerAgent = ora('Agent 正在读取源码验证 Recipe...').start();

      const agentResult = await agentFactory.evolveCheck({
        recipes: recipesWithHints,
        projectOverview: {
          primaryLang: 'unknown',
          fileCount: allFiles.length,
          modules: [],
        },
      });

      spinnerAgent.stop();

      // ── Step 5: 输出结果 ──
      cli.log('\n🤖 Agent 进化决策结果');
      cli.log(`${'─'.repeat(50)}`);
      cli.log(
        `  进化提案: ${agentResult.proposed} | 确认废弃: ${agentResult.deprecated} | 跳过(有效): ${agentResult.skipped}`
      );
      cli.log(`  Agent 轮次: ${agentResult.iterations} | 工具调用: ${agentResult.toolCalls}`);

      if (agentResult.reply) {
        cli.log(`\n${agentResult.reply}`);
      }

      if (opts.json) {
        cli.json({ audit: auditResult, agent: agentResult });
      }

      // ── Step 6: 执行到期 Proposal（含 Agent 刚创建的） ──
      if (container.services.proposalExecutor) {
        const executor = container.get('proposalExecutor') as {
          checkAndExecute(): Promise<{
            executed: { id: string }[];
            rejected: { id: string }[];
            expired: { id: string }[];
          }>;
        };
        const execResult = await executor.checkAndExecute();
        const total =
          execResult.executed.length + execResult.rejected.length + execResult.expired.length;
        if (total > 0) {
          cli.log(
            `\n📋 Proposal 执行: executed=${execResult.executed.length}, rejected=${execResult.rejected.length}, expired=${execResult.expired.length}`
          );
        }
      }

      await bootstrap.shutdown();
    } catch (err: unknown) {
      cli.error(`evolve-check failed: ${(err as Error).message}`);
      const stack = (err as Error).stack;
      if (stack) {
        cli.debug(stack);
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
      cli.log(`Target: ${target}`);
    }
    if (opts.dryRun) {
      cli.log('ℹ️  Dry-run mode: no Recipes will be published');
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
        cli.json(report);
      } else {
        cli.log(`\n📝 AI Scan Report`);
        cli.log(`  Files scanned: ${report.files}`);
        cli.log(`  Published:     ${report.published}`);
        cli.log(`  Skipped:       ${report.skipped || 0}`);
        if (report.errors.length > 0) {
          cli.log(`  Errors:        ${report.errors.length}`);
          for (const err of report.errors.slice(0, 10)) {
            cli.log(`    ❌ ${err}`);
          }
          if (report.errors.length > 10) {
            cli.log(`    ... and ${report.errors.length - 10} more`);
          }
        }
        if (!opts.dryRun && report.published > 0) {
          cli.log(`\n  ✅ ${report.published} Recipes published successfully.`);
        }
        cli.blank();
      }

      await bootstrap.shutdown();
    } catch (err: any) {
      cli.error(`\n❌ ${err.message}`);
      cli.debug(err.stack);
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
  .option('-m, --mode <mode>', '搜索模式: keyword, weighted, semantic, auto', 'auto')
  .option('-l, --limit <n>', '结果数量', '10')
  .option('-r, --rank', '启用排序管线 (CoarseRanker + MultiSignalRanker)')
  .option('-o, --output <format>', '输出格式: text, json', 'text')
  .action(async (query, opts) => {
    try {
      const { bootstrap, container } = await initContainer();
      const engine = container.get('searchEngine');
      const results = await engine.search(query, {
        type: opts.type,
        mode: opts.mode,
        limit: parseInt(opts.limit, 10),
        rank: opts.rank || false,
      });

      if (opts.output === 'json') {
        cli.log(JSON.stringify(results, null, 2));
      } else if (results.items.length === 0) {
        cli.log('No results found.');
      } else {
        const modeInfo = results.mode || opts.mode;
        const rankInfo = results.ranked ? ', ranked' : '';
        cli.log(
          `\n🔍 ${results.items.length} result(s) for "${query}" [mode: ${modeInfo}${rankInfo}]\n`
        );
        for (const item of results.items) {
          const badge = item.type === 'recipe' ? '📘' : item.type === 'solution' ? '💡' : '🛡️';
          const score = item.score ? ` [${(item.score * 100).toFixed(0)}%]` : '';
          cli.log(`  ${badge} ${item.title || item.trigger || item.id}${score}`);
          if (item.description) {
            cli.log(`     ${item.description.slice(0, 100)}`);
          }
        }
        cli.blank();
      }

      await bootstrap.shutdown();
    } catch (err: any) {
      cli.error(`Error: ${err.message}`);
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
        cli.error(`File not found: ${filePath}`);
        process.exit(1);
      }

      const code = readFileSync(filePath, 'utf8');
      const { bootstrap, container } = await initContainer();

      const { detectLanguage } = await import('../lib/service/guard/GuardCheckEngine.js');
      const engine = container.get('guardCheckEngine');
      const language = detectLanguage(filePath);
      const violations = engine.checkCode(code, language, { scope: opts.scope });

      if (opts.json) {
        cli.json({
          violations,
          summary: {
            total: violations.length,
            errors: violations.filter((v: any) => v.severity === 'error').length,
            warnings: violations.filter((v: any) => v.severity === 'warning').length,
          },
        });
      } else if (violations.length === 0) {
        cli.log('✅ No violations found.');
      } else {
        const errors = violations.filter((v: any) => v.severity === 'error');
        const warnings = violations.filter((v: any) => v.severity === 'warning');
        cli.log(
          `\n🔍 Guard: ${violations.length} violation(s) — ${errors.length} error(s), ${warnings.length} warning(s)\n`
        );
        for (const v of violations) {
          const icon = v.severity === 'error' ? '❌' : v.severity === 'warning' ? '⚠️' : 'ℹ️';
          cli.log(`  ${icon} [${v.ruleId}] ${v.message}`);
          if (v.line) {
            cli.log(`    Line ${v.line}: ${v.snippet || ''}`);
          }
          if (v.fixSuggestion) {
            cli.log(`    💡 Fix: ${v.fixSuggestion}`);
          }
        }
        cli.blank();
      }

      await bootstrap.shutdown();
      process.exit(violations.some((v: any) => v.severity === 'error') ? 1 : 0);
    } catch (err: any) {
      cli.error(`Error: ${err.message}`);
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
  .option('--max-uncertain <n>', 'uncertain 条目阈值 (超出时 exit 2)', '50')
  .option('--min-coverage <n>', '最低覆盖率 (0-100，低于时 exit 3)', '0')
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
          cli.log(`Report written to ${opts.output}`);
        } else {
          cli.log(output);
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

      // Exit code: 0=PASS, 1=FAIL(violations), 2=WARN(uncertain/warnings), 3=FAIL(coverage)
      const maxUncertain = parseInt(opts.maxUncertain, 10);
      const minCoverage = parseInt(opts.minCoverage, 10);

      if (report.qualityGate.status === 'FAIL') {
        process.exit(report.summary.errors > 0 ? 1 : 2);
      }
      if (minCoverage > 0 && (report.coverageScore ?? 100) < minCoverage) {
        process.exit(3);
      }
      if (maxUncertain > 0 && (report.uncertainSummary?.total ?? 0) > maxUncertain) {
        process.exit(2);
      }
      process.exit(0);
    } catch (err: any) {
      cli.error(`Error: ${err.message}`);
      cli.debug(err.stack);
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
      } catch (_err: any) {
        cli.error('❌ 无法获取 git staged 文件（是否在 git 仓库中？）');
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
      const files: { path: string; content: string }[] = [];
      for (const f of sourceFiles) {
        const filePath = resolve(f);
        if (existsSync(filePath)) {
          files.push({ path: filePath, content: readFileSync(filePath, 'utf8') });
        }
      }

      const result = engine.auditFiles(files, { scope: 'file' });
      const { summary } = result;

      if (opts.json) {
        cli.json({ files: result.files, summary });
      } else if (summary.totalViolations === 0) {
        cli.log(`✅ ${sourceFiles.length} staged file(s) checked — no violations.`);
      } else {
        cli.log(
          `\n🔍 Guard (staged): ${summary.totalViolations} violation(s) in ${sourceFiles.length} file(s)\n`
        );
        const filesWithIssues = result.files.filter((f: any) => f.summary.total > 0);
        for (const file of filesWithIssues.slice(0, 10)) {
          cli.log(`  📄 ${file.filePath}`);
          for (const v of file.violations.slice(0, 5)) {
            const icon = v.severity === 'error' ? '❌' : '⚠️';
            cli.log(`    ${icon} [${v.ruleId}] ${v.message}`);
          }
          if (file.violations.length > 5) {
            cli.log(`    ... and ${file.violations.length - 5} more`);
          }
        }
        cli.blank();
      }

      await bootstrap.shutdown();
      process.exit(summary.totalErrors > 0 ? 1 : 0);
    } catch (err: any) {
      cli.error(`Error: ${err.message}`);
      cli.debug(err.stack);
      process.exit(1);
    }
  });

// ─────────────────────────────────────────────────────
// panorama 命令
// ─────────────────────────────────────────────────────
program
  .command('panorama [path]')
  .description('项目全景分析：架构层级、覆盖率、知识空白')
  .option('--json', '以 JSON 格式输出')
  .option('--gaps', '仅显示知识空白区')
  .option('--health', '仅显示健康度评分')
  .action(async (scanPath, opts) => {
    try {
      const projectRoot = resolve(scanPath || '.');
      const { bootstrap, container } = await initContainer({ projectRoot });
      const panoramaService = container.get('panoramaService');
      await panoramaService.ensureData();

      if (opts.gaps) {
        const gaps = await panoramaService.getGaps();
        if (opts.json) {
          cli.log(JSON.stringify(gaps, null, 2));
        } else {
          cli.log(`\n🔍 Knowledge Gaps: ${gaps.length} found\n`);
          for (const g of gaps.slice(0, 20)) {
            const priority = g.priority === 'high' ? '🔴' : g.priority === 'medium' ? '🟡' : '🔵';
            cli.log(
              `  ${priority} [${g.dimensionName}] ${g.recipeCount} recipes (${g.status}) — ${g.suggestedTopics.join(', ')}`
            );
          }
          if (gaps.length > 20) {
            cli.log(`\n  ... and ${gaps.length - 20} more gaps`);
          }
        }
        await bootstrap.shutdown();
        return;
      }

      if (opts.health) {
        const health = await panoramaService.getHealth();
        if (opts.json) {
          cli.log(JSON.stringify(health, null, 2));
        } else {
          const icon = health.healthScore >= 80 ? '✅' : health.healthScore >= 50 ? '⚠️' : '❌';
          cli.log(`\n${icon} Panorama Health: ${health.healthScore}/100\n`);
          cli.log(`  Dimension Coverage: ${health.healthRadar.dimensionCoverage}%`);
          cli.log(`  Avg Coupling: ${health.avgCoupling}`);
          cli.log(`  Modules:      ${health.moduleCount}`);
          cli.log(`  Cycles:       ${health.cycleCount}`);
          cli.log(`  Gaps:         ${health.gapCount} (${health.highPriorityGaps} high-priority)`);
        }
        await bootstrap.shutdown();
        return;
      }

      // 默认: 全景概览
      const overview = await panoramaService.getOverview();
      if (opts.json) {
        cli.log(JSON.stringify(overview, null, 2));
      } else {
        cli.log(`\n📐 Panorama Overview\n`);
        cli.log(`  Project:  ${overview.projectRoot}`);
        cli.log(`  Modules:  ${overview.moduleCount}`);
        cli.log(`  Layers:   ${overview.layerCount}`);
        cli.log(`  Files:    ${overview.totalFiles}`);
        cli.log(`  Recipes:  ${overview.totalRecipes}`);
        cli.log(`  Coverage: ${overview.overallCoverage}%`);
        cli.log(`  Cycles:   ${overview.cycleCount}`);
        cli.log(`  Gaps:     ${overview.gapCount}`);

        if (overview.layers && overview.layers.length > 0) {
          cli.log(`\n  Layers:`);
          for (const layer of overview.layers) {
            const totalFiles = layer.modules.reduce(
              (sum: number, m: { fileCount: number }) => sum + m.fileCount,
              0
            );
            cli.log(`    ${layer.name}: ${layer.modules.length} modules, ${totalFiles} files`);
          }
        }
      }

      await bootstrap.shutdown();
    } catch (err: any) {
      cli.error(`Error: ${err.message}`);
      cli.debug(err.stack);
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
  .option('--no-open', '禁止自动打开浏览器（CI/CD 环境适用）')
  .option('-d, --dir <directory>', '指定 Alembic 项目目录（默认：当前目录）')
  .option('--api-only', '仅启动 API 服务（不启动前端）')
  .action(async (opts) => {
    const { spawn } = await import('node:child_process');

    // 标记为长驻 API 服务进程（CacheCoordinator 用于判断是否启动轮询）
    process.env.ALEMBIC_API_SERVER = '1';

    // 项目根目录：-d 选项 > 环境变量 ALEMBIC_CWD > 当前目录
    const projectRoot = opts.dir || process.env.ALEMBIC_CWD || process.cwd();
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

      // ── UiStartupTasks: 后台异步刷新（不阻塞 UI） ──
      import('../lib/service/bootstrap/UiStartupTasks.js')
        .then(({ runUiStartupTasks }) => runUiStartupTasks({ projectRoot, container }))
        .then((report) => {
          if (report.errors.length > 0) {
            cli.warn(`⚠️  UiStartupTasks completed with ${report.errors.length} error(s)`);
          }
        })
        .catch((err: any) => {
          cli.debug(`UiStartupTasks failed: ${err.message}`);
        });

      // ── MCP 配置检测 ──
      const cursorMcpPath = join(projectRoot, '.cursor', 'mcp.json');
      const vscodeMcpPath = join(projectRoot, '.vscode', 'mcp.json');
      const hasMcpConfig = (() => {
        try {
          const c = JSON.parse(readFileSync(cursorMcpPath, 'utf8'));
          if ('alembic' in (c.mcpServers || {})) {
            return true;
          }
        } catch {
          /* */
        }
        try {
          const v = JSON.parse(readFileSync(vscodeMcpPath, 'utf8'));
          if ('alembic' in (v.servers || {})) {
            return true;
          }
        } catch {
          /* */
        }
        return false;
      })();

      if (hasMcpConfig) {
        console.log('💡 请确认 IDE 中 Alembic MCP 开关已打开，否则 Agent 无法调用工具');
      }

      // 启动 SignalCollector 后台 AI 分析服务
      // [DISABLED] 暂时关闭 AI 调用和 Skills 推荐功能
      // 恢复时删除 `if (false)` 包裹即可
      if (false as boolean) {
        try {
          const { SignalCollector } = await import('../lib/service/skills/SignalCollector.js');
          const { getRealtimeService } = await import(
            '../lib/infrastructure/realtime/RealtimeService.js'
          );
          const db = container.get('database');
          const agentFactory = container.get('agentFactory');
          const knowledgeRepo = container.get('knowledgeRepository');
          const auditRepo = container.get('auditRepository');

          const signalCollector = new SignalCollector({
            projectRoot,
            knowledgeRepo: knowledgeRepo as any,
            auditRepo: auditRepo as any,
            agentFactory,
            container,
            mode: process.env.ALEMBIC_SIGNAL_MODE || 'auto',
            intervalMs: parseInt(process.env.ALEMBIC_SIGNAL_INTERVAL || '3600000', 10),
            onSuggestions: (suggestions: any) => {
              try {
                const realtime = getRealtimeService();
                realtime.broadcastEvent('skill:suggestions', { suggestions });
              } catch {
                /* realtime 未就绪 */
              }
            },
          });
          signalCollector.start();
          (globalThis as any)._signalCollector = signalCollector;

          // 将 SignalCollector 绑定到 AIRecallStrategy (延迟注入)
          try {
            const aiStrategy = (container.singletons as Record<string, any>)._aiRecallStrategy;
            if (aiStrategy && typeof aiStrategy.setSignalCollector === 'function') {
              aiStrategy.setSignalCollector(signalCollector);
            }
          } catch {
            /* recommendation pipeline not yet initialized */
          }
        } catch (scErr: any) {
          cli.warn(`⚠️  SignalCollector failed to start: ${scErr.message}`);
          cli.debug(scErr.stack);
        }
      }

      if (opts.apiOnly) {
        return;
      }

      // 2. 启动 Dashboard UI
      const dashboardDir = DASHBOARD_DIR;
      const distDir = join(dashboardDir, 'dist');
      const hasPrebuilt = existsSync(join(distDir, 'index.html'));
      const hasSrc = existsSync(join(dashboardDir, 'src'));

      if (hasPrebuilt && !hasSrc) {
        // ── 生产模式：npm 安装的包，在 API 服务器上直接托管预构建产物 ──
        // 同端口同 origin → /api 路由自然可达，无跨域问题
        httpServer.mountDashboard(distDir);

        const dashUrl = `http://127.0.0.1:${port}/`;
        console.log(`\n  🚀 Dashboard: ${dashUrl}\n`);

        if (opts.open !== false) {
          const open = (await import('open')).default;
          open(dashUrl);
        }
      } else {
        // ── 开发模式：有源码，启动 Vite Dev Server ──
        if (!existsSync(join(dashboardDir, 'node_modules'))) {
          const install = spawn('npm', ['install'], { cwd: dashboardDir, stdio: 'inherit' });
          await new Promise((resolve, reject) => {
            install.on('close', (code) =>
              code === 0 ? resolve(undefined) : reject(new Error(`npm install exited with ${code}`))
            );
          });
        }
        const viteArgs = ['--host'];
        if (opts.open !== false) {
          viteArgs.push('--open');
        }
        const vite = spawn('npx', ['vite', ...viteArgs], {
          cwd: dashboardDir,
          stdio: 'inherit',
          env: { ...process.env, VITE_API_URL: `http://127.0.0.1:${port}` },
        });

        vite.on('error', (err) => {
          cli.error(`❌ Vite failed to start: ${err.message}`);
        });

        process.on('SIGINT', () => {
          vite.kill();
          process.exit(0);
        });
      }
    } catch (err: any) {
      cli.error(`❌ API server failed to start: ${err.message}`);
      if (err.code === 'EADDRINUSE') {
        cli.error(
          `   Port ${port} is already in use. Kill it with: lsof -ti:${port} | xargs kill -9`
        );
      }
      process.exit(1);
    }
  });

// ─────────────────────────────────────────────────────
// status 命令
// ─────────────────────────────────────────────────────
program
  .command('status')
  .description('检查环境状态')
  .option('--json', 'JSON 格式输出')
  .action(async (opts) => {
    cli.log('\n  Alembic Environment Status');
    cli.log(`  ${'─'.repeat(40)}`);

    // AI 配置
    const { getAiConfigInfo } = await import('../lib/external/ai/AiFactory.js');
    const aiInfo = getAiConfigInfo();
    if (aiInfo.provider && aiInfo.provider !== 'none') {
      cli.log(`  AI Provider:  ${aiInfo.provider}`);
      if (aiInfo.model) {
        cli.log(`  AI Model:     ${aiInfo.model}`);
      }
    } else {
      cli.log('  AI Provider:  通过 IDE Agent（无需配置）');
    }

    // 检查数据库 (Ghost-aware)
    const { WorkspaceResolver } = await import('../lib/shared/WorkspaceResolver.js');
    const resolver = WorkspaceResolver.fromProject(process.cwd());
    const dbPath = join(resolver.dataRoot, '.asd', 'alembic.db');
    const dbExists = existsSync(dbPath);
    cli.log(`  Database:     ${dbExists ? `✅ ${dbPath}` : '❌ not found'}`);

    // 检查 .asd 目录
    const asdDir = join(resolver.dataRoot, '.asd');
    cli.log(
      `  Workspace:    ${existsSync(asdDir) ? `✅ ${resolver.ghost ? '👻 Ghost' : '.asd/'}` : '❌ not initialized (run alembic setup)'}`
    );

    // 检查依赖
    cli.log('  Dependencies:');
    for (const dep of ['better-sqlite3', 'commander', 'express']) {
      try {
        await import(dep);
        cli.log(`    ✅ ${dep}`);
      } catch {
        cli.log(`    ❌ ${dep} (missing)`);
      }
    }

    // 如果数据库存在，加载知识库统计
    if (dbExists) {
      try {
        const projectRoot = resolve('.');
        const { bootstrap, container } = await initContainer({ projectRoot });
        const knowledgeService = container.get('knowledgeService');
        const stats = (await knowledgeService.getStats()) as Record<string, number> | null;
        if (stats) {
          cli.log('  Knowledge:');
          cli.log(
            `    Total: ${stats.total ?? 0}  Active: ${stats.active ?? 0}  Staging: ${stats.staging ?? 0}  Evolving: ${stats.evolving ?? 0}  Decaying: ${stats.decaying ?? 0}  Pending: ${stats.pending ?? 0}  Deprecated: ${stats.deprecated ?? 0}`
          );
          cli.log(
            `    Rules: ${stats.rules ?? 0}  Patterns: ${stats.patterns ?? 0}  Facts: ${stats.facts ?? 0}`
          );
        }

        // Signal Bus 统计
        const signalBus = container.get('signalBus');
        if (signalBus) {
          const bus = signalBus as { emitCount?: number; listenerCount?: number };
          cli.log('  Signals:');
          cli.log(`    Emitted: ${bus.emitCount ?? 0}  Listeners: ${bus.listenerCount ?? 0}`);
        }

        await bootstrap.shutdown();
      } catch {
        // 降级: 无法加载容器时只展示基础状态
      }
    }

    if (opts.json) {
      // 简化 JSON 输出模式
      const result: Record<string, unknown> = {
        aiProvider: aiInfo.provider ?? 'ide-agent',
        aiModel: aiInfo.model ?? null,
        database: dbExists,
        workspace: existsSync(asdDir),
      };
      cli.json(result);
    }

    cli.blank();
  });

// ─────────────────────────────────────────────────────
// health 命令
// ─────────────────────────────────────────────────────
program
  .command('health')
  .description('综合健康报告：系统状态、知识生命周期、Guard 合规、信号统计')
  .option('-d, --dir <path>', '项目目录', '.')
  .option('--json', '以 JSON 格式输出')
  .action(async (opts) => {
    const projectRoot = resolve(opts.dir);

    const { getAiConfigInfo } = await import('../lib/external/ai/AiFactory.js');
    const { WorkspaceResolver } = await import('../lib/shared/WorkspaceResolver.js');
    const resolver = WorkspaceResolver.fromProject(projectRoot);
    const aiInfo = getAiConfigInfo();
    const aiOk = !!(aiInfo.provider && aiInfo.provider !== 'none');

    const dbPath = join(resolver.dataRoot, '.asd', 'alembic.db');
    const dbExists = existsSync(dbPath);

    let dbSizeMB = 0;
    let dbEntries = 0;
    let guardRuleCount = 0;
    let knowledgeStats: Record<string, number> = {};
    let complianceScore = 0;
    let coverageScore = 0;
    let confidencePct = 0;
    let signalEmitted = 0;
    let signalListeners = 0;

    if (dbExists) {
      try {
        const { statSync } = await import('node:fs');
        const stat = statSync(dbPath);
        dbSizeMB = +(stat.size / (1024 * 1024)).toFixed(1);
      } catch {
        /* stat 失败不阻塞 */
      }

      try {
        const { bootstrap, container } = await initContainer({ projectRoot });

        try {
          const knowledgeService = container.get('knowledgeService');
          const stats = (await knowledgeService.getStats()) as Record<string, number> | null;
          if (stats) {
            knowledgeStats = stats;
            dbEntries = stats.total ?? 0;
          }
        } catch {
          /* knowledge service 不可用 */
        }

        try {
          const engine = container.get('guardCheckEngine');
          const rules = engine.getRules();
          guardRuleCount = rules.length;
        } catch {
          /* guard engine 不可用 */
        }

        try {
          const reporter = container.get('complianceReporter');
          const report = await reporter.generate(projectRoot, {
            qualityGate: { maxErrors: 0, maxWarnings: 100, minScore: 0 },
            maxFiles: 200,
          });
          complianceScore = report.complianceScore ?? 0;
          coverageScore = report.coverageScore ?? 0;
          confidencePct = report.confidenceScore ?? 0;
        } catch {
          /* compliance reporter 不可用 */
        }

        try {
          const signalBus = container.get('signalBus') as {
            emitCount?: number;
            listenerCount?: number;
          };
          signalEmitted = signalBus.emitCount ?? 0;
          signalListeners = signalBus.listenerCount ?? 0;
        } catch {
          /* signal bus 不可用 */
        }

        await bootstrap.shutdown();
      } catch {
        /* container init 失败，降级展示基础信息 */
      }
    }

    const healthData = {
      system: {
        ai: aiOk,
        db: dbExists,
        dbSizeMB,
        dbEntries,
        guardRules: guardRuleCount,
      },
      knowledge: {
        active: knowledgeStats.active ?? 0,
        staging: knowledgeStats.staging ?? 0,
        evolving: knowledgeStats.evolving ?? 0,
        decaying: knowledgeStats.decaying ?? 0,
      },
      guard: {
        compliance: complianceScore,
        coverage: coverageScore,
        confidence: confidencePct,
      },
      signals: {
        emitted: signalEmitted,
        listeners: signalListeners,
      },
    };

    if (opts.json) {
      cli.json(healthData);
    } else {
      const dbStatus = dbExists ? `✅(${dbSizeMB}MB, ${dbEntries} entries)` : '❌';
      const aiIcon = aiOk ? '✅' : '❌';

      cli.log('');
      cli.log('Alembic Health Report');
      cli.log('═════════════════════════');
      cli.log(`🔧 System:  AI:${aiIcon}  DB:${dbStatus}  Guard:${guardRuleCount} rules`);
      cli.log(
        `📊 Knowledge: Active:${healthData.knowledge.active} Staging:${healthData.knowledge.staging} Evolving:${healthData.knowledge.evolving} Decaying:${healthData.knowledge.decaying}`
      );
      cli.log(
        `🛡️ Guard: Compliance:${complianceScore} Coverage:${coverageScore} Confidence:${confidencePct}%`
      );
      cli.log(`📡 Signals: emitted:${signalEmitted} listeners:${signalListeners}`);
      cli.blank();
    }
  });

// ─────────────────────────────────────────────────────
// embed 命令 — 构建/重建语义向量索引
// ─────────────────────────────────────────────────────
program
  .command('embed')
  .description('构建/重建语义向量索引（可选 — 增强搜索质量，非必需）')
  .option('-d, --dir <path>', '项目目录', '.')
  .option('--force', '忽略增量检测，全量重建')
  .option('--clear', '清空现有索引后重建')
  .option('--dry-run', '只报告不执行')
  .option('--json', 'JSON 输出')
  .option('--validate', '只验证索引健康状态')
  .action(async (opts) => {
    const projectRoot = resolve(opts.dir);
    const { bootstrap, container } = await initContainer({ projectRoot });

    try {
      // 优先使用 VectorService，降级到 IndexingPipeline
      const hasVectorService = !!container.services.vectorService;

      if (opts.validate) {
        if (hasVectorService) {
          const vs = container.get('vectorService');
          const validation = await vs.validate();
          const stats = await vs.getStats();
          if (opts.json) {
            cli.json({ validation, stats });
          } else {
            cli.log('\n  Vector Index Health Check');
            cli.log(`  ${'─'.repeat(40)}`);
            cli.log(`  Status:    ${validation.healthy ? '✅ Healthy' : '⚠️  Issues found'}`);
            cli.log(`  Entries:   ${stats.count ?? 0}`);
            cli.log(`  Dimension: ${stats.dimension ?? 0}`);
            cli.log(`  Quantized: ${stats.quantized ?? false}`);
            cli.log(
              `  Embed:     ${stats.embedProviderAvailable ? 'Available' : 'Not configured'}`
            );
            if (validation.issues.length > 0) {
              cli.log(`\n  Issues:`);
              for (const issue of validation.issues) {
                cli.log(`    • ${issue}`);
              }
            }
            cli.blank();
          }
        } else {
          cli.log('VectorService not available. Configure an AI API key first.');
        }
        return;
      }

      if (hasVectorService) {
        const vs = container.get('vectorService');

        if (opts.clear) {
          await vs.clear();
          cli.log('  🗑️  Existing vector index cleared.');
        }

        const start = Date.now();
        cli.log('  Building semantic index...');

        const result = await vs.fullBuild({
          force: opts.force ?? false,
          dryRun: opts.dryRun ?? false,
        });

        const duration = ((Date.now() - start) / 1000).toFixed(1);

        if (opts.json) {
          cli.json(result);
        } else {
          cli.log('\n  Embedding Report');
          cli.log(`  ${'─'.repeat(40)}`);
          cli.log(`  Scanned:   ${result.scanned ?? 0} files`);
          cli.log(`  Chunked:   ${result.chunked ?? 0} chunks`);
          cli.log(`  Enriched:  ${result.enriched ?? 0} (contextual)`);
          cli.log(`  Embedded:  ${result.embedded ?? 0}`);
          cli.log(`  Upserted:  ${result.upserted ?? 0}`);
          cli.log(`  Skipped:   ${result.skipped ?? 0} (unchanged)`);
          cli.log(`  Errors:    ${result.errors ?? 0}`);
          cli.log(`  Duration:  ${duration}s`);
          cli.blank();
        }
      } else {
        // 降级: 直接使用 IndexingPipeline
        const pipeline = container.get('indexingPipeline');
        const result = await pipeline.run({
          force: opts.force ?? false,
          dryRun: opts.dryRun ?? false,
          clear: opts.clear ?? false,
        });

        if (opts.json) {
          cli.json(result);
        } else {
          cli.log('\n  Embedding Report (pipeline mode)');
          cli.log(`  ${'─'.repeat(40)}`);
          cli.log(`  Scanned:  ${result.scanned} files`);
          cli.log(`  Chunked:  ${result.chunked} chunks`);
          cli.log(`  Embedded: ${result.embedded}`);
          cli.log(`  Upserted: ${result.upserted}`);
          cli.log(`  Skipped:  ${result.skipped} (unchanged)`);
          cli.log(`  Errors:   ${result.errors}`);
          cli.blank();
        }
      }
    } finally {
      await bootstrap.shutdown?.();
    }
  });

// ─────────────────────────────────────────────────────
// upgrade 命令
// ─────────────────────────────────────────────────────
program
  .command('upgrade')
  .description(
    '升级 IDE 集成（全量：MCP + Rules + Hooks + Instructions + Skills + Constitution + .gitignore）'
  )
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
      cli.log('\n  Cursor Rules Delivery');
      cli.log(`  ${'─'.repeat(40)}`);
      cli.log(`  Channel A: ${result.channelA?.rulesCount ?? '?'} always-on rules`);
      cli.log(
        `  Channel B: ${result.channelB?.topicCount ?? Object.keys(result.channelB?.topics || {}).length} topic rules`
      );
      cli.log(
        `  Channel C: ${result.channelC?.synced ?? '?'} skills (${result.channelC?.errors ?? 0} errors)`
      );
      if (result.channelC.errors > 0) {
        cli.log(`  ⚠️  ${result.channelC.errors} skill(s) failed to deliver`);
      }

      if (opts.verbose && result.channelB.topics) {
        cli.log('\n  Channel B Topics:');
        for (const [topic, info] of Object.entries(result.channelB.topics)) {
          cli.log(
            `    ${topic}: ${(info as any).count ?? (info as any).rules?.length ?? '?'} rules`
          );
        }
      }
      cli.blank();
    } finally {
      await bootstrap.shutdown?.();
    }
  });

// ─────────────────────────────────────────────────────
// task 命令 — Task 系统已迁移到 MCP (零 DB，纯内存 + JSONL)
// CLI task 子命令已废弃，通过 MCP alembic_task 操作
// ─────────────────────────────────────────────────────
const taskCmd = program
  .command('task')
  .description('Task 管理（已迁移到 MCP — 通过 alembic_task 操作）');

taskCmd
  .command('list')
  .description('[已废弃] Task 系统不再使用数据库。通过 MCP prime 操作获取上下文。')
  .action(() => {
    cli.log('\n  ⚠️ Task 系统已迁移到 MCP（零 DB，纯内存 + JSONL）。');
    cli.log('  使用 alembic_task({ operation: "prime" }) 加载上下文。\n');
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
      cli.error('❌ 未找到 .cursor/ 目录，请先运行 alembic setup 或 alembic cursor-rules');
      process.exit(1);
    }

    for (const target of targets) {
      let count = 0;

      // 1. 镜像 rules/ — alembic- 前缀文件（.mdc → .md 改名）
      const cursorRulesDir = join(cursorDir, 'rules');
      if (existsSync(cursorRulesDir)) {
        const targetRulesDir = join(projectRoot, target, 'rules');
        mkdirSync(targetRulesDir, { recursive: true });
        const files = readdirSync(cursorRulesDir).filter(
          (f) => f.startsWith('alembic-') && (f.endsWith('.mdc') || f.endsWith('.md'))
        );
        for (const file of files) {
          const destName = file.endsWith('.mdc') ? file.replace(/\.mdc$/, '.md') : file;
          copyFileSync(join(cursorRulesDir, file), join(targetRulesDir, destName));
          count++;
        }
      }

      // 2. 镜像 skills/ — alembic- 前缀目录
      const cursorSkillsDir = join(cursorDir, 'skills');
      if (existsSync(cursorSkillsDir)) {
        const targetSkillsDir = join(projectRoot, target, 'skills');
        const skillDirs = readdirSync(cursorSkillsDir, { withFileTypes: true }).filter(
          (d) => d.isDirectory() && d.name.startsWith('alembic-')
        );
        for (const dir of skillDirs) {
          _copyDirRecursive(join(cursorSkillsDir, dir.name), join(targetSkillsDir, dir.name));
          count++;
        }
      }

      // 3. 镜像 hooks/ — hook 脚本（全覆盖）
      const cursorHooksDir = join(cursorDir, 'hooks');
      if (existsSync(cursorHooksDir)) {
        _copyDirRecursive(cursorHooksDir, join(projectRoot, target, 'hooks'));
        count++;
      }

      // 4. 镜像 commands/ — 斜杠命令（全覆盖）
      const cursorCommandsDir = join(cursorDir, 'commands');
      if (existsSync(cursorCommandsDir)) {
        _copyDirRecursive(cursorCommandsDir, join(projectRoot, target, 'commands'));
        count++;
      }

      // 5. 镜像 hooks.json
      const hooksJson = join(cursorDir, 'hooks.json');
      if (existsSync(hooksJson)) {
        mkdirSync(join(projectRoot, target), { recursive: true });
        copyFileSync(hooksJson, join(projectRoot, target, 'hooks.json'));
        count++;
      }

      const label = target.replace('.', '').charAt(0).toUpperCase() + target.slice(2);
      cli.log(`  ✅ ${label}: ${count} item(s) mirrored`);
    }
  });

/** 递归复制目录（mirror 命令用） */
function _copyDirRecursive(src: any, dest: any) {
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
      cli.log('ℹ️  Dry-run mode: no changes will be written');
    }

    // 通过 Bootstrap 打开目标项目的 DB
    const ConfigLoader = (await import('../lib/infrastructure/config/ConfigLoader.js')).default;
    const env = process.env.NODE_ENV || 'development';
    ConfigLoader.load(env);
    ConfigLoader.set('database.path', '.asd/alembic.db');

    const { bootstrap, container } = await initContainer({ projectRoot });
    const db = container.get('database')?.getDb?.();
    if (!db) {
      cli.error('❌ 无法打开数据库，请先运行 alembic setup');
      process.exit(1);
    }

    try {
      const report: any = await syncService.syncAll(db as any, {
        dryRun: opts.dryRun,
        force: opts.force,
      });

      cli.log('\n  Knowledge Sync Report');
      cli.log(`  ${'─'.repeat(40)}`);
      cli.log(`  Created:   ${report.created ?? 0}`);
      cli.log(`  Updated:   ${report.updated ?? 0}`);
      cli.log(`  Unchanged: ${report.unchanged ?? 0}`);
      cli.log(`  Deleted:   ${report.deleted ?? 0}`);

      if (report.reconcileReport) {
        cli.log(`\n  📍 Source Refs`);
        cli.log(`  ${'─'.repeat(40)}`);
        cli.log(`  Inserted:  ${report.reconcileReport.inserted ?? 0}`);
        cli.log(`  Active:    ${report.reconcileReport.active ?? 0}`);
        cli.log(`  Stale:     ${report.reconcileReport.stale ?? 0}`);
        cli.log(`  Skipped:   ${report.reconcileReport.skipped ?? 0}`);
      }

      if (
        report.repairReport &&
        (report.repairReport.renamed > 0 || report.repairReport.stillStale > 0)
      ) {
        cli.log(`\n  🔧 Rename Repairs`);
        cli.log(`  ${'─'.repeat(40)}`);
        cli.log(`  Renamed:    ${report.repairReport.renamed ?? 0}`);
        cli.log(`  Still Stale: ${report.repairReport.stillStale ?? 0}`);
      }

      if (report.violations.length > 0) {
        cli.log(`\n  ⚠️  Violations (${report.violations.length}):`);
        for (const v of report.violations) {
          cli.log(`    ❌ ${v.file || v.id}: ${v.message || v}`);
        }
      }

      if (report.orphaned.length > 0) {
        cli.log(`\n  👻 Orphaned entries (${report.orphaned.length}):`);
        for (const id of report.orphaned) {
          cli.log(`    ${id}`);
        }
      }
      cli.blank();
    } finally {
      await bootstrap.shutdown?.();
    }
  });

// ─────────────────────────────────────────────────────
// list-warnings 命令
// ─────────────────────────────────────────────────────
program
  .command('list-warnings')
  .description('列出知识库中的 warnings（矛盾 / 冗余）')
  .option('-d, --dir <path>', '项目目录', '.')
  .option('--status <status>', '按状态过滤：open / resolved / dismissed', 'open')
  .option('--type <type>', '按类型过滤：contradiction / redundancy')
  .option('--json', '以 JSON 格式输出')
  .action(async (opts) => {
    const projectRoot = resolve(opts.dir);
    const { bootstrap, container } = await initContainer({ projectRoot });
    try {
      const warningRepo = container.get(
        'warningRepository'
      ) as import('../lib/repository/evolution/WarningRepository.js').WarningRepository;

      const filter: Record<string, string> = {};
      if (opts.status) {
        filter.status = opts.status;
      }
      if (opts.type) {
        filter.type = opts.type;
      }

      const warnings = warningRepo.find(filter as any, 200);
      const openCount = warningRepo.countOpen();

      if (opts.json) {
        cli.json({ openCount, warnings });
        return;
      }

      cli.log(`\n  Recipe Warnings (open: ${openCount})`);
      cli.log(`  ${'─'.repeat(50)}`);

      if (warnings.length === 0) {
        cli.log('  ✅ No warnings found');
      } else {
        for (const w of warnings) {
          const icon = w.type === 'contradiction' ? '⚠️' : '🔄';
          const date = new Date(w.detectedAt).toISOString().slice(0, 10);
          cli.log(`  ${icon} [${w.type}] ${w.description}`);
          cli.log(
            `     target: ${w.targetRecipeId}  confidence: ${(w.confidence * 100).toFixed(0)}%  detected: ${date}  status: ${w.status}`
          );
          if (w.relatedRecipeIds.length > 0) {
            cli.log(`     related: ${w.relatedRecipeIds.join(', ')}`);
          }
        }
      }
      cli.blank();
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
 * @param [opts.projectRoot] 项目根目录（默认 cwd）
 * @returns >}
 */
async function initContainer(opts: any = {}) {
  const projectRoot = opts.projectRoot || process.cwd();

  // 切换工作目录到项目根 — 确保 DB 等相对路径正确解析
  if (resolve(projectRoot) !== resolve(process.cwd())) {
    process.chdir(projectRoot);
  }

  // 配置路径安全守卫 — 阻止写操作逃逸到项目外
  const { default: Bootstrap } = await import('../lib/bootstrap.js');
  (Bootstrap as any).configurePathGuard(projectRoot);

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
    workspaceResolver: bootstrap.components.workspaceResolver,
  });
  return { bootstrap, container };
}

// ─────────────────────────────────────────────────────
// ghost 命令 — 管理 Ghost 模式
// ─────────────────────────────────────────────────────
program
  .command('ghost')
  .description('管理 Ghost 模式（零项目侵入）')
  .argument('[action]', '操作: status | on | off | clean | list', 'status')
  .option('-d, --dir <path>', '项目目录', '.')
  .action(async (action: string, opts: { dir: string }) => {
    const { ProjectRegistry, getGhostWorkspaceDir } = await import(
      '../lib/shared/ProjectRegistry.js'
    );
    const fs = await import('node:fs');
    const os = await import('node:os');
    const projectRoot = resolve(opts.dir);

    /** 移动目录（同卷 rename，跨卷 copy+delete） */
    function moveDir(src: string, dest: string) {
      if (!fs.existsSync(src)) {
        return;
      }
      fs.mkdirSync(dirname(dest), { recursive: true });
      try {
        fs.renameSync(src, dest);
      } catch {
        fs.cpSync(src, dest, { recursive: true });
        fs.rmSync(src, { recursive: true, force: true });
      }
    }

    /** 清理 .gitignore 中的 Alembic managed section */
    function removeGitignoreSection(root: string) {
      const giPath = join(root, '.gitignore');
      if (!fs.existsSync(giPath)) {
        return;
      }
      const content = fs.readFileSync(giPath, 'utf8');
      const BEGIN = '# >>> Alembic (managed block — do not edit) >>>';
      const END = '# <<< Alembic <<<';
      const beginIdx = content.indexOf(BEGIN);
      const endIdx = content.indexOf(END);
      if (beginIdx === -1 || endIdx === -1) {
        return;
      }
      const cleaned = (content.slice(0, beginIdx) + content.slice(endIdx + END.length))
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      if (cleaned.length === 0) {
        fs.unlinkSync(giPath);
      } else {
        fs.writeFileSync(giPath, `${cleaned}\n`);
      }
    }

    /** 写 MCP 配置到指定路径 */
    function writeMcpConfig(dest: string, key: string, entry: Record<string, unknown>) {
      fs.mkdirSync(dirname(dest), { recursive: true });
      let config: Record<string, Record<string, unknown>> = {};
      if (fs.existsSync(dest)) {
        try {
          config = JSON.parse(fs.readFileSync(dest, 'utf8'));
        } catch {
          /* */
        }
      }
      if (!config[key]) {
        config[key] = {};
      }
      config[key].asd = entry;
      fs.writeFileSync(dest, JSON.stringify(config, null, 2));
    }

    /** 移除 MCP 配置中的 alembic 条目 */
    function removeMcpEntry(dest: string, key: string) {
      if (!fs.existsSync(dest)) {
        return;
      }
      try {
        const config = JSON.parse(fs.readFileSync(dest, 'utf8'));
        if (config[key]?.asd) {
          delete config[key].asd;
          if (Object.keys(config[key]).length === 0) {
            delete config[key];
          }
          if (Object.keys(config).length === 0) {
            fs.unlinkSync(dest);
          } else {
            fs.writeFileSync(dest, JSON.stringify(config, null, 2));
          }
        }
      } catch {
        /* */
      }
    }

    /** VSCode 全局配置目录 */
    function vscodeMcpGlobalPath() {
      const p = process.platform;
      if (p === 'darwin') {
        return join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'mcp.json');
      }
      if (p === 'win32') {
        return join(process.env.APPDATA || '', 'Code', 'User', 'mcp.json');
      }
      return join(os.homedir(), '.config', 'Code', 'User', 'mcp.json');
    }

    /** Cursor MCP 条目（全局用 ${workspaceFolder}） */
    const cursorMcpEntry = {
      command: 'alembic-mcp',
      env: { ALEMBIC_PROJECT_DIR: '${workspaceFolder}' },
    };

    /** VSCode MCP 条目 */
    function vscodeMcpEntry(absPath: boolean) {
      return {
        type: 'stdio',
        command: 'alembic-mcp',
        env: {
          ALEMBIC_PROJECT_DIR: absPath ? projectRoot : '${workspaceFolder}',
        },
      };
    }

    switch (action) {
      case 'status': {
        const entry = ProjectRegistry.get(projectRoot);
        if (!entry) {
          console.log('  项目未注册。运行 alembic setup 或 alembic setup --ghost 初始化。');
        } else if (entry.ghost) {
          const wsDir = ProjectRegistry.getWorkspaceDir(projectRoot);
          console.log(`  👻 Ghost 模式: 已启用`);
          console.log(`  📁 工作区:     ${wsDir}`);
          console.log(`  🆔 项目 ID:    ${entry.id}`);
          console.log(`  📅 注册时间:   ${entry.createdAt}`);
        } else {
          console.log(`  📌 标准模式: 数据存储在项目内`);
          console.log(`  🆔 项目 ID:    ${entry.id}`);
        }
        break;
      }

      case 'on': {
        // ── 标准 → Ghost ──────────────────────────────
        const existing = ProjectRegistry.get(projectRoot);
        if (existing?.ghost) {
          console.log('  已在 Ghost 模式，无需切换。');
          break;
        }

        // 1. 注册为 Ghost
        const entry = ProjectRegistry.register(projectRoot, true);
        const wsDir = getGhostWorkspaceDir(entry.id);
        fs.mkdirSync(wsDir, { recursive: true });

        // 2. 迁移数据目录：项目 → 全局
        const asdSrc = join(projectRoot, '.asd');
        const asdDest = join(wsDir, '.asd');
        const kbSrc = join(projectRoot, 'Alembic');
        const kbDest = join(wsDir, 'Alembic');

        let migrated = false;
        if (fs.existsSync(asdSrc)) {
          moveDir(asdSrc, asdDest);
          migrated = true;
        }
        if (fs.existsSync(kbSrc)) {
          moveDir(kbSrc, kbDest);
          migrated = true;
        }

        // 3. .gitignore Alembic section 保留 — 作为安全网防止意外产物被 git 追踪

        // 4. MCP 切换：项目级 → 全局
        //    Cursor: 项目 .cursor/mcp.json → 全局 ~/.cursor/mcp.json
        removeMcpEntry(join(projectRoot, '.cursor', 'mcp.json'), 'mcpServers');
        writeMcpConfig(join(os.homedir(), '.cursor', 'mcp.json'), 'mcpServers', cursorMcpEntry);
        //    VSCode: 项目 .vscode/mcp.json → 全局（绝对路径）
        removeMcpEntry(join(projectRoot, '.vscode', 'mcp.json'), 'servers');
        writeMcpConfig(vscodeMcpGlobalPath(), 'servers', vscodeMcpEntry(true));

        console.log(`  👻 Ghost 模式已启用`);
        console.log(`  📁 工作区: ${wsDir}`);
        if (migrated) {
          console.log('  📦 已迁移 .asd/ 和 Alembic/ 到外置工作区');
        }
        console.log('  📌 MCP 配置已切换到全局（~/.cursor/mcp.json + VSCode 全局）');
        if (!migrated) {
          console.log('  提示: 运行 alembic setup --ghost 完成初始化');
        }
        break;
      }

      case 'off': {
        // ── Ghost → 标准 ──────────────────────────────
        const existing = ProjectRegistry.get(projectRoot);
        if (!existing) {
          console.log('  项目未注册。运行 alembic setup 初始化。');
          break;
        }
        if (!existing.ghost) {
          console.log('  已在标准模式，无需切换。');
          break;
        }

        const wsDir = getGhostWorkspaceDir(existing.id);

        // 1. 迁移数据目录：全局 → 项目
        const asdSrc = join(wsDir, '.asd');
        const asdDest = join(projectRoot, '.asd');
        const kbSrc = join(wsDir, 'Alembic');
        const kbDest = join(projectRoot, 'Alembic');

        let migrated = false;
        if (fs.existsSync(asdSrc)) {
          moveDir(asdSrc, asdDest);
          migrated = true;
        }
        if (fs.existsSync(kbSrc)) {
          moveDir(kbSrc, kbDest);
          migrated = true;
        }

        // 2. 更新注册为标准模式
        ProjectRegistry.register(projectRoot, false);

        // 3. MCP 切换：全局 → 项目级
        //    Cursor: 全局 → 项目 .cursor/mcp.json
        removeMcpEntry(join(os.homedir(), '.cursor', 'mcp.json'), 'mcpServers');
        writeMcpConfig(join(projectRoot, '.cursor', 'mcp.json'), 'mcpServers', cursorMcpEntry);
        //    VSCode: 全局 → 项目 .vscode/mcp.json
        removeMcpEntry(vscodeMcpGlobalPath(), 'servers');
        writeMcpConfig(join(projectRoot, '.vscode', 'mcp.json'), 'servers', vscodeMcpEntry(false));

        // 4. 清理空的外置工作区目录
        if (fs.existsSync(wsDir) && fs.readdirSync(wsDir).length === 0) {
          fs.rmdirSync(wsDir);
        }

        console.log('  📌 已切换到标准模式');
        if (migrated) {
          console.log('  📦 已迁移 .asd/ 和 Alembic/ 回项目内');
        }
        console.log('  📌 MCP 配置已切换到项目级（.cursor/mcp.json + .vscode/mcp.json）');
        console.log('  提示: 运行 alembic upgrade 补全 .gitignore 等配置');
        break;
      }

      case 'list': {
        const all = ProjectRegistry.list();
        if (all.length === 0) {
          console.log('  暂无已注册项目。');
        } else {
          console.log(`  已注册 ${all.length} 个项目：\n`);
          for (const { projectRoot: root, entry } of all) {
            const mode = entry.ghost ? '👻 Ghost' : '📌 标准';
            console.log(`  ${mode}  ${entry.id}  ${root}`);
          }
        }
        break;
      }

      case 'clean': {
        const entry = ProjectRegistry.get(projectRoot);
        if (!entry?.ghost) {
          console.log('  当前项目不在 Ghost 模式，无需清理。');
          break;
        }
        const wsDir = ProjectRegistry.getWorkspaceDir(projectRoot);
        console.log(`  将删除外置工作区: ${wsDir}`);
        console.log('  确认后请手动删除此目录。');
        break;
      }

      default:
        console.error(`  未知操作: ${action}`);
        console.log('  用法: alembic ghost [status|on|off|list|clean]');
    }
  });

program.parse(process.argv);
