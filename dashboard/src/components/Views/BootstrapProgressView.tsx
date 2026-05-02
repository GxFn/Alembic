/**
 * BootstrapProgressView — 冷启动异步进度面板
 *
 * 展示每个维度任务的卡片状态：
 *   skeleton  → 灰色骨架动画
 *   filling   → 蓝色脉冲动画
 *   completed → 绿色勾号
 *   failed    → 红色叉号
 *
 * 全部完成后弹出通知。
 */

import React, { useEffect, useState } from 'react';
import { Check, X, Loader2, Sparkles, Code2, Layers, BookOpen, Zap, Settings, Bot, Brain, Filter, Wand2, GitMerge, Clock, Wrench, StopCircle } from 'lucide-react';
import { useI18n } from '../../i18n';
import type { BootstrapSession, BootstrapTask, ReviewState } from '../../hooks/useBootstrapSocket';

/* ═══════════════════════════════════════════════════════
 *  Icon & Color mapping
 * ═══════════════════════════════════════════════════════ */

/** 维度执行顺序 — 按 Tier 层级排列（统一维度注册表） */
const DIMENSION_EXECUTION_ORDER = [
  // Tier 1: 基础数据
  'architecture', 'swift-objc-idiom', 'ts-js-module', 'python-structure',
  'jvm-annotation', 'go-module', 'rust-ownership', 'csharp-dotnet',
  'react-patterns', 'vue-patterns', 'spring-patterns', 'swiftui-patterns', 'django-fastapi',
  // Tier 2: 规范+模式
  'coding-standards', 'design-patterns', 'ui-interaction',
  // Tier 3: 横切关注点+总结
  'error-resilience', 'concurrency-async', 'data-event-flow',
  'networking-api', 'testing-quality', 'security-auth',
  'performance-optimization', 'observability-logging', 'agent-guidelines',
];

const DIM_ICON_MAP: Record<string, React.ReactNode> = {
  // 新统一维度
  'architecture':              <Layers className="w-5 h-5" />,
  'coding-standards':          <BookOpen className="w-5 h-5" />,
  'design-patterns':           <Code2 className="w-5 h-5" />,
  'error-resilience':          <Sparkles className="w-5 h-5" />,
  'concurrency-async':         <Zap className="w-5 h-5" />,
  'data-event-flow':           <Zap className="w-5 h-5" />,
  'networking-api':            <Settings className="w-5 h-5" />,
  'ui-interaction':            <Layers className="w-5 h-5" />,
  'testing-quality':           <Code2 className="w-5 h-5" />,
  'security-auth':             <Settings className="w-5 h-5" />,
  'performance-optimization':  <Sparkles className="w-5 h-5" />,
  'observability-logging':     <BookOpen className="w-5 h-5" />,
  'agent-guidelines':          <Bot className="w-5 h-5" />,
};

function getDimIcon(dimId: string) {
  return DIM_ICON_MAP[dimId] || <Code2 className="w-5 h-5" />;
}

/* ═══════════════════════════════════════════════════════
 *  Task card component
 * ═══════════════════════════════════════════════════════ */

const TaskCard: React.FC<{ task: BootstrapTask }> = ({ task }) => {
  const { t } = useI18n();
  const { status, meta } = task;

  const statusStyles: Record<string, string> = {
    skeleton:  'bg-[var(--bg-subtle)] border-[var(--border-default)]',
    filling:   'bg-blue-50 border-blue-300',
    completed: 'bg-emerald-50 border-emerald-300',
    failed:    'bg-red-50 border-red-300',
  };

  const statusBadge: Record<string, React.ReactNode> = {
    skeleton: (
      <span className="flex items-center gap-1 text-xs text-[var(--fg-muted)]">
        <div className="w-2 h-2 rounded-full bg-[var(--border-emphasis)]" />
        {t('bootstrap.statusLabels.skeleton')}
      </span>
    ),
    filling: (
      <span className="flex items-center gap-1 text-xs text-blue-600">
        <Loader2 className="w-3 h-3 animate-spin" />
        {t('bootstrap.statusLabels.filling')}
      </span>
    ),
    completed: (
      <span className="flex items-center gap-1 text-xs text-emerald-600">
        <Check className="w-3 h-3" />
        {t('bootstrap.statusLabels.completed')}
      </span>
    ),
    failed: (
      <span className="flex items-center gap-1 text-xs text-red-600">
        <X className="w-3 h-3" />
        {t('bootstrap.statusLabels.failed')}
      </span>
    ),
  };

  return (
    <div className={`relative rounded-xl border p-4 transition-all duration-300 ${statusStyles[status] || statusStyles.skeleton}`}>
      {/* Skeleton shimmer overlay */}
      {status === 'skeleton' && (
        <div className="absolute inset-0 rounded-xl overflow-hidden">
          <div className="animate-pulse bg-gradient-to-r from-transparent via-[var(--border-default)]/40 to-transparent h-full w-full" />
        </div>
      )}

      {/* Filling pulse overlay */}
      {status === 'filling' && (
        <div className="absolute inset-0 rounded-xl overflow-hidden">
          <div className="animate-pulse bg-gradient-to-r from-transparent via-blue-200/30 to-transparent h-full w-full" />
        </div>
      )}

      <div className="relative z-10 flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className={`flex-shrink-0 p-2 rounded-lg ${
            status === 'completed' ? 'bg-emerald-100 text-emerald-600' :
            status === 'filling' ? 'bg-blue-100 text-blue-600' :
            status === 'failed' ? 'bg-red-100 text-red-600' :
            'bg-[var(--bg-subtle)] text-[var(--fg-muted)]'
          }`}>
            {getDimIcon(task.id)}
          </div>
          <div>
            <h3 className={`font-medium text-sm ${
              status === 'skeleton' ? 'text-[var(--fg-muted)]' : 'text-[var(--fg-primary)]'
            }`}>
              {(() => {
                const key = `bootstrap.pipelineLabels.${meta.dimId}`;
                const translated = t(key);
                return translated !== key ? translated : meta.label;
              })()}
            </h3>
            {status === 'completed' && task.result && (
              <p className="text-xs text-emerald-600 mt-0.5">
                {(() => {
                  const r = task.result as Record<string, unknown>;
                  const sourceCount = (r.sourceCount as number) ?? 0;
                  const extracted = (r.extracted as number) ?? 0;
                  if (r.type === 'empty') return t('bootstrap.noMatch');
                  if (r.type === 'skill') {
                    if (r.empty) return t('bootstrap.noMatch');
                    return extracted > 0
                      ? t('bootstrap.featuresAndCandidates', { sourceCount, extracted })
                      : t('bootstrap.featuresOnly', { sourceCount });
                  }
                  if (extracted > 0) return t('bootstrap.candidatesOnly', { extracted });
                  return t('bootstrap.noMatch');
                })()}
              </p>
            )}
            {status === 'failed' && task.error && (
              <p className="text-xs text-red-500 mt-0.5 truncate max-w-[240px]">
                {task.error}
              </p>
            )}
          </div>
        </div>
        <div className="flex-shrink-0">
          {statusBadge[status]}
        </div>
      </div>
    </div>
  );
};

/* ═══════════════════════════════════════════════════════
 *  AI Review Pipeline panel
 * ═══════════════════════════════════════════════════════ */

const REVIEW_ROUNDS = [
  { key: 'round1' as const, labelKey: 'bootstrap.reviewRounds.round1Label', descKey: 'bootstrap.reviewRounds.round1Desc', icon: <Filter className="w-4 h-4" /> },
  { key: 'round2' as const, labelKey: 'bootstrap.reviewRounds.round2Label', descKey: 'bootstrap.reviewRounds.round2Desc', icon: <Wand2 className="w-4 h-4" /> },
  { key: 'round3' as const, labelKey: 'bootstrap.reviewRounds.round3Label', descKey: 'bootstrap.reviewRounds.round3Desc', icon: <GitMerge className="w-4 h-4" /> },
] as const;

const ReviewPipelinePanel: React.FC<{ review: ReviewState }> = ({ review }) => {
  const { t } = useI18n();
  if (review.activeRound === 0) return null;

  return (
    <div className="mt-5 border border-purple-200 rounded-xl bg-purple-50/50 p-4">
      <div className="flex items-center gap-2 mb-3">
        <Brain className="w-5 h-5 text-purple-600" />
        <h3 className="text-sm font-semibold text-purple-800">{t('bootstrap.reviewPipeline')}</h3>
      </div>

      <div className="space-y-2.5">
        {REVIEW_ROUNDS.map(({ key, labelKey, descKey, icon }) => {
          const round = review[key];
          const isActive = round.status === 'running';
          const isDone = round.status === 'completed';
          const isIdle = round.status === 'idle';

          return (
            <div
              key={key}
              className={`flex items-center gap-3 p-2.5 rounded-lg border transition-all duration-300 ${
                isActive ? 'border-purple-300 bg-purple-100/60' :
                isDone    ? 'border-emerald-300 bg-emerald-50/60' :
                            'border-[var(--border-default)] bg-[var(--bg-surface)]'
              }`}
            >
              {/* Icon */}
              <div className={`flex-shrink-0 p-1.5 rounded-md ${
                isActive ? 'bg-purple-200 text-purple-700' :
                isDone    ? 'bg-emerald-100 text-emerald-600' :
                            'bg-[var(--bg-subtle)] text-[var(--fg-muted)]'
              }`}>
                {icon}
              </div>

              {/* Label + detail */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className={`text-sm font-medium ${isIdle ? 'text-[var(--fg-muted)]' : 'text-[var(--fg-primary)]'}`}>{t(labelKey)}</span>
                  <span className="text-xs text-[var(--fg-muted)]">{t(descKey)}</span>
                </div>

                {/* Round-specific progress details */}
                {key === 'round1' && isDone && (
                  <p className="text-xs text-emerald-600 mt-0.5">
                    {t('bootstrap.round1Done', { kept: review.round1.kept ?? '?', merged: review.round1.merged ?? 0, dropped: review.round1.dropped ?? 0 })}
                  </p>
                )}
                {key === 'round2' && isActive && typeof review.round2.progress === 'number' && (
                  <div className="mt-1.5">
                    <div className="w-full h-1.5 bg-purple-200 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-purple-500 rounded-full transition-all duration-300"
                        style={{ width: `${review.round2.progress}%` }}
                      />
                    </div>
                    <p className="text-xs text-purple-600 mt-0.5">{t('bootstrap.round2Progress', { current: review.round2.current ?? 0, total: review.round2.total ?? '?' })}</p>
                  </div>
                )}
                {key === 'round2' && isDone && (
                  <p className="text-xs text-emerald-600 mt-0.5">
                    {t('bootstrap.round2Done', { refined: review.round2.refined ?? '?', total: review.round2.total ?? '?' })}
                  </p>
                )}
                {key === 'round3' && isDone && (
                  <p className="text-xs text-emerald-600 mt-0.5">
                    {t('bootstrap.round3Done', { afterDedup: review.round3.afterDedup ?? '?', relationsFound: review.round3.relationsFound ?? 0 })}
                  </p>
                )}
              </div>

              {/* Status indicator */}
              <div className="flex-shrink-0">
                {isActive && <Loader2 className="w-4 h-4 text-purple-500 animate-spin" />}
                {isDone && <Check className="w-4 h-4 text-emerald-500" />}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

/* ═══════════════════════════════════════════════════════
 *  Time formatting helper
 * ═══════════════════════════════════════════════════════ */

function formatDuration(ms: number): string {
  if (ms < 0) return '--';
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min === 0) return `${sec}s`;
  return `${min}m ${sec.toString().padStart(2, '0')}s`;
}

/* ═══════════════════════════════════════════════════════
 *  Main progress panel
 * ═══════════════════════════════════════════════════════ */

interface BootstrapProgressViewProps {
  session: BootstrapSession | null;
  isAllDone: boolean;
  /** AI review pipeline state */
  reviewState?: ReviewState;
  /** Called when user acknowledges completion */
  onDismiss?: () => void;
  /** Called when user cancels the running operation */
  onCancel?: () => void;
  /** Whether cancel is in flight */
  isCancelling?: boolean;
}

const BootstrapProgressView: React.FC<BootstrapProgressViewProps> = ({
  session,
  isAllDone,
  reviewState,
  onDismiss,
  onCancel,
  isCancelling = false,
}) => {
  const { t } = useI18n();
  const [now, setNow] = useState(Date.now());

  // Tick every second while running
  useEffect(() => {
    if (!session || session.status !== 'running') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [session?.status]);

  // 通知逻辑已移至 App.tsx（App 层永远挂载，不受 tab 切换影响，彻底避免重复弹出）

  if (!session) return null;

  // ── Compute elapsed & estimated remaining time ──
  const elapsedMs = session.startedAt ? now - session.startedAt : (session.elapsedMs ?? 0);
  const done = session.completed + session.failed;
  const remaining = session.total - done;
  // Use server-reported elapsed (from last task completion) for remaining estimate — fixed, not ticking
  const serverElapsedMs = session.elapsedMs ?? 0;
  const estimatedRemainingMs = done > 0 && serverElapsedMs > 0 ? Math.round((serverElapsedMs / done) * remaining) : -1;
  const toolCalls = session.totalToolCalls ?? 0;

  const statusText =
    session.status === 'completed' ? t('bootstrap.allCompleted') :
    session.status === 'completed_with_errors' ? t('bootstrap.completedWithErrors') :
    null;

  return (
    <div className="bg-[var(--bg-surface)] rounded-2xl border border-[var(--border-default)] shadow-sm p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold text-[var(--fg-primary)]">{t('bootstrap.title')}</h2>
            {session.testMode?.enabled && (
              <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200">
                <Filter size={10} />
                {t('bootstrap.testMode')}
              </span>
            )}
          </div>
          {statusText && <p className="text-sm text-[var(--fg-secondary)] mt-0.5">{statusText}</p>}
          {session.testMode?.enabled && (
            <p className="text-xs text-amber-600 mt-0.5">
              {t('bootstrap.testModeHint', {
                bootstrap: session.testMode.bootstrapDims.length > 0 ? session.testMode.bootstrapDims.join(', ') : t('bootstrap.testModeAll'),
                rescan: session.testMode.rescanDims.length > 0 ? session.testMode.rescanDims.join(', ') : t('bootstrap.testModeAll'),
              })}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* Cancel button — only when running */}
          {session.status === 'running' && onCancel && (
            <button
              onClick={onCancel}
              disabled={isCancelling}
              className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg border border-red-200 bg-red-50 hover:bg-red-100 text-red-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isCancelling ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <StopCircle size={14} />
              )}
              {t('bootstrap.cancel')}
            </button>
          )}
          {/* Dismiss button — only when done */}
          {isAllDone && onDismiss && (
            <button
              onClick={onDismiss}
              className="text-sm px-3 py-1.5 rounded-lg bg-[var(--bg-subtle)] hover:bg-[var(--bg-subtle)] text-[var(--fg-secondary)] transition-colors"
          >
            {t('bootstrap.close')}
          </button>
          )}
        </div>
      </div>

      {/* Stats bar — elapsed time, remaining time, tool calls */}
      <div className="flex flex-wrap items-center gap-4 mb-5 text-sm">
        <div className="flex items-center gap-1.5 text-[var(--fg-secondary)]">
          <Clock size={14} className="text-[var(--fg-muted)]" />
          <span>{t('bootstrap.elapsed')} <span className="font-medium text-[var(--fg-primary)]">{formatDuration(elapsedMs)}</span></span>
        </div>
        {session.status === 'running' && remaining > 0 && estimatedRemainingMs > 0 && (
          <div className="flex items-center gap-1.5 text-[var(--fg-secondary)]">
            <Clock size={14} className="text-blue-400" />
            <span>{t('bootstrap.estimatedRemaining')} <span className="font-medium text-blue-600">{formatDuration(estimatedRemainingMs)}</span></span>
          </div>
        )}
        <div className="flex items-center gap-1.5 text-[var(--fg-secondary)]">
          <Wrench size={14} className="text-[var(--fg-muted)]" />
          <span>{t('bootstrap.toolCalls')} <span className="font-medium text-[var(--fg-primary)]">{toolCalls}</span></span>
        </div>
        <div className="text-[var(--fg-muted)] text-xs">
          {t('bootstrap.dimensions', { done, total: session.total })}
        </div>
      </div>

      {/* Task cards grid — sorted by execution order */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
        {[...session.tasks]
          .sort((a, b) => {
            const ai = DIMENSION_EXECUTION_ORDER.indexOf(a.meta?.dimId ?? a.id);
            const bi = DIMENSION_EXECUTION_ORDER.indexOf(b.meta?.dimId ?? b.id);
            return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
          })
          .map(task => (
            <TaskCard key={task.id} task={task} />
          ))}
      </div>

      {/* AI Review pipeline progress */}
      {reviewState && reviewState.activeRound > 0 && (
        <ReviewPipelinePanel review={reviewState} />
      )}
    </div>
  );
};

export default BootstrapProgressView;
