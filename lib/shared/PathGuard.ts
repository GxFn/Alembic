/**
 * PathGuard — 文件写入路径安全守卫（双层防护）
 *
 * 防止 AutoSnippet 在项目目录之外 或 项目内非法位置 创建文件。
 * BiliDemo/data 事件的根因：process.cwd() 解析到非预期目录，DB/日志等写操作
 * 逃逸到用户项目外，创建了脏数据。
 *
 * 双层防护：
 *  Layer 1 — assertSafe(path):
 *    边界检查，拦截写到 projectRoot 外的操作
 *  Layer 2 — assertProjectWriteSafe(path):
 *    项目内作用域检查，仅允许写入以下前缀：
 *      .autosnippet/     — 运行时 DB、记忆、对话、信号快照
 *      {kbDir}/          — 知识库（recipes、candidates、skills、guard 文件）
 *      .cursor/          — Cursor IDE 集成
 *      .vscode/          — VSCode 集成
 *      .github/          — Copilot instructions
 *      .gitignore        — 追加忽略规则
 *    项目内其他位置（如 data/、src/ 等）一律拦截
 *
 * 设计：
 *  - 单例模式，通过 configure() 绑定 projectRoot
 *  - 新建文件/目录前调用 assertProjectWriteSafe() 校验
 *  - 修改已有文件前调用 assertSafe() 校验（不限制项目内位置）
 *  - 允许白名单目录（Xcode snippets、全局缓存等）
 *  - 错误不静默：越界写操作抛出 PathGuardError
 */

import fs from 'node:fs';
import path from 'node:path';

export class PathGuardError extends Error {
  projectRoot: any;
  targetPath: any;
  /**
   * @param {string} targetPath 被拦截的目标路径
   * @param {string} projectRoot 当前项目根目录
   * @param {string} [reason] 拦截原因
   */
  constructor(targetPath, projectRoot, reason?) {
    const msg = reason
      ? `[PathGuard] ${reason}: "${targetPath}"`
      : `[PathGuard] 写入路径越界: "${targetPath}" 不在允许范围内。`;
    super(
      msg +
        `\n  projectRoot: ${projectRoot}` +
        `\n  提示: 检查 process.cwd() 或 projectRoot 配置是否正确`
    );
    this.name = 'PathGuardError';
    this.targetPath = targetPath;
    this.projectRoot = projectRoot;
  }
}

/**
 * 项目内允许 AutoSnippet 创建新文件/目录的前缀
 * 注意：这是相对于 projectRoot 的前缀列表
 */
const PROJECT_WRITE_SCOPE_PREFIXES = [
  '.autosnippet', // 运行时 DB、记忆、对话、信号快照
  '.cursor', // Cursor IDE 集成
  '.vscode', // VSCode 集成
  '.github', // Copilot instructions
];

/**
 * 项目根目录下允许直接写入的文件（非目录前缀匹配）
 */
const PROJECT_ROOT_WRITABLE_FILES = ['.gitignore', '.env'];

class PathGuard {
  targetPath: any;
  /** @type {string|null} 项目根目录（绝对路径） */
  #projectRoot = null;

  /** @type {string|null} AutoSnippet 包自身根目录 */
  #packageRoot = null;

  /** @type {Set<string>} 额外允许的绝对路径前缀 */
  #allowList = new Set();

  /** @type {string|null} 知识库目录名（如 'AutoSnippet'） */
  #knowledgeBaseDir = null;

  /** @type {boolean} 是否已配置 */
  #configured = false;

  /**
   * 配置 PathGuard（每个进程执行一次）
   * @param {object} opts
   * @param {string} opts.projectRoot 用户项目根目录（绝对路径）
   * @param {string} [opts.packageRoot] - AutoSnippet 包自身根目录
   * @param {string} [opts.knowledgeBaseDir='AutoSnippet'] 知识库目录名
   * @param {string[]} [opts.extraAllowPaths] 额外允许的路径前缀
   */
  configure({ projectRoot, packageRoot, knowledgeBaseDir, extraAllowPaths = [] }) {
    if (!projectRoot || !path.isAbsolute(projectRoot)) {
      throw new Error(`[PathGuard] projectRoot 必须是绝对路径，收到: "${projectRoot}"`);
    }

    this.#projectRoot = path.resolve(projectRoot);
    this.#packageRoot = packageRoot ? path.resolve(packageRoot) : null;
    this.#knowledgeBaseDir = knowledgeBaseDir || null; // 延迟解析

    // 默认白名单：全局缓存 + 平台 Snippets 目录
    const HOME = process.env.HOME || process.env.USERPROFILE || '';
    if (HOME) {
      this.#allowList.add(path.join(HOME, '.autosnippet', 'cache'));
      this.#allowList.add(path.join(HOME, '.autosnippet', 'snippets'));
      if (process.platform === 'darwin') {
        this.#allowList.add(path.join(HOME, 'Library/Developer/Xcode/UserData/CodeSnippets'));
      }
    }

    // 用户自定义白名单
    for (const p of extraAllowPaths) {
      if (path.isAbsolute(p)) {
        this.#allowList.add(path.resolve(p));
      }
    }

    this.#configured = true;
  }

  /** 是否已配置 */
  get configured() {
    return this.#configured;
  }

  /** 当前 projectRoot */
  get projectRoot() {
    return this.#projectRoot;
  }

  /**
   * 设置知识库目录名（可在 configure 之后延迟设置）
   * @param {string} dirName 如 'AutoSnippet'、'Knowledge' 等
   */
  setKnowledgeBaseDir(dirName) {
    if (dirName && typeof dirName === 'string') {
      this.#knowledgeBaseDir = dirName;
    }
  }

  /**
   * Layer 1: 断言路径在允许的边界范围内
   * 用于修改已有文件的场景（如 XcodeIntegration 插入 header、SpmHelper 修改 Package.swift）
   * @param {string} targetPath 要写入的绝对路径
   * @throws {PathGuardError}
   */
  assertSafe(targetPath) {
    if (!this.#configured) {
      return;
    }

    if (!targetPath || typeof targetPath !== 'string') {
      throw new PathGuardError(String(targetPath), this.#projectRoot);
    }

    const resolved = path.resolve(targetPath);

    // 1. 项目目录内 — 允许
    if (this.#isUnder(resolved, this.#projectRoot)) {
      return;
    }

    // 2. AutoSnippet 包自身目录内（logs/ 等）— 允许
    if (this.#packageRoot && this.#isUnder(resolved, this.#packageRoot)) {
      return;
    }

    // 3. 白名单目录 — 允许
    for (const allowed of this.#allowList) {
      if (this.#isUnder(resolved, allowed)) {
        return;
      }
    }

    // 越界
    throw new PathGuardError(resolved, this.#projectRoot);
  }

  /**
   * Layer 2: 断言路径在项目内允许的写入作用域中
   * 用于创建新目录/新文件的场景（如 mkdirSync、writeFileSync 创建新文件）
   * 比 assertSafe() 更严格：即使在 projectRoot 内，也只允许写入特定前缀
   * @param {string} targetPath 要创建的绝对路径
   * @throws {PathGuardError}
   */
  assertProjectWriteSafe(targetPath) {
    if (!this.#configured) {
      return;
    }

    // 先做边界检查
    this.assertSafe(targetPath);

    const resolved = path.resolve(targetPath);

    // 如果不在 projectRoot 内（在白名单/packageRoot 中），跳过项目内检查
    if (!this.#isUnder(resolved, this.#projectRoot)) {
      return;
    }

    // 计算相对于 projectRoot 的路径
    const relative = path.relative(this.#projectRoot, resolved);
    const firstSegment = relative.split(path.sep)[0];

    // 检查是否在允许的前缀中
    for (const prefix of PROJECT_WRITE_SCOPE_PREFIXES) {
      if (firstSegment === prefix) {
        return;
      }
    }

    // 检查知识库目录（动态解析）
    const kbDir = this.#resolveKnowledgeBaseDir();
    if (kbDir && firstSegment === kbDir) {
      return;
    }

    // 检查根目录可写文件（如 .gitignore）
    if (PROJECT_ROOT_WRITABLE_FILES.includes(relative)) {
      return;
    }

    // 不在允许的写入范围内
    throw new PathGuardError(
      resolved,
      this.#projectRoot,
      `项目内写入范围受限: "${relative}" 不在允许的目录中（允许: ${[...PROJECT_WRITE_SCOPE_PREFIXES, kbDir || 'AutoSnippet'].join(', ')}）`
    );
  }

  /**
   * 安全检查（不抛错，返回 boolean）
   * @param {string} targetPath
   * @returns {boolean}
   */
  isSafe(targetPath) {
    try {
      this.assertSafe(targetPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 项目内写入范围检查（不抛错，返回 boolean）
   * @param {string} targetPath
   * @returns {boolean}
   */
  isProjectWriteSafe(targetPath) {
    try {
      this.assertProjectWriteSafe(targetPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 将相对路径安全地解析到 projectRoot 下
   * 替代 path.resolve(relativePath)（后者基于 cwd，不安全）
   * @param {string} relativePath
   * @returns {string} 绝对路径
   */
  resolveProjectPath(relativePath) {
    if (!this.#configured || !this.#projectRoot) {
      // 未配置时 fallback 到 cwd（向后兼容）
      return path.resolve(relativePath);
    }
    const resolved = path.resolve(this.#projectRoot, relativePath);
    this.assertSafe(resolved);
    return resolved;
  }

  /**
   * 重置状态（仅用于测试）
   */
  _reset() {
    this.#projectRoot = null;
    this.#packageRoot = null;
    this.#allowList.clear();
    this.#knowledgeBaseDir = null;
    this.#configured = false;
  }

  /**
   * resolved 是否在 base 目录下
   */
  #isUnder(resolved, base) {
    return resolved === base || resolved.startsWith(base + path.sep);
  }

  /**
   * 解析知识库目录名
   * 优先使用 configure 阶段传入的值，否则尝试运行时探测
   */
  #resolveKnowledgeBaseDir() {
    if (this.#knowledgeBaseDir) {
      return this.#knowledgeBaseDir;
    }

    // 运行时探测: 查找包含 AutoSnippet.boxspec.json 的子目录
    try {
      const entries = fs.readdirSync(this.#projectRoot, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory() && !e.name.startsWith('.')) {
          if (fs.existsSync(path.join(this.#projectRoot, e.name, 'AutoSnippet.boxspec.json'))) {
            this.#knowledgeBaseDir = e.name;
            return e.name;
          }
        }
      }
    } catch {
      /* ignore */
    }

    // 默认
    return 'AutoSnippet';
  }
}

// 单例 — 整个进程共享
const pathGuard = new PathGuard();

export default pathGuard;
