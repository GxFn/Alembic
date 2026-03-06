/**
 * checkpoint.js — Bootstrap 断点续传 (Checkpoint) 存储/恢复
 *
 * 在维度级粒度保存/加载/清理执行进度，支持意外中断后恢复。
 *
 * 调用方:
 *   - orchestrator.js (内部 Agent) — AI pipeline 每个维度完成后保存
 *   - dimension-complete.js (外部 Agent) — 外部 Agent 通知维度完成时保存
 *   - bootstrap.js — clearCheckpoints() 全量重建前清理
 *
 * @module pipeline/checkpoint
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import Logger from '../../../../../infrastructure/logging/Logger.js';
import pathGuard from '../../../../../shared/PathGuard.js';

const logger = Logger.getInstance();

const CHECKPOINT_TTL_MS = 3600_000; // 1小时内有效

/**
 * 保存维度级 checkpoint
 * @param {string} projectRoot
 * @param {string} sessionId
 * @param {string} dimId
 * @param {object} result 维度执行结果
 * @param {object} [digest] - DimensionDigest
 */
export async function saveDimensionCheckpoint(
  projectRoot,
  sessionId,
  dimId,
  result,
  digest = null
) {
  try {
    const checkpointDir = path.join(projectRoot, '.autosnippet', 'bootstrap-checkpoint');
    await fs.mkdir(checkpointDir, { recursive: true });
    await fs.writeFile(
      path.join(checkpointDir, `${dimId}.json`),
      JSON.stringify({ dimId, sessionId, ...result, digest, completedAt: Date.now() })
    );
  } catch (err) {
    logger.warn(`[Bootstrap-v3] checkpoint save failed for "${dimId}": ${err.message}`);
  }
}

/**
 * 加载有效的 checkpoints
 * @param {string} projectRoot
 * @returns {Promise<Map<string, object>>} dimId → checkpoint data
 */
export async function loadCheckpoints(projectRoot) {
  const checkpoints = new Map();
  try {
    const checkpointDir = path.join(projectRoot, '.autosnippet', 'bootstrap-checkpoint');
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

/**
 * 清理 checkpoint 目录
 * @param {string} projectRoot
 */
export async function clearCheckpoints(projectRoot) {
  try {
    const checkpointDir = path.join(projectRoot, '.autosnippet', 'bootstrap-checkpoint');
    pathGuard.assertSafe(checkpointDir);
    await fs.rm(checkpointDir, { recursive: true, force: true });
  } catch (err) {
    if (err?.name === 'PathGuardError') {
      throw err;
    }
    /* ignore other errors */
  }
}
