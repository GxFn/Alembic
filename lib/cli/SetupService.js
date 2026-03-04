/**
 * SetupService — 项目初始化服务（V2 重构版）
 *
 * 一键初始化 AutoSnippet V2 工作空间，5 步完成：
 *
 *   Step 1  .autosnippet/ 运行时目录 + config.json + .gitignore
 *   Step 2  AutoSnippet/ 子仓库（核心数据 + 权限能力 + skills/）
 *   Step 3  IDE 集成（VSCode MCP + Cursor MCP + copilot-instructions + cursor-rules
 *           + skills-template + cursor-workflow + claude-hooks + guard-ci + pre-commit-hook）
 *   Step 4  SQLite 数据库 + V1 数据迁移
 *   Step 5  平台相关初始化（macOS → Xcode Snippets）
 *
 * ═══════════════════════════════════════════════════════════
 *
 * 数据架构（核心数据在子仓库，受 git 权限保护）
 * ─────────────────────────────────────────────
 *   AutoSnippet/  (Git 子仓库 = 唯一真实来源 Source of Truth)
 *     ├─ constitution.yaml    权限宪法：角色 + 权限矩阵 + 治理规则 + 能力探测
 *     ├─ boxspec.json         项目规格定义
 *     ├─ recipes/*.md         统一知识实体（代码规范/模式/架构/调用链/数据流/...）
 *     ├─ skills/             Project Skills（冷启动自动生成 + 手动创建）
 *     └─ README.md
 *
 *   .autosnippet/  (运行时缓存，gitignored)
 *     ├─ config.json          项目配置
 *     ├─ autosnippet.db       SQLite 运行时缓存（从子仓库同步 + candidates/snippets/audit）
 *     ├─ context/             向量索引缓存
 *     └─ logs/                运行日志
 *
 * 数据流
 * ─────
 *   写入：编辑子仓库文件 → git push（需权限）→ asd sync → 更新 DB 缓存
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
  existsSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileDeployer } from './deploy/FileDeployer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** AutoSnippet 源码仓库根目录（定位 templates/ 等资源） */
const REPO_ROOT = resolve(__dirname, '..', '..');

// ─────────────────────────────────────────────────────

export class SetupService {
  /**
   * @param {{ projectRoot: string, force?: boolean }} options
   */
  constructor(options) {
    this.projectRoot = resolve(options.projectRoot);
    this.projectName = this.projectRoot.split('/').pop();
    this.force = options.force || false;
    this.seed = options.seed || false;

    // 运行时目录（gitignored）
    this.runtimeDir = join(this.projectRoot, '.autosnippet');
    this.dbPath = join(this.runtimeDir, 'autosnippet.db');

    // 核心数据目录（子仓库）
    this.coreDir = join(this.projectRoot, 'AutoSnippet');
    this.recipesDir = join(this.coreDir, 'recipes');
    this.candidatesDir = join(this.coreDir, 'candidates');
    this.skillsDir = join(this.coreDir, 'skills');
  }

  /* ═══ 公共入口 ═══════════════════════════════════════ */

  getSteps() {
    return [
      { label: '创建运行时目录与配置', fn: () => this.stepRuntime() },
      { label: '初始化核心数据子仓库', fn: () => this.stepCoreRepo() },
      { label: '配置 IDE 集成', fn: () => this.stepIDE() },
      { label: '初始化数据库', fn: () => this.stepDatabase() },
      { label: '平台相关初始化', fn: () => this.stepPlatform() },
    ];
  }

  async run() {
    const steps = this.getSteps();
    const results = [];
    const total = steps.length;

    for (let i = 0; i < total; i++) {
      const { label, fn } = steps[i];
      const tag = `[${i + 1}/${total}]`;
      process.stdout.write(`  ${tag} ${label}...`);
      try {
        const r = await fn();
        const _detail = this._formatStepDetail(r);
        results.push({ step: i + 1, label, ok: true, ...(r || {}) });
      } catch (err) {
        console.error(`       ${err.message}`);
        results.push({ step: i + 1, label, ok: false, error: err.message });
      }
    }

    this._results = results;
    return results;
  }

  /** @private 格式化步骤结果的简要信息 */
  _formatStepDetail(r) {
    if (!r) {
      return '';
    }
    const parts = [];
    if (r.configured) {
      parts.push(r.configured.join(', '));
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
    const results = this._results || [];
    const _ok = results.filter((r) => r.ok).length;
    const _fail = results.filter((r) => !r.ok).length;
  }

  /* ═══ Step 1: 运行时目录与配置 ═══════════════════════ */

  stepRuntime() {
    mkdirSync(this.runtimeDir, { recursive: true });

    // config.json
    const configPath = join(this.runtimeDir, 'config.json');
    if (existsSync(configPath) && !this.force) {
    } else {
      const config = {
        version: 2,
        projectName: this.projectName,
        database: this.dbPath,
        core: {
          dir: 'AutoSnippet',
          constitution: 'AutoSnippet/constitution.yaml',
        },
        ai: { provider: process.env.ASD_AI_PROVIDER || 'auto' },
        guard: { enabled: true },
        watch: {
          enabled: false,
          paths: ['Sources', 'src'],
          extensions: ['.swift', '.m', '.h'],
        },
      };
      writeFileSync(configPath, JSON.stringify(config, null, 2));
    }

    // .env — AI 配置模板
    this._ensureEnvFile();

    return { created: 'runtime' };
  }

  /* ═══ Step 2: 核心数据子仓库 ═════════════════════════ */

  stepCoreRepo() {
    const coreGit = join(this.coreDir, '.git');
    const alreadyRepo = existsSync(coreGit);

    // 创建目录结构
    for (const d of [this.coreDir, this.recipesDir, this.candidatesDir, this.skillsDir]) {
      mkdirSync(d, { recursive: true });
    }

    // 初始化 git（如果还不是 git 仓库）
    if (!alreadyRepo) {
      this._git(['init'], this.coreDir);
    } else {
    }

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

    // .gitignore（子仓库自身）
    const giPath = join(this.coreDir, '.gitignore');
    if (!existsSync(giPath)) {
      writeFileSync(giPath, '.DS_Store\n*.swp\n');
    }

    // 初始提交
    if (!alreadyRepo) {
      this._git(['add', '.'], this.coreDir);
      this._git(['commit', '-m', 'Init AutoSnippet knowledge base'], this.coreDir);
    }

    return { coreInit: true, alreadyRepo };
  }

  /** @private 写入 constitution.yaml（优先从模板复制） */
  _writeConstitution() {
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
          '# AutoSnippet Constitution',
          'version: "2.0"',
          '',
          'capabilities:',
          '  git_write:',
          '    description: "子仓库 git push 权限"',
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

  /** @private 写入 boxspec.json */
  _writeBoxspec() {
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
          knowledgeBase: { dir: 'AutoSnippet' },
          module: { rootDir: 'AutoSnippet' },
        },
        null,
        2
      )
    );
  }

  /** @private 复制 _template.md 到 recipes/ */
  _copyRecipeTemplate() {
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

  /** @private 复制示例 Recipe（冷启动推荐） */
  _copySeedRecipes() {
    const seedDir = join(REPO_ROOT, 'templates', 'recipes-setup');
    if (!existsSync(seedDir)) {
      return;
    }

    // 匹配 seed-*.md 文件
    let files;
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

  /** @private 写入核心目录 README */
  _writeCoreReadme() {
    const dest = join(this.coreDir, 'README.md');
    if (existsSync(dest) && !this.force) {
      return;
    }

    writeFileSync(
      dest,
      [
        `# ${this.projectName} — AutoSnippet Knowledge Base`,
        '',
        '此目录是项目的 **核心知识库**，通过 Git 子仓库管理，同时承载数据存储与权限控制。',
        '',
        '## 目录结构',
        '',
        '```',
        'AutoSnippet/',
        '├── constitution.yaml   权限宪法（角色 + 权限 + 治理规则 + 能力探测）',
        '├── boxspec.json        项目规格',
        '├── recipes/            统一知识实体（Markdown + YAML front-matter）',
        '│   ├── _template.md    格式参考',
        '│   ├── naming-rules.md 代码规范示例',
        '│   ├── mvvm-arch.md    架构模式示例',
        '│   └── ...             代码模式/调用链/数据流/约束/风格/...',
        '├── skills/             Project Skills（冷启动自动生成 + 手动创建）',
        '│   └── <name>/SKILL.md AI Agent 知识增强文档',
        '└── README.md',
        '```',
        '',
        '## 统一知识模型',
        '',
        '所有知识统一为 **Recipe** 实体，由 `knowledgeType` 区分维度：',
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
        'AutoSnippet 使用 **三层权限架构**：',
        '',
        '| 层级 | 机制 | 职责 |',
        '|------|------|------|',
        '| ① 能力层 | `git push --dry-run` | 探测子仓库物理写权限 |',
        '| ② 角色层 | `constitution.yaml` roles | 角色权限矩阵 (action:resource) |',
        '| ③ 治理层 | `constitution.yaml` priorities | 业务规则引擎 |',
        '',
        'git 权限只是"能力信号"，**最终裁决权在 Constitution YAML**。',
        '',
        '## 团队使用',
        '',
        '```bash',
        '# 方式 1: 添加远程仓库',
        'cd AutoSnippet',
        'git remote add origin <your-repo-url>',
        '',
        '# 方式 2: 使用 git submodule（推荐）',
        'cd ..',
        'rm -rf AutoSnippet',
        'git submodule add <your-repo-url> AutoSnippet',
        '```',
        '',
        '> 运行时缓存（DB 索引、Candidates、Snippets、审计日志）在 `.autosnippet/autosnippet.db`。',
        '> **核心数据的唯一真实来源是此目录中的文件**，DB 仅做缓存。修改 Recipe/Guard 规则必须通过 git。',
        '',
      ].join('\n')
    );
  }

  /* ═══ Step 3: IDE 集成 ═══════════════════════════════ */

  stepIDE() {
    const deployer = new FileDeployer({
      projectRoot: this.projectRoot,
      force: this.force,
    });
    const { deployed, skipped, errors } = deployer.deployAll('setup');

    if (errors.length > 0) {
      for (const { id, error } of errors) {
        console.error(`   ⚠ ${id}: ${error}`);
      }
    }

    return { configured: deployed };
  }

  /* ═══ Step 4: 数据库初始化 ═══════════════════════════ */

  async stepDatabase() {
    const ConfigLoader = (await import('../infrastructure/config/ConfigLoader.js')).default;
    const Bootstrap = (await import('../bootstrap.js')).default;

    const env = process.env.NODE_ENV || 'development';
    ConfigLoader.load(env);
    ConfigLoader.set('database.path', this.dbPath);

    const bootstrap = new Bootstrap({ env });
    await bootstrap.initialize();

    const db = bootstrap.components?.db?.getDb?.();
    if (db) {
      // 从子仓库文件同步核心数据到 DB 缓存（统一 Recipe 模型）
      await this._syncRecipesToDB(db);
    }

    await bootstrap.shutdown();
    ConfigLoader.config = null; // 重置静态状态
    return { dbPath: this.dbPath };
  }

  /**
   * @private 从 AutoSnippet/recipes/*.md + candidates/*.md 同步到 DB 缓存
   * 委托 KnowledgeSyncService 执行全字段同步（setup 场景跳过违规记录）
   */
  async _syncRecipesToDB(db) {
    const { KnowledgeSyncService } = await import('./KnowledgeSyncService.js');
    const syncService = new KnowledgeSyncService(this.projectRoot);
    const report = syncService.sync(db, { skipViolations: true });

    if (report.synced > 0) {
    } else {
    }

    if (report.orphaned.length > 0) {
    }
  }

  /* ═══ Step 5: Snippet 初始化 (Xcode + VSCode) ═══════ */

  async stepPlatform() {
    const initScript = join(REPO_ROOT, 'scripts', 'init-snippets.js');
    if (!existsSync(initScript)) {
      return { skipped: true };
    }

    try {
      const mod = await import(initScript);
      const initFn = mod.initialize || mod.default?.initialize || mod.default;
      if (typeof initFn !== 'function') {
        return { skipped: true };
      }

      const result = await initFn(this.projectRoot, 'all');
      return result;
    } catch (e) {
      console.warn(`   ⚠️  Snippet 初始化失败：${e.message}`);
      return { error: e.message };
    }
  }

  /* ═══ Helpers ════════════════════════════════════════ */

  /**
   * @private 在项目根目录创建 .env 文件（从 .env.example 复制）
   * 如果 .env 已存在则跳过并提示用户手动配置。
   */
  _ensureEnvFile() {
    const envPath = join(this.projectRoot, '.env');
    if (existsSync(envPath)) {
      return;
    }

    const examplePath = join(REPO_ROOT, '.env.example');
    if (existsSync(examplePath)) {
      copyFileSync(examplePath, envPath);
    } else {
      // fallback: .env.example 缺失时写入最小模板
      writeFileSync(
        envPath,
        [
          '# AutoSnippet AI 配置（由 asd setup 自动生成）',
          '# 完整配置说明见 .env.example',
          '',
          'ASD_AI_PROVIDER=google',
          'ASD_AI_MODEL=gemini-3-flash-preview',
          '# ASD_GOOGLE_API_KEY=',
          '',
        ].join('\n')
      );
    }
  }

  /** @private 在指定目录执行 git 命令 */
  _git(args, cwd) {
    try {
      return execSync(`git ${args.join(' ')}`, {
        cwd,
        stdio: 'pipe',
        encoding: 'utf8',
      }).trim();
    } catch (e) {
      if (args[0] === 'commit' && e.status === 1) {
        return '';
      }
      throw e;
    }
  }
}

export default SetupService;
