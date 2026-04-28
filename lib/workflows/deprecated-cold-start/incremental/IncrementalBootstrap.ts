/**
 * IncrementalBootstrap — 增量冷启动控制器
 *
 * 基于 BootstrapSnapshot 存储的文件指纹，检测项目变更范围，
 * 推断受影响维度，并控制 fillDimensionsV3 仅执行受影响维度。
 *
 * 流程:
 *   1. 加载上次成功快照
 *   2. 扫描当前文件 → 计算 diff (added/modified/deleted)
 *   3. 推断受影响维度 → { mode, dimensions, skippedDimensions }
 *   4. 从快照恢复未变更维度的 EpisodicMemory
 *   5. 只对受影响维度执行 Analyst → Producer
 *   6. 完成后保存新快照
 *
 * @module pipeline/IncrementalBootstrap
 */

import { SessionStore } from '#agent/memory/SessionStore.js';
import type {
  BootstrapFile,
  LoggerLike,
  SaveSnapshotParams,
} from '#external/mcp/handlers/types.js';
import { BootstrapSnapshot } from '#workflows/deprecated-cold-start/incremental/BootstrapSnapshot.js';

// ──────────────────────────────────────────────────────────────
// IncrementalBootstrap 类
// ──────────────────────────────────────────────────────────────

export class IncrementalBootstrap {
  #snapshot;

  #logger;

  #projectRoot;

  constructor(db: unknown, projectRoot: string, { logger }: { logger?: LoggerLike | null } = {}) {
    this.#snapshot = new BootstrapSnapshot(db, { logger });
    this.#logger = logger || null;
    this.#projectRoot = projectRoot;
  }

  /**
   * 评估增量可行性 — 在 bootstrap 流程最开始调用
   *
   * @param currentFiles 当前扫描到的文件
   * @param allDimIds 所有可用维度 ID
   */
  evaluate(currentFiles: BootstrapFile[], allDimIds: string[]) {
    try {
      // 1. 加载上次快照
      const previousSnapshot = this.#snapshot.getLatest(this.#projectRoot);

      if (!previousSnapshot) {
        this.#log('No previous snapshot found — full bootstrap required');
        return {
          canIncremental: false,
          mode: 'full',
          affectedDimensions: allDimIds,
          skippedDimensions: [],
          previousSnapshot: null,
          diff: null,
          reason: '无历史快照，需要全量冷启动',
          restoredEpisodic: null,
        };
      }

      // 2. 计算 diff
      const diff = this.#snapshot.computeDiff(previousSnapshot, currentFiles, this.#projectRoot);

      this.#log(
        `Diff: +${diff.added.length} added, ~${diff.modified.length} modified, ` +
          `-${diff.deleted.length} deleted, =${diff.unchanged.length} unchanged ` +
          `(ratio: ${(diff.changeRatio * 100).toFixed(1)}%)`
      );

      // 3. 推断受影响维度
      const inference = this.#snapshot.inferAffectedDimensions(previousSnapshot, diff, allDimIds);

      if (inference.mode === 'full') {
        this.#log(`Full rebuild recommended: ${inference.reason}`);
        return {
          canIncremental: false,
          mode: 'full',
          affectedDimensions: allDimIds,
          skippedDimensions: [],
          previousSnapshot,
          diff,
          reason: inference.reason,
          restoredEpisodic: null,
        };
      }

      // 4. 增量可行 → 尝试恢复 SessionStore
      let restoredEpisodic: SessionStore | null = null;
      if (previousSnapshot.episodicData) {
        try {
          restoredEpisodic = SessionStore.fromJSON(previousSnapshot.episodicData);
          this.#log(
            `Restored SessionStore: ${restoredEpisodic.getCompletedDimensions().length} dimensions`
          );
        } catch (err: unknown) {
          this.#log(
            `Failed to restore SessionStore: ${err instanceof Error ? err.message : String(err)}`,
            'warn'
          );
        }
      }

      this.#log(
        `Incremental plan: ${inference.dimensions.length} affected, ` +
          `${inference.skippedDimensions.length} skipped — ${inference.reason}`
      );

      return {
        canIncremental: true,
        mode: 'incremental',
        affectedDimensions: inference.dimensions,
        skippedDimensions: inference.skippedDimensions,
        previousSnapshot,
        diff,
        reason: inference.reason,
        restoredEpisodic,
      };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.#log(`Incremental evaluation failed: ${errMsg} — fallback to full`, 'warn');
      return {
        canIncremental: false,
        mode: 'full',
        affectedDimensions: allDimIds,
        skippedDimensions: [],
        previousSnapshot: null,
        diff: null,
        reason: `增量评估失败 (${errMsg})，回退全量`,
        restoredEpisodic: null,
      };
    }
  }

  /**
   * 保存快照 — 在 bootstrap 完成后调用
   *
   * @param [params.meta] { durationMs, candidateCount, primaryLang }
   * @param [params.plan] evaluate() 返回的计划 (增量时)
   * @returns 快照 ID
   */
  saveSnapshot(params: SaveSnapshotParams) {
    const { sessionId, allFiles, dimensionStats, episodicMemory, meta = {}, plan = null } = params;

    // 构建带 referencedFilesList 的 dimensionStats
    const enrichedStats = { ...dimensionStats };
    if (episodicMemory) {
      for (const dimId of episodicMemory.getCompletedDimensions()) {
        const report = episodicMemory.getDimensionReport?.(dimId);
        if (report && enrichedStats[dimId]) {
          enrichedStats[dimId] = {
            ...enrichedStats[dimId],
            referencedFilesList: report.referencedFiles || [],
          };
        }
      }
    }

    return this.#snapshot.save({
      sessionId,
      projectRoot: this.#projectRoot,
      allFiles,
      dimensionStats: enrichedStats,
      episodicData: episodicMemory?.toJSON() || null,
      meta,
      isIncremental: plan?.mode === 'incremental',
      parentId: plan?.previousSnapshot?.id || null,
      changedFiles: plan?.diff
        ? [...(plan.diff.added || []), ...(plan.diff.modified || []), ...(plan.diff.deleted || [])]
        : [],
      affectedDims: plan?.affectedDimensions || [],
    });
  }

  /** 获取快照管理器 (用于直接查询) */
  getSnapshotManager() {
    return this.#snapshot;
  }

  #log(msg: string, level = 'info') {
    if (this.#logger) {
      const fn = (this.#logger as Record<string, ((...args: unknown[]) => void) | undefined>)[
        level
      ];
      fn?.(`[IncrementalBootstrap] ${msg}`);
    }
  }
}

export default IncrementalBootstrap;
