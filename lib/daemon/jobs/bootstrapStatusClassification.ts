import type { DaemonJobStatus } from '@alembic/core/daemon';

/**
 * bootstrap session 状态 → job 状态的分类(单源,供 DaemonJobRunner 与 http/routes/jobs 共用)。
 *
 * 修复(2026-07-10 BiliDili 真实冷启动):此前 `completed_with_errors` 一律映射为 `failed`,
 * 于是"15 维度里 14 个成功、产出 68 条候选、仅 1 个维度质量门耗尽"被整体报为 bootstrap
 * FAILED(UI 红)。这不成比例——一个产出了绝大多数知识的冷启动是成功的,单维度失败应作为
 * 警告显示在该维度卡片与 warnings 里,而不是拖垮整个 job。
 *
 * 正确语义(job 状态无 partial 档,只能落 completed/failed):
 *   - session `failed`(会话级硬失败/编排错误)              → failed
 *   - `completed_with_errors` 且【确有】成功任务(completed>0) → completed(部分成功)
 *   - `completed_with_errors` 且零成功 / completed 数据缺失    → failed(无法证明有产出,保守)
 *   - 其它(completed)                                        → completed
 * 取消/中止由调用方在此之前判定,不在本函数职责内。
 */
export function classifyBootstrapErrorStatus(input: {
  rawStatus: string | undefined;
  completedTasks: number | null | undefined;
}): DaemonJobStatus | null {
  if (input.rawStatus === 'failed') {
    return 'failed';
  }
  if (input.rawStatus === 'completed_with_errors') {
    // 只有正向确认到成功任务才降级为 completed;数据缺失/零成功保守判 failed。
    return typeof input.completedTasks === 'number' && input.completedTasks > 0
      ? 'completed'
      : 'failed';
  }
  // 非错误态:交调用方按其既有分支处理(返回 null 表示"本函数不裁决")。
  return null;
}
