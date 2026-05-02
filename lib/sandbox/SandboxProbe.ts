import fs from 'node:fs/promises';
import path from 'node:path';

const SANDBOX_EXEC_PATH = '/usr/bin/sandbox-exec';

const BUILTIN_NESTED_CONFLICT_BINS = new Set([
  'xcodebuild',
  'swift',
  'swiftc',
  'xcrun',
  'simctl',
  'actool',
  'ibtool',
  'codesign',
]);

let _sandboxExecAvailable: boolean | null = null;

/** 检测 sandbox-exec 是否可用 */
export async function isSandboxExecAvailable(): Promise<boolean> {
  if (_sandboxExecAvailable !== null) {
    return _sandboxExecAvailable;
  }
  try {
    await fs.access(SANDBOX_EXEC_PATH, fs.constants.X_OK);
    _sandboxExecAvailable = true;
  } catch {
    _sandboxExecAvailable = false;
  }
  return _sandboxExecAvailable;
}

/** 同步检测（首次调用后缓存可用） */
export function isSandboxExecAvailableSync(): boolean | null {
  return _sandboxExecAvailable;
}

/** 重置缓存（仅测试用） */
export function resetSandboxProbeCache(): void {
  _sandboxExecAvailable = null;
  _nestedConflictBins = null;
}

let _nestedConflictBins: Set<string> | null = null;

function getNestedConflictBins(): Set<string> {
  if (_nestedConflictBins) {
    return _nestedConflictBins;
  }
  const extra = process.env.ALEMBIC_SANDBOX_NESTED_CONFLICT_BINS?.trim();
  if (extra) {
    const extraSet = extra
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    _nestedConflictBins = new Set([...BUILTIN_NESTED_CONFLICT_BINS, ...extraSet]);
  } else {
    _nestedConflictBins = BUILTIN_NESTED_CONFLICT_BINS;
  }
  return _nestedConflictBins;
}

/**
 * 检测目标二进制是否存在嵌套沙箱冲突。
 *
 * macOS 不支持嵌套 sandbox-exec。xcodebuild / swift build
 * 等工具内部自带沙箱，外层再包一层会导致崩溃。
 *
 * 返回 true 时应跳过 sandbox-exec 包装，仅做环境净化。
 */
export function hasNestedSandboxConflict(bin: string): boolean {
  const basename = path.basename(bin);
  return getNestedConflictBins().has(basename);
}

export function getSandboxExecPath(): string {
  return SANDBOX_EXEC_PATH;
}
