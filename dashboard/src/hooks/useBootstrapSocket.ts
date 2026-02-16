/**
 * useBootstrapSocket — Socket.io hook for bootstrap progress events
 *
 * Uses a shared singleton socket connection (lib/socket.ts) and listens
 * for bootstrap:* events to update progress state.
 *
 * On reconnect, polls GET /bootstrap/status to catch up on missed events.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { getSocket } from '../lib/socket';
import api from '../api';

/* ═══════════════════════════════════════════════════════
 *  Types
 * ═══════════════════════════════════════════════════════ */

export interface BootstrapTaskMeta {
  type: 'skill' | 'candidate';
  dimId: string;
  label: string;
  skillWorthy: boolean;
  skillMeta?: { name: string; description: string } | null;
}

export interface BootstrapTask {
  id: string;
  status: 'skeleton' | 'filling' | 'completed' | 'failed';
  meta: BootstrapTaskMeta;
  startedAt?: number | null;
  completedAt?: number | null;
  result?: Record<string, unknown> | null;
  error?: string | null;
}

/** AI 审查轮次状态 */
export type ReviewRoundStatus = 'idle' | 'running' | 'completed';

export interface ReviewState {
  /** 当前正在执行的轮次 (0 = 未开始, 1/2/3) */
  activeRound: 0 | 1 | 2 | 3;
  round1: { status: ReviewRoundStatus; total?: number; kept?: number; dropped?: number; merged?: number };
  round2: { status: ReviewRoundStatus; total?: number; current?: number; progress?: number; refined?: number };
  round3: { status: ReviewRoundStatus; total?: number; afterDedup?: number; relationsFound?: number };
}

const INITIAL_REVIEW_STATE: ReviewState = {
  activeRound: 0,
  round1: { status: 'idle' },
  round2: { status: 'idle' },
  round3: { status: 'idle' },
};

export interface BootstrapSession {
  id: string;
  status: 'running' | 'completed' | 'completed_with_errors' | 'idle';
  progress: number;
  total: number;
  completed: number;
  failed: number;
  filling: number;
  skeleton: number;
  tasks: BootstrapTask[];
  summary?: Record<string, unknown> | null;
  /** AI 审查管线状态 */
  review?: ReviewState;
  /** 会话开始时间戳 (ms) */
  startedAt?: number;
  /** 累计工具调用次数 */
  totalToolCalls?: number;
  /** 后端计算的已用毫秒 */
  elapsedMs?: number;
}

interface UseBootstrapSocketReturn {
  /** Current bootstrap session state */
  session: BootstrapSession | null;
  /** Whether socket is connected */
  isConnected: boolean;
  /** Whether all tasks are done */
  isAllDone: boolean;
  /** AI review pipeline state */
  reviewState: ReviewState;
  /** Reset session (clear state) */
  resetSession: () => void;
  /** Start session from API response skeleton */
  initFromApiResponse: (sessionData: BootstrapSession) => void;
}

/* ═══════════════════════════════════════════════════════
 *  Hook
 * ═══════════════════════════════════════════════════════ */

export function useBootstrapSocket(): UseBootstrapSocketReturn {
  const [session, setSession] = useState<BootstrapSession | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [reviewState, setReviewState] = useState<ReviewState>(INITIAL_REVIEW_STATE);
  const sessionIdRef = useRef<string | null>(null);
  const recoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const socket = getSocket();

    // ── Connection state ──
    const onConnect = () => {
      setIsConnected(true);
      // Fix 7: 初始连接 + 重连均恢复 bootstrap 状态（避免页面刷新后丢失 session）
      // 节流：500ms 内多次 connect 事件只调一次（StrictMode / 快速重连场景）
      if (recoverTimerRef.current) clearTimeout(recoverTimerRef.current);
      recoverTimerRef.current = setTimeout(() => recoverBootstrapStatus(), 500);
    };
    const onDisconnect = () => setIsConnected(false);

    // ── Fix 4+7: 恢复 bootstrap 状态（初始连接 + 重连均调用）──
    const recoverBootstrapStatus = async () => {
      try {
        const status = await api.getBootstrapStatus();
        // 只恢复正在运行中的 session，已完成/失败的不再续传
        if (status && status.status === 'running' && status.tasks) {
          // Only update if the session matches or is newer
          setSession(prev => {
            if (!prev || prev.id === status.id || status.progress > (prev?.progress ?? 0)) {
              sessionIdRef.current = status.id;
              return status as BootstrapSession;
            }
            return prev;
          });
        }
      } catch {
        // Server unreachable — ignore, socket events will resume
      }
    };

    const onReconnect = () => recoverBootstrapStatus();

    // ── Bootstrap progress events ──

    const onStarted = (data: { tasks: Array<{ id: string } & BootstrapTaskMeta>; total: number; sessionId: string; startedAt?: number }) => {
      sessionIdRef.current = data.sessionId;
      setReviewState(INITIAL_REVIEW_STATE); // 新 session 重置 AI 审查状态
      setSession({
        id: data.sessionId,
        status: 'running',
        progress: 0,
        total: data.total,
        completed: 0,
        failed: 0,
        filling: 0,
        skeleton: data.total,
        startedAt: data.startedAt || Date.now(),
        totalToolCalls: 0,
        elapsedMs: 0,
        tasks: data.tasks.map(t => ({
          id: t.id,
          status: 'skeleton' as const,
          meta: { type: t.type, dimId: t.dimId, label: t.label, skillWorthy: t.skillWorthy, skillMeta: t.skillMeta },
        })),
      });
    };

    const onTaskStarted = (data: { taskId: string; progress: number }) => {
      setSession(prev => {
        if (!prev) return prev;
        const updatedTasks = prev.tasks.map(t =>
          t.id === data.taskId
            ? { ...t, status: 'filling' as const, startedAt: Date.now() }
            : t
        );
        return {
          ...prev,
          progress: data.progress,
          tasks: updatedTasks,
          filling: updatedTasks.filter(t => t.status === 'filling').length,
          skeleton: updatedTasks.filter(t => t.status === 'skeleton').length,
        };
      });
    };

    const onTaskCompleted = (data: { taskId: string; result: Record<string, unknown>; progress: number; completed: number; total: number; totalToolCalls?: number; elapsedMs?: number }) => {
      setSession(prev => {
        if (!prev) return prev;
        const updatedTasks = prev.tasks.map(t =>
          t.id === data.taskId
            ? { ...t, status: 'completed' as const, completedAt: Date.now(), result: data.result }
            : t
        );
        return {
          ...prev,
          progress: data.progress,
          completed: data.completed,
          total: data.total,
          totalToolCalls: data.totalToolCalls ?? prev.totalToolCalls,
          elapsedMs: data.elapsedMs ?? prev.elapsedMs,
          tasks: updatedTasks,
          filling: updatedTasks.filter(t => t.status === 'filling').length,
          skeleton: updatedTasks.filter(t => t.status === 'skeleton').length,
        };
      });
    };

    const onTaskFailed = (data: { taskId: string; error: string; progress: number }) => {
      setSession(prev => {
        if (!prev) return prev;
        const updatedTasks = prev.tasks.map(t =>
          t.id === data.taskId
            ? { ...t, status: 'failed' as const, completedAt: Date.now(), error: data.error }
            : t
        );
        return {
          ...prev,
          progress: data.progress,
          failed: updatedTasks.filter(t => t.status === 'failed').length,
          tasks: updatedTasks,
          filling: updatedTasks.filter(t => t.status === 'filling').length,
          skeleton: updatedTasks.filter(t => t.status === 'skeleton').length,
        };
      });
    };

    const onAllCompleted = (data: { sessionId: string; summary: Record<string, unknown> }) => {
      setSession(prev => {
        if (!prev) return prev;
        // 只处理当前 session 的完成事件（abort 后的旧 session 完成事件应忽略）
        if (data.sessionId && prev.id !== data.sessionId) return prev;
        // Fix 9: 将所有未完成的任务标记为 completed（防止丢失个别 task-completed 事件时卡在"等待中"）
        const finalTasks = prev.tasks.map(t =>
          t.status === 'skeleton' || t.status === 'filling'
            ? { ...t, status: 'completed' as const, completedAt: Date.now() }
            : t
        );
        return {
          ...prev,
          status: finalTasks.some(t => t.status === 'failed') ? 'completed_with_errors' : 'completed',
          progress: 100,
          completed: finalTasks.filter(t => t.status === 'completed').length,
          summary: data.summary,
          tasks: finalTasks,
          filling: 0,
          skeleton: 0,
        };
      });
    };

    // ── AI Review progress events ──

    const onReviewR1Started = (data: { total: number }) => {
      setReviewState(prev => ({ ...prev, activeRound: 1, round1: { status: 'running', total: data.total } }));
    };
    const onReviewR1Completed = (data: { kept: number; dropped: number; merged: number; total: number }) => {
      setReviewState(prev => ({
        ...prev,
        activeRound: 1,
        round1: { status: 'completed', total: data.total, kept: data.kept, dropped: data.dropped, merged: data.merged },
      }));
    };
    const onReviewR2Started = (data: { total: number }) => {
      setReviewState(prev => ({ ...prev, activeRound: 2, round2: { status: 'running', total: data.total } }));
    };
    const onReviewR2Progress = (data: { current: number; total: number; progress: number }) => {
      setReviewState(prev => ({
        ...prev,
        activeRound: 2,
        round2: { ...prev.round2, status: 'running', current: data.current, total: data.total, progress: data.progress },
      }));
    };
    const onReviewR2Completed = (data: { total: number; refined: number }) => {
      setReviewState(prev => ({
        ...prev,
        activeRound: 2,
        round2: { status: 'completed', total: data.total, refined: data.refined, progress: 100 },
      }));
    };
    const onReviewR3Started = (data: { total: number }) => {
      setReviewState(prev => ({ ...prev, activeRound: 3, round3: { status: 'running', total: data.total } }));
    };
    const onReviewR3Completed = (data: { total: number; afterDedup: number; relationsFound: number }) => {
      setReviewState(prev => ({
        ...prev,
        activeRound: 3,
        round3: { status: 'completed', total: data.total, afterDedup: data.afterDedup, relationsFound: data.relationsFound },
      }));
    };

    // ── Register listeners ──
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.io.on('reconnect', onReconnect);
    socket.on('bootstrap:started', onStarted);
    socket.on('bootstrap:task-started', onTaskStarted);
    socket.on('bootstrap:task-completed', onTaskCompleted);
    socket.on('bootstrap:task-failed', onTaskFailed);
    socket.on('bootstrap:all-completed', onAllCompleted);
    socket.on('review:round1-started', onReviewR1Started);
    socket.on('review:round1-completed', onReviewR1Completed);
    socket.on('review:round2-started', onReviewR2Started);
    socket.on('review:round2-progress', onReviewR2Progress);
    socket.on('review:round2-completed', onReviewR2Completed);
    socket.on('review:round3-started', onReviewR3Started);
    socket.on('review:round3-completed', onReviewR3Completed);

    // Sync initial connection state
    setIsConnected(socket.connected);

    // Fix 8: 如果 socket 已连接（单例复用），connect 事件不会再触发，
    // 需要主动调用 recoverBootstrapStatus 恢复 session
    if (socket.connected) {
      recoverBootstrapStatus();
    }

    // Cleanup: only remove listeners, do NOT disconnect shared socket
    return () => {
      if (recoverTimerRef.current) clearTimeout(recoverTimerRef.current);
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.io.off('reconnect', onReconnect);
      socket.off('bootstrap:started', onStarted);
      socket.off('bootstrap:task-started', onTaskStarted);
      socket.off('bootstrap:task-completed', onTaskCompleted);
      socket.off('bootstrap:task-failed', onTaskFailed);
      socket.off('bootstrap:all-completed', onAllCompleted);
      socket.off('review:round1-started', onReviewR1Started);
      socket.off('review:round1-completed', onReviewR1Completed);
      socket.off('review:round2-started', onReviewR2Started);
      socket.off('review:round2-progress', onReviewR2Progress);
      socket.off('review:round2-completed', onReviewR2Completed);
      socket.off('review:round3-started', onReviewR3Started);
      socket.off('review:round3-completed', onReviewR3Completed);
    };
  }, []);

  const resetSession = useCallback(() => {
    sessionIdRef.current = null;
    setSession(null);
    setReviewState(INITIAL_REVIEW_STATE);
  }, []);

  const initFromApiResponse = useCallback((sessionData: BootstrapSession) => {
    if (sessionData) {
      setSession(prev => {
        if (prev && prev.id === sessionData.id) {
          // progress 只计 completed/failed，filling 不算；需额外对比 active 任务数
          const prevActive = (prev.filling ?? 0) + (prev.completed ?? 0) + (prev.failed ?? 0);
          const apiActive = (sessionData.filling ?? 0) + (sessionData.completed ?? 0) + (sessionData.failed ?? 0);
          if (prev.progress > sessionData.progress || prevActive > apiActive) {
            return prev; // socket 驱动的状态更新，不要被 API 快照覆盖
          }
        }
        sessionIdRef.current = sessionData.id;
        return sessionData;
      });
    }
  }, []);

  const isAllDone = session?.status === 'completed' || session?.status === 'completed_with_errors';

  return { session, isConnected, isAllDone, reviewState, resetSession, initFromApiResponse };
}
