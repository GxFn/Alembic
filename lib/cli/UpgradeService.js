/**
 * UpgradeService — IDE 集成升级服务
 *
 * 当 AutoSnippet 发布新版本后，老用户执行 `asd upgrade` 即可更新：
 *   ① MCP 配置（.cursor/mcp.json + .vscode/mcp.json）
 *   ② Cursor Skills（.cursor/skills/）
 *   ③ Cursor Rules（.cursor/rules/autosnippet-conventions.mdc + autosnippet-skills.mdc）
 *   ④ Agent Instructions（AGENTS.md + CLAUDE.md + .github/copilot-instructions.md — 通过 Channel F 动态生成）
 *   ⑤ Constitution（AutoSnippet/constitution.yaml）
 *   ⑥ .gitignore（升级规则 + 清理旧版本残留）
 *   ⑦ Skills 路径迁移（.autosnippet/skills/ → AutoSnippet/skills/）
 *
 * 不会重建数据库、子仓库或运行时目录。
 */

import { execSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeCopyFile } from '../service/cursor/FileProtection.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const REPO_ROOT = resolve(__dirname, '..', '..');

export class UpgradeService {
  constructor(options) {
    this.projectRoot = resolve(options.projectRoot);
    this.projectName = this.projectRoot.split('/').pop();
  }

  async run({ skillsOnly = false, mcpOnly = false } = {}) {
    const results = [];

    if (!skillsOnly) {
      results.push(this._upgradeMCP());
    }
    if (!mcpOnly) {
      results.push(this._upgradeSkills());
    }
    if (!skillsOnly && !mcpOnly) {
      results.push(this._upgradeCursorRules());
      // NOTE: .qoder/ .trae/ 不再自动镜像，用户可通过 `asd mirror` 按需同步
      results.push(this._upgradeSkillsTemplate());
      results.push(this._upgradeCopilotInstructions());
      results.push(this._upgradeConstitution());
      results.push(this._upgradeGitignore());
      results.push(this._migrateSkillsPath());
      results.push(this._ensureSkillsDir());
    }

    return results;
  }

  /* ═══ MCP 配置 ══════════════════════════════════════ */

  _upgradeMCP() {
    const mcpServerPath = join(REPO_ROOT, 'bin', 'mcp-server.js');
    const nodePath = join(REPO_ROOT, 'node_modules');

    // Cursor
    this._updateCursorMCP(mcpServerPath, nodePath);
    // VSCode
    this._updateVSCodeMCP(mcpServerPath, nodePath);
  }

  _updateCursorMCP(mcpServerPath, nodePath) {
    const configPath = join(this.projectRoot, '.cursor', 'mcp.json');
    if (!existsSync(configPath)) {
      return;
    }

    let config = {};
    try {
      config = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch {
      /* */
    }
    if (!config.mcpServers) {
      config.mcpServers = {};
    }

    config.mcpServers.autosnippet = {
      command: 'node',
      args: [mcpServerPath],
      env: {
        ASD_PROJECT_DIR: this.projectRoot,
        NODE_PATH: nodePath,
      },
    };

    writeFileSync(configPath, JSON.stringify(config, null, 2));
  }

  _updateVSCodeMCP(mcpServerPath, nodePath) {
    const vscodeDir = join(this.projectRoot, '.vscode');
    const mcpConfigPath = join(vscodeDir, 'mcp.json');

    let config = {};
    if (existsSync(mcpConfigPath)) {
      try {
        config = JSON.parse(readFileSync(mcpConfigPath, 'utf8'));
      } catch {
        /* */
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
        NODE_PATH: nodePath,
      },
    };

    mkdirSync(vscodeDir, { recursive: true });
    writeFileSync(mcpConfigPath, JSON.stringify(config, null, 2));
  }

  /* ═══ Skills ════════════════════════════════════════ */

  _upgradeSkills() {
    const installScript = join(REPO_ROOT, 'scripts', 'install-cursor-skill.js');
    if (!existsSync(installScript)) {
      return;
    }

    try {
      execSync(`node "${installScript}"`, {
        cwd: this.projectRoot,
        stdio: 'inherit',
        env: { ...process.env, NODE_PATH: join(REPO_ROOT, 'node_modules') },
      });
    } catch (e) {
      console.error(`   ❌ Skills 安装失败: ${e.message}`);
    }
  }

  /* ═══ Cursor Rules ══════════════════════════════════ */

  _upgradeCursorRules() {
    const src = join(REPO_ROOT, 'templates', 'cursor-rules', 'autosnippet-conventions.mdc');
    if (!existsSync(src)) {
      return;
    }

    const destDir = join(this.projectRoot, '.cursor', 'rules');
    const dest = join(destDir, 'autosnippet-conventions.mdc');
    mkdirSync(destDir, { recursive: true });
    copyFileSync(src, dest);

    // 动态生成 4 通道交付物料（如 ServiceContainer 已初始化）
    this._triggerCursorDelivery();
  }

  /**
   * 触发 Cursor Delivery Pipeline 动态生成
   * 包含 Channel A-D + Channel F (AGENTS.md / CLAUDE.md / copilot-instructions)
   * 非阻塞 — 失败不影响 upgrade 流程
   */
  _triggerCursorDelivery() {
    import('../injection/ServiceContainer.js')
      .then(({ getServiceContainer }) => {
        const container = getServiceContainer();
        if (container.services.cursorDeliveryPipeline) {
          const pipeline = container.get('cursorDeliveryPipeline');
          pipeline
            .deliver()
            .then((_result) => {})
            .catch((_err) => {
              /* fire-and-forget: delivery failure is non-critical during upgrade */
            });
        }
      })
      .catch(() => {
        // ServiceContainer 未初始化 — 正常（upgrade 可能在无 DB 环境执行）
      });
  }

  /* ═══ Mirror IDE Rules (Qoder / Trae) ═══════════════ */

  /**
   * 镜像 .cursor/rules/ 中的 autosnippet-* 文件到目标 IDE 目录
   * 只触碰 autosnippet- 前缀的文件，保留用户自定义规则
   * @param {string} targetDirName - '.qoder' 或 '.trae'
   */
  _upgradeMirrorIDE(targetDirName) {
    const _label = targetDirName.replace('.', '').charAt(0).toUpperCase() + targetDirName.slice(2);

    // 镜像 .cursor/rules/ 中的 autosnippet-* 文件
    const cursorRulesDir = join(this.projectRoot, '.cursor', 'rules');
    if (!existsSync(cursorRulesDir)) {
      return;
    }

    const targetRulesDir = join(this.projectRoot, targetDirName, 'rules');
    mkdirSync(targetRulesDir, { recursive: true });

    // 只复制 autosnippet- 前缀的文件，不触碰用户自己创建的规则
    const files = readdirSync(cursorRulesDir).filter(
      (f) => (f.endsWith('.mdc') || f.endsWith('.md')) && f.startsWith('autosnippet-')
    );
    for (const file of files) {
      const destName = file.endsWith('.mdc') ? file.replace(/\.mdc$/, '.md') : file;
      copyFileSync(join(cursorRulesDir, file), join(targetRulesDir, destName));
    }

    // 镜像 .cursor/skills/ 中的 autosnippet-* 技能目录
    const cursorSkillsDir = join(this.projectRoot, '.cursor', 'skills');
    if (existsSync(cursorSkillsDir)) {
      const targetSkillsDir = join(this.projectRoot, targetDirName, 'skills');
      mkdirSync(targetSkillsDir, { recursive: true });
      const skillDirs = readdirSync(cursorSkillsDir, { withFileTypes: true }).filter(
        (d) => d.isDirectory() && d.name.startsWith('autosnippet-')
      );
      for (const dir of skillDirs) {
        this._copyDirRecursiveSkill(
          join(cursorSkillsDir, dir.name),
          join(targetSkillsDir, dir.name)
        );
      }
    }
  }

  /** @private 递归复制目录（合并模式，不删除目标已有文件） */
  _copyDirRecursiveSkill(src, dest) {
    mkdirSync(dest, { recursive: true });
    for (const entry of readdirSync(src, { withFileTypes: true })) {
      const srcPath = join(src, entry.name);
      const destPath = join(dest, entry.name);
      if (entry.isDirectory()) {
        this._copyDirRecursiveSkill(srcPath, destPath);
      } else {
        copyFileSync(srcPath, destPath);
      }
    }
  }

  /* ═══ Copilot Instructions (fallback static copy) ══════════════════ */

  /**
   * 静态模板回退 — 当 _triggerCursorDelivery() 无法运行时
   * （无 DB 环境），至少保证有一份基础模板。
   * Channel F 动态生成会覆盖此文件。
   */
  _upgradeCopilotInstructions() {
    const src = join(REPO_ROOT, 'templates', 'copilot-instructions.md');
    if (!existsSync(src)) {
      return;
    }

    const destDir = join(this.projectRoot, '.github');
    const dest = join(destDir, 'copilot-instructions.md');
    mkdirSync(destDir, { recursive: true });
    const { written } = safeCopyFile(src, dest);
    if (!written) {
    }
  }

  /* ═══ Constitution ══════════════════════════════════ */

  _upgradeConstitution() {
    const src = join(REPO_ROOT, 'templates', 'constitution.yaml');
    if (!existsSync(src)) {
      return;
    }

    // 子仓库路径：AutoSnippet/constitution.yaml
    const dest = join(this.projectRoot, 'AutoSnippet', 'constitution.yaml');
    if (!existsSync(join(this.projectRoot, 'AutoSnippet'))) {
      return;
    }

    // 如果目标已存在，备份旧版本
    if (existsSync(dest)) {
      const oldContent = readFileSync(dest, 'utf8');
      const newContent = readFileSync(src, 'utf8');
      if (oldContent === newContent) {
        return;
      }
      const backupPath = `${dest}.bak`;
      copyFileSync(dest, backupPath);
    }

    copyFileSync(src, dest);

    // 如果子仓库是 git 仓库，提示用户提交
    const gitDir = join(this.projectRoot, 'AutoSnippet', '.git');
    if (existsSync(gitDir)) {
    }
  }
  /* ═══ Skills Template ════════════════════════════════ */

  _upgradeSkillsTemplate() {
    const src = join(REPO_ROOT, 'templates', 'cursor-rules', 'autosnippet-skills.mdc');
    if (!existsSync(src)) {
      return;
    }

    const destDir = join(this.projectRoot, '.cursor', 'rules');
    const dest = join(destDir, 'autosnippet-skills.mdc');
    mkdirSync(destDir, { recursive: true });
    copyFileSync(src, dest);
  }

  /* ═══ .gitignore ════════════════════════════════════ */

  _upgradeGitignore() {
    const giPath = join(this.projectRoot, '.gitignore');
    if (!existsSync(giPath)) {
      return;
    }

    let content = readFileSync(giPath, 'utf8');
    let changed = false;

    // v2.4.0 迁移：旧格式 ".autosnippet/" → 新格式 ".autosnippet/*"
    if (content.includes('.autosnippet/') && !content.includes('.autosnippet/*')) {
      content = content.replace(/^\.autosnippet\/$/m, '.autosnippet/*');
      changed = true;
    }

    // 确保有 .autosnippet/*
    if (!content.includes('.autosnippet/') && !content.includes('.autosnippet/*')) {
      content += `\n# AutoSnippet 运行时缓存（不入库）\n.autosnippet/*\n`;
      changed = true;
    }

    // 确保 config.json 跟踪
    if (!content.includes('!.autosnippet/config.json')) {
      content += `!.autosnippet/config.json\n`;
      changed = true;
    }

    // 清理旧版本的 .autosnippet/skills/ negation（已迁移到 AutoSnippet/skills/）
    if (content.includes('!.autosnippet/skills/')) {
      content = content.replace(/^!?\.autosnippet\/skills\/.*\n?/gm, '');
      changed = true;
    }

    // ── v2.8.1: 新增缺失的 gitignore 规则 ──

    // _draft_*.md — AI Agent 在项目根目录创建的草稿文件
    if (!content.includes('_draft_*.md')) {
      content += `\n# AutoSnippet AI 草稿文件（项目根目录临时文件）\n_draft_*.md\n`;
      changed = true;
    }

    // .DS_Store — macOS 元数据
    if (!content.includes('.DS_Store')) {
      content += `\n# macOS 元数据\n.DS_Store\n`;
      changed = true;
    }

    // nohup.out — 后台进程输出
    if (!content.includes('nohup.out')) {
      content += `nohup.out\n`;
      changed = true;
    }

    // *.sw[a-p] — vim swap 文件
    if (!content.match(/\*\.sw\[a-p\]/)) {
      content += `*.sw[a-p]\n`;
      changed = true;
    }

    // .autosnippet-drafts/ — AI 草稿目录
    if (!content.includes('.autosnippet-drafts')) {
      content += `\n# AutoSnippet AI 草稿（临时）\n.autosnippet-drafts/\n`;
      changed = true;
    }

    // .env — 环境变量
    if (!content.includes('.env') || (!content.match(/^\.env$/m) && !content.match(/^\.env\s/m))) {
      content += `\n# AutoSnippet 环境变量（含 API Key，不入库）\n.env\n`;
      changed = true;
    }

    // logs/ — 运行日志
    if (!content.match(/^logs\/?$/m)) {
      content += `\n# AutoSnippet 运行日志\nlogs/\n`;
      changed = true;
    }

    // 确保 AutoSnippet/ 不被忽略
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
    } else {
    }
  }

  /* ═══ Skills 路径迁移 ═══════════════════════════════ */

  _migrateSkillsPath() {
    const oldSkillsDir = join(this.projectRoot, '.autosnippet', 'skills');
    const newSkillsDir = join(this.projectRoot, 'AutoSnippet', 'skills');

    if (!existsSync(oldSkillsDir)) {
      return;
    }
    if (!existsSync(join(this.projectRoot, 'AutoSnippet'))) {
      return;
    }

    try {
      mkdirSync(newSkillsDir, { recursive: true });
      const entries = readdirSync(oldSkillsDir, { withFileTypes: true });
      let migrated = 0;

      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        const src = join(oldSkillsDir, entry.name);
        const dest = join(newSkillsDir, entry.name);
        if (existsSync(dest)) {
          continue;
        }
        // 复制目录
        execSync(`cp -r "${src}" "${dest}"`, { stdio: 'pipe' });
        migrated++;
      }

      if (migrated > 0) {
      } else {
      }
    } catch (e) {
      console.error(`   ❌ 迁移失败: ${e.message}`);
    }
  }

  /* ═══ 确保 Skills 目录存在 ══════════════════════════ */

  _ensureSkillsDir() {
    const skillsDir = join(this.projectRoot, 'AutoSnippet', 'skills');
    if (!existsSync(join(this.projectRoot, 'AutoSnippet'))) {
      return;
    }
    if (existsSync(skillsDir)) {
      return;
    }

    mkdirSync(skillsDir, { recursive: true });
  }
}

export default UpgradeService;
