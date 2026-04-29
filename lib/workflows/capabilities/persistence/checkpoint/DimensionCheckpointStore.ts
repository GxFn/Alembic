/**
 * DimensionCheckpointStore — 维度执行断点存储/恢复
 *
 * 在维度级粒度保存/加载/清理执行进度，支持意外中断后恢复。
 *
 * 调用方:
 *   - orchestrator.js (内部 Agent) — AI pipeline 每个维度完成后保存
 *   - dimension-complete.js (外部 Agent) — 外部 Agent 通知维度完成时保存
 *   - workflow cleanup — clearDimensionCheckpoints() 全量重建前清理
 *
 * @module pipeline/checkpoint
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import Logger from '#infra/logging/Logger.js';
import pathGuard from '#shared/PathGuard.js';

const logger = Logger.getInstance();

const CHECKPOINT_TTL_MS = 3600_000; // 1小时内有效

/**
 * 保存维度级 checkpoint
 * @param result 维度执行结果
 * @param [digest] DimensionDigest
 */
export async function saveDimensionCheckpoint(
  dataRoot: string,
  sessionId: string,
  dimId: string,
  result: Record<string, unknown>,
  digest = null
) {
  try {
    const checkpointDir = path.join(dataRoot, '.asd', 'bootstrap-checkpoint');
    await fs.mkdir(checkpointDir, { recursive: true });
    await fs.writeFile(
      path.join(checkpointDir, `${dimId}.json`),
      JSON.stringify({ dimId, sessionId, ...result, digest, completedAt: Date.now() })
    );
  } catch (err: unknown) {
    logger.warn(
      `[Bootstrap-v3] checkpoint save failed for "${dimId}": ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * 加载有效的 checkpoints
 * @returns dimId → checkpoint data
 */
export async function loadDimensionCheckpoints(dataRoot: string) {
  const checkpoints = new Map();
  try {
    const checkpointDir = path.join(dataRoot, '.asd', 'bootstrap-checkpoint');
    const files = await fs.readdir(checkpointDir).catch(() => []);
    const now = Date.now();
    for (const file of files) {
      if (!file.endsWith('.json')) {
        continue;
      }
      try {
        const content = await fs.readFile(path.join(checkpointDir, file), 'utf-8');
        const data = JSON.parse(content);
        if (data.completedAt && now - data.completedAt < CHECKPOINT_TTL_MS) {
          checkpoints.set(data.dimId, data);
        }
      } catch {
        /* skip corrupt checkpoint */
      }
    }
  } catch {
    /* checkpoint dir doesn't exist */
  }
  return checkpoints;
}

/** 清理 checkpoint 目录 */
export async function clearDimensionCheckpoints(dataRoot: string) {
  try {
    const checkpointDir = path.join(dataRoot, '.asd', 'bootstrap-checkpoint');
    pathGuard.assertSafe(checkpointDir);
    await fs.rm(checkpointDir, { recursive: true, force: true });
  } catch (err: unknown) {
    if ((err as { name?: string })?.name === 'PathGuardError') {
      throw err;
    }
    /* ignore other errors */
  }
}

export const loadCheckpoints = loadDimensionCheckpoints;
export const clearCheckpoints = clearDimensionCheckpoints;
