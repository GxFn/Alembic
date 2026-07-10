/**
 * classifyBootstrapErrorStatus(2026-07-10 BiliDili 冷启动缺陷回归)。
 *
 * 缺陷:15 维度 14 成功、68 候选、仅 ui-interaction 质量门耗尽,却因
 * completed_with_errors → failed 的一刀切映射把整个 bootstrap 报为 FAILED。
 * 修复语义:部分成功(completed>0)判 completed;零成功/数据缺失/会话级 failed 判 failed。
 */
import { describe, expect, it } from 'vitest';
import { classifyBootstrapErrorStatus } from '../../lib/daemon/jobs/bootstrapStatusClassification.js';

describe('classifyBootstrapErrorStatus', () => {
  it('部分成功:completed_with_errors 且 completed>0 → completed(单维失败不拖垮全局)', () => {
    // BiliDili 真实数据:14 成功 / 1 失败。
    expect(
      classifyBootstrapErrorStatus({ rawStatus: 'completed_with_errors', completedTasks: 14 })
    ).toBe('completed');
  });

  it('零成功:completed_with_errors 且 completed=0 → failed(真的什么都没产出)', () => {
    expect(
      classifyBootstrapErrorStatus({ rawStatus: 'completed_with_errors', completedTasks: 0 })
    ).toBe('failed');
  });

  it('数据缺失:completed_with_errors 但 completed 未知 → failed(保守,无法证明有产出)', () => {
    expect(
      classifyBootstrapErrorStatus({ rawStatus: 'completed_with_errors', completedTasks: null })
    ).toBe('failed');
    expect(
      classifyBootstrapErrorStatus({
        rawStatus: 'completed_with_errors',
        completedTasks: undefined,
      })
    ).toBe('failed');
  });

  it('会话级硬失败:rawStatus=failed → failed(不受 completed 影响)', () => {
    expect(classifyBootstrapErrorStatus({ rawStatus: 'failed', completedTasks: 14 })).toBe(
      'failed'
    );
  });

  it('非错误态:completed/undefined → null(交调用方按既有分支处理)', () => {
    expect(classifyBootstrapErrorStatus({ rawStatus: 'completed', completedTasks: 15 })).toBeNull();
    expect(classifyBootstrapErrorStatus({ rawStatus: undefined, completedTasks: 0 })).toBeNull();
  });
});
