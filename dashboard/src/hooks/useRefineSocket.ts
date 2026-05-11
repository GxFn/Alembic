/**
 * useRefineSocket — Socket.io hook for AI refine progress events
 *
 * Listens for refine:* events pushed from the backend during
 * batch AI refinement of bootstrap candidates.
 *
 * Events:
 *   refine:started        — { total, candidateIds }
 *   refine:item-started   — { candidateId, title, current, total, progress }
 *   refine:item-completed — { candidateId, title, refined, current, total, progress, refinedSoFar }
 *   refine:item-failed    — { candidateId, title, error, current, total, progress }
 *   refine:completed      — { total, refined, failed }
 */

import { useState, useEffect, useCallback } from 'react';
import { getSocket } from '../lib/socket';

/* ═══════════════════════════════════════════════════════
 *  Types
 * ═══════════════════════════════════════════════════════ */

export interface RefineItemStatus {
  candidateId: string;
  title: string;
  status: 'pending' | 'refining' | 'done' | 'failed';
  refined?: boolean;
  error?: string | null;
}

export interface RefineSession {
  status: 'idle' | 'running' | 'completed';
  total: number;
  current: number;
  progress: number;
  refined: number;
  failed: number;
  items: RefineItemStatus[];
}

interface UseRefineSocketReturn {
  /** Current refine session state */
  refine: RefineSession | null;
  /** Whether refine is currently running */
  isRefining: boolean;
  /** Whether refine is done */
  isRefineDone: boolean;
  /** Dismiss / reset refine state */
  resetRefine: () => void;
}

/* ═══════════════════════════════════════════════════════
 *  Hook
 * ═══════════════════════════════════════════════════════ */

export function useRefineSocket(): UseRefineSocketReturn {
  const [refine, setRefine] = useState<RefineSession | null>(null);

  useEffect(() => {
    const socket = getSocket();

    const onStarted = (data: { total: number; candidateIds: string[] }) => {
      setRefine({
        status: 'running',
        total: data.total,
        current: 0,
        progress: 0,
        refined: 0,
        failed: 0,
        items: data.candidateIds.map(id => ({
          candidateId: id,
          title: '',
          status: 'pending' as const,
        })),
      });
    };

    const onItemStarted = (data: { candidateId: string; title: string; current: number; total: number; progress: number }) => {
      setRefine(prev => {
        if (!prev) return prev;
        return {
          ...prev,
          current: data.current,
          progress: data.progress,
          items: prev.items.map(item =>
            item.candidateId === data.candidateId
              ? { ...item, title: data.title, status: 'refining' as const }
              : item
          ),
        };
      });
    };

    const onItemCompleted = (data: { candidateId: string; title: string; refined: boolean; current: number; total: number; progress: number; refinedSoFar: number }) => {
      setRefine(prev => {
        if (!prev) return prev;
        return {
          ...prev,
          current: data.current,
          progress: data.progress,
          refined: data.refinedSoFar,
          items: prev.items.map(item =>
            item.candidateId === data.candidateId
              ? { ...item, title: data.title, status: 'done' as const, refined: data.refined }
              : item
          ),
        };
      });
    };

    const onItemFailed = (data: { candidateId: string; title: string; error: string; current: number; total: number; progress: number }) => {
      setRefine(prev => {
        if (!prev) return prev;
        return {
          ...prev,
          current: data.current,
          progress: data.progress,
          failed: prev.failed + 1,
          items: prev.items.map(item =>
            item.candidateId === data.candidateId
              ? { ...item, title: data.title, status: 'failed' as const, error: data.error }
              : item
          ),
        };
      });
    };

    const onCompleted = (data: { total: number; refined: number; failed: number }) => {
      setRefine(prev => {
        if (!prev) return prev;
        return {
          ...prev,
          status: 'completed',
          progress: 100,
          refined: data.refined,
          failed: data.failed,
        };
      });
    };

    socket.on('refine:started', onStarted);
    socket.on('refine:item-started', onItemStarted);
    socket.on('refine:item-completed', onItemCompleted);
    socket.on('refine:item-failed', onItemFailed);
    socket.on('refine:completed', onCompleted);

    return () => {
      socket.off('refine:started', onStarted);
      socket.off('refine:item-started', onItemStarted);
      socket.off('refine:item-completed', onItemCompleted);
      socket.off('refine:item-failed', onItemFailed);
      socket.off('refine:completed', onCompleted);
    };
  }, []);

  const resetRefine = useCallback(() => setRefine(null), []);

  const isRefining = refine?.status === 'running';
  const isRefineDone = refine?.status === 'completed';

  return { refine, isRefining, isRefineDone, resetRefine };
}
