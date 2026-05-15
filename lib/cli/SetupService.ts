/**
 * SetupService — 项目初始化服务（V2 重构版）
 *
 * 初始化 Alembic 工作空间底座：
 *
 *   Step 1  .asd/ 运行时目录 + config.json
 *   Step 2  Alembic/ 知识库目录结构 + Alembic/recipes/（有 --repo 则 clone，无则为普通目录）
 *   Step 3  SQLite 数据库 + Recipe 同步
 *   Step 4  向量索引
 *
 * ═══════════════════════════════════════════════════════════
 *
 * 数据架构（核心数据在子仓库，受 git 权限保护）
 * ─────────────────────────────────────────────
 *   Alembic/  (知识库根目录)
 *     ├─ constitution.yaml    权限宪法：角色 + 权限矩阵 + 治理规则 + 能力探测
 *     ├─ boxspec.json         项目规格定义
 *     ├─ recipes/             Git 子仓库 = 唯一真实来源 Source of Truth
 *     │   └─ *.md             统一知识实体（代码规范/模式/架构/调用链/数据流/...）
 *     ├─ candidates/          候选知识（待审批）
 *     ├─ skills/              Project Skills（冷启动自动生成 + 手动创建）
 *     └─ README.md
 *
 *   .asd/  (运行时缓存，gitignored)
 *     ├─ config.json          项目配置（含 core.subRepoDir 子仓库路径）
 *     ├─ alembic.db       SQLite 运行时缓存（从子仓库同步 + candidates/snippets/audit）
 *     ├─ context/             向量索引缓存
 *     └─ logs/                运行日志
 *
 * 数据流
 * ─────
 *   写入：编辑子仓库文件 → git push（需权限）→ 插件运行时同步 → 更新 DB 缓存
 *   读取：查询 SQLite（快速索引）
 *   核心数据（统一 Recipe 实体）修改必须经过 git，普通用户无法绕过
 *
 * 权限模型（三层架构）
 * ──────────────────
 *   ① 能力层 WriteGuard  — git push --dry-run：探测子仓库写权限（物理信号）
 *   ② 角色层 Permission  — constitution.yaml 角色权限矩阵（逻辑裁决）
 *   ③ 治理层 Constitution — constitution.yaml 优先级规则引擎（业务裁决）
 *
 *   子仓库 git 权限只是"一种能力（capability）"，最终裁决权在 Constitution YAML。
 */

import { execSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { isExcludedProject } from '../shared/isOwnDevRepo.js';
import {
  DEFAULT_KNOWLEDGE_BASE_DIR,
  DEFAULT_SUB_REPO_DIR,
  isGitRepo,
} from '../shared/ProjectMarkers.js';
import { ProjectRegistry } from '../shared/ProjectRegistry.js';
import { PACKAGE_ROOT } from '../shared/package-root.js';
import { WorkspaceResolver } from '../shared/WorkspaceResolver.js';

/** Alembic 源码仓库根目录（定位 templates/ 等资源） */
const REPO_ROOT = PACKAGE_ROOT;

// ─────────────────────────────────────────────────────

export type SetupProfile = 'codex-plugin' | 'headless';

export class SetupService {
  force: boolean;
  profile: SetupProfile;
  projectName: string;
  projectRoot: string;
  /** Ghost 模式：所有数据写到 ~/.asd/workspaces/<id>/ */
  ghost: boolean;
  /** 静默模式：用于 --json 场景，避免进度输出污染 stdout */
  quiet: boolean;
  /** WorkspaceResolver — Ghost 模式感知的路径解析 */
  resolver: WorkspaceResolver | null;
  _results: Array<{ step: number; label: string; ok: boolean; error?: string }> | null = null;
  candidatesDir: string;
  coreDir: string;
  dbPath: string;
  recipesDir: string;
  runtimeDir: string;
  seed: boolean;
  skillsDir: string;
  /** 子仓库相对路径（相对于 projectRoot），如 'Alembic/recipes' */
  subRepoDir: string;
  /** 子仓库绝对路径 */
  subRepoPath: string;
  /** 子仓库远程仓库 URL（为空则 recipes/ 作为普通目录随主仓库提交） */
  subRepoUrl: string | undefined;
  /**
   * @param options
   */
  constructor(options: {
    projectRoot: string;
    force?: boolean;
    seed?: boolean;
    /** 初始化 profile：codex-plugin 为 Codex 市场插件模式，headless 为插件共同底座 */
    profile?: SetupProfile;
    /** 静默输出（用于 MCP/插件宿主需要结构化结果的场景） */
    quiet?: boolean;
    /** Ghost 模式：零项目侵入，数据外置到 ~/.asd/workspaces/ */
    ghost?: boolean;
    /** 自定义子仓库相对路径（默认 'Alembic/recipes'） */
    subRepoDir?: string;
    /** 子仓库远程仓库 URL（提供则 clone，不提供则 recipes/ 为普通目录） */
    subRepoUrl?: string;
  }) {
    this.projectRoot = resolve(options.projectRoot);
    this.projectName = this.projectRoot.split('/').pop() || '';
    this.force = options.force || false;
    this.seed = options.seed || false;
    this.profile = options.profile || 'headless';
    this.quiet = options.quiet || false;
    this.subRepoDir = options.subRepoDir || DEFAULT_SUB_REPO_DIR;
    this.subRepoUrl = options.subRepoUrl;

    // Ghost 模式：显式配置优先；Codex 插件 profile 默认 Ghost；否则继承注册表状态
    const existingEntry = ProjectRegistry.get(this.projectRoot);
    this.ghost =
      options.ghost ?? (this.profile === 'codex-plugin' ? true : (existingEntry?.ghost ?? false));

    // ── 排除项目保护 ──────────────────────────────────
    const exclusion = isExcludedProject(this.projectRoot);
    if (exclusion.excluded && !this.ghost) {
      throw new Error(
        `[SetupService] 检测到当前目录是排除项目（${exclusion.reason}），` +
          '拒绝执行 setup 以避免创建 .asd/ 和 Alembic/ 运行时数据。' +
          '\n提示: 请由 IDE 插件传入真实用户项目目录，并优先使用 Ghost 模式初始化。'
      );
    }

    // ── Ghost 模式：注册项目 + 创建外置工作区 ──
    if (this.ghost) {
      const entry = ProjectRegistry.register(this.projectRoot, true);
      this.resolver = new WorkspaceResolver({
        projectRoot: this.projectRoot,
        ghost: true,
        projectId: entry.id,
      });
    } else {
      // 标准模式也注册（ghost=false）
      ProjectRegistry.register(this.projectRoot, false);
      this.resolver = new WorkspaceResolver({ projectRoot: this.projectRoot, ghost: false });
    }

    // 使用 resolver 统一计算路径
    this.runtimeDir = this.resolver.runtimeDir;
    this.dbPath = this.resolver.databasePath;
    this.coreDir = this.resolver.knowledgeDir;
    this.recipesDir = this.resolver.recipesDir;
    this.candidatesDir = this.resolver.candidatesDir;
    this.skillsDir = this.resolver.skillsDir;

    // 子仓库绝对路径（Ghost 模式下也在外置工作区内）
    this.subRepoPath = this.ghost
      ? join(this.resolver.dataRoot, this.subRepoDir)
      : join(this.projectRoot, this.subRepoDir);
  }

  /* ═══ 公共入口 ═══════════════════════════════════════ */

  getSteps(): Array<{ label: string; fn: () => unknown | Promise<unknown> }> {
    const steps: Array<{ label: string; fn: () => unknown | Promise<unknown> }> = [
      { label: '创建运行时目录与配置', fn: () => this.stepRuntime() },
      { label: '初始化知识库与 recipes 子仓库', fn: () => this.stepCoreRepo() },
      { label: '初始化数据库', fn: () => this.stepDatabase() },
      { label: '初始化向量索引', fn: () => this.stepVectorIndex() },
    ];

    return steps;
  }

  async run() {
    const steps = this.getSteps();
    const results: Array<{ step: number; label: string; ok: boolean; error?: string }> = [];
    const total = steps.length;

    for (let i = 0; i < total; i++) {
      const { label, fn } = steps[i];
      const tag = `[${i + 1}/${total}]`;
      if (!this.quiet) {
        process.stdout.write(`  ${tag} ${label}...`);
      }
      try {
        const r = await fn();
        const stepResult = r && typeof r === 'object' ? (r as Record<string, unknown>) : undefined;
        const _detail = this._formatStepDetail(stepResult);
        results.push({ step: i + 1, label, ok: true, ...(stepResult || {}) });
      } catch (err: unknown) {
        if (!this.quiet) {
          console.error(`       ${(err as Error).message}`);
        }
        results.push({ step: i + 1, label, ok: false, error: (err as Error).message });
      }
    }

    this._results = results;
    return results;
  }

  /** 格式化步骤结果的简要信息 */
  private _formatStepDetail(r: Record<string, unknown> | undefined) {
    if (!r) {
      return '';
    }
    const parts: string[] = [];
    if (r.configured) {
      parts.push((r.configured as string[]).join(', '));
    }
    if (r.entries !== undefined) {
      parts.push(`${r.entries} entries`);
    }
    if (r.migrated !== undefined) {
      parts.push(`migrated ${r.migrated}`);
    }
    return parts.length > 0 ? ` (${parts.join('; ')})` : '';
  }

  printSummary() {
    if (this.quiet) {
      return;
    }
    const results = this._results || [];
    const ok = results.filter((r) => r.ok).length;
    const fail = results.filter((r) => !r.ok).length;

    console.log('');
    if (fail === 0) {
      console.log(`  ✅ Setup 完成（${ok} 步骤全部成功）`);
    } else {
      console.log(`  ⚠️  Setup 完成（${ok} 成功，${fail} 失败）`);
    }
    if (this.ghost) {
      console.log(`  👻 Ghost 模式已启用 — 数据存储在: ${this.resolver?.dataRoot}`);
    }
    console.log('');
    console.log('  下一步：');
    if (this.profile === 'codex-plugin') {
      console.log('    1. 在 Codex 插件中调用 alembic_health 检查 MCP 可用性');
      console.log('    2. 非简单编码任务前使用 alembic_task(operation=prime)');
      console.log('    3. 写完后使用 alembic_guard 检查当前变更');
    } else {
      console.log('    1. 由目标 IDE 插件启动 Alembic MCP 或 daemon');
      console.log('    2. 首次使用前确认插件已传入准确的项目目录');
      console.log('    3. 使用插件侧命令执行 bootstrap、rescan、guard 等能力');
    }
    console.log('');
  }

  /* ═══ Step 1: 运行时目录与配置 ═══════════════════════ */

  stepRuntime() {
    mkdirSync(this.runtimeDir, { recursive: true });

    // config.json
    const configPath = join(this.runtimeDir, 'config.json');
    if (existsSync(configPath) && !this.force) {
    } else {
      const config: Record<string, unknown> = {
        version: 2,
        projectName: this.projectName,
        database: '.asd/alembic.db',
        core: {
          dir: DEFAULT_KNOWLEDGE_BASE_DIR,
          constitution: `${DEFAULT_KNOWLEDGE_BASE_DIR}/constitution.yaml`,
          subRepoDir: this.subRepoDir,
          ...(this.subRepoUrl ? { subRepoUrl: this.subRepoUrl } : {}),
        },
        ai: { provider: process.env.ALEMBIC_AI_PROVIDER || 'auto' },
        guard: { enabled: true },
        watch: {
          enabled: false,
          paths: ['Sources', 'src'],
          extensions: ['.swift', '.m', '.h'],
        },
      };
      writeFileSync(configPath, JSON.stringify(config, null, 2));
    }

    return { created: 'runtime' };
  }

  /* ═══ Step 2: 知识库目录 + recipes 子仓库 ═════════════ */

  stepCoreRepo() {
    const alreadyRepo = isGitRepo(this.subRepoPath);

    // 创建目录结构
    for (const d of [this.coreDir, this.recipesDir, this.candidatesDir, this.skillsDir]) {
      mkdirSync(d, { recursive: true });
    }

    // ── 子仓库处理：有 URL → clone 模式；无 URL → 普通目录 ──
    if (this.subRepoUrl) {
      if (alreadyRepo) {
        // 幂等：已是 git 仓库，确保 remote 一致
        this._ensureRemote(this.subRepoUrl);
      } else if (this._hasFiles(this.subRepoPath)) {
        // 有文件但不是 git 仓库 → 备份 + clone + 合并
        this._cloneWithMerge(this.subRepoUrl);
      } else {
        // 空目录 → 直接 clone（先移除空目录，git clone 需要目标不存在）
        try {
          rmdirSync(this.subRepoPath);
        } catch {
          /* 目录可能不存在或不为空，忽略 */
        }
        this._git(['clone', this.subRepoUrl, this.subRepoPath], this.projectRoot);
      }
    }
    // else: 无 URL → recipes/ 是普通目录，随主仓库提交，不执行 git init

    // constitution.yaml — 权限宪法
    this._writeConstitution();

    // boxspec.json — 项目规格
    this._writeBoxspec();

    // recipes/_template.md — Recipe 格式参考
    this._copyRecipeTemplate();

    // seed recipes — 冷启动示例
    if (this.seed) {
      this._copySeedRecipes();
    }

    // README.md
    this._writeCoreReadme();

    // .gitignore（子仓库自身，仅在有 URL 即子仓库模式时写入）
    if (this.subRepoUrl) {
      const giPath = join(this.subRepoPath, '.gitignore');
      if (!existsSync(giPath)) {
        writeFileSync(giPath, '.DS_Store\n*.swp\n');
      }
    }

    // clone 后可能写入了模板文件，提交它们（仅新 clone 时）
    if (this.subRepoUrl && !alreadyRepo && isGitRepo(this.subRepoPath)) {
      try {
        const status = this._git(['status', '--porcelain'], this.subRepoPath);
        if (status.trim().length > 0) {
          this._git(['add', '.'], this.subRepoPath);
          this._git(['commit', '-m', 'Add Alembic template files'], this.subRepoPath);
        }
      } catch {
        /* clone 的空仓库首次 commit 可能无变更，忽略 */
      }
    }

    return {
      coreInit: true,
      alreadyRepo,
      subRepoPath: this.subRepoDir,
      hasUrl: Boolean(this.subRepoUrl),
    };
  }

  /** 写入 constitution.yaml（优先从模板复制） */
  private _writeConstitution() {
    const dest = join(this.coreDir, 'constitution.yaml');
    if (existsSync(dest) && !this.force) {
      return;
    }

    const tmpl = join(REPO_ROOT, 'templates', 'constitution.yaml');
    if (existsSync(tmpl)) {
      copyFileSync(tmpl, dest);
    } else {
      // 内联生成最小宪法（模板文件不可用时的 fallback）
      writeFileSync(
        dest,
        [
          '# Alembic Constitution',
          'version: "2.0"',
          '',
          'capabilities:',
          '  git_write:',
          '    description: "recipes 子仓库 git push 权限"',
          '    probe: "git push --dry-run"',
          '    no_subrepo: "allow"',
          '    no_remote: "allow"',
          '    cache_ttl: 86400',
          '',
          'rules:',
          '  - id: destructive_confirm',
          '    check: "删除操作必须有 confirmed: true"',
          '  - id: content_required',
          '    check: "创建 candidate/recipe 必须提供 code 或 content"',
          '  - id: ai_no_direct_recipe',
          '    check: "AI actor 不能直接创建或批准 Recipe"',
          '  - id: batch_authorized',
          '    check: "批量操作必须有 authorized: true"',
          '',
          'roles:',
          '  - id: "developer"',
          '    name: "Developer"',
          '    permissions: ["*"]',
          '    requires_capability: ["git_write"]',
          '  - id: "contributor"',
          '    name: "Contributor"',
          '    permissions: ["read:recipes", "read:candidates", "read:guard_rules", "read:audit_logs:self"]',
          '  - id: "visitor"',
          '    name: "Visitor"',
          '    permissions: ["read:recipes", "read:guard_rules"]',
          '  - id: "external_agent"',
          '    name: "External Agent"',
          '    permissions: ["read:recipes", "read:guard_rules", "create:candidates", "submit:knowledge"]',
          '  - id: "chat_agent"',
          '    name: "AgentRuntime"',
          '    permissions: ["read:recipes", "read:candidates", "create:candidates", "read:guard_rules"]',
          '',
        ].join('\n')
      );
    }
  }

  /** 写入 boxspec.json */
  private _writeBoxspec() {
    const dest = join(this.coreDir, 'boxspec.json');
    if (existsSync(dest) && !this.force) {
      return;
    }

    writeFileSync(
      dest,
      JSON.stringify(
        {
          name: this.projectName,
          schemaVersion: 2,
          kind: 'root',
          root: true,
          knowledgeBase: { dir: DEFAULT_KNOWLEDGE_BASE_DIR },
          subRepo: { dir: this.subRepoDir },
          module: { rootDir: DEFAULT_KNOWLEDGE_BASE_DIR },
        },
        null,
        2
      )
    );
  }

  /** 复制 _template.md 到 recipes/ */
  private _copyRecipeTemplate() {
    const src = join(REPO_ROOT, 'templates', 'recipes-setup', '_template.md');
    if (!existsSync(src)) {
      return;
    }

    const dest = join(this.recipesDir, '_template.md');
    if (existsSync(dest) && !this.force) {
      return;
    }
    copyFileSync(src, dest);
  }

  /** 复制示例 Recipe（冷启动推荐） */
  private _copySeedRecipes() {
    const seedDir = join(REPO_ROOT, 'templates', 'recipes-setup');
    if (!existsSync(seedDir)) {
      return;
    }

    // 匹配 seed-*.md 文件
    let files: string[];
    try {
      files = readdirSync(seedDir).filter((f) => f.startsWith('seed-') && f.endsWith('.md'));
    } catch {
      return;
    }

    let count = 0;
    for (const file of files) {
      const dest = join(this.recipesDir, file.replace('seed-', ''));
      if (existsSync(dest) && !this.force) {
        continue;
      }
      copyFileSync(join(seedDir, file), dest);
      count++;
    }
    if (count > 0) {
    }
  }

  /** 写入核心目录 README */
  private _writeCoreReadme() {
    const dest = join(this.coreDir, 'README.md');
    if (existsSync(dest) && !this.force) {
      return;
    }

    writeFileSync(
      dest,
      [
        `# ${this.projectName} — Alembic Knowledge Base`,
        '',
        '此目录是项目的 **核心知识库**，`recipes/` 目录存放核心知识数据。',
        '',
        '## 目录结构',
        '',
        '```',
        'Alembic/',
        '├── constitution.yaml   权限宪法（角色 + 权限 + 治理规则 + 能力探测）',
        '├── boxspec.json        项目规格',
        ...(this.subRepoUrl
          ? [
              '├── recipes/            ★ 独立 Git 子仓库 — 统一知识实体（Source of Truth）',
              '│   ├── .git/           独立 git 仓库',
            ]
          : ['├── recipes/            ★ 知识目录 — 统一知识实体（Source of Truth）']),
        '│   ├── _template.md    格式参考',
        '│   └── ...             代码模式/调用链/数据流/约束/风格/...',
        '├── candidates/         候选知识（待审批）',
        '├── skills/             Project Skills（冷启动自动生成 + 手动创建）',
        '│   └── <name>/SKILL.md AI Agent 知识增强文档',
        '└── README.md',
        '```',
        '',
        '## 统一知识模型',
        '',
        '所有知识统一为 **Recipe** 实体，由 `dimensionId` 表示维度归属，`knowledgeType` 表示知识类型：',
        '',
        '| knowledgeType | 说明 |',
        '|---------------|------|',
        '| code-standard | 代码规范 |',
        '| code-pattern | 代码模式 |',
        '| code-relation | 代码关联 |',
        '| inheritance | 继承与接口 |',
        '| call-chain | 调用链路 |',
        '| data-flow | 数据流向 |',
        '| module-dependency | 模块与依赖 |',
        '| architecture | 模式与架构 |',
        '| best-practice | 最佳实践 |',
        '| boundary-constraint | 边界约束（含 Guard 规则） |',
        '| code-style | 代码风格 |',
        '| solution | 问题解决方案 |',
        '',
        '## 权限模型',
        '',
        'Alembic 使用 **三层权限架构**：',
        '',
        '| 层级 | 机制 | 职责 |',
        '|------|------|------|',
        '| ① 能力层 | `git push --dry-run` | 探测 recipes 子仓库物理写权限 |',
        '| ② 角色层 | `constitution.yaml` roles | 角色权限矩阵 (action:resource) |',
        '| ③ 治理层 | `constitution.yaml` priorities | 业务规则引擎 |',
        '',
        'git 权限只是"能力信号"，**最终裁决权在 Constitution YAML**。',
        '',
        ...(this.subRepoUrl
          ? [
              '## 团队协作',
              '',
              '团队成员克隆主仓库后，需额外获取 recipes 子仓库：',
              '',
              '```bash',
              '# 方式 A：git submodule（推荐，自动关联）',
              `git submodule add ${this.subRepoUrl} ${this.subRepoDir}`,
              '',
              '# 方式 B：独立 clone',
              `git clone ${this.subRepoUrl} ${this.subRepoDir}`,
              '```',
            ]
          : [
              '## Recipes 知识库',
              '',
              '`recipes/` 目录随主仓库提交。如需独立管理（团队权限控制），由 IDE 插件适配层提供 recipes 远端配置入口。',
            ]),
        '',
        '> 运行时缓存（DB 索引、Candidates、Snippets、审计日志）在 `.asd/alembic.db`。',
        '> **核心数据的唯一真实来源是 `recipes/` 目录中的文件**，DB 仅做缓存。',
        '',
      ].join('\n')
    );
  }

  /* ═══ Step 3: 数据库初始化 ═══════════════════════════ */

  async stepDatabase() {
    const ConfigLoader = (await import('../infrastructure/config/ConfigLoader.js')).default;
    const Bootstrap = (await import('../bootstrap.js')).default;

    const previousCwd = process.cwd();
    const previousProjectDir = process.env.ALEMBIC_PROJECT_DIR;
    const previousQuiet = process.env.ALEMBIC_QUIET;
    let bootstrap: InstanceType<typeof Bootstrap> | null = null;

    try {
      process.env.ALEMBIC_PROJECT_DIR = this.projectRoot;
      if (this.quiet) {
        process.env.ALEMBIC_QUIET = '1';
      }
      if (resolve(process.cwd()) !== this.projectRoot) {
        process.chdir(this.projectRoot);
      }

      Bootstrap.configurePathGuard(this.projectRoot, this.resolver?.knowledgeBaseDir);

      const env = process.env.NODE_ENV || 'development';
      ConfigLoader.load(env);
      ConfigLoader.set('database.path', '.asd/alembic.db');

      bootstrap = new Bootstrap({ env });
      await bootstrap.initialize();

      const db = bootstrap.components?.db?.getDb?.();
      if (db) {
        // 从子仓库文件同步核心数据到 DB 缓存（统一 Recipe 模型）
        await this._syncRecipesToDB(db);
      }

      return { dbPath: this.dbPath };
    } finally {
      if (bootstrap) {
        await bootstrap.shutdown();
      }
      ConfigLoader.config = null; // 重置静态状态
      if (previousProjectDir === undefined) {
        delete process.env.ALEMBIC_PROJECT_DIR;
      } else {
        process.env.ALEMBIC_PROJECT_DIR = previousProjectDir;
      }
      if (previousQuiet === undefined) {
        delete process.env.ALEMBIC_QUIET;
      } else {
        process.env.ALEMBIC_QUIET = previousQuiet;
      }
      if (resolve(process.cwd()) !== resolve(previousCwd)) {
        process.chdir(previousCwd);
      }
    }
  }

  /**
   * 从 Alembic/recipes/*.md + candidates/*.md 同步到 DB 缓存
   * 委托 KnowledgeSyncService 执行全字段同步（setup 场景跳过违规记录）
   */
  private async _syncRecipesToDB(db: unknown) {
    const { KnowledgeSyncService } = await import('./KnowledgeSyncService.js');
    const syncRoot = this.resolver?.dataRoot ?? this.projectRoot;
    const syncService = new KnowledgeSyncService(syncRoot);
    const report = syncService.sync(db as Parameters<typeof syncService.sync>[0], {
      skipViolations: true,
    });

    if (report.synced > 0) {
    } else {
    }

    if (report.orphaned.length > 0) {
    }
  }

  /* ═══ Helpers ════════════════════════════════════════ */

  /** 在指定目录执行 git 命令 */
  private _git(args: string[], cwd: string) {
    try {
      return execSync(`git ${args.join(' ')}`, {
        cwd,
        stdio: 'pipe',
        encoding: 'utf8',
      }).trim();
    } catch (e: unknown) {
      if (args[0] === 'commit' && (e as { status?: number }).status === 1) {
        return '';
      }
      throw e;
    }
  }

  /** 检查目录中是否有文件（排除 . 和 ..） */
  private _hasFiles(dirPath: string): boolean {
    try {
      const entries = readdirSync(dirPath);
      return entries.length > 0;
    } catch {
      return false;
    }
  }

  /** 确保子仓库的 remote origin 与给定 URL 一致 */
  private _ensureRemote(url: string) {
    try {
      const currentUrl = this._git(['remote', 'get-url', 'origin'], this.subRepoPath);
      if (currentUrl !== url) {
        this._git(['remote', 'set-url', 'origin', url], this.subRepoPath);
      }
    } catch {
      // 没有 origin remote → 添加
      this._git(['remote', 'add', 'origin', url], this.subRepoPath);
    }
  }

  /**
   * 备份已有文件 → clone → 合并回来（不覆盖远端文件）
   * 适用于 recipes/ 有模板文件但还不是 git 仓库的场景
   */
  private _cloneWithMerge(url: string) {
    const backupDir = `${this.subRepoPath}-backup-${Date.now()}`;

    // 1. 备份
    renameSync(this.subRepoPath, backupDir);

    // 2. clone
    try {
      this._git(['clone', url, this.subRepoPath], this.projectRoot);
    } catch (err: unknown) {
      // clone 失败 → 恢复备份
      try {
        renameSync(backupDir, this.subRepoPath);
      } catch {
        /* 尽力恢复 */
      }
      throw err;
    }

    // 3. 合并备份文件到 clone 结果（不覆盖已有文件）
    try {
      const files = readdirSync(backupDir);
      for (const file of files) {
        const dest = join(this.subRepoPath, file);
        if (!existsSync(dest)) {
          cpSync(join(backupDir, file), dest, { recursive: true });
        }
      }
    } catch {
      /* 合并阶段出错不影响 clone 结果 */
    }

    // 4. 清理备份
    try {
      rmSync(backupDir, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响主流程 */
    }
  }

  /* ═══ Step 6: 向量索引初始化 ═══════════════════════════ */

  /**
   * 尝试初始化向量索引: 检查 embedding provider 可用性，
   * 若可用则自动构建初始索引；否则返回插件宿主可展示的提示。
   *
   * 此步骤为 best-effort: 失败不阻塞 setup 流程。
   */
  async stepVectorIndex() {
    try {
      const { getServiceContainer } = await import('../injection/ServiceContainer.js');
      const container = getServiceContainer();

      // 检查 VectorService 是否已注册
      if (!container.services.vectorService) {
        return {
          status: 'skipped',
          reason: 'vectorService 未注册（AI Provider 未配置或容器未完全初始化）',
          hint: '在插件宿主中配置 embedding provider 后重新执行初始化或索引构建',
        };
      }

      const vectorService = container.get('vectorService');

      const stats = await vectorService.getStats();

      // 如果 embedding provider 不可用，提示用户
      if (!stats.embedProviderAvailable) {
        return {
          status: 'skipped',
          reason: '未配置 AI API Key',
          hint: '配置 API Key 后由插件宿主触发向量索引构建',
        };
      }

      // 如果索引已有数据，跳过
      if (stats.count > 0 && !this.force) {
        return {
          status: 'skipped',
          reason: `向量索引已存在 (${stats.count} entries)`,
        };
      }

      // 构建初始索引
      const result = await vectorService.fullBuild({ force: this.force });
      return {
        status: 'done',
        indexed: result.upserted ?? 0,
        skipped: result.skipped ?? 0,
        errors: result.errors ?? 0,
      };
    } catch (err: unknown) {
      // 向量初始化失败不阻塞 setup 流程
      return {
        status: 'warning',
        error: err instanceof Error ? err.message : String(err),
        hint: '可由插件宿主重新触发向量索引构建',
      };
    }
  }
}

export default SetupService;
