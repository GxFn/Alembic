/**
 * EvolutionPanel — Recipe 进化信号侧面板
 *
 * 用于 RecipesView 的 Drawer.Panel 内部，展示当前 Recipe 关联的
 * Proposals（进化提案）和 Warnings（知识警告）。
 */
import React, { useEffect, useState, useCallback } from 'react';
import { AlertTriangle, RefreshCw, Check, X, Loader2, GitMerge, Copy, ChevronDown, ChevronRight } from 'lucide-react';
import api from '../../api';
import type { ProposalRecord, WarningRecord } from '../../types';
import { useI18n } from '../../i18n';
import { cn } from '../../lib/utils';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { notify } from '../../utils/notification';
import { getErrorMessage } from '../../utils/error';

interface EvolutionPanelProps {
  recipeId: string;
  recipeName: string;
  idTitleMap?: Record<string, string>;
  onActionComplete?: () => void;
}

/* ── Status config ── */
const proposalStatusConfig: Record<string, { label: string; variant: 'default' | 'blue' | 'green' | 'red' | 'amber' }> = {
  pending:   { label: 'Pending',   variant: 'amber' },
  observing: { label: 'Observing', variant: 'blue' },
  executed:  { label: 'Executed',  variant: 'green' },
  rejected:  { label: 'Rejected',  variant: 'red' },
  expired:   { label: 'Expired',   variant: 'default' },
};

const warningStatusConfig: Record<string, { label: string; variant: 'default' | 'blue' | 'green' | 'red' | 'amber' }> = {
  open:      { label: 'Open',      variant: 'amber' },
  resolved:  { label: 'Resolved',  variant: 'green' },
  dismissed: { label: 'Dismissed', variant: 'default' },
};

const EvolutionPanel: React.FC<EvolutionPanelProps> = ({
  recipeId,
  recipeName,
  idTitleMap,
  onActionComplete,
}) => {
  const { t } = useI18n();
  const [proposals, setProposals] = useState<ProposalRecord[]>([]);
  const [warnings, setWarnings] = useState<WarningRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [p, w] = await Promise.all([
        api.getProposalsByRecipe(recipeId),
        api.getWarningsByRecipe(recipeId),
      ]);
      setProposals(p);
      setWarnings(w);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [recipeId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const toggleExpand = (id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) { next.delete(id); } else { next.add(id); }
      return next;
    });
  };

  const resolveTitle = (id: string) => idTitleMap?.[id] || id.slice(0, 8);

  /* ── Actions ── */
  const handleReject = async (id: string) => {
    setActionLoading(id);
    try {
      await api.rejectProposal(id, 'user rejected from dashboard');
      notify(t('evolution.proposalRejected'), { type: 'success' });
      await fetchData();
      onActionComplete?.();
    } catch (err: unknown) {
      notify(getErrorMessage(err, t('common.operationFailed')), { type: 'error' });
    } finally {
      setActionLoading(null);
    }
  };

  const handleResolve = async (id: string) => {
    setActionLoading(id);
    try {
      await api.resolveWarning(id, 'resolved from dashboard');
      notify(t('evolution.warningResolved'), { type: 'success' });
      await fetchData();
      onActionComplete?.();
    } catch (err: unknown) {
      notify(getErrorMessage(err, t('common.operationFailed')), { type: 'error' });
    } finally {
      setActionLoading(null);
    }
  };

  const handleDismiss = async (id: string) => {
    setActionLoading(id);
    try {
      await api.dismissWarning(id, 'dismissed from dashboard');
      notify(t('evolution.warningDismissed'), { type: 'success' });
      await fetchData();
      onActionComplete?.();
    } catch (err: unknown) {
      notify(getErrorMessage(err, t('common.operationFailed')), { type: 'error' });
    } finally {
      setActionLoading(null);
    }
  };

  /* ── Loading state ── */
  if (loading) {
    return (
      <div className="flex items-center justify-center h-40">
        <Loader2 size={20} className="animate-spin text-[var(--fg-muted)]" />
      </div>
    );
  }

  const activeProposals = proposals.filter(p => p.status === 'pending' || p.status === 'observing');
  const resolvedProposals = proposals.filter(p => p.status !== 'pending' && p.status !== 'observing');
  const openWarnings = warnings.filter(w => w.status === 'open');
  const closedWarnings = warnings.filter(w => w.status !== 'open');

  const isEmpty = proposals.length === 0 && warnings.length === 0;

  if (isEmpty) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center px-4">
        <Check size={32} className="text-[var(--status-success)] mb-3 opacity-60" />
        <p className="text-sm font-medium text-[var(--fg-secondary)]">{t('evolution.noSignals')}</p>
        <p className="text-xs text-[var(--fg-muted)] mt-1">{t('evolution.noSignalsDesc')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* ── Header ── */}
      <div className="flex items-center justify-between px-1">
        <h3 className="text-xs font-bold text-[var(--fg-muted)] uppercase tracking-wider">
          {t('evolution.title')}
        </h3>
        <button
          onClick={fetchData}
          className="p-1 rounded text-[var(--fg-muted)] hover:text-[var(--fg-primary)] transition-colors"
          title={t('common.refresh')}
        >
          <RefreshCw size={12} />
        </button>
      </div>

      {/* ═══ Active Proposals ═══ */}
      {activeProposals.length > 0 && (
        <section>
          <div className="flex items-center gap-1.5 mb-2 px-1">
            <GitMerge size={12} className="text-[var(--accent)]" />
            <span className="text-[11px] font-bold text-[var(--fg-secondary)]">
              {t('evolution.proposals')} ({activeProposals.length})
            </span>
          </div>
          <div className="space-y-2">
            {activeProposals.map(p => (
              <ProposalCard
                key={p.id}
                proposal={p}
                expanded={expandedIds.has(p.id)}
                onToggle={() => toggleExpand(p.id)}
                onReject={() => handleReject(p.id)}
                actionLoading={actionLoading === p.id}
                resolveTitle={resolveTitle}
                t={t}
              />
            ))}
          </div>
        </section>
      )}

      {/* ═══ Open Warnings ═══ */}
      {openWarnings.length > 0 && (
        <section>
          <div className="flex items-center gap-1.5 mb-2 px-1">
            <AlertTriangle size={12} className="text-amber-500" />
            <span className="text-[11px] font-bold text-[var(--fg-secondary)]">
              {t('evolution.warnings')} ({openWarnings.length})
            </span>
          </div>
          <div className="space-y-2">
            {openWarnings.map(w => (
              <WarningCard
                key={w.id}
                warning={w}
                expanded={expandedIds.has(w.id)}
                onToggle={() => toggleExpand(w.id)}
                onResolve={() => handleResolve(w.id)}
                onDismiss={() => handleDismiss(w.id)}
                actionLoading={actionLoading === w.id}
                resolveTitle={resolveTitle}
                t={t}
              />
            ))}
          </div>
        </section>
      )}

      {/* ═══ Resolved / History ═══ */}
      {(resolvedProposals.length > 0 || closedWarnings.length > 0) && (
        <section className="opacity-60">
          <div className="flex items-center gap-1.5 mb-2 px-1">
            <span className="text-[11px] font-bold text-[var(--fg-muted)]">
              {t('evolution.history')} ({resolvedProposals.length + closedWarnings.length})
            </span>
          </div>
          <div className="space-y-1.5">
            {resolvedProposals.map(p => (
              <div key={p.id} className="flex items-center gap-2 text-[11px] text-[var(--fg-muted)] px-2 py-1">
                <GitMerge size={10} />
                <span className="truncate flex-1">{p.description}</span>
                <Badge variant={proposalStatusConfig[p.status]?.variant || 'default'} className="text-[9px]">
                  {proposalStatusConfig[p.status]?.label || p.status}
                </Badge>
              </div>
            ))}
            {closedWarnings.map(w => (
              <div key={w.id} className="flex items-center gap-2 text-[11px] text-[var(--fg-muted)] px-2 py-1">
                <AlertTriangle size={10} />
                <span className="truncate flex-1">{w.description}</span>
                <Badge variant={warningStatusConfig[w.status]?.variant || 'default'} className="text-[9px]">
                  {warningStatusConfig[w.status]?.label || w.status}
                </Badge>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
};

/* ═══════════════════════════════════════════════════════
 *  Sub-components
 * ═══════════════════════════════════════════════════════ */

interface ProposalCardProps {
  proposal: ProposalRecord;
  expanded: boolean;
  onToggle: () => void;
  onReject: () => void;
  actionLoading: boolean;
  resolveTitle: (id: string) => string;
  t: (key: string, params?: Record<string, string | number>) => string;
}

const ProposalCard: React.FC<ProposalCardProps> = ({
  proposal: p,
  expanded,
  onToggle,
  onReject,
  actionLoading,
  resolveTitle,
  t,
}) => {
  const sc = proposalStatusConfig[p.status];
  return (
    <div className="border border-[var(--border-default)] rounded-lg bg-[var(--bg-surface)] overflow-hidden">
      {/* Header row */}
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-[var(--bg-subtle)] transition-colors"
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Badge variant={p.type === 'deprecate' ? 'red' : 'blue'} className="text-[9px] uppercase shrink-0">
          {p.type}
        </Badge>
        <span className="text-xs text-[var(--fg-primary)] truncate flex-1">{p.description}</span>
        <Badge variant={sc?.variant || 'default'} className="text-[9px] shrink-0">
          {sc?.label || p.status}
        </Badge>
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="px-3 pb-3 space-y-2 border-t border-[var(--border-default)]">
          {/* Meta */}
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-[var(--fg-muted)] mt-2">
            <span>{t('evolution.source')}: {p.source}</span>
            <span>{t('evolution.confidence')}: {Math.round(p.confidence * 100)}%</span>
            <span>{t('evolution.proposed')}: {new Date(p.proposedAt).toLocaleDateString('zh-CN')}</span>
            <span>{t('evolution.expires')}: {new Date(p.expiresAt).toLocaleDateString('zh-CN')}</span>
          </div>

          {/* Related recipes */}
          {p.relatedRecipeIds.length > 0 && (
            <div className="text-[10px] text-[var(--fg-muted)]">
              <span className="font-medium">{t('evolution.related')}: </span>
              {p.relatedRecipeIds.map(id => resolveTitle(id)).join(', ')}
            </div>
          )}

          {/* Evidence */}
          {p.evidence.length > 0 && (
            <details className="text-[10px]">
              <summary className="cursor-pointer text-[var(--fg-muted)] hover:text-[var(--fg-secondary)]">
                {t('evolution.evidence')} ({p.evidence.length})
              </summary>
              <pre className="mt-1 p-2 bg-[var(--bg-subtle)] rounded text-[10px] overflow-x-auto max-h-32">
                {JSON.stringify(p.evidence, null, 2)}
              </pre>
            </details>
          )}

          {/* Actions */}
          {(p.status === 'pending' || p.status === 'observing') && (
            <div className="flex items-center gap-2 pt-1">
              <Button
                variant="secondary"
                size="sm"
                onClick={onReject}
                disabled={actionLoading}
                className="text-[11px] h-7"
              >
                {actionLoading ? <Loader2 size={12} className="animate-spin mr-1" /> : <X size={12} className="mr-1" />}
                {t('evolution.reject')}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

interface WarningCardProps {
  warning: WarningRecord;
  expanded: boolean;
  onToggle: () => void;
  onResolve: () => void;
  onDismiss: () => void;
  actionLoading: boolean;
  resolveTitle: (id: string) => string;
  t: (key: string, params?: Record<string, string | number>) => string;
}

const WarningCard: React.FC<WarningCardProps> = ({
  warning: w,
  expanded,
  onToggle,
  onResolve,
  onDismiss,
  actionLoading,
  resolveTitle,
  t,
}) => {
  const sc = warningStatusConfig[w.status];
  return (
    <div className="border border-[var(--border-default)] rounded-lg bg-[var(--bg-surface)] overflow-hidden">
      {/* Header row */}
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-[var(--bg-subtle)] transition-colors"
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Badge variant={w.type === 'contradiction' ? 'red' : 'amber'} className="text-[9px] uppercase shrink-0">
          {w.type}
        </Badge>
        <span className="text-xs text-[var(--fg-primary)] truncate flex-1">{w.description}</span>
        <Badge variant={sc?.variant || 'default'} className="text-[9px] shrink-0">
          {sc?.label || w.status}
        </Badge>
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="px-3 pb-3 space-y-2 border-t border-[var(--border-default)]">
          {/* Meta */}
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-[var(--fg-muted)] mt-2">
            <span>{t('evolution.confidence')}: {Math.round(w.confidence * 100)}%</span>
            <span>{t('evolution.detected')}: {new Date(w.detectedAt).toLocaleDateString('zh-CN')}</span>
          </div>

          {/* Related recipes */}
          {w.relatedRecipeIds.length > 0 && (
            <div className="text-[10px] text-[var(--fg-muted)]">
              <span className="font-medium">{t('evolution.related')}: </span>
              {w.relatedRecipeIds.map(id => resolveTitle(id)).join(', ')}
            </div>
          )}

          {/* Evidence */}
          {w.evidence.length > 0 && (
            <details className="text-[10px]">
              <summary className="cursor-pointer text-[var(--fg-muted)] hover:text-[var(--fg-secondary)]">
                {t('evolution.evidence')} ({w.evidence.length})
              </summary>
              <ul className="mt-1 space-y-0.5 pl-4 list-disc">
                {w.evidence.map((e, i) => (
                  <li key={i} className="text-[var(--fg-secondary)]">{e}</li>
                ))}
              </ul>
            </details>
          )}

          {/* Actions */}
          {w.status === 'open' && (
            <div className="flex items-center gap-2 pt-1">
              <Button
                variant="secondary"
                size="sm"
                onClick={onResolve}
                disabled={actionLoading}
                className="text-[11px] h-7"
              >
                {actionLoading ? <Loader2 size={12} className="animate-spin mr-1" /> : <Check size={12} className="mr-1" />}
                {t('evolution.resolve')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={onDismiss}
                disabled={actionLoading}
                className="text-[11px] h-7 text-[var(--fg-muted)]"
              >
                <X size={12} className="mr-1" />
                {t('evolution.dismiss')}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default EvolutionPanel;

/** 获取指定 Recipe 的 Evolution 信号计数（proposal + warning 活跃数） */
export async function fetchEvolutionCounts(recipeId: string): Promise<{ proposals: number; warnings: number }> {
  try {
    const [proposals, warnings] = await Promise.all([
      api.getProposalsByRecipe(recipeId),
      api.getWarningsByRecipe(recipeId),
    ]);
    return {
      proposals: proposals.filter(p => p.status === 'pending' || p.status === 'observing').length,
      warnings: warnings.filter(w => w.status === 'open').length,
    };
  } catch {
    return { proposals: 0, warnings: 0 };
  }
}
