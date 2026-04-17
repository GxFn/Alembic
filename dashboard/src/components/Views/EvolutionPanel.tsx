/**
 * EvolutionPanel — Recipe 进化信号侧面板
 *
 * 用于 RecipesView 的 Drawer.Panel 内部，展示当前 Recipe 关联的
 * Proposals（进化提案）和 Warnings（知识警告）。
 */
import React, { useEffect, useState, useCallback } from 'react';
import { AlertTriangle, RefreshCw, Check, X, Loader2, GitMerge, Play, Eye, ChevronDown, ChevronRight } from 'lucide-react';
import api from '../../api';
import type { ProposalRecord, WarningRecord } from '../../types';
import { useI18n } from '../../i18n';
import { cn } from '../../lib/utils';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '../ui/Dialog';
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
  const [confirmDialog, setConfirmDialog] = useState<{
    open: boolean;
    action: 'execute' | 'observe';
    proposal: ProposalRecord | null;
  }>({ open: false, action: 'execute', proposal: null });

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

  const handleExecute = async (proposal: ProposalRecord) => {
    setConfirmDialog({ open: false, action: 'execute', proposal: null });
    setActionLoading(proposal.id);
    try {
      await api.executeProposal(proposal.id);
      notify(t('evolution.proposalExecuted'), { type: 'success' });
      await fetchData();
      onActionComplete?.();
    } catch (err: unknown) {
      notify(getErrorMessage(err, t('common.operationFailed')), { type: 'error' });
    } finally {
      setActionLoading(null);
    }
  };

  const handleObserve = async (proposal: ProposalRecord) => {
    setConfirmDialog({ open: false, action: 'observe', proposal: null });
    setActionLoading(proposal.id);
    try {
      await api.observeProposal(proposal.id);
      notify(t('evolution.proposalObserving'), { type: 'success' });
      await fetchData();
      onActionComplete?.();
    } catch (err: unknown) {
      notify(getErrorMessage(err, t('common.operationFailed')), { type: 'error' });
    } finally {
      setActionLoading(null);
    }
  };

  const openConfirmDialog = (action: 'execute' | 'observe', proposal: ProposalRecord) => {
    setConfirmDialog({ open: true, action, proposal });
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
                onExecute={() => openConfirmDialog('execute', p)}
                onObserve={p.status === 'pending' ? () => openConfirmDialog('observe', p) : undefined}
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

      {/* ═══ Confirm Dialog ═══ */}
      <ConfirmDialog
        open={confirmDialog.open}
        action={confirmDialog.action}
        proposal={confirmDialog.proposal}
        onClose={() => setConfirmDialog({ open: false, action: 'execute', proposal: null })}
        onConfirm={() => {
          if (!confirmDialog.proposal) { return; }
          if (confirmDialog.action === 'execute') {
            handleExecute(confirmDialog.proposal);
          } else {
            handleObserve(confirmDialog.proposal);
          }
        }}
        resolveTitle={resolveTitle}
        t={t}
      />
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
  onExecute: () => void;
  onObserve?: () => void;
  actionLoading: boolean;
  resolveTitle: (id: string) => string;
  t: (key: string, params?: Record<string, string | number>) => string;
}

const ProposalCard: React.FC<ProposalCardProps> = ({
  proposal: p,
  expanded,
  onToggle,
  onReject,
  onExecute,
  onObserve,
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

          {/* Confidence indicator */}
          {p.confidence < 0.5 && (
            <div className="flex items-center gap-1 text-[10px] text-amber-600 bg-amber-50 dark:bg-amber-950/30 px-2 py-1 rounded">
              <AlertTriangle size={10} />
              {t('evolution.lowConfidence')}
            </div>
          )}

          {/* Observation window status */}
          {p.status === 'observing' && (
            <div className="text-[10px] text-[var(--fg-muted)]">
              {Date.now() >= p.expiresAt
                ? <span className="text-green-600 font-medium">{t('evolution.observationExpired')}</span>
                : <span>{t('evolution.observationRemaining')}: {formatRemainingTime(p.expiresAt - Date.now(), t)}</span>
              }
            </div>
          )}

          {/* suggestedChanges preview for update type */}
          {p.type === 'update' && extractSuggestedChanges(p.evidence).length > 0 && (
            <details className="text-[10px]">
              <summary className="cursor-pointer text-[var(--accent)] hover:text-[var(--accent-hover)] font-medium">
                {t('evolution.suggestedChanges')} ({extractSuggestedChanges(p.evidence).length})
              </summary>
              <div className="mt-1 space-y-1">
                {extractSuggestedChanges(p.evidence).map((change, i) => (
                  <div key={i} className="flex items-center gap-2 px-2 py-1 bg-[var(--bg-subtle)] rounded">
                    <Badge variant="blue" className="text-[8px] shrink-0">{change.field}</Badge>
                    <span className="text-[var(--fg-secondary)] truncate">{change.action}: {change.preview}</span>
                  </div>
                ))}
              </div>
            </details>
          )}

          {/* Actions */}
          {(p.status === 'pending' || p.status === 'observing') && (
            <div className="flex items-center gap-2 pt-1">
              {/* Execute button */}
              <Button
                variant="primary"
                size="sm"
                onClick={onExecute}
                disabled={actionLoading}
                className="text-[11px] h-7"
              >
                {actionLoading ? <Loader2 size={12} className="animate-spin mr-1" /> : <Play size={12} className="mr-1" />}
                {p.type === 'deprecate' ? t('evolution.executeDeprecate') : t('evolution.executeMerge')}
              </Button>

              {/* Observe button — only for pending */}
              {onObserve && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={onObserve}
                  disabled={actionLoading}
                  className="text-[11px] h-7"
                >
                  <Eye size={12} className="mr-1" />
                  {t('evolution.startObserving')}
                </Button>
              )}

              {/* Reject button */}
              <Button
                variant="ghost"
                size="sm"
                onClick={onReject}
                disabled={actionLoading}
                className="text-[11px] h-7 text-[var(--fg-muted)]"
              >
                <X size={12} className="mr-1" />
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

/* ═══════════════════════════════════════════════════════
 *  Confirm Dialog
 * ═══════════════════════════════════════════════════════ */

interface ConfirmDialogProps {
  open: boolean;
  action: 'execute' | 'observe';
  proposal: ProposalRecord | null;
  onClose: () => void;
  onConfirm: () => void;
  resolveTitle: (id: string) => string;
  t: (key: string, params?: Record<string, string | number>) => string;
}

const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  open,
  action,
  proposal,
  onClose,
  onConfirm,
  resolveTitle,
  t,
}) => {
  if (!proposal) { return null; }

  const isExecute = action === 'execute';
  const isDeprecate = proposal.type === 'deprecate';
  const isPending = proposal.status === 'pending';
  const changes = extractSuggestedChanges(proposal.evidence);

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) { onClose(); } }}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle className="text-base">
            {isExecute
              ? (isDeprecate ? t('evolution.confirmDeprecateTitle') : t('evolution.confirmExecuteTitle'))
              : t('evolution.confirmObserveTitle')
            }
          </DialogTitle>
          <DialogDescription>
            {isExecute
              ? (isDeprecate
                  ? t('evolution.confirmDeprecateDesc')
                  : isPending
                    ? t('evolution.confirmExecutePendingDesc')
                    : t('evolution.confirmExecuteDesc'))
              : t('evolution.confirmObserveDesc')
            }
          </DialogDescription>
        </DialogHeader>

        <div className="px-5 py-3 space-y-3">
          {/* Proposal summary */}
          <div className="text-xs space-y-1.5">
            <div className="flex items-center gap-2">
              <Badge variant={isDeprecate ? 'red' : 'blue'} className="text-[9px] uppercase">{proposal.type}</Badge>
              <span className="text-[var(--fg-primary)]">{proposal.description}</span>
            </div>
            <div className="flex flex-wrap gap-x-3 text-[10px] text-[var(--fg-muted)]">
              <span>{t('evolution.confidence')}: {Math.round(proposal.confidence * 100)}%</span>
              <span>{t('evolution.source')}: {proposal.source}</span>
            </div>
          </div>

          {/* Low confidence warning */}
          {proposal.confidence < 0.5 && isExecute && (
            <div className="flex items-center gap-1.5 text-[11px] text-amber-600 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 rounded-md">
              <AlertTriangle size={12} />
              {t('evolution.lowConfidenceWarning')}
            </div>
          )}

          {/* Pending skip observation warning */}
          {isPending && isExecute && (
            <div className="flex items-center gap-1.5 text-[11px] text-blue-600 bg-blue-50 dark:bg-blue-950/30 px-3 py-2 rounded-md">
              <Eye size={12} />
              {t('evolution.skipObservationWarning')}
            </div>
          )}

          {/* SuggestedChanges preview for update */}
          {isExecute && !isDeprecate && changes.length > 0 && (
            <div className="space-y-1">
              <span className="text-[10px] font-medium text-[var(--fg-secondary)]">{t('evolution.changesToApply')}:</span>
              <div className="space-y-1 max-h-32 overflow-y-auto">
                {changes.map((c, i) => (
                  <div key={i} className="flex items-center gap-2 text-[10px] px-2 py-1 bg-[var(--bg-subtle)] rounded">
                    <Badge variant="blue" className="text-[8px] shrink-0">{c.field}</Badge>
                    <span className="text-[var(--fg-muted)]">{c.action}</span>
                    <span className="text-[var(--fg-secondary)] truncate">{c.preview}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Deprecate: related recipes */}
          {isExecute && isDeprecate && proposal.relatedRecipeIds.length > 0 && (
            <div className="text-[10px] text-[var(--fg-muted)]">
              <span className="font-medium">{t('evolution.replacedBy')}: </span>
              {proposal.relatedRecipeIds.map(id => resolveTitle(id)).join(', ')}
            </div>
          )}

          {/* Outcome hint */}
          {isExecute && (
            <div className="text-[10px] text-[var(--fg-muted)] bg-[var(--bg-subtle)] px-3 py-2 rounded-md">
              {isDeprecate
                ? t('evolution.outcomeDeprecate')
                : t('evolution.outcomeUpdate')
              }
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose} className="text-[11px]">
            {t('common.cancel')}
          </Button>
          <Button
            variant={isExecute && isDeprecate ? 'danger' : 'primary'}
            size="sm"
            onClick={onConfirm}
            className="text-[11px]"
          >
            {isExecute
              ? (isDeprecate ? t('evolution.confirmDeprecate') : t('evolution.confirmExecute'))
              : t('evolution.confirmObserve')
            }
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/* ═══════════════════════════════════════════════════════
 *  Helpers
 * ═══════════════════════════════════════════════════════ */

interface SuggestedChange {
  field: string;
  action: string;
  preview: string;
}

function extractSuggestedChanges(evidence: Record<string, unknown>[]): SuggestedChange[] {
  const results: SuggestedChange[] = [];
  for (const ev of evidence) {
    const sc = ev.suggestedChanges as Record<string, unknown> | undefined;
    if (!sc) { continue; }
    const changes = (sc.changes ?? sc.patches) as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(changes)) { continue; }
    for (const c of changes) {
      results.push({
        field: String(c.field ?? ''),
        action: String(c.action ?? 'replace'),
        preview: String(c.newValue ?? c.newContent ?? '').slice(0, 60),
      });
    }
  }
  return results;
}

function formatRemainingTime(
  ms: number,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  const hours = Math.floor(ms / (1000 * 60 * 60));
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    return `${days}${t('evolution.days')}`;
  }
  return `${hours}${t('evolution.hours')}`;
}

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
