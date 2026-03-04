/**
 * system-interaction.js — 系统交互工具 (3)
 *
 * 为 Agent 提供与本地操作系统交互的能力:
 *
 * 1. run_safe_command     安全执行终端命令 (受 SafetyPolicy 约束)
 * 2. write_project_file   写入/创建项目文件 (受文件范围约束)
 * 3. get_environment_info 获取运行环境信息
 *
 * ⚠️ 安全设计:
 *   - run_safe_command 在工具层即执行命令黑名单/白名单检查
 *   - write_project_file 在工具层即执行文件路径范围检查
 *   - 两者均依赖 AgentRuntime 注入的 safetyPolicy 上下文
 *   - 即使 safetyPolicy 未注入，工具自身也有基础安全兜底
 *
 * @module system-interaction
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ─── 常量 ────────────────────────────────────────────

/** 工具层兜底: 始终拒绝的危险命令模式 (无论 SafetyPolicy 是否注入) */
const HARDCODED_BLACKLIST = [
  /\brm\s+-rf\s+[\/~]/,
  /\bsudo\b/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  /\b(shutdown|reboot|halt)\b/,
  />\s*\/dev\//,
  /\bcurl\b.*\|\s*(bash|sh)/,
  /\bchmod\s+777/,
  /\bpasswd\b/,
  /\bkillall\b/,
  /\bfork\s*bomb/i,
  /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;/,  // fork bomb pattern
];

/** 工具层兜底: 无 SafetyPolicy 时仅允许的安全命令前缀 */
const FALLBACK_SAFE_PREFIXES = [
  'ls', 'cat', 'head', 'tail', 'grep', 'find', 'wc',
  'echo', 'pwd', 'date', 'which', 'file', 'stat',
  'git log', 'git status', 'git diff', 'git branch', 'git show',
  'npm list', 'npm outdated', 'node -v', 'npm -v',
  'python --version', 'python3 --version',
  'env', 'printenv',
];

/** 命令执行超时 (ms) */
const COMMAND_TIMEOUT = 30_000;

/** 输出截断长度 (bytes) */
const MAX_OUTPUT_LENGTH = 16_000;

/** 文件写入最大尺寸 (bytes) */
const MAX_WRITE_SIZE = 512 * 1024;

// ─── 内部工具函数 ────────────────────────────────────

/**
 * 硬编码黑名单检查 — 工具层兜底, 无论是否有 SafetyPolicy 都生效
 */
function _isHardBlacklisted(command) {
  for (const pattern of HARDCODED_BLACKLIST) {
    if (pattern.test(command)) return true;
  }
  return false;
}

/**
 * 无 SafetyPolicy 时的白名单兜底
 */
function _isFallbackSafe(command) {
  const trimmed = command.trim();
  return FALLBACK_SAFE_PREFIXES.some(prefix => trimmed.startsWith(prefix));
}

/**
 * 截断过长输出
 */
function _truncate(text, max = MAX_OUTPUT_LENGTH) {
  if (!text || text.length <= max) return text;
  return `${text.slice(0, max)}\n\n... [输出已截断, 共 ${text.length} 字符]`;
}

/**
 * 获取 projectRoot — 优先从 context 获取, 兜底用 cwd
 */
function _getProjectRoot(ctx) {
  return ctx.projectRoot || ctx.container?.get?.('projectRoot') || process.cwd();
}

// ═══════════════════════════════════════════════════════
// 1. run_safe_command — 安全执行终端命令
// ═══════════════════════════════════════════════════════

export const runSafeCommand = {
  name: 'run_safe_command',
  description:
    '在项目目录下安全执行终端命令。' +
    '命令受安全策略约束: 危险命令(sudo/rm -rf/shutdown 等)被自动拦截。' +
    '适用于: 查看 git 状态、运行测试、检查依赖版本、执行构建等。' +
    '超时 30 秒, 输出超过 16KB 会被截断。' +
    '如果需要管道或重定向, 请用 sh -c "..." 包装。',
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: '要执行的终端命令, 如 "git status" 或 "npm test"',
      },
      cwd: {
        type: 'string',
        description: '工作目录 (相对于项目根目录), 缺省为项目根目录',
      },
      timeout: {
        type: 'number',
        description: '超时时间(毫秒), 默认 30000',
      },
    },
    required: ['command'],
  },
  handler: async (params, ctx) => {
    const { command, cwd, timeout } = params;
    const projectRoot = _getProjectRoot(ctx);

    if (!command || typeof command !== 'string' || command.trim().length === 0) {
      return { error: '命令不能为空' };
    }

    // ── 安全检查 Layer 1: 硬编码黑名单 (无条件拦截) ──
    if (_isHardBlacklisted(command)) {
      return { error: `安全拦截: 命令 "${command}" 匹配危险模式, 已被阻止执行` };
    }

    // ── 安全检查 Layer 2: SafetyPolicy (如果注入) ──
    const safetyPolicy = ctx.safetyPolicy || null;
    if (safetyPolicy) {
      const check = safetyPolicy.checkCommand(command);
      if (!check.safe) {
        return { error: `SafetyPolicy 拦截: ${check.reason}` };
      }
    } else {
      // 无 SafetyPolicy 时使用白名单兜底
      if (!_isFallbackSafe(command)) {
        return {
          error: `无安全策略: 命令 "${command}" 不在安全白名单中。` +
            `允许的命令前缀: ${FALLBACK_SAFE_PREFIXES.join(', ')}`,
        };
      }
    }

    // ── 解析工作目录 ──
    let workDir = projectRoot;
    if (cwd) {
      workDir = path.isAbsolute(cwd) ? cwd : path.resolve(projectRoot, cwd);
      // 范围检查
      if (!workDir.startsWith(path.resolve(projectRoot))) {
        return { error: `工作目录 "${cwd}" 超出项目范围 "${projectRoot}"` };
      }
    }

    if (!fs.existsSync(workDir)) {
      return { error: `工作目录 "${workDir}" 不存在` };
    }

    // ── 执行命令 ──
    const effectiveTimeout = timeout || COMMAND_TIMEOUT;

    try {
      const { stdout, stderr } = await execFileAsync('sh', ['-c', command], {
        cwd: workDir,
        timeout: effectiveTimeout,
        maxBuffer: 1024 * 1024,    // 1MB 缓冲
        env: {
          ...process.env,
          // 禁用交互式 pager
          GIT_PAGER: 'cat',
          PAGER: 'cat',
          LESS: '-FRX',
        },
      });

      return {
        exitCode: 0,
        stdout: _truncate(stdout),
        stderr: _truncate(stderr),
        command,
        cwd: workDir,
      };
    } catch (err) {
      // 超时
      if (err.killed) {
        return {
          error: `命令执行超时 (${effectiveTimeout}ms)`,
          command,
          stdout: _truncate(err.stdout || ''),
          stderr: _truncate(err.stderr || ''),
        };
      }

      // 非零退出
      return {
        exitCode: err.code ?? 1,
        stdout: _truncate(err.stdout || ''),
        stderr: _truncate(err.stderr || err.message || ''),
        command,
        cwd: workDir,
      };
    }
  },
};

// ═══════════════════════════════════════════════════════
// 2. write_project_file — 写入项目文件
// ═══════════════════════════════════════════════════════

export const writeProjectFile = {
  name: 'write_project_file',
  description:
    '在项目目录内创建或覆盖写入文件。' +
    '自动创建不存在的中间目录。文件路径必须在项目范围内。' +
    '适用于: 生成配置文件、创建代码文件、写入分析报告等。' +
    '最大写入 512KB。',
  parameters: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: '目标文件路径 (相对于项目根目录或绝对路径)',
      },
      content: {
        type: 'string',
        description: '要写入的文件内容',
      },
      append: {
        type: 'boolean',
        description: '是否追加模式 (默认 false = 覆盖写入)',
      },
    },
    required: ['filePath', 'content'],
  },
  handler: async (params, ctx) => {
    const { filePath, content, append } = params;
    const projectRoot = _getProjectRoot(ctx);

    if (!filePath || typeof filePath !== 'string') {
      return { error: '文件路径不能为空' };
    }
    if (typeof content !== 'string') {
      return { error: '文件内容必须为字符串' };
    }

    // ── 大小限制 ──
    if (Buffer.byteLength(content, 'utf-8') > MAX_WRITE_SIZE) {
      return { error: `文件内容超过大小限制 (${MAX_WRITE_SIZE / 1024}KB)` };
    }

    // ── 路径解析与安全检查 ──
    const resolved = path.isAbsolute(filePath)
      ? path.resolve(filePath)
      : path.resolve(projectRoot, filePath);

    const scopeRoot = path.resolve(projectRoot);
    if (!resolved.startsWith(scopeRoot + path.sep) && resolved !== scopeRoot) {
      return { error: `文件路径 "${filePath}" 超出项目范围 "${projectRoot}"` };
    }

    // SafetyPolicy 路径检查
    const safetyPolicy = ctx.safetyPolicy || null;
    if (safetyPolicy) {
      const check = safetyPolicy.checkFilePath(resolved);
      if (!check.safe) {
        return { error: `SafetyPolicy 拦截: ${check.reason}` };
      }
    }

    // ── 危险路径兜底 ──
    const dangerousPatterns = [
      /node_modules\//,
      /\.git\//,
      /\.env$/,
      /\.env\.local$/,
      /package-lock\.json$/,
      /yarn\.lock$/,
      /pnpm-lock\.yaml$/,
    ];
    const relPath = path.relative(scopeRoot, resolved);
    for (const p of dangerousPatterns) {
      if (p.test(relPath)) {
        return { error: `安全拦截: 不允许写入 "${relPath}" (匹配受保护路径模式)` };
      }
    }

    // ── 写入文件 ──
    try {
      // 确保目录存在
      const dir = path.dirname(resolved);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      if (append) {
        fs.appendFileSync(resolved, content, 'utf-8');
      } else {
        fs.writeFileSync(resolved, content, 'utf-8');
      }

      const stat = fs.statSync(resolved);
      return {
        success: true,
        filePath: relPath,
        absolutePath: resolved,
        size: stat.size,
        mode: append ? 'append' : 'overwrite',
      };
    } catch (err) {
      return { error: `写入文件失败: ${err.message}` };
    }
  },
};

// ═══════════════════════════════════════════════════════
// 3. get_environment_info — 获取运行环境信息
// ═══════════════════════════════════════════════════════

export const getEnvironmentInfo = {
  name: 'get_environment_info',
  description:
    '获取当前运行环境的系统信息。' +
    '包括: 操作系统、Node.js 版本、项目路径、Git 分支、依赖管理器等。' +
    '适用于: 环境诊断、构建问题排查、项目状态检查。',
  parameters: {
    type: 'object',
    properties: {
      sections: {
        type: 'array',
        items: {
          type: 'string',
          enum: ['os', 'node', 'git', 'project', 'all'],
        },
        description: '要获取的信息部分, 默认 ["all"]',
      },
    },
    required: [],
  },
  handler: async (params, ctx) => {
    const sections = params.sections || ['all'];
    const all = sections.includes('all');
    const projectRoot = _getProjectRoot(ctx);
    const info = {};

    // ── OS 信息 ──
    if (all || sections.includes('os')) {
      info.os = {
        platform: os.platform(),
        arch: os.arch(),
        release: os.release(),
        hostname: os.hostname(),
        uptime: `${Math.floor(os.uptime() / 3600)}h ${Math.floor((os.uptime() % 3600) / 60)}m`,
        memory: {
          total: `${Math.round(os.totalmem() / (1024 * 1024 * 1024))}GB`,
          free: `${Math.round(os.freemem() / (1024 * 1024 * 1024))}GB`,
        },
        cpus: os.cpus().length,
        shell: process.env.SHELL || process.env.COMSPEC || 'unknown',
      };
    }

    // ── Node 信息 ──
    if (all || sections.includes('node')) {
      info.node = {
        version: process.version,
        execPath: process.execPath,
        pid: process.pid,
        env: {
          NODE_ENV: process.env.NODE_ENV || 'unset',
          npm_package_version: process.env.npm_package_version || 'N/A',
        },
      };

      // npm/pnpm/yarn 版本
      for (const pm of ['npm', 'pnpm', 'yarn']) {
        try {
          const { stdout } = await execFileAsync(pm, ['--version'], {
            timeout: 5000,
          });
          info.node[`${pm}_version`] = stdout.trim();
        } catch {
          // 未安装, 跳过
        }
      }
    }

    // ── Git 信息 ──
    if (all || sections.includes('git')) {
      info.git = {};
      try {
        const { stdout: branch } = await execFileAsync(
          'git', ['branch', '--show-current'],
          { cwd: projectRoot, timeout: 5000 },
        );
        info.git.branch = branch.trim();

        const { stdout: status } = await execFileAsync(
          'git', ['status', '--porcelain'],
          { cwd: projectRoot, timeout: 5000 },
        );
        const lines = status.trim().split('\n').filter(Boolean);
        info.git.dirty = lines.length > 0;
        info.git.changedFiles = lines.length;

        const { stdout: lastCommit } = await execFileAsync(
          'git', ['log', '-1', '--format=%h %s (%cr)'],
          { cwd: projectRoot, timeout: 5000 },
        );
        info.git.lastCommit = lastCommit.trim();

        const { stdout: remoteUrl } = await execFileAsync(
          'git', ['remote', 'get-url', 'origin'],
          { cwd: projectRoot, timeout: 5000 },
        );
        info.git.remote = remoteUrl.trim();
      } catch {
        info.git.error = '非 Git 仓库或 Git 未安装';
      }
    }

    // ── 项目信息 ──
    if (all || sections.includes('project')) {
      info.project = {
        root: projectRoot,
      };

      // package.json
      const pkgPath = path.join(projectRoot, 'package.json');
      if (fs.existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
          info.project.name = pkg.name;
          info.project.version = pkg.version;
          info.project.type = pkg.type || 'commonjs';
          info.project.dependencies = Object.keys(pkg.dependencies || {}).length;
          info.project.devDependencies = Object.keys(pkg.devDependencies || {}).length;
        } catch { /* invalid package.json */ }
      }

      // Podfile / Cartfile / build.gradle / CMakeLists / Makefile 检测
      const projectIndicators = [
        { file: 'Podfile', type: 'CocoaPods (iOS)' },
        { file: 'Cartfile', type: 'Carthage (iOS)' },
        { file: 'Package.swift', type: 'Swift Package Manager' },
        { file: 'build.gradle', type: 'Gradle (Android/Java)' },
        { file: 'pom.xml', type: 'Maven (Java)' },
        { file: 'CMakeLists.txt', type: 'CMake (C/C++)' },
        { file: 'Makefile', type: 'Make' },
        { file: 'Cargo.toml', type: 'Cargo (Rust)' },
        { file: 'go.mod', type: 'Go Modules' },
        { file: 'requirements.txt', type: 'pip (Python)' },
        { file: 'pyproject.toml', type: 'Python project' },
        { file: 'Gemfile', type: 'Bundler (Ruby)' },
      ];
      info.project.buildSystems = projectIndicators
        .filter(({ file }) => fs.existsSync(path.join(projectRoot, file)))
        .map(({ type }) => type);
    }

    return info;
  },
};
