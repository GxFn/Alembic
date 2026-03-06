/**
 * CapabilityProbe — 子仓库能力探针
 *
 * 通过 `git push --dry-run` 探测当前用户对子仓库的物理写权限。
 * 探测结果被缓存（默认 24h）以避免重复执行。
 *
 * 三种探测结果：
 *   'admin'       — 无子仓库（个人项目）/ 有 push 权限 → developer
 *   'contributor'  — 有子仓库但无 push 权限 → developer（本地用户 = 项目 Owner）
 *   'visitor'      — noRemote=deny 严格模式 → developer（仅探针级别区分，角色统一为 developer）
 *
 * 当没有 remote 时根据 constitution capabilities.git_write.no_remote 策略决定：
 *   'allow' (默认) — 本地开发，视为 admin
 *   'deny'          — 严格模式，视为 visitor
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import Logger from '../../infrastructure/logging/Logger.js';

/**
 * @typedef {'admin' | 'contributor' | 'visitor'} ProbeResult
 * @typedef {{ result: ProbeResult, cachedAt: number, expiresAt: number, detail: string }} ProbeCache
 */

export class CapabilityProbe {
  /**
   * @param {object} options
   * @param {string} [options.subRepoPath]  子仓库根路径（默认 cwd/AutoSnippet）
   * @param {number} [options.cacheTTL]     缓存 TTL（秒），默认 86400
   * @param {string} [options.noRemote]     无 remote 策略: 'allow' | 'deny'
   */
  constructor(options = {}) {
    this.logger = Logger.getInstance();
    this.subRepoPath = options.subRepoPath || this._detectSubRepo();
    this.cacheTTL = (options.cacheTTL ?? 86400) * 1000; // 转为 ms
    this.noRemote = options.noRemote || 'allow';

    /** @type {ProbeCache | null} */
    this._cache = null;
  }

  // ═══════════════════════════════════════════════════
  //  Public API
  // ═══════════════════════════════════════════════════

  /**
   * 执行探测，返回角色级别
   * @returns {ProbeResult}
   */
  probe() {
    // 命中缓存
    if (this._cache && Date.now() < this._cache.expiresAt) {
      this.logger.debug('CapabilityProbe: cache hit', { result: this._cache.result });
      return this._cache.result;
    }

    const result = this._runProbe();
    this._cache = {
      result,
      cachedAt: Date.now(),
      expiresAt: Date.now() + this.cacheTTL,
      detail: `probed at ${new Date().toISOString()}`,
    };

    this.logger.info('CapabilityProbe: probed', {
      subRepoPath: this.subRepoPath,
      result,
    });

    return result;
  }

  /**
   * 将探测结果映射为 Constitution 角色 ID
   * @param {ProbeResult} probeResult
   * @returns {string}
   */
  toRole(probeResult) {
    // 本地运行 AutoSnippet 的用户 = 项目 Owner = developer
    // 探针级别的 admin/contributor/visitor 仅做信息记录，角色统一为 developer
    switch (probeResult) {
      default:
        return 'developer';
    }
  }

  /**
   * 一步到位：探测并返回角色
   * @returns {string} Constitution role ID
   */
  probeRole() {
    return this.toRole(this.probe());
  }

  /**
   * 获取当前缓存状态（for dashboard display）
   */
  getCacheStatus() {
    if (!this._cache) {
      return { cached: false };
    }
    return {
      cached: true,
      result: this._cache.result,
      cachedAt: this._cache.cachedAt,
      expiresAt: this._cache.expiresAt,
      expired: Date.now() >= this._cache.expiresAt,
    };
  }

  /**
   * 清除缓存（强制下次重新探测）
   */
  invalidate() {
    this._cache = null;
  }

  // ═══════════════════════════════════════════════════
  //  Internal
  // ═══════════════════════════════════════════════════

  /**
   * 自动检测子仓库路径
   * @returns {string | null}
   */
  _detectSubRepo() {
    // 常见路径：cwd/AutoSnippet 或 .autosnippet/AutoSnippet
    const candidates = [
      path.resolve(process.cwd(), 'AutoSnippet'),
      path.resolve(process.cwd(), '.autosnippet', 'AutoSnippet'),
    ];

    for (const p of candidates) {
      if (fs.existsSync(path.join(p, '.git')) || fs.existsSync(path.join(p, '..', '.gitmodules'))) {
        return p;
      }
      // 即使不是独立 git 目录，但文件夹存在也返回（可能是 subtree 形式）
      if (fs.existsSync(p)) {
        return p;
      }
    }

    return null;
  }

  /**
   * 执行实际探测
   * @returns {ProbeResult}
   */
  _runProbe() {
    // Case 1: 子仓库路径不存在 → 个人项目模式，全权限
    if (!this.subRepoPath || !fs.existsSync(this.subRepoPath)) {
      this.logger.debug('CapabilityProbe: no sub-repo — personal project, granting admin');
      return 'admin';
    }

    // Case 2: 检查是否是 git 仓库
    const isGitRepo = this._isGitRepo(this.subRepoPath);
    if (!isGitRepo) {
      // 有目录但不是 git 仓库 → contributor（可本地编辑但不能 push）
      this.logger.debug('CapabilityProbe: directory exists but not a git repo');
      return 'contributor';
    }

    // Case 3: 检查是否有 remote
    const hasRemote = this._hasRemote(this.subRepoPath);
    if (!hasRemote) {
      // 无 remote，根据策略决定
      this.logger.debug('CapabilityProbe: no remote', { noRemote: this.noRemote });
      return this.noRemote === 'allow' ? 'admin' : 'visitor';
    }

    // Case 4: 有 remote → 执行 git push --dry-run 探测写权限
    try {
      return this._probePush(this.subRepoPath);
    } catch (err) {
      this.logger.warn('CapabilityProbe: push probe failed', { error: err.message });
      return 'contributor';
    }
  }

  /**
   * @param {string} repoPath
   * @returns {boolean}
   */
  _isGitRepo(repoPath) {
    try {
      execSync('git rev-parse --git-dir', {
        cwd: repoPath,
        stdio: 'pipe',
        timeout: 5000,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * @param {string} repoPath
   * @returns {boolean}
   */
  _hasRemote(repoPath) {
    try {
      const output = execSync('git remote', {
        cwd: repoPath,
        stdio: 'pipe',
        timeout: 5000,
        encoding: 'utf8',
      });
      return output.trim().length > 0;
    } catch {
      return false;
    }
  }

  /**
   * git push --dry-run 探测
   * @param {string} repoPath
   * @returns {ProbeResult}
   */
  _probePush(repoPath) {
    try {
      execSync('git push --dry-run 2>&1', {
        cwd: repoPath,
        stdio: 'pipe',
        timeout: 15000,
        encoding: 'utf8',
      });
      // 成功 → 有写权限
      return 'admin';
    } catch (err) {
      const stderr = (err.stderr || err.stdout || err.message || '').toString();
      // "Everything up-to-date" 也算成功
      if (stderr.includes('Everything up-to-date') || stderr.includes('up to date')) {
        return 'admin';
      }
      // 明确被拒绝
      if (
        stderr.includes('permission') ||
        stderr.includes('denied') ||
        stderr.includes('403') ||
        stderr.includes('401')
      ) {
        return 'contributor';
      }
      // 网络错误等 → 降级为 contributor
      this.logger.debug('CapabilityProbe: push dry-run inconclusive', {
        stderr: stderr.slice(0, 200),
      });
      return 'contributor';
    }
  }
}

export default CapabilityProbe;
