/**
 * @module DiscovererPreference
 * @description Discoverer 用户偏好持久化 + 冲突检测
 *
 * 当多个 Discoverer 匹配且置信度接近时，允许用户确认选择并持久化。
 * CLI 上下文使用 readline 交互，MCP/HTTP 上下文返回 ambiguous 标记。
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

const PREFERENCE_DIR = '.asd';
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
 */
function getPreferencePath(projectRoot: string): string {
  return join(projectRoot, PREFERENCE_DIR, PREFERENCE_FILE);
}

/**
 * 加载已保存的 Discoverer 偏好
 * @returns 偏好数据，或 null（无偏好/文件不存在/损坏）
 */
export function loadPreference(projectRoot: string): DiscovererPreferenceData | null {
  const prefPath = getPreferencePath(projectRoot);

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
 */
export function savePreference(
  projectRoot: string,
  discovererId: string,
  alternatives: string[],
  userConfirmed: boolean
): void {
  const prefPath = getPreferencePath(projectRoot);
  const prefDir = join(projectRoot, PREFERENCE_DIR);

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

// ── CLI Interactive Prompt ──────────────────────────

/**
 * CLI 交互式确认 Discoverer 选择
 * 仅在 CLI 终端上下文（stdin 可用）时有效
 *
 * @returns 用户选择的 Discoverer ID，或 null（非交互环境/超时）
 */
export async function promptDiscovererChoice(
  matches: DetectMatch[],
  recommended?: DetectMatch
): Promise<string | null> {
  // 检测是否在可交互终端
  if (!process.stdin.isTTY) {
    return null;
  }

  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const question = (prompt: string): Promise<string> =>
    new Promise((resolve) => {
      rl.question(prompt, (answer) => {
        resolve(answer.trim());
      });
    });

  try {
    console.log('\n⚠️  项目构建系统识别需要确认\n');
    console.log('检测到以下构建系统配置：');

    for (let i = 0; i < matches.length; i++) {
      const m = matches[i];
      const rec = recommended && m.discovererId === recommended.discovererId ? '  ← 推荐' : '';
      console.log(`  [${i + 1}] ${m.displayName}  confidence: ${m.confidence.toFixed(2)}${rec}`);
    }

    const defaultIdx = recommended
      ? matches.findIndex((m) => m.discovererId === recommended.discovererId) + 1
      : 1;

    const answer = await question(
      `\n请选择主要构建系统 [1-${matches.length}]，或按回车使用推荐 (${defaultIdx}): `
    );

    const choice = answer === '' ? defaultIdx : Number.parseInt(answer, 10);

    if (choice >= 1 && choice <= matches.length) {
      return matches[choice - 1].discovererId;
    }

    // 无效输入, 使用推荐
    return recommended?.discovererId ?? matches[0].discovererId;
  } finally {
    rl.close();
  }
}
