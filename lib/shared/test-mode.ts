/**
 * test-mode.ts — 通用测试模式支持
 *
 * 通过 .env 配置启用测试模式，限制 bootstrap / rescan 维度数量以加速端到端测试，
 * 并统一管理终端测试能力的接入开关。
 *
 * 环境变量:
 *   ALEMBIC_TEST_MODE=1                                    启用测试模式
 *   ALEMBIC_TEST_BOOTSTRAP_DIMS=arch,coding                冷启动阶段维度 (逗号分隔 ID)
 *   ALEMBIC_TEST_RESCAN_DIMS=design-patterns               增量扫描阶段维度 (逗号分隔 ID)
 *   ALEMBIC_TEST_TERMINAL=1                                启用终端测试能力
 *   ALEMBIC_TEST_TERMINAL_TOOLSET=terminal-run              终端工具集 (baseline|terminal-run|terminal-shell|terminal-pty)
 *
 * 兼容旧环境变量:
 *   ALEMBIC_BOOTSTRAP_TERMINAL_TEST → ALEMBIC_TEST_TERMINAL
 *   ALEMBIC_BOOTSTRAP_TERMINAL_TOOLSET → ALEMBIC_TEST_TERMINAL_TOOLSET
 *
 * 当 ALEMBIC_TEST_MODE 未设置或为 falsy 时，所有 API 透明返回原始数据。
 */

import Logger from '#infra/logging/Logger.js';
import type { DimensionDef } from '#types/project-snapshot.js';

function envBool(key: string): boolean {
  const v = process.env[key];
  return v === '1' || v === 'true';
}

function envList(key: string): string[] {
  const v = process.env[key]?.trim();
  if (!v) {
    return [];
  }
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function envStr(key: string): string {
  return (process.env[key] ?? '').trim();
}

/** 是否启用了测试模式 */
export function isTestMode(): boolean {
  return envBool('ALEMBIC_TEST_MODE');
}

/** 终端测试能力配置 */
export interface TestTerminalConfig {
  enabled: boolean;
  toolset: string;
}

/** 沙箱状态信息 */
export interface SandboxStatusConfig {
  mode: string;
  available: boolean;
}

/** 完整测试模式配置 */
export interface TestModeConfig {
  enabled: boolean;
  bootstrapDims: string[];
  rescanDims: string[];
  terminal: TestTerminalConfig;
  sandbox: SandboxStatusConfig;
}

/**
 * 解析终端测试能力配置
 *
 * 优先级: ALEMBIC_TEST_TERMINAL > ALEMBIC_BOOTSTRAP_TERMINAL_TEST（兼容旧值）
 * 工具集: ALEMBIC_TEST_TERMINAL_TOOLSET > ALEMBIC_BOOTSTRAP_TERMINAL_TOOLSET
 */
function resolveTerminalTestConfig(): TestTerminalConfig {
  const enabled = envBool('ALEMBIC_TEST_TERMINAL') || envBool('ALEMBIC_BOOTSTRAP_TERMINAL_TEST');
  const toolset =
    envStr('ALEMBIC_TEST_TERMINAL_TOOLSET') ||
    envStr('ALEMBIC_BOOTSTRAP_TERMINAL_TOOLSET') ||
    (enabled ? 'terminal-run' : 'baseline');
  return { enabled, toolset };
}

function resolveSandboxStatus(): SandboxStatusConfig {
  const v = (process.env.ALEMBIC_SANDBOX_MODE ?? '').trim().toLowerCase();
  const mode =
    v === 'disabled' || v === '0' || v === 'off' ? 'disabled' : v === 'audit' ? 'audit' : 'enforce';
  return { mode, available: process.platform === 'darwin' };
}

/** 获取测试模式完整配置（供 API / 前端展示 / 终端工具集解析） */
export function getTestModeConfig(): TestModeConfig {
  return {
    enabled: isTestMode(),
    bootstrapDims: envList('ALEMBIC_TEST_BOOTSTRAP_DIMS'),
    rescanDims: envList('ALEMBIC_TEST_RESCAN_DIMS'),
    terminal: resolveTerminalTestConfig(),
    sandbox: resolveSandboxStatus(),
  };
}

/**
 * 根据测试模式配置过滤维度
 *
 * - 测试模式关闭时原样返回
 * - 测试模式开启但未配置对应阶段的维度 ID 时原样返回（不限制）
 * - 测试模式开启且有配置时，只保留配置中列出的维度
 */
export function applyTestDimensionFilter(
  dimensions: DimensionDef[],
  mode: 'bootstrap' | 'rescan'
): DimensionDef[] {
  if (!isTestMode()) {
    return dimensions;
  }

  const configKey =
    mode === 'bootstrap' ? 'ALEMBIC_TEST_BOOTSTRAP_DIMS' : 'ALEMBIC_TEST_RESCAN_DIMS';
  const allowedIds = envList(configKey);

  if (allowedIds.length === 0) {
    return dimensions;
  }

  const allowedSet = new Set(allowedIds);
  const filtered = dimensions.filter((d) => allowedSet.has(d.id));

  Logger.info(
    `[TestMode] ${mode} dimension filter: ${filtered.map((d) => d.id).join(', ')} (${filtered.length}/${dimensions.length})`
  );

  return filtered;
}
