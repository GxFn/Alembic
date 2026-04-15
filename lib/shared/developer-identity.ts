/**
 * 开发者身份解析
 *
 * 优先级链：
 *   1. 环境变量 ALEMBIC_USER
 *   2. git config user.name（项目级 → 全局）
 *   3. 操作系统用户名
 *   4. 'unknown'
 *
 * 结果在进程级缓存，避免重复 exec。
 */

import { execSync } from 'node:child_process';
import { userInfo } from 'node:os';

let _cached: string | null = null;

/**
 * 同步获取当前开发者标识（缓存）。
 * @param cwd — 用于解析 git config 的工作目录（默认 process.cwd()）
 */
export function getDeveloperIdentity(cwd?: string): string {
  if (_cached) {
    return _cached;
  }
  _cached = resolveDeveloperIdentity(cwd);
  return _cached;
}

/** 清除缓存（测试用） */
export function clearDeveloperIdentityCache() {
  _cached = null;
}

function resolveDeveloperIdentity(cwd?: string): string {
  // 1. 环境变量
  const envUser = process.env['ALEMBIC_USER'];
  if (envUser?.trim()) {
    return envUser.trim();
  }

  // 2. git config user.name
  try {
    const name = execSync('git config user.name', {
      cwd: cwd || process.cwd(),
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (name) {
      return name;
    }
  } catch {
    // git 未安装或不在 git repo 中
  }

  // 3. OS 用户名
  try {
    const info = userInfo();
    if (info.username) {
      return info.username;
    }
  } catch {
    // 极罕见：userInfo() 在某些容器环境可能失败
  }

  return 'unknown';
}
