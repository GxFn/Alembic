/**
 * RefineProgressBar — AI 润色实时进度条
 *
 * 显示批量 AI 润色的逐条进度：
 *   - 进度百分比 + 文字（3/20 润色中）
 *   - 当前正在处理的候选名称
 *   - 完成后显示结果统计
 */

import React, { useEffect, useRef } from 'react';
import { Sparkles, Check, X, Loader2 } from 'lucide-react';
import { notify } from '../../utils/notification';
import type { RefineSession } from '../../hooks/useRefineSocket';
import { useI18n } from '../../i18n';

interface RefineProgressBarProps {
  refine: RefineSession | null;
  isRefineDone: boolean;
  onDismiss?: () => void;
}

const RefineProgressBar: React.FC<RefineProgressBarProps> = ({ refine, isRefineDone, onDismiss }) => {
  const { t } = useI18n();
  const notifiedRef = useRef(false);

  useEffect(() => {
    if (isRefineDone && refine && !notifiedRef.current) {
      notifiedRef.current = true;
      const msg = refine.failed > 0
        ? t('refineProgress.doneMsgWithFail', { refined: String(refine.refined), failed: String(refine.failed) })
        : t('refineProgress.doneMsg', { refined: String(refine.refined) });
      notify(msg, { title: t('refineProgress.doneTitle'), type: refine.failed > 0 ? 'error' : 'success' });
    }
  }, [isRefineDone, refine]);

  useEffect(() => {
    if (!refine) notifiedRef.current = false;
  }, [refine]);

  if (!refine) return null;

  const currentItem = refine.items.find(i => i.status === 'refining');
  const doneCount = refine.items.filter(i => i.status === 'done' || i.status === 'failed').length;

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4 mb-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className={`p-1.5 rounded-lg ${isRefineDone ? 'bg-emerald-50' : 'bg-blue-50'}`}>
            {isRefineDone
              ? <Check className="w-4 h-4 text-emerald-600" />
              : <Sparkles className="w-4 h-4 text-blue-600" />
            }
          </div>
          <div>
            <h3 className="text-sm font-semibold text-slate-800">
              {isRefineDone ? t('refineProgress.doneTitle') : t('refineProgress.runningTitle')}
            </h3>
            <p className="text-xs text-slate-500">
              {isRefineDone
                ? (refine.failed > 0
                    ? t('refineProgress.doneMsgWithFail', { refined: String(refine.refined), failed: String(refine.failed) })
                    : t('refineProgress.doneMsg', { refined: String(refine.refined) }))
                : t('refineProgress.progressMsg', { done: String(doneCount), total: String(refine.total) })
              }
              {currentItem && !isRefineDone && (
                <span className="ml-2 text-blue-600">
                  <Loader2 className="w-3 h-3 inline animate-spin mr-1" />
                  {currentItem.title || currentItem.candidateId.slice(0, 8)}
                </span>
              )}
            </p>
          </div>
        </div>
        {isRefineDone && onDismiss && (
          <button
            onClick={onDismiss}
            className="text-xs px-2.5 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-600 transition-colors"
          >
            {t('refineProgress.closeBtn')}
          </button>
        )}
      </div>

      {/* Progress bar */}
      <div className="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ease-out ${
            isRefineDone
              ? refine.failed > 0 ? 'bg-amber-400' : 'bg-emerald-500'
              : 'bg-blue-500'
          }`}
          style={{ width: `${refine.progress}%` }}
        />
      </div>

      {/* Failed items summary (if any) */}
      {isRefineDone && refine.failed > 0 && (
        <div className="mt-2 text-xs text-red-500 flex items-center gap-1">
          <X className="w-3 h-3" />
          {refine.items.filter(i => i.status === 'failed').map(i => i.title || i.candidateId.slice(0, 8)).join('、')}
        </div>
      )}
    </div>
  );
};

export default RefineProgressBar;
