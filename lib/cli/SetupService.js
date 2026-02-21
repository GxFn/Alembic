/**
 * SetupService — 项目初始化服务（V2 重构版）
 *
 * 一键初始化 AutoSnippet V2 工作空间，5 步完成：
 *
 *   Step 1  .autosnippet/ 运行时目录 + config.json + .gitignore
 *   Step 2  AutoSnippet/ 子仓库（核心数据 + 权限能力 + skills/）
 *   Step 3  IDE 集成（VSCode MCP + Cursor MCP + copilot-instructions + cursor-rules + skills-template）
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
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** AutoSnippet 源码仓库根目录（定位 templates/ 等资源） */
const REPO_ROOT = resolve(__dirname, '..', '..');
/** V2 子项目根目录（定位 bin/mcp-server.js 等） */
const V2_ROOT = resolve(__dirname, '..', '..');

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

    console.log('');
    console.log(`  ⚙ AutoSnippet Setup — ${this.projectName}`);
    console.log(`  ${'─'.repeat(44)}`);

    for (let i = 0; i < total; i++) {
      const { label, fn } = steps[i];
      const tag = `[${i + 1}/${total}]`;
      process.stdout.write(`  ${tag} ${label}...`);
      try {
        const r = await fn();
        const detail = this._formatStepDetail(r);
        console.log(` ✅${detail}`);
        results.push({ step: i + 1, label, ok: true, ...(r || {}) });
      } catch (err) {
        console.log(` ❌`);
        console.error(`       ${err.message}`);
        results.push({ step: i + 1, label, ok: false, error: err.message });
      }
    }

    this._results = results;
    return results;
  }

  /** @private 格式化步骤结果的简要信息 */
  _formatStepDetail(r) {
    if (!r) return '';
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
    const ok = results.filter((r) => r.ok).length;
    const fail = results.filter((r) => !r.ok).length;

    console.log(`  ${'─'.repeat(44)}`);
    console.log(`  ✨ Setup 完成: ${ok} 成功${fail > 0 ? `, ${fail} 失败` : ''}`);
    console.log('');
    console.log('  后续操作:');
    console.log('    asd coldstart        扫描项目、AI 生成知识库');
    console.log('    asd ui               启动 Dashboard + API Server');
    console.log('    asd watch            启动 Xcode 文件监听');
    console.log('');
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

    // 确保 .autosnippet/ 在主仓库 .gitignore 中
    this._ensureGitignore();

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
          '    name: "ChatAgent"',
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
    const mcpServerPath = join(V2_ROOT, 'bin', 'mcp-server.js');

    this._configureVSCodeMCP(mcpServerPath);
    this._configureCursorMCP(mcpServerPath);
    this._copyCopilotInstructions();
    this._copyCursorRules();
    this._copySkillsTemplate();
    this._mirrorCursorToIDE('.qoder');
    this._mirrorCursorToIDE('.trae');

    const extResult = this._installVSCodeExtension();

    const configured = [
      'vscode-mcp',
      'cursor-mcp',
      'copilot-instructions',
      'cursor-rules',
      'skills-template',
      'qoder-rules',
      'trae-rules',
    ];
    if (extResult) {
      configured.push(...extResult);
    }
    return { configured };
  }

  /**
   * @private 构建 + 安装 VSCode Extension (.vsix)
   *
   * 流程：
   *   1. 编译 TypeScript（tsc）
   *   2. 打包 .vsix（vsce package）
   *   3. 探测所有可用的 VS Code 兼容 IDE CLI
   *   4. 对每个 IDE 执行 --install-extension
   *
   * 支持：VS Code / Cursor / Codex 等基于 VS Code 的 IDE。
   * 找不到任何 IDE CLI 时静默跳过，不阻断 setup 流程。
   *
   * @returns {string[]|null} 安装成功的 IDE 列表, 或 null
   */
  _installVSCodeExtension() {
    const extDir = join(REPO_ROOT, 'resources', 'vscode-ext');
    const pkgJson = join(extDir, 'package.json');

    if (!existsSync(pkgJson)) {
      return null;
    }

    // ── 1. 编译 TypeScript ──
    try {
      execSync('npx tsc -p ./tsconfig.json', { cwd: extDir, stdio: 'pipe' });
    } catch (e) {
      console.error(`   ⚠ VSCode Extension 编译失败: ${e.stderr?.toString().trim() || e.message}`);
      return null;
    }

    // ── 2. 打包 .vsix ──
    let vsixPath;
    try {
      const out = execSync('npx @vscode/vsce package --no-dependencies 2>&1', {
        cwd: extDir,
        stdio: 'pipe',
        encoding: 'utf8',
      });
      // 从输出中提取 vsix 文件路径:  "DONE  Packaged: /path/to/autosnippet-0.1.0.vsix ..."
      const m = out.match(/Packaged:\s*(.+\.vsix)/);
      if (m) {
        vsixPath = m[1].trim();
      }
    } catch (e) {
      console.error(`   ⚠ VSCode Extension 打包失败: ${e.message}`);
      return null;
    }

    // fallback: 扫描目录找 .vsix 文件
    if (!vsixPath || !existsSync(vsixPath)) {
      try {
        const files = readdirSync(extDir).filter((f) => f.endsWith('.vsix'));
        if (files.length > 0) {
          // 取最新的
          files.sort().reverse();
          vsixPath = join(extDir, files[0]);
        }
      } catch {
        /* ignore */
      }
    }

    if (!vsixPath || !existsSync(vsixPath)) {
      console.error('   ⚠ 找不到 .vsix 文件，跳过 Extension 安装');
      return null;
    }

    // ── 3. 探测可用的 IDE CLI ──
    const cliCandidates = this._discoverIDEClis();
    if (cliCandidates.length === 0) {
      console.error('   ⚠ 未找到 VS Code / Cursor 等 IDE CLI，跳过 Extension 安装');
      console.error('     提示: 手动安装 → 在 IDE 中 Cmd+Shift+P → "Install from VSIX"');
      console.error(`     文件: ${vsixPath}`);
      return null;
    }

    // ── 4. 逐个安装 ──
    const installed = [];
    for (const { name, cli } of cliCandidates) {
      try {
        execSync(`"${cli}" --install-extension "${vsixPath}" --force 2>&1`, {
          stdio: 'pipe',
          encoding: 'utf8',
          timeout: 30_000,
        });
        installed.push(`vscode-ext:${name}`);
      } catch (e) {
        console.error(`   ⚠ ${name} Extension 安装失败: ${e.message}`);
      }
    }
    return installed.length > 0 ? installed : null;
  }

  /**
   * @private 探测系统中所有 VS Code 兼容 IDE 的 CLI 路径
   * @returns {{ name: string, cli: string }[]}
   */
  _discoverIDEClis() {
    const candidates = [];

    // 1. PATH 中的命令（跨平台: which → Unix, where → Windows）
    const whichCmd = process.platform === 'win32' ? 'where' : 'which';
    for (const cmd of ['code', 'cursor', 'codex', 'code-insiders']) {
      try {
        const p = execSync(`${whichCmd} ${cmd}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim().split('\n')[0];
        if (p) {
          candidates.push({ name: cmd, cli: p });
        }
      } catch {
        /* not in PATH */
      }
    }

    // 2. 平台特定的 IDE 安装路径
    if (process.platform === 'darwin') {
      // macOS: /Applications/xxx.app/Contents/Resources/app/bin/
      const appPaths = [
        { name: 'vscode', app: '/Applications/Visual Studio Code.app', bin: 'code' },
        { name: 'vscode-insiders', app: '/Applications/Visual Studio Code - Insiders.app', bin: 'code-insiders' },
        { name: 'cursor', app: '/Applications/Cursor.app', bin: 'cursor' },
        { name: 'codex', app: '/Applications/Codex.app', bin: 'codex' },
      ];
      for (const { name, app, bin } of appPaths) {
        const cli = join(app, 'Contents', 'Resources', 'app', 'bin', bin);
        if (existsSync(cli) && !candidates.some((c) => c.name === name)) {
          candidates.push({ name, cli });
        }
      }
    } else if (process.platform === 'win32') {
      // Windows: %LOCALAPPDATA%\Programs\xxx
      const localAppData = process.env.LOCALAPPDATA || join(process.env.USERPROFILE || '', 'AppData', 'Local');
      const winPaths = [
        { name: 'vscode', dir: 'Microsoft VS Code', bin: 'bin/code.cmd' },
        { name: 'vscode-insiders', dir: 'Microsoft VS Code Insiders', bin: 'bin/code-insiders.cmd' },
        { name: 'cursor', dir: 'cursor', bin: 'cursor.exe' },
      ];
      for (const { name, dir, bin } of winPaths) {
        const cli = join(localAppData, 'Programs', dir, bin);
        if (existsSync(cli) && !candidates.some((c) => c.name === name)) {
          candidates.push({ name, cli });
        }
      }
    } else {
      // Linux: 常见安装路径
      const linuxPaths = [
        { name: 'vscode', bin: '/usr/share/code/bin/code' },
        { name: 'vscode', bin: '/usr/bin/code' },
        { name: 'cursor', bin: '/usr/bin/cursor' },
        { name: 'cursor', bin: `${process.env.HOME || ''}/.local/bin/cursor` },
      ];
      for (const { name, bin } of linuxPaths) {
        if (existsSync(bin) && !candidates.some((c) => c.name === name)) {
          candidates.push({ name, cli: bin });
        }
      }
    }

    // 3. 去重（同一个二进制不重复安装）— 使用 Node.js 原生 realpathSync 替代 readlink -f
    const seen = new Set();
    return candidates.filter((c) => {
      let realPath = c.cli;
      try {
        realPath = realpathSync(c.cli);
      } catch {
        /* use as-is */
      }
      if (seen.has(realPath)) return false;
      seen.add(realPath);
      return true;
    });
  }

  /** @private .vscode/mcp.json → VSCode MCP (新标准格式) */
  _configureVSCodeMCP(mcpServerPath) {
    const vscodeDir = join(this.projectRoot, '.vscode');
    const mcpConfigPath = join(vscodeDir, 'mcp.json');
    mkdirSync(vscodeDir, { recursive: true });

    let config = {};
    if (existsSync(mcpConfigPath)) {
      try {
        config = JSON.parse(readFileSync(mcpConfigPath, 'utf8'));
      } catch {
        /* ignore */
      }
    }

    if (!config.servers) {
      config.servers = {};
    }
    config.servers.autosnippet = {
      type: 'stdio',
      command: 'node',
      args: [mcpServerPath],
      env: {
        ASD_PROJECT_DIR: this.projectRoot,
        NODE_PATH: join(V2_ROOT, 'node_modules'),
      },
    };

    writeFileSync(mcpConfigPath, JSON.stringify(config, null, 2));
  }

  /** @private .cursor/mcp.json */
  _configureCursorMCP(mcpServerPath) {
    const cursorDir = join(this.projectRoot, '.cursor');
    const configPath = join(cursorDir, 'mcp.json');
    mkdirSync(cursorDir, { recursive: true });

    let existing = {};
    if (existsSync(configPath)) {
      try {
        existing = JSON.parse(readFileSync(configPath, 'utf8'));
      } catch {
        /* ignore */
      }
    }

    if (!existing.mcpServers) {
      existing.mcpServers = {};
    }
    existing.mcpServers.autosnippet = {
      command: 'node',
      args: [mcpServerPath],
      env: {
        ASD_PROJECT_DIR: this.projectRoot,
        NODE_PATH: join(V2_ROOT, 'node_modules'),
      },
    };

    writeFileSync(configPath, JSON.stringify(existing, null, 2));
  }

  /** @private .github/copilot-instructions.md */
  _copyCopilotInstructions() {
    const src = join(REPO_ROOT, 'templates', 'copilot-instructions.md');
    if (!existsSync(src)) {
      return;
    }

    const destDir = join(this.projectRoot, '.github');
    const dest = join(destDir, 'copilot-instructions.md');
    if (existsSync(dest) && !this.force) {
      return;
    }

    mkdirSync(destDir, { recursive: true });
    copyFileSync(src, dest);
  }

  /** @private .cursor/rules/autosnippet-conventions.mdc */
  _copyCursorRules() {
    const src = join(REPO_ROOT, 'templates', 'cursor-rules', 'autosnippet-conventions.mdc');
    if (!existsSync(src)) {
      return;
    }

    const destDir = join(this.projectRoot, '.cursor', 'rules');
    const dest = join(destDir, 'autosnippet-conventions.mdc');
    if (existsSync(dest) && !this.force) {
      return;
    }

    mkdirSync(destDir, { recursive: true });
    copyFileSync(src, dest);
  }

  /** @private .cursor/rules/autosnippet-skills.mdc — Project Skills 索引模板 */
  _copySkillsTemplate() {
    const src = join(REPO_ROOT, 'templates', 'cursor-rules', 'autosnippet-skills.mdc');
    if (!existsSync(src)) {
      return;
    }

    const destDir = join(this.projectRoot, '.cursor', 'rules');
    const dest = join(destDir, 'autosnippet-skills.mdc');
    if (existsSync(dest) && !this.force) {
      return;
    }

    mkdirSync(destDir, { recursive: true });
    copyFileSync(src, dest);
  }
  /** @private 镜像 .cursor/rules/ 中的 autosnippet-* 文件到目标 IDE 目录（Qoder / Trae 兼容）
   *  只复制 autosnippet- 前缀的文件，不触碰用户自己创建的规则 */
  _mirrorCursorToIDE(targetDirName) {
    const cursorRulesDir = join(this.projectRoot, '.cursor', 'rules');
    if (!existsSync(cursorRulesDir)) {
      return;
    }

    const targetRulesDir = join(this.projectRoot, targetDirName, 'rules');
    mkdirSync(targetRulesDir, { recursive: true });

    // 只镜像 autosnippet- 前缀的文件，保留目标目录中用户已有的其他文件
    const files = readdirSync(cursorRulesDir).filter(
      (f) => (f.endsWith('.mdc') || f.endsWith('.md')) && f.startsWith('autosnippet-')
    );
    for (const file of files) {
      const destName = file.endsWith('.mdc') ? file.replace(/\.mdc$/, '.md') : file;
      copyFileSync(join(cursorRulesDir, file), join(targetRulesDir, destName));
    }
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

  /** @private 确保项目 .gitignore 正确配置 AutoSnippet 相关规则 */
  _ensureGitignore() {
    const giPath = join(this.projectRoot, '.gitignore');
    let content = existsSync(giPath) ? readFileSync(giPath, 'utf8') : '';
    let changed = false;

    // ── v2.4.0 迁移：旧格式 ".autosnippet/" → 新格式 ".autosnippet/*" ──
    // 旧格式会忽略整个目录（git 不遍历内部），导致 skills/ 和 config.json 无法被 negation 恢复
    // 新格式忽略目录内所有文件，允许 negation 模式取消特定子路径
    if (content.includes('.autosnippet/') && !content.includes('.autosnippet/*')) {
      content = content.replace(/^\.autosnippet\/$/m, '.autosnippet/*');
      changed = true;
    }

    // ── 必须忽略：.autosnippet/*（运行时缓存、DB、向量索引、memory） ──
    if (!content.includes('.autosnippet/') && !content.includes('.autosnippet/*')) {
      content += `\n# AutoSnippet 运行时缓存（不入库）\n.autosnippet/*\n`;
      changed = true;
    }

    // ── 必须跟踪：.autosnippet/config.json（项目配置） ──
    if (!content.includes('!.autosnippet/config.json')) {
      content += `!.autosnippet/config.json\n`;
      changed = true;
    }

    // ── 必须忽略：.env（包含 API Key 等敏感信息） ──
    if (!content.includes('.env') || (!content.match(/^\.env$/m) && !content.match(/^\.env\s/m))) {
      content += `\n# AutoSnippet 环境变量（含 API Key，不入库）\n.env\n`;
      changed = true;
    }

    // ── 必须忽略：logs/（winston 运行日志，可达数十 MB） ──
    if (!content.match(/^logs\/?$/m)) {
      content += `\n# AutoSnippet 运行日志\nlogs/\n`;
      changed = true;
    }

    // ── 必须忽略：.autosnippet-drafts/（AI 草稿临时目录） ──
    if (!content.includes('.autosnippet-drafts')) {
      content += `\n# AutoSnippet AI 草稿（临时）\n.autosnippet-drafts/\n`;
      changed = true;
    }

    // ── 必须忽略：_draft_*.md（AI Agent 在项目根目录创建的草稿文件） ──
    if (!content.includes('_draft_*.md')) {
      content += `\n# AutoSnippet AI 草稿文件（项目根目录临时文件）\n_draft_*.md\n`;
      changed = true;
    }

    // ── 必须忽略：常见系统 / 编辑器临时文件 ──
    if (!content.includes('.DS_Store')) {
      content += `\n# macOS 元数据\n.DS_Store\n`;
      changed = true;
    }
    if (!content.includes('nohup.out')) {
      content += `nohup.out\n`;
      changed = true;
    }
    if (!content.match(/\*\.sw[a-p]/)) {
      content += `*.sw[a-p]\n`;
      changed = true;
    }

    // Skills 已迁移到 AutoSnippet/skills/（知识库目录内），自动跟随 Git

    // ── 清理旧版本的 .autosnippet/skills/ negation（已迁移，不再需要）──
    if (content.includes('!.autosnippet/skills/')) {
      content = content.replace(/^!?\.autosnippet\/skills\/.*\n?/gm, '');
      changed = true;
    }

    // ── 必须跟踪：AutoSnippet/（知识库子仓库）──
    // 如果用户误将 AutoSnippet/ 加入忽略，追加 !AutoSnippet/ 取消忽略
    const lines = content.split('\n');
    const hasIgnoreAS = lines.some((l) => {
      const t = l.trim();
      return (
        (t === 'AutoSnippet/' || t === 'AutoSnippet') && !t.startsWith('#') && !t.startsWith('!')
      );
    });
    const hasNegation = lines.some((l) => l.trim() === '!AutoSnippet/');

    if (hasIgnoreAS && !hasNegation) {
      content += `\n# AutoSnippet 知识库必须入库（取消上方忽略）\n!AutoSnippet/\n`;
      changed = true;
    }

    if (changed) {
      writeFileSync(giPath, content);
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
