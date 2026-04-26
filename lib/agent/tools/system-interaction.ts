/**
 * system-interaction.js — 系统交互工具 (2)
 *
 * 为 Agent 提供与本地操作系统交互的能力:
 *
 * 1. write_project_file   写入/创建项目文件 (受文件范围约束)
 * 2. get_environment_info 获取运行环境信息
 *
 * ⚠️ 安全设计:
 *   - write_project_file 在工具层即执行文件路径范围检查
 *   - 终端执行由 TerminalAdapter / terminal_run 结构化能力提供
 *
 * @module system-interaction
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { WriteZone } from '#infra/io/WriteZone.js';
import type { ToolHandlerContext } from './_shared.js';

const execFileAsync = promisify(execFile);

// ─── 类型定义 ────────────────────────────────────────

/** SafetyPolicy 安全策略接口 */
interface SafetyPolicy {
  checkFilePath(filePath: string): { safe: boolean; reason?: string };
}

/** 系统交互工具的 handler 上下文 */
export interface SystemToolContext extends ToolHandlerContext {
  safetyPolicy?: SafetyPolicy;
}

export interface WriteProjectFileParams {
  filePath: string;
  content: string;
  append?: boolean;
}

export interface GetEnvironmentInfoParams {
  sections?: string[];
}

export interface EnvironmentInfo {
  os?: Record<string, unknown>;
  node?: Record<string, unknown>;
  git?: Record<string, unknown>;
  project?: Record<string, unknown>;
}

// ─── 常量 ────────────────────────────────────────────

/** 文件写入最大尺寸 (bytes) */
const MAX_WRITE_SIZE = 512 * 1024;

// ─── 内部工具函数 ────────────────────────────────────

/** 获取 projectRoot — 优先从 context 获取, 兜底用 cwd */
function _getProjectRoot(ctx: ToolHandlerContext) {
  return ctx.projectRoot || ctx.container?.get?.('projectRoot') || process.cwd();
}

// ═══════════════════════════════════════════════════════
// 1. write_project_file — 写入项目文件
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
  handler: async (params: WriteProjectFileParams, ctx: SystemToolContext) => {
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
      const wz = ctx.container?.get?.('writeZone') as WriteZone | undefined;
      if (wz) {
        const target = resolved.startsWith(wz.dataRoot)
          ? wz.data(resolved.replace(wz.dataRoot, '').replace(/^\//, ''))
          : wz.project(relPath);
        if (append) {
          wz.appendFile(target, content);
        } else {
          wz.writeFile(target, content);
        }
      } else {
        const dir = path.dirname(resolved);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        if (append) {
          fs.appendFileSync(resolved, content, 'utf-8');
        } else {
          fs.writeFileSync(resolved, content, 'utf-8');
        }
      }

      const stat = fs.statSync(resolved);
      return {
        success: true,
        filePath: relPath,
        absolutePath: resolved,
        size: stat.size,
        mode: append ? 'append' : 'overwrite',
      };
    } catch (err: unknown) {
      return { error: `写入文件失败: ${(err as Error).message}` };
    }
  },
};

// ═══════════════════════════════════════════════════════
// 2. get_environment_info — 获取运行环境信息
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
  handler: async (params: GetEnvironmentInfoParams, ctx: ToolHandlerContext) => {
    const sections = params.sections || ['all'];
    const all = sections.includes('all');
    const projectRoot = _getProjectRoot(ctx);
    const info: EnvironmentInfo = {};

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
        const { stdout: branch } = await execFileAsync('git', ['branch', '--show-current'], {
          cwd: projectRoot,
          timeout: 5000,
        });
        info.git.branch = branch.trim();

        const { stdout: status } = await execFileAsync('git', ['status', '--porcelain'], {
          cwd: projectRoot,
          timeout: 5000,
        });
        const lines = status.trim().split('\n').filter(Boolean);
        info.git.dirty = lines.length > 0;
        info.git.changedFiles = lines.length;

        const { stdout: lastCommit } = await execFileAsync(
          'git',
          ['log', '-1', '--format=%h %s (%cr)'],
          { cwd: projectRoot, timeout: 5000 }
        );
        info.git.lastCommit = lastCommit.trim();

        const { stdout: remoteUrl } = await execFileAsync('git', ['remote', 'get-url', 'origin'], {
          cwd: projectRoot,
          timeout: 5000,
        });
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
        } catch {
          /* invalid package.json */
        }
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
