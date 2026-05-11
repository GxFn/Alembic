/**
 * test-mode.ts — 通用测试模式支持
 *
 * 通过 .env 配置启用测试模式，限制 bootstrap / rescan 维度数量以加速端到端测试。
 * 终端能力已成为默认沙箱能力；这里仅保留终端档位覆盖配置。
 *
 * 环境变量:
 *   ALEMBIC_TEST_MODE=1                                    启用测试模式
 *   ALEMBIC_TEST_BOOTSTRAP_DIMS=arch,coding                冷启动阶段维度 (逗号分隔 ID)
 *   ALEMBIC_TEST_RESCAN_DIMS=design-patterns               增量扫描阶段维度 (逗号分隔 ID)
 *   ALEMBIC_TERMINAL_TOOLSET=terminal-run                   终端工具集 (baseline|terminal-run|terminal-shell|terminal-pty)
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

/** 终端默认能力配置 */
export interface TerminalConfig {
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
  terminal: TerminalConfig;
  sandbox: SandboxStatusConfig;
}

/**
 * 解析终端能力配置
 *
 * 终端执行已由沙箱治理，默认开放 terminal-run。
 * 使用 ALEMBIC_TERMINAL_TOOLSET=baseline 可显式回退到无终端档位。
 * 不再读取旧测试开关；测试模式只负责维度过滤。
 */
function resolveTerminalConfig(): TerminalConfig {
  const toolset = envStr('ALEMBIC_TERMINAL_TOOLSET') || 'terminal-run';
  return { enabled: toolset !== 'baseline', toolset };
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
    terminal: resolveTerminalConfig(),
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
