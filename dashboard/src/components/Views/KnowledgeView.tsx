import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Library, Shield, Lightbulb, Search, BookOpen,
  Loader2, Zap, Archive, RotateCcw, Trash2, X, Clock, CheckCircle2,
  RefreshCw,
  Globe, Layers, Link2,
  ArrowUpCircle, Sparkles, TrendingDown, ArrowRight, ArrowDown,
} from 'lucide-react';
import { useDrawerWide } from '../../hooks/useDrawerWide';
import { useI18n } from '../../i18n';
import type {
  KnowledgeEntry, KnowledgeLifecycle, KnowledgeKind,
  KnowledgeStatsResponse
} from '../../types';
import api from '../../api';
import { notify } from '../../utils/notification';
import { getErrorMessage } from '../../utils/error';
import { categoryConfigs } from '../../constants';
import { normalizeCode } from '../Shared/CodeBlock';
import Pagination from '../Shared/Pagination';
import { KnowledgeSkeleton } from '../Skeletons';
import { Drawer } from '../Layout/Drawer';
import { Button } from '../ui';
import DrawerMeta from '../Shared/DrawerMeta';
import type { BadgeItem, MetaItem } from '../Shared/DrawerMeta';
import DrawerContent from '../Shared/DrawerContent';
import Select from '../ui/Select';

/* ═══ 配置 ══════════════════════════════════════════════ */

const LIFECYCLE_CONFIG: Record<string, {
  labelKey: string; color: string; bg: string; border: string;
  hoverBorder: string; badgeBg: string; badgeColor: string;
  icon: React.ElementType;
}> = {
  pending:    { labelKey: 'lifecycle.pending',    color: 'text-gray-600 dark:text-gray-400',   bg: 'bg-gray-500/8 dark:bg-gray-500/15',   border: 'border-gray-300 dark:border-gray-600',   hoverBorder: 'hover:border-gray-400 dark:hover:border-gray-500', badgeBg: 'bg-gray-500/15 dark:bg-gray-500/25', badgeColor: 'text-gray-600 dark:text-gray-300', icon: Clock },
  staging:    { labelKey: 'lifecycle.staging',    color: 'text-blue-600 dark:text-blue-400',   bg: 'bg-blue-500/8 dark:bg-blue-500/15',   border: 'border-blue-300 dark:border-blue-600',   hoverBorder: 'hover:border-blue-400 dark:hover:border-blue-500', badgeBg: 'bg-blue-500/15 dark:bg-blue-500/25', badgeColor: 'text-blue-600 dark:text-blue-300', icon: ArrowUpCircle },
  active:     { labelKey: 'lifecycle.active',     color: 'text-green-600 dark:text-green-400', bg: 'bg-green-500/8 dark:bg-green-500/15', border: 'border-green-300 dark:border-green-600', hoverBorder: 'hover:border-green-400 dark:hover:border-green-500', badgeBg: 'bg-green-500/15 dark:bg-green-500/25', badgeColor: 'text-green-600 dark:text-green-300', icon: CheckCircle2 },
  evolving:   { labelKey: 'lifecycle.evolving',   color: 'text-purple-600 dark:text-purple-400', bg: 'bg-purple-500/8 dark:bg-purple-500/15', border: 'border-purple-300 dark:border-purple-600', hoverBorder: 'hover:border-purple-400 dark:hover:border-purple-500', badgeBg: 'bg-purple-500/15 dark:bg-purple-500/25', badgeColor: 'text-purple-600 dark:text-purple-300', icon: Sparkles },
  decaying:   { labelKey: 'lifecycle.decaying',   color: 'text-orange-600 dark:text-orange-400', bg: 'bg-orange-500/8 dark:bg-orange-500/15', border: 'border-orange-300 dark:border-orange-600', hoverBorder: 'hover:border-orange-400 dark:hover:border-orange-500', badgeBg: 'bg-orange-500/15 dark:bg-orange-500/25', badgeColor: 'text-orange-600 dark:text-orange-300', icon: TrendingDown },
  deprecated: { labelKey: 'lifecycle.deprecated', color: 'text-red-600 dark:text-red-400',    bg: 'bg-red-500/8 dark:bg-red-500/15',    border: 'border-red-300 dark:border-red-600',    hoverBorder: 'hover:border-red-400 dark:hover:border-red-500', badgeBg: 'bg-red-500/15 dark:bg-red-500/25', badgeColor: 'text-red-600 dark:text-red-300', icon: Archive },
};

const KIND_CONFIG: Record<string, { labelKey: string; color: string; bg: string; border: string; icon: React.ElementType }> = {
  rule:    { labelKey: 'kind.rule',    color: 'text-red-700',    bg: 'bg-red-50',    border: 'border-red-200',    icon: Shield },
  pattern: { labelKey: 'kind.pattern', color: 'text-violet-700', bg: 'bg-violet-50', border: 'border-violet-200', icon: Lightbulb },
  fact:    { labelKey: 'kind.fact',    color: 'text-cyan-700',   bg: 'bg-cyan-50',   border: 'border-cyan-200',   icon: BookOpen },
};

/** 生命周期操作按钮配置（6 状态） */
const LIFECYCLE_ACTIONS: Record<string, Array<{ action: string; labelKey: string; color: string; bg: string; icon: React.ElementType; needsReason?: boolean }>> = {
  pending:       [
    { action: 'publish',    labelKey: 'knowledge.actionPublish',    color: 'text-green-700',  bg: 'bg-green-50 hover:bg-green-100', icon: CheckCircle2 },
    { action: 'stage',      labelKey: 'knowledge.actionStage',      color: 'text-blue-700',   bg: 'bg-blue-50 hover:bg-blue-100',   icon: ArrowUpCircle },
    { action: 'deprecate',  labelKey: 'knowledge.actionDeprecate',  color: 'text-red-700',    bg: 'bg-red-50 hover:bg-red-100',     icon: Archive, needsReason: true },
  ],
  staging:       [
    { action: 'publish',    labelKey: 'knowledge.actionPublish',    color: 'text-green-700',  bg: 'bg-green-50 hover:bg-green-100', icon: CheckCircle2 },
    { action: 'reactivate', labelKey: 'knowledge.actionUnstage',    color: 'text-gray-700',   bg: 'bg-gray-50 hover:bg-gray-100',   icon: RotateCcw },
  ],
  active:        [
    { action: 'evolve',     labelKey: 'knowledge.actionEvolve',     color: 'text-purple-700', bg: 'bg-purple-50 hover:bg-purple-100', icon: Sparkles },
    { action: 'decay',      labelKey: 'knowledge.actionDecay',      color: 'text-orange-700', bg: 'bg-orange-50 hover:bg-orange-100', icon: TrendingDown, needsReason: true },
    { action: 'deprecate',  labelKey: 'knowledge.actionDeprecate',  color: 'text-red-700',    bg: 'bg-red-50 hover:bg-red-100',     icon: Archive, needsReason: true },
  ],
  evolving:      [
    { action: 'restore',    labelKey: 'knowledge.actionRestore',    color: 'text-green-700',  bg: 'bg-green-50 hover:bg-green-100', icon: CheckCircle2 },
    { action: 'decay',      labelKey: 'knowledge.actionDecay',      color: 'text-orange-700', bg: 'bg-orange-50 hover:bg-orange-100', icon: TrendingDown, needsReason: true },
  ],
  decaying:      [
    { action: 'restore',    labelKey: 'knowledge.actionRestore',    color: 'text-green-700',  bg: 'bg-green-50 hover:bg-green-100', icon: CheckCircle2 },
    { action: 'deprecate',  labelKey: 'knowledge.actionDeprecate',  color: 'text-red-700',    bg: 'bg-red-50 hover:bg-red-100',     icon: Archive, needsReason: true },
  ],
  deprecated:    [
    { action: 'reactivate', labelKey: 'knowledge.actionReactivate', color: 'text-green-700',  bg: 'bg-green-50 hover:bg-green-100', icon: RotateCcw },
  ],
};

/* ═══ 工具函数 ═════════════════════════════════════════ */

function formatDate(ts: number | undefined | null, t: (key: string, params?: Record<string, any>) => string): string {
  if (!ts) return '';
  const ms = ts < 1e12 ? ts * 1000 : ts;
  const d = new Date(ms);
  if (isNaN(d.getTime()) || d.getFullYear() < 2000) return '';
  const now = Date.now();
  const diffMs = now - ms;
  if (diffMs < 0) return d.toLocaleDateString();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return t('candidates.timeJustNow');
  if (diffMin < 60) return t('candidates.timeMinutesAgo', { n: diffMin });
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return t('candidates.timeHoursAgo', { n: diffHour });
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 7) return t('candidates.timeDaysAgo', { n: diffDay });
  return d.toLocaleDateString();
}

function confidenceColor(c: number | null | undefined): { ring: string; text: string; bg: string; labelKey: string } {
  if (c == null) return { ring: 'stroke-[var(--border-default)]', text: 'text-[var(--fg-muted)]', bg: 'bg-[var(--bg-subtle)]', labelKey: '' };
  if (c >= 0.8) return { ring: 'stroke-emerald-500', text: 'text-emerald-700', bg: 'bg-emerald-50', labelKey: 'candidates.confidenceHighLabel' };
  if (c >= 0.6) return { ring: 'stroke-blue-500', text: 'text-blue-700', bg: 'bg-blue-50', labelKey: 'candidates.confidenceMediumLabel' };
  if (c >= 0.4) return { ring: 'stroke-amber-500', text: 'text-amber-700', bg: 'bg-amber-50', labelKey: 'candidates.confidenceMediumLowLabel' };
  return { ring: 'stroke-red-500', text: 'text-red-700', bg: 'bg-red-50', labelKey: 'candidates.confidenceLowLabel' };
}

function codePreview(code: string | undefined, maxLines = 4): string {
  if (!code) return '';
  return normalizeCode(code).split('\n').slice(0, maxLines).join('\n');
}

/* ═══ 来源标签 ════════════════════════════════════════ */

const SOURCE_LABEL_KEYS: Record<string, { labelKey: string; color: string }> = {
  'bootstrap-scan': { labelKey: 'knowledge.sourceBootstrap', color: 'text-violet-600 bg-violet-50 border-violet-200' },
  'mcp': { labelKey: 'knowledge.sourceMcp', color: 'text-blue-600 bg-blue-50 border-blue-200' },
  'manual': { labelKey: 'knowledge.sourceManual', color: 'text-emerald-600 bg-emerald-50 border-emerald-200' },
  'file-watcher': { labelKey: 'knowledge.sourceFileWatcher', color: 'text-orange-600 bg-orange-50 border-orange-200' },
  'clipboard': { labelKey: 'knowledge.sourceClipboard', color: 'text-pink-600 bg-pink-50 border-pink-200' },
  'cli': { labelKey: 'knowledge.sourceCli', color: 'text-[var(--fg-secondary)] bg-[var(--bg-subtle)] border-[var(--border-default)]' },
  'agent': { labelKey: 'knowledge.sourceAgent', color: 'text-violet-600 bg-violet-50 border-violet-200' },
  'submit_with_check': { labelKey: 'knowledge.sourceSubmitCheck', color: 'text-teal-600 bg-teal-50 border-teal-200' },
};

/* ═══ Props ════════════════════════════════════════════ */

interface KnowledgeViewProps {
  onRefresh?: () => void;
  idTitleMap?: Record<string, string>;
}

/* ═══ 驳回原因翻译（兼容旧英文数据） ═════════════════ */

const REJECTION_REASON_MAP: Record<string, string> = {
  'source file deleted (orphan)': '源文件已删除（孤儿条目）',
};

function translateRejectionReason(reason: string): string {
  return REJECTION_REASON_MAP[reason] ?? reason;
}

/* ═══ 组件 ═════════════════════════════════════════════ */

const KnowledgeView: React.FC<KnowledgeViewProps> = ({ onRefresh, idTitleMap: idTitleMapProp }) => {
  const { t } = useI18n();

  // ── i18n 映射（覆盖模块级常量中的中文标签） ──
  const lifecycleLabel = (key: string) => {
    const map: Record<string, string> = {
      pending: t('knowledge.lifecyclePending'),
      staging: t('knowledge.lifecycleStaging'),
      active: t('knowledge.lifecycleActive'),
      evolving: t('knowledge.lifecycleEvolving'),
      decaying: t('knowledge.lifecycleDecaying'),
      deprecated: t('knowledge.lifecycleDeprecated'),
    };
    return map[key] || key;
  };
  const actionLabel = (action: string) => {
    const map: Record<string, string> = {
      publish: t('knowledge.actionPublish'),
      stage: t('knowledge.actionStage'),
      deprecate: t('knowledge.actionDeprecate'),
      reactivate: t('knowledge.actionReactivate'),
      evolve: t('knowledge.actionEvolve'),
      decay: t('knowledge.actionDecay'),
    };
    return map[action] || action;
  };

  // ── 状态 ──
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [stats, setStats] = useState<KnowledgeStatsResponse | null>(null);
  const [lifecycleCounts, setLifecycleCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(12);
  const [total, setTotal] = useState(0);

  // 筛选
  const [filterLifecycle, setFilterLifecycle] = useState<KnowledgeLifecycle | ''>('');
  const [filterKind, setFilterKind] = useState<KnowledgeKind | ''>('');
  const [filterCategory, setFilterCategory] = useState('');
  const [keyword, setKeyword] = useState('');
  const [searchInput, setSearchInput] = useState('');

  // 详情抽屉
  const { isWide: drawerWide, toggle: toggleDrawerWide } = useDrawerWide();
  const [selected, setSelected] = useState<KnowledgeEntry | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  // 批量操作
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchLoading, setBatchLoading] = useState(false);

  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  // ── 数据加载 ──
  const fetchEntries = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.knowledgeList({
        page,
        limit: pageSize,
        lifecycle: filterLifecycle || undefined,
        kind: filterKind || undefined,
        category: filterCategory || undefined,
        keyword: keyword || undefined,
      });
      if (isMountedRef.current) {
        setEntries(result.data || []);
        setTotal(result.pagination?.total || 0);
      }
    } catch (err: unknown) {
      notify(getErrorMessage(err, t('knowledge.loadFailed')), { title: t('common.loadFailed'), type: 'error' });
    } finally {
      if (isMountedRef.current) setLoading(false);
    }
  }, [page, pageSize, filterLifecycle, filterKind, filterCategory, keyword]);

  const fetchStats = useCallback(async () => {
    try {
      const s = await api.knowledgeStats();
      if (isMountedRef.current) setStats(s);
    } catch { /* silent */ }
  }, []);

  const fetchLifecycle = useCallback(async () => {
    try {
      const data = await api.getKnowledgeLifecycle();
      if (isMountedRef.current) {
        setLifecycleCounts(data.counts || {});
      }
    } catch { /* silent */ }
  }, []);

  useEffect(() => { fetchEntries(); }, [fetchEntries]);
  useEffect(() => { fetchStats(); }, [fetchStats]);
  useEffect(() => { fetchLifecycle(); }, [fetchLifecycle]);

  // 搜索防抖
  useEffect(() => {
    const timer = setTimeout(() => {
      setKeyword(searchInput);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // 筛选变化时重置页码
  useEffect(() => { setPage(1); }, [filterLifecycle, filterKind, filterCategory]);

  const refresh = useCallback(() => {
    fetchEntries();
    fetchStats();
    fetchLifecycle();
    onRefresh?.();
  }, [fetchEntries, fetchStats, fetchLifecycle, onRefresh]);

  // ID → 标题 查找表 (将关联关系中的 UUID 解析为可读标题)
  const titleLookup = useMemo(() => {
    const map = new Map<string, string>();
    // 全局 map (包含所有 lifecycle 的 entries)
    if (idTitleMapProp) {
      for (const [id, title] of Object.entries(idTitleMapProp)) {
        map.set(id, title);
      }
    }
    // 当前页本地 entries 补充
    for (const e of entries) {
      if (e.id && e.title) map.set(e.id, e.title);
    }
    return map;
  }, [entries, idTitleMapProp]);

  // ── 生命周期操作 ──
  const handleLifecycleAction = async (entry: KnowledgeEntry, action: string, reason?: string) => {
    setActionLoading(true);
    try {
      const updated = await api.knowledgeLifecycle(entry.id, action, reason);
      notify(`${entry.title} → ${t(LIFECYCLE_CONFIG[updated.lifecycle]?.labelKey || '') || updated.lifecycle}`, { title: t('knowledge.operationSuccess') });
      // 更新本地列表
      setEntries(prev => prev.map(e => e.id === entry.id ? updated : e));
      if (selected?.id === entry.id) setSelected(updated);
      fetchStats();
    } catch (err: unknown) {
      notify(getErrorMessage(err, t('common.operationFailed')), { title: t('common.operationFailed'), type: 'error' });
    } finally {
      if (isMountedRef.current) setActionLoading(false);
    }
  };

  const handleDelete = async (entry: KnowledgeEntry) => {
    if (!confirm(t('knowledge.deleteConfirmMsg', { title: entry.title }))) return;
    try {
      await api.knowledgeDelete(entry.id);
      notify(t('knowledge.deleteSuccess', { title: entry.title }), { title: t('common.delete') });
      setEntries(prev => prev.filter(e => e.id !== entry.id));
      if (selected?.id === entry.id) setSelected(null);
      fetchStats();
    } catch (err: unknown) {
      notify(getErrorMessage(err, t('knowledge.deleteFailed')), { title: t('knowledge.deleteFailed'), type: 'error' });
    }
  };

  // ── 可发布状态（状态机中允许转移到 active 的状态）──
  const PUBLISHABLE_STATES = ['pending', 'staging'];

  // ── 批量操作 ──
  const handleBatchPublish = async () => {
    if (selectedIds.size === 0) return;
    // 只发布处于可发布状态的条目
    const publishableIds = entries
      .filter(e => selectedIds.has(e.id) && PUBLISHABLE_STATES.includes(e.lifecycle))
      .map(e => e.id);
    if (publishableIds.length === 0) {
      notify(t('knowledge.noPublishable'), { title: t('knowledge.batchPublish'), type: 'info' });
      return;
    }
    setBatchLoading(true);
    try {
      const result = await api.knowledgeBatchPublish(publishableIds);
      notify(t('knowledge.batchPublishResult', { success: result.successCount, fail: result.failureCount }), { title: t('knowledge.batchPublish') });
      setSelectedIds(new Set());
      refresh();
    } catch (err: unknown) {
      notify(getErrorMessage(err, t('knowledge.batchPublishFailed')), { title: t('common.operationFailed'), type: 'error' });
    } finally {
      setBatchLoading(false);
    }
  };

  /** 快速批量发布所有可自动通过的待审核条目 */
  const handleBatchPublishAutoApprovable = async () => {
    setBatchLoading(true);
    try {
      // 拉取所有 pending 条目，筛选 auto_approvable
      const result = await api.knowledgeList({ lifecycle: 'pending', limit: 500 });
      const autoIds = (result.data || []).filter((e: KnowledgeEntry) => e.autoApprovable).map((e: KnowledgeEntry) => e.id);
      if (autoIds.length === 0) {
        notify(t('knowledge.noAutoApprovable'), { title: t('knowledge.noPublishable') });
        return;
      }
      const pub = await api.knowledgeBatchPublish(autoIds);
      notify(t('knowledge.autoPublishResult', { count: pub.successCount }), { title: t('knowledge.batchPublishComplete') });
      refresh();
    } catch (err: unknown) {
      notify(getErrorMessage(err, t('knowledge.batchPublishFailed')), { title: t('common.operationFailed'), type: 'error' });
    } finally {
      setBatchLoading(false);
    }
  };

  /** 批量废弃选中条目 */
  const handleBatchDeprecate = async () => {
    if (selectedIds.size === 0) { return; }
    const deprecatableIds = entries
      .filter(e => selectedIds.has(e.id) && (e.lifecycle === 'active' || e.lifecycle === 'evolving'))
      .map(e => e.id);
    if (deprecatableIds.length === 0) {
      notify(t('knowledge.noDeprecatable'), { title: t('knowledge.batchDeprecate'), type: 'info' });
      return;
    }
    setBatchLoading(true);
    try {
      const result = await api.knowledgeBatchDeprecate(deprecatableIds);
      notify(t('knowledge.batchDeprecateResult', { success: result.successCount, fail: result.failureCount }), { title: t('knowledge.batchDeprecate') });
      setSelectedIds(new Set());
      refresh();
    } catch (err: unknown) {
      notify(getErrorMessage(err, t('knowledge.batchDeprecateFailed')), { title: t('common.operationFailed'), type: 'error' });
    } finally {
      setBatchLoading(false);
    }
  };

  /** 批量删除选中条目 */
  const handleBatchDelete = async () => {
    if (selectedIds.size === 0) { return; }
    if (!confirm(t('knowledge.batchDeleteConfirm', { count: selectedIds.size }))) { return; }
    setBatchLoading(true);
    try {
      const result = await api.knowledgeBatchDelete([...selectedIds]);
      notify(t('knowledge.batchDeleteResult', { success: result.deletedCount, fail: result.failureCount }), { title: t('knowledge.batchDelete') });
      setSelectedIds(new Set());
      refresh();
    } catch (err: unknown) {
      notify(getErrorMessage(err, t('knowledge.batchDeleteFailed')), { title: t('common.operationFailed'), type: 'error' });
    } finally {
      setBatchLoading(false);
    }
  };

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === entries.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(entries.map(e => e.id)));
    }
  };

  // ── 抽屉中需要 reason 的操作 ──
  const handleActionWithReason = (entry: KnowledgeEntry, action: string) => {
    const reason = prompt(t('knowledge.deprecateReasonPrompt'));
    if (!reason) return;
    handleLifecycleAction(entry, action, reason);
  };

  /* ═══ 渲染 ═══════════════════════════════════════════ */

  return (
    <div className="space-y-4 pb-6">
      {/* ── 生命周期状态流 ── */}
      {(() => {
        const counts = lifecycleCounts;
        const hasData = Object.values(counts).some(v => v > 0);
        if (!hasData && !stats) { return null; }

        const mergedCounts = (key: string) =>
          counts[key] ?? (stats as Record<string, number> | null)?.[key] ?? 0;

        const StateChip: React.FC<{ stateKey: string; onClick: () => void }> = ({ stateKey, onClick }) => {
          const cfg = LIFECYCLE_CONFIG[stateKey];
          if (!cfg) { return null; }
          const Icon = cfg.icon;
          const count = mergedCounts(stateKey);
          const selected = filterLifecycle === stateKey;
          return (
            <button
              onClick={onClick}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors whitespace-nowrap ${
                selected
                  ? `${cfg.bg} ${cfg.border} ${cfg.color} shadow-sm`
                  : `border-transparent ${cfg.hoverBorder} text-[var(--fg-secondary)]`
              }`}
            >
              <Icon size={14} className={selected ? '' : 'opacity-60'} />
              <span>{lifecycleLabel(stateKey)}</span>
              <span className={`ml-0.5 inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded text-[11px] font-bold ${cfg.badgeBg} ${cfg.badgeColor}`}>
                {count}
              </span>
            </button>
          );
        };

        const Dot = () => <span className="text-[var(--fg-muted)] text-xs opacity-40 select-none">→</span>;
        const toggle = (key: string) =>
          setFilterLifecycle(filterLifecycle === key ? '' : key as KnowledgeLifecycle);

        return (
          <div className="flex items-center gap-x-1.5 gap-y-2 flex-wrap text-[var(--fg-secondary)]">
            <StateChip stateKey="pending" onClick={() => toggle('pending')} />
            <Dot />
            <StateChip stateKey="staging" onClick={() => toggle('staging')} />
            <Dot />
            <StateChip stateKey="active" onClick={() => toggle('active')} />
            <Dot />
            <StateChip stateKey="evolving" onClick={() => toggle('evolving')} />
            <span className="mx-1.5 h-4 border-l border-[var(--border-default)]" />
            <StateChip stateKey="decaying" onClick={() => toggle('decaying')} />
            <Dot />
            <StateChip stateKey="deprecated" onClick={() => toggle('deprecated')} />
          </div>
        );
      })()}

      {/* ── 工具栏 ── */}
      <div className="flex flex-wrap items-center gap-3">
        {/* 搜索 */}
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--fg-muted)]" size={16} />
          <input
            type="text"
            placeholder={t('knowledge.searchPlaceholder')}
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            className="w-full pl-9 pr-3 py-2 rounded-lg border border-[var(--border-default)] text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
          />
        </div>

        {/* Kind 筛选 */}
        <div className="flex gap-1">
          {Object.entries(KIND_CONFIG).map(([key, cfg]) => {
            const Icon = cfg.icon;
            return (
              <button
                key={key}
                onClick={() => setFilterKind(filterKind === key ? '' : key as KnowledgeKind)}
                className={`flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-medium border transition-all ${
                  filterKind === key ? `${cfg.bg} ${cfg.border} ${cfg.color}` : 'bg-[var(--bg-surface)] border-[var(--border-default)] text-[var(--fg-secondary)] hover:bg-[var(--bg-subtle)]'
                }`}
              >
                <Icon size={12} />
                {t(cfg.labelKey)}
              </button>
            );
          })}
        </div>

        {/* Category 筛选 */}
        <Select
          value={filterCategory}
          onChange={v => setFilterCategory(v)}
          options={[
            { value: '', label: t('knowledge.allCategories') },
            ...['View', 'Service', 'Tool', 'Model', 'Network', 'Storage', 'UI', 'Utility'].map(c => ({ value: c, label: c })),
          ]}
          size="sm"
          className="text-xs"
        />

        {/* 刷新 */}
        <button onClick={refresh} className="p-2 rounded-md text-[var(--fg-muted)] hover:bg-[var(--bg-subtle)]" title={t('common.refresh')}>
          <RefreshCw size={16} />
        </button>

        {/* 批量操作 */}
        {selectedIds.size > 0 && (() => {
          const publishableCount = entries.filter(e => selectedIds.has(e.id) && PUBLISHABLE_STATES.includes(e.lifecycle)).length;
          const deprecatableCount = entries.filter(e => selectedIds.has(e.id) && (e.lifecycle === 'active' || e.lifecycle === 'evolving')).length;
          return (
            <div className="flex items-center gap-2 ml-auto">
              <span className="text-xs text-[var(--fg-secondary)]">{t('knowledge.selectedCount', { count: selectedIds.size })}</span>
              {publishableCount > 0 && (
                <button onClick={handleBatchPublish} disabled={batchLoading}
                  className="px-2.5 py-1 text-xs font-medium text-green-700 bg-green-50 border border-green-200 rounded-md hover:bg-green-100 disabled:opacity-50">
                  {batchLoading ? <Loader2 size={12} className="animate-spin" /> : t('knowledge.batchPublish')} ({publishableCount})
                </button>
              )}
              {deprecatableCount > 0 && (
                <button onClick={handleBatchDeprecate} disabled={batchLoading}
                  className="px-2.5 py-1 text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-md hover:bg-amber-100 disabled:opacity-50 flex items-center gap-1">
                  {batchLoading ? <Loader2 size={12} className="animate-spin" /> : <Archive size={12} />}
                  {t('knowledge.batchDeprecate')} ({deprecatableCount})
                </button>
              )}
              <button onClick={handleBatchDelete} disabled={batchLoading}
                className="px-2.5 py-1 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-md hover:bg-red-100 disabled:opacity-50 flex items-center gap-1">
                {batchLoading ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                {t('knowledge.batchDelete')} ({selectedIds.size})
              </button>
              <button onClick={() => setSelectedIds(new Set())} className="p-1 text-[var(--fg-muted)] hover:text-[var(--fg-primary)]">
                <X size={14} />
              </button>
            </div>
          );
        })()}
        {/* 快速批量发布可自动通过的条目 — 仅当存在 pending 条目时显示 */}
        {selectedIds.size === 0 && entries.some(e => e.lifecycle === 'pending') && (
          <button onClick={handleBatchPublishAutoApprovable} disabled={batchLoading}
            className="ml-auto px-3 py-1.5 text-xs font-medium text-cyan-700 bg-cyan-50 border border-cyan-200 rounded-md hover:bg-cyan-100 disabled:opacity-50 flex items-center gap-1.5">
            {batchLoading ? <Loader2 size={12} className="animate-spin" /> : <Zap size={12} />}
            {t('knowledge.quickBatchPublish')}
          </button>
        )}
      </div>

      {/* ── 列表 ── */}
      {loading ? (
        <KnowledgeSkeleton />
      ) : entries.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-[var(--fg-muted)]">
          <Library size={48} className="mb-4 opacity-30" />
          <p className="text-sm">{t('knowledge.noResults')}</p>
          {(keyword || filterLifecycle || filterKind || filterCategory) && (
            <button
              onClick={() => { setSearchInput(''); setFilterLifecycle(''); setFilterKind(''); setFilterCategory(''); }}
              className="mt-2 text-xs text-blue-500 hover:text-blue-700"
            >
              {t('knowledge.clearFilters')}
            </button>
          )}
        </div>
      ) : (
        <>
          {/* 全选 */}
          <div className="flex items-center gap-2 px-1">
            <input
              type="checkbox"
              checked={selectedIds.size === entries.length && entries.length > 0}
              onChange={toggleSelectAll}
              className="rounded border-[var(--border-default)]"
            />
            <span className="text-xs text-[var(--fg-muted)]">{t('knowledge.selectAll')}</span>
            <span className="text-xs text-[var(--fg-muted)] ml-auto">{t('knowledge.totalCount', { count: total })}</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {entries.map(entry => {
              const lc = LIFECYCLE_CONFIG[entry.lifecycle] || LIFECYCLE_CONFIG.pending;
              const kc = KIND_CONFIG[entry.kind] || KIND_CONFIG.pattern;
              const LcIcon = lc.icon;
              const KindIcon = kc.icon;
              const conf = confidenceColor(entry.reasoning?.confidence);

              return (
                <div
                  key={entry.id}
                  onClick={() => setSelected(entry)}
                  className={`group bg-[var(--bg-surface)] rounded-xl border shadow-sm hover:shadow-md cursor-pointer transition-all overflow-hidden ${
                    selected?.id === entry.id ? 'ring-2 ring-blue-300 border-blue-200' : 'border-[var(--border-default)]'
                  }`}
                >
                  <div className="px-4 pt-3 pb-2">
                    {/* 复选框 + badges 行 */}
                    <div className="flex items-center gap-2 mb-1.5">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(entry.id)}
                        onChange={e => { e.stopPropagation(); toggleSelect(entry.id); }}
                        onClick={e => e.stopPropagation()}
                        className="rounded border-[var(--border-default)]"
                      />
                      {/* Lifecycle */}
                      <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${lc.bg} ${lc.color} ${lc.border} border`}>
                        <LcIcon size={10} />{lifecycleLabel(entry.lifecycle)}
                      </span>
                      {/* Kind */}
                      <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${kc.bg} ${kc.color} ${kc.border} border`}>
                        <KindIcon size={10} />{t(kc.labelKey)}
                      </span>
                      {/* Category */}
                      {entry.category && (
                        <span className="text-[10px] text-[var(--fg-muted)]">{entry.category}</span>
                      )}
                      {/* Confidence */}
                      <span className={`text-[10px] px-1.5 py-0.5 rounded ${conf.bg} ${conf.text}`}>
                        {entry.reasoning?.confidence != null ? `${Math.round(entry.reasoning.confidence * 100)}%` : '—'}
                      </span>
                      {/* Auto-approvable 标记 */}
                      {entry.autoApprovable && entry.lifecycle === 'pending' && (
                        <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-cyan-50 text-cyan-600 border border-cyan-200">
                          <Zap size={9} />{t('knowledge.autoApprovable')}
                        </span>
                      )}
                    </div>

                    {/* Title */}
                    <h3 className="text-sm font-bold text-[var(--fg-primary)] mb-1 break-words leading-snug">{entry.title}</h3>

                    {/* Description / Summary */}
                    {(entry.description || entry.content?.rationale) && (
                      <p className="text-xs text-[var(--fg-secondary)] line-clamp-2 leading-relaxed">
                        {entry.description || entry.content?.rationale || ''}
                      </p>
                    )}

                    {/* 代码预览 */}
                    {entry.content?.pattern && (
                      <pre className="mt-1.5 text-[10px] text-[var(--fg-secondary)] bg-[var(--bg-subtle)] rounded p-1.5 line-clamp-3 font-mono overflow-hidden">
                        {codePreview(entry.content.pattern, 3)}
                      </pre>
                    )}
                  </div>

                  {/* Tags + 时间 底部行 */}
                  <div className="px-4 py-2 bg-[var(--bg-subtle)] border-t border-[var(--border-default)] flex items-center gap-2">
                    {entry.tags?.slice(0, 3).map(tag => (
                      <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-600 border border-blue-100">{tag}</span>
                    ))}
                    {entry.tags && entry.tags.length > 3 && (
                      <span className="text-[10px] text-[var(--fg-muted)]">+{entry.tags.length - 3}</span>
                    )}
                    <span className="text-[10px] text-[var(--fg-muted)] ml-auto">
                      {entry.trigger && <span className="text-blue-400 mr-2">{entry.trigger}</span>}
                      {entry.source && <span className="mr-2">{entry.source}</span>}
                      {formatDate(entry.updatedAt, t)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>

          <Pagination
            currentPage={page}
            totalPages={Math.ceil(total / pageSize)}
            onPageChange={setPage}
            pageSize={pageSize}
            onPageSizeChange={(size: number) => { setPageSize(size); setPage(1); }}
            totalItems={total}
          />
        </>
      )}

      {/* ═══ 详情抽屉 ═══ */}
      {selected && (() => {
        const lc = LIFECYCLE_CONFIG[selected.lifecycle] || LIFECYCLE_CONFIG.pending;
        const kc = KIND_CONFIG[selected.kind] || KIND_CONFIG.pattern;
        const catCfg = categoryConfigs[selected.category || ''] || categoryConfigs['All'] || {};
        const r = selected.reasoning;
        const currentIndex = entries.findIndex(e => e.id === selected.id);
        const hasPrev = currentIndex > 0;
        const hasNext = currentIndex < entries.length - 1;
        const goToPrev = () => { if (hasPrev) setSelected(entries[currentIndex - 1]); };
        const goToNext = () => { if (hasNext) setSelected(entries[currentIndex + 1]); };

        return (
        <Drawer open={!!selected} onClose={() => setSelected(null)} size={drawerWide ? 'lg' : 'md'}>
          <Drawer.Header
            title={selected.title}
            leading={
              <button
                onClick={() => { handleDelete(selected); setSelected(null); }}
                title={t('common.delete')}
                className="p-1.5 text-[var(--fg-muted)] hover:text-red-500 rounded-md transition-colors opacity-30 hover:opacity-100 shrink-0"
              >
                <Trash2 size={14} />
              </button>
            }
          >
              <Drawer.Nav
                currentIndex={currentIndex}
                total={entries.length}
                onPrev={goToPrev}
                onNext={goToNext}
                hasPrev={hasPrev}
                hasNext={hasNext}
              />
              <Drawer.HeaderActions>
                <Drawer.WidthToggle
                  isWide={drawerWide}
                  onToggle={toggleDrawerWide}
                  title={drawerWide ? t('knowledge.narrow') : t('knowledge.widen')}
                />
                <Drawer.CloseButton onClose={() => setSelected(null)} />
              </Drawer.HeaderActions>
          </Drawer.Header>

            {/* ── 面板内容 ── */}
            <Drawer.Body>
              {/* 驳回原因 */}
              {selected.rejectionReason && (
                <div className="px-6 py-3 border-b border-[var(--border-default)] bg-red-500/10">
                  <label className="text-[10px] font-bold text-red-400 uppercase mb-1.5 block">{t('knowledge.rejectionReason')}</label>
                  <p className="text-xs text-red-500 dark:text-red-400">{translateRejectionReason(selected.rejectionReason)}</p>
                </div>
              )}

              {/* 1–2. Badges + Metadata + Tags */}
              <DrawerMeta
                badges={(() => {
                  const b: BadgeItem[] = [];
                  b.push({ label: lifecycleLabel(selected.lifecycle), className: `${lc.bg} ${lc.color} ${lc.border}`, icon: lc.icon });
                  b.push({ label: t(kc.labelKey), className: `${kc.bg} ${kc.color} ${kc.border}`, icon: kc.icon });
                  b.push({ label: selected.category || 'general', className: `font-bold uppercase ${catCfg?.bg || 'bg-[var(--bg-subtle)]'} ${catCfg?.color || 'text-[var(--fg-muted)]'} ${catCfg?.border || 'border-[var(--border-default)]'}` });
                  if (selected.knowledgeType) b.push({ label: selected.knowledgeType, className: 'bg-purple-50 text-purple-700 border-purple-200' });
                  if (selected.language) b.push({ label: selected.language, className: 'uppercase font-bold text-[var(--fg-secondary)] bg-[var(--bg-subtle)] border-[var(--border-default)]' });
                  if (selected.trigger) b.push({ label: selected.trigger, className: 'font-mono font-bold bg-amber-50 text-amber-700 border-amber-200' });
                  return b;
                })()}
                metadata={(() => {
                  const m: MetaItem[] = [];
                  if (selected.scope) m.push({ icon: Globe, iconClass: 'text-teal-400', label: t('knowledge.scope'), value: selected.scope === 'universal' ? t('knowledge.scopeUniversal') : selected.scope === 'project-specific' ? t('knowledge.scopeProject') : selected.scope === 'module-level' ? t('knowledge.scopeModule') : selected.scope });
                  if (selected.complexity) m.push({ icon: Layers, iconClass: 'text-orange-400', label: t('knowledge.complexity'), value: selected.complexity === 'advanced' ? t('knowledge.complexityAdvanced') : selected.complexity === 'intermediate' ? t('knowledge.complexityIntermediate') : selected.complexity === 'beginner' ? t('knowledge.complexityBeginner') : selected.complexity });
                  if (selected.source && selected.source !== 'unknown') m.push({ icon: Globe, iconClass: 'text-violet-400', label: t('knowledge.source'), value: SOURCE_LABEL_KEYS[selected.source || ''] ? t(SOURCE_LABEL_KEYS[selected.source || ''].labelKey) : (selected.source || '-') });
                  if (selected.createdAt) m.push({ icon: Clock, iconClass: 'text-[var(--fg-muted)]', label: t('knowledge.createdAt'), value: formatDate(selected.createdAt, t) });
                  if (selected.updatedAt) m.push({ icon: Clock, iconClass: 'text-[var(--fg-muted)]', label: t('knowledge.updatedAt'), value: formatDate(selected.updatedAt, t) });
                  if (selected.publishedAt) m.push({ icon: CheckCircle2, iconClass: 'text-emerald-400', label: t('knowledge.published'), value: formatDate(selected.publishedAt, t) });
                  return m;
                })()}
                tags={selected.tags}
                id={selected.id}
                sourceFile={selected.sourceFile ?? undefined}
                sourceFileLabel={t('knowledge.sourceFile')}
              />

              {/* 3. Relations */}
              {selected.relations && Object.entries(selected.relations).some(([, v]) => Array.isArray(v) && v.length > 0) && (
                <div className="px-6 py-4 border-b border-[var(--border-default)]">
                  <div className="flex items-center gap-1.5 mb-2">
                    <Link2 size={12} className="text-purple-400" />
                    <label className="text-[10px] font-bold text-[var(--fg-muted)] uppercase">{t('knowledge.relatedKnowledge')}</label>
                    {(() => {
                      const total = Object.values(selected.relations).flat().length;
                      return total > 0 ? <span className="text-[9px] bg-purple-100 text-purple-600 px-1.5 py-0.5 rounded-full font-bold">{total}</span> : null;
                    })()}
                  </div>
                  <div className="space-y-1.5">
                    {Object.entries(selected.relations).map(([type, arr]) => {
                      if (!Array.isArray(arr) || arr.length === 0) return null;
                      return (
                        <div key={type} className="flex items-start gap-2">
                          <span className="text-[10px] font-mono text-[var(--fg-secondary)] shrink-0 whitespace-nowrap pt-0.5 uppercase">{type}</span>
                          <div className="flex flex-wrap gap-1">
                            {arr.map((rel: any, ri: number) => {
                              const rawTarget = rel.target || (typeof rel === 'string' ? rel : JSON.stringify(rel));
                              const displayName = titleLookup.get(rawTarget) || rawTarget;
                              return (
                              <span key={ri} className="inline-flex items-center gap-1 px-1.5 py-0.5 border rounded text-[10px] font-mono bg-purple-50 border-purple-200 text-purple-700" title={rawTarget}>
                                {displayName}
                              </span>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* 4. Stats */}
              {(selected.stats && Object.values(selected.stats).some(v => typeof v === 'number' && v > 0)) || (selected.quality && selected.quality.overall > 0) ? (
                <div className="px-6 py-3 border-b border-[var(--border-default)]">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <div className="bg-amber-50/60 rounded-xl p-3 text-center border border-amber-100">
                      <div className="text-lg font-bold text-amber-700">{selected.stats?.authority || Math.round((selected.quality?.overall || 0) * 5) || '—'}</div>
                      <div className="text-[10px] text-amber-500 font-medium">{t('knowledge.authorityScore')}</div>
                    </div>
                    <div className="bg-[var(--bg-subtle)] rounded-xl p-3 text-center border border-[var(--border-default)]">
                      <div className="text-lg font-bold text-[var(--fg-primary)]">{selected.stats?.guardHits ?? 0}</div>
                      <div className="text-[10px] text-[var(--fg-muted)] font-medium">{t('knowledge.guardHits')}</div>
                    </div>
                    <div className="bg-[var(--bg-subtle)] rounded-xl p-3 text-center border border-[var(--border-default)]">
                      <div className="text-lg font-bold text-[var(--fg-primary)]">{selected.stats?.adoptions ?? 0}</div>
                      <div className="text-[10px] text-[var(--fg-muted)] font-medium">{t('knowledge.adoptions')}</div>
                    </div>
                    <div className="bg-blue-50/60 rounded-xl p-3 text-center border border-blue-100">
                      <div className="text-lg font-bold text-blue-700">{selected.stats?.searchHits ?? 0}</div>
                      <div className="text-[10px] text-blue-500 font-medium">{t('knowledge.searchHits')}</div>
                    </div>
                  </div>
                  {selected.stats && (selected.stats.views > 0 || selected.stats.applications > 0) && (
                    <div className="flex items-center gap-4 mt-2 text-[10px] text-[var(--fg-muted)]">
                      <span>{t('knowledge.statViews')}: {selected.stats.views}</span>
                      <span>{t('knowledge.statApplications')}: {selected.stats.applications}</span>
                    </div>
                  )}
                </div>
              ) : null}

              {/* 5. Reasoning — 推理依据 */}
              <DrawerContent.Reasoning
                reasoning={r}
                labels={{ section: t('knowledge.reasoning'), source: `${t('knowledge.source')}:`, confidence: `${t('knowledge.confidence')}:`, alternatives: `${t('knowledge.alternatives')}:` }}
                filterSubmitted
              />

              {/* 6. Quality — 质量评级 */}
              <DrawerContent.Quality
                quality={selected.quality}
                labels={{ section: t('knowledge.qualityGrade'), completeness: t('knowledge.qualityCompletionLabel'), adaptation: t('knowledge.qualityAdaptation'), documentation: t('knowledge.qualityDocumentation') }}
                formatFixed
              />

              {/* 7. Description / Summary */}
              <DrawerContent.Description label={t('knowledge.summary')} text={selected.description} />

              {/* 8. Markdown 文档 */}
              <DrawerContent.MarkdownSection label={t('knowledge.markdownDoc')} content={selected.content?.markdown} />

              {/* 9. Headers */}
              <DrawerContent.Headers label={t('knowledge.importHeaders')} headers={selected.headers} />

              {/* 10. Code / 标准用法 */}
              <DrawerContent.CodePattern label={t('knowledge.codePattern')} code={selected.content?.pattern} language={selected.language} />

              {/* 11. Delivery 字段 */}
              <DrawerContent.Delivery
                delivery={{ topicHint: selected.topicHint, whenClause: selected.whenClause, doClause: selected.doClause, dontClause: selected.dontClause, coreCode: selected.coreCode }}
                language={selected.language}
              />

              {/* 12. Rationale */}
              <DrawerContent.Rationale label={t('knowledge.designRationale')} text={selected.content?.rationale} />

              {/* 13. Steps */}
              <DrawerContent.Steps label={t('knowledge.implementSteps')} steps={selected.content?.steps} />

              {/* 14. Constraints */}
              <DrawerContent.Constraints label={t('knowledge.constraintsLabel')} constraints={selected.constraints} />

              {/* 15. AI 洞察 */}
              {selected.aiInsight && (
                <div className="px-6 py-4 border-b border-[var(--border-default)]">
                  <label className="text-[10px] font-bold text-[var(--fg-muted)] uppercase mb-2 block flex items-center gap-1.5">
                    <Lightbulb size={11} className="text-cyan-400" /> {t('knowledge.aiInsight')}
                  </label>
                  <p className="text-sm text-[var(--fg-secondary)] leading-relaxed">{selected.aiInsight}</p>
                </div>
              )}

              {/* 16. 生命周期历史 */}
              {(() => {
                const hist = Array.isArray(selected.lifecycleHistory)
                  ? selected.lifecycleHistory
                  : (() => { try { const p = typeof selected.lifecycleHistory === 'string' ? JSON.parse(selected.lifecycleHistory) : null; return Array.isArray(p) ? p : []; } catch { return []; } })();
                return hist.length > 0 ? (
                <div className="px-6 py-4 border-b border-[var(--border-default)]">
                  <label className="text-[10px] font-bold text-[var(--fg-muted)] uppercase mb-2 block flex items-center gap-1.5">
                    <Clock size={11} className="text-[var(--fg-muted)]" /> {t('knowledge.lifecycleHistoryLabel')}
                  </label>
                  <div className="space-y-1">
                    {hist.map((h, i) => {
                      const fromCfg = LIFECYCLE_CONFIG[h.from] || LIFECYCLE_CONFIG.pending;
                      const toCfg = LIFECYCLE_CONFIG[h.to] || LIFECYCLE_CONFIG.pending;
                      return (
                        <div key={i} className="flex items-center gap-2 text-[10px]">
                          <span className="text-[var(--fg-muted)] w-20 shrink-0">{formatDate(h.at, t)}</span>
                          <span className={`${fromCfg.color}`}>{lifecycleLabel(h.from)}</span>
                          <span className="text-[var(--fg-muted)]">→</span>
                          <span className={`${toCfg.color} font-medium`}>{lifecycleLabel(h.to)}</span>
                          <span className="text-[var(--fg-muted)] ml-auto">by {h.by}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : null;
              })()}
            </Drawer.Body>

            {/* ── 面板底部操作栏 ── */}
            <Drawer.Footer>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => { handleDelete(selected); setSelected(null); }}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium text-red-500 hover:bg-red-50 border border-red-200 transition-colors"
                >
                  <Trash2 size={14} /> {t('common.delete')}
                </button>
              </div>
              <div className="flex items-center gap-2">
                {(LIFECYCLE_ACTIONS[selected.lifecycle] || []).map(act => {
                  const Icon = act.icon;
                  return (
                    <button
                      key={act.action}
                      onClick={() => act.needsReason ? handleActionWithReason(selected, act.action) : handleLifecycleAction(selected, act.action)}
                      disabled={actionLoading}
                      className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-bold border transition-colors disabled:opacity-50 ${act.bg} ${act.color} border-current/20`}
                    >
                      {actionLoading ? <Loader2 size={14} className="animate-spin" /> : <Icon size={14} />}
                      {actionLabel(act.action)}
                    </button>
                  );
                })}
              </div>
            </Drawer.Footer>
        </Drawer>
        );
      })()}
    </div>
  );
};

export default KnowledgeView;
