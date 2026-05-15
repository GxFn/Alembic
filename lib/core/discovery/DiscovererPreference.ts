/**
 * @module DiscovererPreference
 * @description Discoverer 用户偏好持久化 + 冲突检测
 *
 * 当多个 Discoverer 匹配且置信度接近时，允许用户确认选择并持久化。
 * 插件运行时返回 ambiguous 标记，由宿主决定如何向用户确认。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ── Types ───────────────────────────────────────────

export interface DiscovererPreferenceData {
  selectedDiscoverer: string;
  selectedAt: string;
  alternatives: string[];
  userConfirmed: boolean;
}

export interface DetectMatch {
  discovererId: string;
  displayName: string;
  confidence: number;
}

export interface ConflictResult {
  ambiguous: boolean;
  reason?: string;
  matches: DetectMatch[];
  recommended?: DetectMatch;
}

// ── Constants ───────────────────────────────────────

const PREFERENCE_FILE = 'discoverer-preference.json';

/** 两个 Discoverer confidence 差值低于此阈值视为模糊 */
const AMBIGUITY_THRESHOLD = 0.1;

/** 最高 confidence 低于此值视为启发式不确定 */
const HEURISTIC_UNCERTAIN_THRESHOLD = 0.6;

// ── Conflict Detection ──────────────────────────────

/**
 * 检测 Discoverer 匹配结果是否存在冲突/模糊
 */
export function detectConflict(matches: DetectMatch[]): ConflictResult {
  if (matches.length === 0) {
    return { ambiguous: false, matches };
  }

  if (matches.length === 1) {
    return { ambiguous: false, matches, recommended: matches[0] };
  }

  const top = matches[0];
  const second = matches[1];

  // 条件 1: 多个高置信度结果 (≥ 0.60)
  const highConfCount = matches.filter((m) => m.confidence >= 0.6).length;

  // 条件 2: top-1 与 top-2 差距 < 阈值
  const closeDelta = top.confidence - second.confidence < AMBIGUITY_THRESHOLD;

  // 条件 3: 最高分仍低于阈值（仅启发式命中）
  const heuristicOnly = top.confidence < HEURISTIC_UNCERTAIN_THRESHOLD;

  if (highConfCount >= 2 && closeDelta) {
    return {
      ambiguous: true,
      reason: `Multiple build systems detected with similar confidence (${top.displayName}: ${top.confidence.toFixed(2)} vs ${second.displayName}: ${second.confidence.toFixed(2)})`,
      matches,
      recommended: top,
    };
  }

  if (heuristicOnly) {
    return {
      ambiguous: true,
      reason: `No definitive build system identified (highest: ${top.displayName} at ${top.confidence.toFixed(2)})`,
      matches,
      recommended: top,
    };
  }

  return { ambiguous: false, matches, recommended: top };
}

// ── Preference Persistence ──────────────────────────

/**
 * 获取偏好文件路径
 * @param root dataRoot（Ghost 模式下为外置工作区）或 projectRoot
 */
function getPreferencePath(root: string): string {
  return join(root, '.asd', PREFERENCE_FILE);
}

/**
 * 加载已保存的 Discoverer 偏好
 * @param dataRoot dataRoot（Ghost 模式下为外置工作区）或 projectRoot
 * @returns 偏好数据，或 null（无偏好/文件不存在/损坏）
 */
export function loadPreference(dataRoot: string): DiscovererPreferenceData | null {
  const prefPath = getPreferencePath(dataRoot);

  if (!existsSync(prefPath)) {
    return null;
  }

  try {
    const content = readFileSync(prefPath, 'utf8');
    const data = JSON.parse(content) as DiscovererPreferenceData;

    // 基本结构校验
    if (typeof data.selectedDiscoverer !== 'string' || typeof data.userConfirmed !== 'boolean') {
      return null;
    }

    return data;
  } catch {
    return null;
  }
}

/**
 * 保存 Discoverer 偏好
 * @param dataRoot dataRoot（Ghost 模式下为外置工作区）或 projectRoot
 */
export function savePreference(
  dataRoot: string,
  discovererId: string,
  alternatives: string[],
  userConfirmed: boolean
): void {
  const prefPath = getPreferencePath(dataRoot);
  const prefDir = join(dataRoot, '.asd');

  if (!existsSync(prefDir)) {
    mkdirSync(prefDir, { recursive: true });
  }

  const data: DiscovererPreferenceData = {
    selectedDiscoverer: discovererId,
    selectedAt: new Date().toISOString(),
    alternatives,
    userConfirmed,
  };

  writeFileSync(prefPath, JSON.stringify(data, null, 2), 'utf8');
}
