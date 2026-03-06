/**
 * FileDeployer — 统一文件部署引擎
 *
 * 根据 FileManifest 中的策略，部署文件到用户项目。
 * SetupService 和 UpgradeService 共享此引擎，消除所有重复代码。
 *
 * 策略实现：
 *   overwrite        — mkdirSync + copyFileSync
 *   overwrite-dir    — 递归复制目录中的所有文件
 *   signature-safe   — safeCopyFile（签名匹配才覆盖）
 *   create-only      — 仅在文件不存在时复制
 *   merge-json       — 读取现有 JSON，合并 autosnippet 键，写回
 *   merge-gitignore  — 增量追加缺失规则 + 迁移旧格式
 *   backup-overwrite — 备份旧文件再覆盖
 *   inject-marker    — 在 <!-- autosnippet:begin/end --> 标记间注入
 *   generate         — 调用自定义生成函数
 */

import { execSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkWriteSafety, safeCopyFile } from '../../service/cursor/FileProtection.js';
import { injectAutoApprove } from '../../external/mcp/autoApproveInjector.js';
import {
  MANIFEST,
  GITIGNORE_RULES,
  GITIGNORE_MIGRATIONS,
  buildMcpServerEntry,
} from './FileManifest.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** AutoSnippet 源码仓库根目录 */
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const TEMPLATES_DIR = join(REPO_ROOT, 'templates');

export class FileDeployer {
  force: any;
  projectName: any;
  projectRoot: any;
  /**
   * @param {{ projectRoot: string, force?: boolean }} options
   */
  constructor({ projectRoot, force = false }) {
    this.projectRoot = resolve(projectRoot);
    this.projectName = this.projectRoot.split('/').pop();
    this.force = force;
  }

  /* ═══ 公共入口 ═══════════════════════════════════════ */

  /**
   * 部署所有适用的文件
   * @param {'setup'|'upgrade'} mode
   * @param {{ filter?: string[] }} options 可选过滤部署的 category
   * @returns {{ deployed: string[], skipped: string[], errors: Array<{id: string, error: string}> }}
   */
  // @ts-expect-error TS migration: TS2339
  deployAll(mode, { filter } = {}) {
    const applicable = MANIFEST.filter((entry) => {
      if (entry.on !== 'both' && entry.on !== mode) return false;
      if (filter && !filter.includes(entry.category)) return false;
      return true;
    });

    const deployed = [];
    const skipped = [];
    const errors = [];

    for (const entry of applicable) {
      try {
        const result = this._deployOne(entry, mode);
        if (result) {
          deployed.push(entry.id);
        } else {
          skipped.push(entry.id);
        }
      } catch (err: any) {
        errors.push({ id: entry.id, error: err.message });
      }
    }

    return { deployed, skipped, errors };
  }

  /**
   * 按 category 部署
   * @param {string} category
   * @param {'setup'|'upgrade'} mode
   */
  deployCategory(category, mode) {
    return this.deployAll(mode, { filter: [category] });
  }

  /* ═══ 单文件部署路由 ═════════════════════════════════ */

  /**
   * @param {object} entry - Manifest 条目
   * @param {'setup'|'upgrade'} mode
   * @returns {boolean} 是否实际写入了文件
   */
  _deployOne(entry, mode) {
    switch (entry.strategy) {
      case 'overwrite':
        return this._strategyOverwrite(entry);
      case 'overwrite-dir':
        return this._strategyOverwriteDir(entry);
      case 'signature-safe':
        return this._strategySignatureSafe(entry, mode);
      case 'create-only':
        return this._strategyCreateOnly(entry);
      case 'merge-json':
        return this._strategyMergeJson(entry);
      case 'merge-gitignore':
        return this._strategyMergeGitignore(entry);
      case 'backup-overwrite':
        return this._strategyBackupOverwrite(entry);
      case 'inject-marker':
        return this._strategyInjectMarker(entry);
      case 'generate':
        return this._strategyGenerate(entry);
      default:
        throw new Error(`Unknown deploy strategy: ${entry.strategy}`);
    }
  }

  /* ═══ 策略实现 ═══════════════════════════════════════ */

  /** overwrite — AutoSnippet 完全拥有，始终覆盖 */
  _strategyOverwrite(entry) {
    const src = join(TEMPLATES_DIR, entry.src);
    if (!existsSync(src)) return false;

    const dest = join(this.projectRoot, entry.dest);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    if (entry.chmod) this._chmodExec(dest);
    return true;
  }

  /** overwrite-dir — 递归覆盖目录 */
  _strategyOverwriteDir(entry) {
    const srcDir = join(TEMPLATES_DIR, entry.src);
    if (!existsSync(srcDir)) return false;

    const destDir = join(this.projectRoot, entry.dest);
    const copied = this._copyDirRecursive(srcDir, destDir, entry.chmod);

    // 清理旧文件
    if (entry.cleanup) {
      for (const rel of entry.cleanup) {
        const old = join(this.projectRoot, rel);
        if (existsSync(old)) {
          try { unlinkSync(old); } catch { /* ignore */ }
        }
      }
    }

    return copied;
  }

  /** signature-safe — 有 AutoSnippet 签名才覆盖 */
  _strategySignatureSafe(entry, mode) {
    const src = join(TEMPLATES_DIR, entry.src);
    if (!existsSync(src)) return false;

    const dest = join(this.projectRoot, entry.dest);
    mkdirSync(dirname(dest), { recursive: true });

    // setup + 不存在 → 直接复制
    if (mode === 'setup' && !existsSync(dest)) {
      copyFileSync(src, dest);
      return true;
    }

    // setup + 已存在 + 非 force → 尝试签名覆盖
    if (mode === 'setup' && existsSync(dest) && !this.force) {
      const { canWrite } = checkWriteSafety(dest);
      if (!canWrite) {
        // 签名保护失败 → 尝试 fallback 策略
        if (entry.fallback === 'inject-marker') {
          return this._strategyInjectMarker(entry);
        }
        return false;
      }
      copyFileSync(src, dest);
      return true;
    }

    // upgrade 或 force → safeCopyFile
    const { written } = safeCopyFile(src, dest);
    if (!written && entry.fallback === 'inject-marker') {
      return this._strategyInjectMarker(entry);
    }
    return written;
  }

  /** create-only — 仅在不存在时创建 */
  _strategyCreateOnly(entry) {
    let dest;
    if (entry.resolveDest) {
      dest = this._resolvers[entry.resolveDest]?.call(this);
      if (!dest) return false;
    } else {
      dest = join(this.projectRoot, entry.dest);
    }

    if (existsSync(dest) && !this.force) return false;

    const { canWrite } = checkWriteSafety(dest);
    if (!canWrite) return false;

    const src = join(TEMPLATES_DIR, entry.src);
    if (!existsSync(src)) return false;

    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    if (entry.chmod) this._chmodExec(dest);
    return true;
  }

  /** merge-json — 读取现有 JSON，合并 autosnippet 键 */
  _strategyMergeJson(entry) {
    const dest = join(this.projectRoot, entry.dest);
    mkdirSync(dirname(dest), { recursive: true });

    let config = {};
    if (existsSync(dest)) {
      try { config = JSON.parse(readFileSync(dest, 'utf8')); } catch { /* */ }
    }

    const parentKey = entry.jsonKey;
    if (!config[parentKey]) config[parentKey] = {};

    const ide = entry.id === 'vscode-mcp' ? 'vscode' : 'cursor';
    config[parentKey].autosnippet = buildMcpServerEntry(this.projectRoot, ide);

    writeFileSync(dest, JSON.stringify(config, null, 2));
    return true;
  }

  /** merge-gitignore — 增量追加规则 + 迁移旧格式 */
  _strategyMergeGitignore(_entry) {
    const giPath = join(this.projectRoot, '.gitignore');
    let content = existsSync(giPath) ? readFileSync(giPath, 'utf8') : '';
    let changed = false;

    // 1. 迁移旧格式
    for (const migration of GITIGNORE_MIGRATIONS) {
      if (migration.find.test(content)) {
        content = content.replace(migration.find, migration.replace);
        changed = true;
      }
    }

    // 2. 追加缺失规则
    for (const rule of GITIGNORE_RULES) {
      const pattern = rule.pattern;
      // 对 negation 规则 (!xxx) 检查原模式
      const checkStr = rule.negation ? pattern : pattern.replace(/[[\]*?]/g, '\\$&');
      if (!content.includes(pattern)) {
        const prefix = rule.comment ? `\n# ${rule.comment}\n` : '';
        content += `${prefix}${pattern}\n`;
        changed = true;
      }
    }

    // 3. 确保 AutoSnippet/ 不被忽略
    const lines = content.split('\n');
    const hasIgnoreAS = lines.some((l) => {
      const t = l.trim();
      return (t === 'AutoSnippet/' || t === 'AutoSnippet') && !t.startsWith('#') && !t.startsWith('!');
    });
    if (hasIgnoreAS && !lines.some((l) => l.trim() === '!AutoSnippet/')) {
      content += `\n# AutoSnippet 知识库必须入库（取消上方忽略）\n!AutoSnippet/\n`;
      changed = true;
    }

    if (changed) {
      writeFileSync(giPath, content);
    }
    return changed;
  }

  /** backup-overwrite — 备份旧文件后覆盖 */
  _strategyBackupOverwrite(entry) {
    const src = join(TEMPLATES_DIR, entry.src);
    if (!existsSync(src)) return false;

    // 需要目标目录存在
    if (entry.requireDir) {
      const reqDir = join(this.projectRoot, entry.requireDir);
      if (!existsSync(reqDir)) return false;
    }

    const dest = join(this.projectRoot, entry.dest);

    if (existsSync(dest)) {
      const oldContent = readFileSync(dest, 'utf8');
      const newContent = readFileSync(src, 'utf8');
      if (oldContent === newContent) return false; // 无变化
      copyFileSync(dest, `${dest}.bak`); // 备份
    }

    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    return true;
  }

  /** inject-marker — 在 autosnippet:begin/end 标记间注入 */
  _strategyInjectMarker(entry) {
    const BEGIN_MARKER = '<!-- autosnippet:begin -->';
    const END_MARKER = '<!-- autosnippet:end -->';

    const src = join(TEMPLATES_DIR, entry.src);
    if (!existsSync(src)) return false;

    const templateContent = readFileSync(src, 'utf8');
    const beginIdx = templateContent.indexOf(BEGIN_MARKER);
    const endIdx = templateContent.indexOf(END_MARKER);
    if (beginIdx === -1 || endIdx === -1) return false;

    const snippet = templateContent.slice(beginIdx, endIdx + END_MARKER.length);
    const dest = join(this.projectRoot, entry.dest);
    const destDir = dirname(dest);
    mkdirSync(destDir, { recursive: true });

    if (existsSync(dest)) {
      const existing = readFileSync(dest, 'utf8');
      if (existing.includes(BEGIN_MARKER)) {
        // 替换现有段落
        const updated = existing.replace(
          new RegExp(`${BEGIN_MARKER}[\\s\\S]*?${END_MARKER}`),
          snippet,
        );
        writeFileSync(dest, updated);
        return true;
      }
      // 追加到末尾
      writeFileSync(dest, `${existing}\n\n${snippet}\n`);
      return true;
    }

    writeFileSync(dest, `${snippet}\n`);
    return true;
  }

  /** generate — 自定义生成逻辑 */
  _strategyGenerate(entry) {
    const fn = this._generators[entry.generate];
    if (!fn) {
      throw new Error(`Unknown generator: ${entry.generate}`);
    }
    return fn.call(this);
  }

  /* ═══ 自定义生成器 ═══════════════════════════════════ */

  _generators = {
    /** AGENTS.md 静态骨架 */
    generateAgentsMd() {
      const claudePath = join(this.projectRoot, 'CLAUDE.md');
      if (existsSync(claudePath)) return false; // 有 CLAUDE.md 时跳过

      const agentsPath = join(this.projectRoot, 'AGENTS.md');
      if (existsSync(agentsPath) && !this.force) return false;

      const { canWrite } = checkWriteSafety(agentsPath);
      if (!canWrite) return false;

      const content = [
        `# ${this.projectName} — Agent Instructions`,
        '',
        '> Auto-generated by AutoSnippet.',
        '',
        '## AutoSnippet Integration',
        '',
        'This project uses **AutoSnippet** for knowledge management and decision tracking.',
        '',
        '### MCP Tools',
        '',
        '- `autosnippet_search` — Search knowledge',
        '- `autosnippet_knowledge` — Browse/get recipes',
        '- `autosnippet_submit_knowledge` — Submit candidate',
        '- `autosnippet_guard` — Code compliance check',
        '- `autosnippet_health` — Service health & KB stats',
        '- `autosnippet_task` — Unified task & decision management (prime/create/claim/close/record_decision/revise_decision/unpin_decision/list_decisions)',
        '',
        '### VS Code Agent Mode',
        '',
        'Type `#asd` before your message in Agent Mode to activate project memory.',
        '',
        '### Constraints',
        '',
        '1. Do NOT modify knowledge base files directly.',
        '2. Create or update knowledge only through MCP tools.',
        '',
      ].join('\n');

      writeFileSync(agentsPath, content);
      return true;
    },

    /** 安装 Cursor Skills */
    installSkills() {
      const installScript = join(REPO_ROOT, 'scripts', 'install-cursor-skill.js');
      if (!existsSync(installScript)) return false;

      try {
        execSync(`node "${installScript}"`, {
          cwd: this.projectRoot,
          stdio: 'pipe',
          env: { ...process.env, NODE_PATH: join(REPO_ROOT, 'node_modules') },
        });
        return true;
      } catch {
        return false;
      }
    },

    /** 确保 AutoSnippet/skills/ 目录存在 */
    ensureSkillsDir() {
      const autoDir = join(this.projectRoot, 'AutoSnippet');
      if (!existsSync(autoDir)) return false;

      const skillsDir = join(autoDir, 'skills');
      if (existsSync(skillsDir)) return false;

      mkdirSync(skillsDir, { recursive: true });
      return true;
    },

    /** 触发 Cursor Delivery Pipeline 动态生成（fire-and-forget） */
    triggerCursorDelivery() {
      this._triggerCursorDeliveryAsync().catch(() => {});
      return true;
    },

    /** 注入 autoApprove */
    injectAutoApprove() {
      try {
        // @ts-expect-error TS migration: TS2554
        injectAutoApprove(this.projectRoot);
        return true;
      } catch {
        return false;
      }
    },

    /** 构建并安装 VSCode Extension */
    installVSCodeExtension() {
      const extDir = join(REPO_ROOT, 'resources', 'vscode-ext');
      const pkgJson = join(extDir, 'package.json');
      if (!existsSync(pkgJson)) return false;

      try {
        // 编译 TypeScript
        execSync('npx tsc -p ./tsconfig.json', { cwd: extDir, stdio: 'pipe' });

        // 打包 .vsix
        execSync('npx @vscode/vsce package --no-dependencies -o autosnippet.vsix', {
          cwd: extDir,
          stdio: 'pipe',
        });

        const vsixPath = join(extDir, 'autosnippet.vsix');
        if (!existsSync(vsixPath)) return false;

        // 探测可用 IDE CLI
        const cliCandidates = ['code', 'cursor', 'codex'];
        const installed = [];

        for (const cli of cliCandidates) {
          try {
            execSync(`which ${cli}`, { stdio: 'pipe' });
            execSync(`${cli} --install-extension "${vsixPath}" --force`, { stdio: 'pipe' });
            installed.push(cli);
          } catch { /* CLI 不可用 */ }
        }

        return installed.length > 0;
      } catch {
        return false;
      }
    },
  };

  /* ═══ Destination Resolvers ══════════════════════════ */

  _resolvers = {
    /** 解析 pre-commit hook 的目标路径 */
    resolvePreCommitDest() {
      const huskyDir = join(this.projectRoot, '.husky');
      if (existsSync(huskyDir)) {
        return join(huskyDir, 'pre-commit');
      }
      if (existsSync(join(this.projectRoot, '.git'))) {
        const hooksDir = join(this.projectRoot, '.git', 'hooks');
        mkdirSync(hooksDir, { recursive: true });
        return join(hooksDir, 'pre-commit');
      }
      return null;
    },
  };

  /* ═══ Helpers ════════════════════════════════════════ */

  /** 递归复制目录 */
  _copyDirRecursive(srcDir, destDir, chmod = false) {
    if (!existsSync(srcDir)) return false;
    let copied = false;

    const entries = readdirSync(srcDir, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = join(srcDir, entry.name);
      const destPath = join(destDir, entry.name);

      if (entry.isDirectory()) {
        const sub = this._copyDirRecursive(srcPath, destPath, chmod);
        copied = copied || sub;
      } else {
        mkdirSync(destDir, { recursive: true });
        copyFileSync(srcPath, destPath);
        if (chmod && entry.name.endsWith('.sh')) {
          this._chmodExec(destPath);
        }
        copied = true;
      }
    }
    return copied;
  }

  /** chmod +x */
  _chmodExec(filePath) {
    try {
      execSync(`chmod +x "${filePath}"`, { stdio: 'pipe' });
    } catch { /* Windows — ignore */ }
  }

  /** 异步触发 Cursor Delivery Pipeline */
  async _triggerCursorDeliveryAsync() {
    try {
      const { getServiceContainer } = await import('../../injection/ServiceContainer.js');
      const container = getServiceContainer();
      const pipeline = container.services.cursorDeliveryPipeline
        ? container.get('cursorDeliveryPipeline')
        : null;
      if (pipeline) {
        await pipeline.deliver();
      }
    } catch {
      // ServiceContainer 未初始化 — 正常（upgrade 可能在无 DB 环境执行）
    }
  }
}

export default FileDeployer;
