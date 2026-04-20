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
 *   merge-json       — 读取现有 JSON，合并 alembic 键，写回
 *   merge-gitignore  — 增量追加缺失规则 + 迁移旧格式
 *   backup-overwrite — 备份旧文件再覆盖
 *   inject-marker    — 在 <!-- alembic:begin/end --> 标记间注入
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
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { injectAutoApprove } from '../../external/mcp/autoApproveInjector.js';
import { checkWriteSafety, safeCopyFile } from '../../service/delivery/FileProtection.js';
import { DEFAULT_KNOWLEDGE_BASE_DIR } from '../../shared/ProjectMarkers.js';
import { PACKAGE_ROOT, TEMPLATES_DIR } from '../../shared/package-root.js';
import {
  buildMcpServerEntry,
  GITIGNORE_MIGRATIONS,
  GITIGNORE_RULES,
  GITIGNORE_SECTION_BEGIN,
  GITIGNORE_SECTION_END,
  MANIFEST,
} from './FileManifest.js';

/** Alembic 源码仓库根目录 */
const REPO_ROOT = PACKAGE_ROOT;

/** Manifest entry type */
interface ManifestEntry {
  id: string;
  src?: string;
  dest: string | null;
  strategy: string;
  on: string;
  category?: string;
  jsonKey?: string;
  chmod?: boolean;
  generate?: string;
  fallback?: string;
  resolveDest?: string;
  cleanup?: string[];
  requireDir?: string;
  ghostPolicy?: 'deploy' | 'skip' | 'global';
}

export class FileDeployer {
  force: boolean;
  projectName: string;
  projectRoot: string;
  /** Ghost 模式 — 部署时跳过 ghostPolicy='skip' 的条目 */
  ghost: boolean;
  /** @param {{ projectRoot: string, force?: boolean, ghost?: boolean }} options */
  constructor({
    projectRoot,
    force = false,
    ghost = false,
  }: { projectRoot: string; force?: boolean; ghost?: boolean }) {
    this.projectRoot = resolve(projectRoot);
    this.projectName = this.projectRoot.split('/').pop() || '';
    this.force = force;
    this.ghost = ghost;
  }

  /* ═══ 公共入口 ═══════════════════════════════════════ */

  /**
   * 部署所有适用的文件
   * @param options 可选过滤部署的 category
   * @returns > }}
   */
  deployAll(mode: 'setup' | 'upgrade', { filter }: { filter?: string[] } = {}) {
    const applicable = (MANIFEST as ManifestEntry[]).filter((entry) => {
      if (entry.on !== 'both' && entry.on !== mode) {
        return false;
      }
      if (filter && !filter.includes(entry.category!)) {
        return false;
      }
      // Ghost 模式过滤：跳过 ghostPolicy='skip' 和无 ghostPolicy 的条目
      if (this.ghost) {
        const policy = entry.ghostPolicy ?? 'skip';
        if (policy === 'skip') {
          return false;
        }
      }
      return true;
    });

    const deployed: string[] = [];
    const skipped: string[] = [];
    const errors: { id: string; error: string }[] = [];

    for (const entry of applicable) {
      try {
        const result = this._deployOne(entry, mode);
        if (result) {
          deployed.push(entry.id);
        } else {
          skipped.push(entry.id);
        }
      } catch (err: unknown) {
        errors.push({ id: entry.id, error: (err as Error).message });
      }
    }

    return { deployed, skipped, errors };
  }

  /** 按 category 部署 */
  deployCategory(category: string, mode: 'setup' | 'upgrade') {
    return this.deployAll(mode, { filter: [category] });
  }

  /* ═══ 单文件部署路由 ═════════════════════════════════ */

  /**
   * @param entry Manifest 条目
   * @returns 是否实际写入了文件
   */
  _deployOne(entry: ManifestEntry, mode: 'setup' | 'upgrade') {
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

  /** overwrite — Alembic 完全拥有，始终覆盖 */
  _strategyOverwrite(entry: ManifestEntry) {
    const src = join(TEMPLATES_DIR, entry.src!);
    if (!existsSync(src)) {
      return false;
    }

    const dest = join(this.projectRoot, entry.dest!);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    if (entry.chmod) {
      this._chmodExec(dest);
    }
    return true;
  }

  /** overwrite-dir — 递归覆盖目录 */
  _strategyOverwriteDir(entry: ManifestEntry) {
    const srcDir = join(TEMPLATES_DIR, entry.src!);
    if (!existsSync(srcDir)) {
      return false;
    }

    const destDir = join(this.projectRoot, entry.dest!);
    const copied = this._copyDirRecursive(srcDir, destDir, entry.chmod);

    // 清理旧文件
    if (entry.cleanup) {
      for (const rel of entry.cleanup) {
        const old = join(this.projectRoot, rel);
        if (existsSync(old)) {
          try {
            unlinkSync(old);
          } catch {
            /* ignore */
          }
        }
      }
    }

    return copied;
  }

  /** signature-safe — 有 Alembic 签名才覆盖 */
  _strategySignatureSafe(entry: ManifestEntry, mode: 'setup' | 'upgrade') {
    const src = join(TEMPLATES_DIR, entry.src!);
    if (!existsSync(src)) {
      return false;
    }

    const dest = join(this.projectRoot, entry.dest!);
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
  _strategyCreateOnly(entry: ManifestEntry) {
    let dest: string | null | undefined;
    if (entry.resolveDest) {
      dest = this._resolvers[entry.resolveDest]?.call(this);
      if (!dest) {
        return false;
      }
    } else {
      dest = join(this.projectRoot, entry.dest!);
    }

    if (existsSync(dest) && !this.force) {
      return false;
    }

    const { canWrite } = checkWriteSafety(dest);
    if (!canWrite) {
      return false;
    }

    const src = join(TEMPLATES_DIR, entry.src!);
    if (!existsSync(src)) {
      return false;
    }

    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    if (entry.chmod) {
      this._chmodExec(dest);
    }
    return true;
  }

  /** merge-json — 读取现有 JSON，合并 alembic 键 */
  _strategyMergeJson(entry: ManifestEntry) {
    // Ghost 模式 + global policy → 写入全局配置
    //   Cursor:  ~/.cursor/mcp.json
    //   VSCode:  ~/Library/Application Support/Code/User/mcp.json (macOS)
    //            ~/.config/Code/User/mcp.json (Linux)
    //            %APPDATA%/Code/User/mcp.json (Windows)
    let dest: string;
    if (this.ghost && entry.ghostPolicy === 'global') {
      if (entry.id === 'vscode-mcp') {
        dest = join(this._vscodeMcpGlobalDir(), 'mcp.json');
      } else {
        dest = join(os.homedir(), entry.dest!);
      }
    } else {
      dest = join(this.projectRoot, entry.dest!);
    }
    mkdirSync(dirname(dest), { recursive: true });

    let config: Record<string, Record<string, unknown>> = {};
    if (existsSync(dest)) {
      try {
        config = JSON.parse(readFileSync(dest, 'utf8'));
      } catch {
        /* */
      }
    }

    const parentKey = entry.jsonKey!;
    if (!config[parentKey]) {
      config[parentKey] = {};
    }

    const ide = entry.id === 'vscode-mcp' ? 'vscode' : 'cursor';
    // 只有 VSCode 全局配置不支持 ${workspaceFolder}，需要绝对路径
    const useAbsPath = this.ghost && entry.ghostPolicy === 'global' && entry.id === 'vscode-mcp';
    config[parentKey].alembic = buildMcpServerEntry(this.projectRoot, ide, useAbsPath);

    writeFileSync(dest, JSON.stringify(config, null, 2));
    return true;
  }

  /**
   * merge-gitignore — section-based 管理
   *
   * 设计：用 BEGIN/END 标记包裹 Alembic 规则块，整块替换。
   * - 首次：追加 section 到文件末尾
   * - 升级：替换已有 section（规则变更自动生效）
   * - 迁移：清理旧版逐行追加的散落规则
   */
  _strategyMergeGitignore(_entry: ManifestEntry) {
    const giPath = join(this.projectRoot, '.gitignore');
    let content = existsSync(giPath) ? readFileSync(giPath, 'utf8') : '';
    let changed = false;

    // 1. 迁移旧格式（regex-based cleanup）
    for (const migration of GITIGNORE_MIGRATIONS) {
      if (migration.find.test(content)) {
        content = content.replace(migration.find, migration.replace);
        changed = true;
      }
    }

    // 2. 迁移：清理旧版散落的 Alembic 规则（无 section marker 时代的残留）
    //    只清理 Alembic 专属规则，不触碰通用规则（.DS_Store, .env 等可能是用户自己添加的）
    const alembicOnlyPatterns = GITIGNORE_RULES.filter((r) => r.pattern.startsWith('.asd')).map(
      (r) => r.pattern
    );
    const alembicOnlyComments = GITIGNORE_RULES.filter(
      (r) => r.comment && r.pattern.startsWith('.asd')
    ).map((r) => `# ${r.comment}`);
    // 仅清除含 "Alembic" 标识的旧版注入注释（确保是 Alembic 写入的，非用户自己添加的）
    const legacyTokens = [
      '# Alembic 运行时缓存（不入库）',
      '# Alembic 环境变量（含 API Key，不入库）',
      '# Alembic 运行日志',
    ];
    const allOldTokens = new Set([...alembicOnlyPatterns, ...alembicOnlyComments, ...legacyTokens]);

    // 只有在 section markers 不存在时才清理散落规则（避免误删 section 内容后重复清理）
    if (!content.includes(GITIGNORE_SECTION_BEGIN)) {
      const lines = content.split('\n');
      const cleaned = lines.filter((line) => !allOldTokens.has(line.trim()));
      const cleanedContent = cleaned
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trimEnd();
      if (cleanedContent !== content.trimEnd()) {
        content = cleanedContent.endsWith('\n') ? cleanedContent : `${cleanedContent}\n`;
        changed = true;
      }
    }

    // 3. 构建 Alembic section block
    const sectionLines = [GITIGNORE_SECTION_BEGIN];
    for (const rule of GITIGNORE_RULES) {
      if (rule.comment) {
        sectionLines.push(`# ${rule.comment}`);
      }
      sectionLines.push(rule.pattern);
    }

    // 确保 Alembic/ 知识库不被忽略
    const kbDir = DEFAULT_KNOWLEDGE_BASE_DIR;
    const contentLines = content.split('\n');
    const hasIgnoreAS = contentLines.some((l) => {
      const t = l.trim();
      return (t === `${kbDir}/` || t === kbDir) && !t.startsWith('#') && !t.startsWith('!');
    });
    if (hasIgnoreAS) {
      sectionLines.push(`# 知识库必须入库`);
      sectionLines.push(`!${kbDir}/`);
    }

    sectionLines.push(GITIGNORE_SECTION_END);
    const sectionBlock = sectionLines.join('\n');

    // 4. 插入或替换 section
    const beginIdx = content.indexOf(GITIGNORE_SECTION_BEGIN);
    const endIdx = content.indexOf(GITIGNORE_SECTION_END);

    if (beginIdx !== -1 && endIdx !== -1) {
      // 替换已有 section
      const before = content.substring(0, beginIdx);
      const after = content.substring(endIdx + GITIGNORE_SECTION_END.length);
      const newContent = `${before}${sectionBlock}${after}`;
      if (newContent !== content) {
        content = newContent;
        changed = true;
      }
    } else {
      // 首次追加
      const separator = content.endsWith('\n') || content.length === 0 ? '\n' : '\n\n';
      content += `${separator}${sectionBlock}\n`;
      changed = true;
    }

    if (changed) {
      writeFileSync(giPath, content);
    }
    return changed;
  }

  /** backup-overwrite — 备份旧文件后覆盖 */
  _strategyBackupOverwrite(entry: ManifestEntry) {
    const src = join(TEMPLATES_DIR, entry.src!);
    if (!existsSync(src)) {
      return false;
    }

    // 需要目标目录存在
    if (entry.requireDir) {
      const reqDir = join(this.projectRoot, entry.requireDir);
      if (!existsSync(reqDir)) {
        return false;
      }
    }

    const dest = join(this.projectRoot, entry.dest!);

    if (existsSync(dest)) {
      const oldContent = readFileSync(dest, 'utf8');
      const newContent = readFileSync(src, 'utf8');
      if (oldContent === newContent) {
        return false; // 无变化
      }
      copyFileSync(dest, `${dest}.bak`); // 备份
    }

    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    return true;
  }

  /** inject-marker — 在 alembic:begin/end 标记间注入 */
  _strategyInjectMarker(entry: ManifestEntry) {
    const BEGIN_MARKER = '<!-- alembic:begin -->';
    const END_MARKER = '<!-- alembic:end -->';

    const src = join(TEMPLATES_DIR, entry.src!);
    if (!existsSync(src)) {
      return false;
    }

    const templateContent = readFileSync(src, 'utf8');
    const beginIdx = templateContent.indexOf(BEGIN_MARKER);
    const endIdx = templateContent.indexOf(END_MARKER);
    if (beginIdx === -1 || endIdx === -1) {
      return false;
    }

    const snippet = templateContent.slice(beginIdx, endIdx + END_MARKER.length);
    const dest = join(this.projectRoot, entry.dest!);
    const destDir = dirname(dest);
    mkdirSync(destDir, { recursive: true });

    if (existsSync(dest)) {
      const existing = readFileSync(dest, 'utf8');
      if (existing.includes(BEGIN_MARKER)) {
        // 替换现有段落
        const updated = existing.replace(
          new RegExp(`${BEGIN_MARKER}[\\s\\S]*?${END_MARKER}`),
          snippet
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
  _strategyGenerate(entry: ManifestEntry) {
    const fn = (this._generators as Record<string, () => boolean>)[entry.generate!];
    if (!fn) {
      throw new Error(`Unknown generator: ${entry.generate}`);
    }
    return fn.call(this);
  }

  /** 获取 VSCode 全局用户配置目录 */
  _vscodeMcpGlobalDir(): string {
    const platform = process.platform;
    if (platform === 'darwin') {
      return join(os.homedir(), 'Library', 'Application Support', 'Code', 'User');
    }
    if (platform === 'win32') {
      return join(process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming'), 'Code', 'User');
    }
    // Linux
    return join(process.env.XDG_CONFIG_HOME || join(os.homedir(), '.config'), 'Code', 'User');
  }

  /* ═══ 自定义生成器 ═══════════════════════════════════ */

  _generators: Record<string, (this: FileDeployer) => boolean | void> = {
    /** .cursor/rules/alembic-conventions.mdc — 读 conventions.md + YAML frontmatter */
    generateConventionsMdc() {
      const tpl = join(TEMPLATES_DIR, 'instructions/conventions.md');
      if (!existsSync(tpl)) {
        return false;
      }

      const body = readFileSync(tpl, 'utf8').trimEnd();
      const content = [
        '---',
        'description: Alembic conventions — behavioral rules for task tracking, knowledge guardrails, and MCP usage',
        'alwaysApply: true',
        '---',
        '',
        '# Alembic Conventions',
        '',
        body,
        '',
      ].join('\n');

      const dest = join(this.projectRoot, '.cursor/rules/alembic-conventions.mdc');
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, content);
      return true;
    },

    /** .github/copilot-instructions.md — 读 conventions.md + HTML markers */
    generateCopilotInstructions() {
      const tpl = join(TEMPLATES_DIR, 'instructions/conventions.md');
      if (!existsSync(tpl)) {
        return false;
      }

      const body = readFileSync(tpl, 'utf8').trimEnd();
      const content = [
        '<!-- alembic:begin -->',
        '',
        '# Alembic Conventions',
        '',
        body,
        '',
        '<!-- alembic:end -->',
        '',
      ].join('\n');

      const dest = join(this.projectRoot, '.github/copilot-instructions.md');
      const destDir = dirname(dest);
      mkdirSync(destDir, { recursive: true });

      // 如果文件已存在且包含 begin/end markers，仅替换标记间内容
      if (existsSync(dest)) {
        const existing = readFileSync(dest, 'utf8');
        const BEGIN = '<!-- alembic:begin -->';
        const END = '<!-- alembic:end -->';
        if (existing.includes(BEGIN) && existing.includes(END)) {
          const snippet = content.trimEnd();
          const updated = existing.replace(new RegExp(`${BEGIN}[\\s\\S]*?${END}`), snippet);
          writeFileSync(dest, updated);
          return true;
        }
        // 用户文件无 markers 且无 Alembic 签名 → 追加
        const { canWrite } = checkWriteSafety(dest);
        if (!canWrite) {
          writeFileSync(dest, `${existing}\n\n${content}`);
          return true;
        }
      }

      writeFileSync(dest, content);
      return true;
    },

    /** AGENTS.md 静态骨架 — 读 agent-static.md 模板 */
    generateAgentsMd() {
      const claudePath = join(this.projectRoot, 'CLAUDE.md');
      if (existsSync(claudePath)) {
        return false; // 有 CLAUDE.md 时跳过
      }

      const agentsPath = join(this.projectRoot, 'AGENTS.md');
      if (existsSync(agentsPath) && !this.force) {
        return false;
      }

      const { canWrite } = checkWriteSafety(agentsPath);
      if (!canWrite) {
        return false;
      }

      const tpl = join(TEMPLATES_DIR, 'instructions/agent-static.md');
      if (!existsSync(tpl)) {
        return false;
      }

      const content = readFileSync(tpl, 'utf8').replace(/\{\{projectName\}\}/g, this.projectName);
      writeFileSync(agentsPath, content);
      return true;
    },

    /** 安装 Cursor Skills */
    installSkills() {
      // 编译产物在 dist/scripts/，源码在 scripts/ — 优先用 dist
      const distScript = join(REPO_ROOT, 'dist', 'scripts', 'install-cursor-skill.js');
      const srcScript = join(REPO_ROOT, 'scripts', 'install-cursor-skill.js');
      const installScript = existsSync(distScript) ? distScript : srcScript;
      if (!existsSync(installScript)) {
        return false;
      }

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

    /** 确保 Alembic/skills/ 目录存在 */
    ensureSkillsDir() {
      const autoDir = join(this.projectRoot, DEFAULT_KNOWLEDGE_BASE_DIR);
      if (!existsSync(autoDir)) {
        return false;
      }

      const skillsDir = join(autoDir, 'skills');
      if (existsSync(skillsDir)) {
        return false;
      }

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
      if (!existsSync(pkgJson)) {
        return false;
      }

      try {
        // 编译 TypeScript
        execSync('npx tsc -p ./tsconfig.json', { cwd: extDir, stdio: 'pipe' });

        // 打包 .vsix
        execSync('npx @vscode/vsce package --no-dependencies -o alembic.vsix', {
          cwd: extDir,
          stdio: 'pipe',
        });

        const vsixPath = join(extDir, 'alembic.vsix');
        if (!existsSync(vsixPath)) {
          return false;
        }

        // 探测可用 IDE CLI
        const cliCandidates = ['code', 'cursor', 'codex'];
        const installed: string[] = [];

        for (const cli of cliCandidates) {
          try {
            execSync(`which ${cli}`, { stdio: 'pipe' });
            execSync(`${cli} --install-extension "${vsixPath}" --force`, { stdio: 'pipe' });
            installed.push(cli);
          } catch {
            /* CLI 不可用 */
          }
        }

        return installed.length > 0;
      } catch {
        return false;
      }
    },
  };

  /* ═══ Destination Resolvers ══════════════════════════ */

  _resolvers: Record<string, (this: FileDeployer) => string | null> = {};

  /* ═══ Helpers ════════════════════════════════════════ */

  /** 递归复制目录 */
  _copyDirRecursive(srcDir: string, destDir: string, chmod = false): boolean {
    if (!existsSync(srcDir)) {
      return false;
    }
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
  _chmodExec(filePath: string) {
    try {
      execSync(`chmod +x "${filePath}"`, { stdio: 'pipe' });
    } catch {
      /* Windows — ignore */
    }
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
        await (pipeline as unknown as { deliver: () => Promise<void> }).deliver();
      }
    } catch {
      // ServiceContainer 未初始化 — 正常（upgrade 可能在无 DB 环境执行）
    }
  }
}

export default FileDeployer;
