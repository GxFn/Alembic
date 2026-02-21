import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  BookOpen, Shield, Lightbulb, Search, Filter, ArrowUpDown, ChevronDown, ChevronUp,
  ChevronLeft, ChevronRight,
  Eye, Code2, Tag, Clock, CheckCircle2, Zap, Archive, RotateCcw, Trash2,
  Loader2, BarChart3, Maximize2, Minimize2, X, Copy, RefreshCw,
  Globe, Layers, Hash, FolderOpen, FileText, FileCode, Link2
} from 'lucide-react';
import { useDrawerWide } from '../../hooks/useDrawerWide';
import { useI18n } from '../../i18n';
import type {
  KnowledgeEntry, KnowledgeLifecycle, KnowledgeKind,
  KnowledgeStatsResponse
} from '../../types';
import api from '../../api';
import { notify } from '../../utils/notification';
import { categoryConfigs } from '../../constants';
import CodeBlock, { normalizeCode } from '../Shared/CodeBlock';
import MarkdownWithHighlight from '../Shared/MarkdownWithHighlight';
import Pagination from '../Shared/Pagination';
import { ICON_SIZES } from '../../constants/icons';
import PageOverlay from '../Shared/PageOverlay';

/* ═══ 配置 ══════════════════════════════════════════════ */

const LIFECYCLE_CONFIG: Record<string, { labelKey: string; color: string; bg: string; border: string; icon: React.ElementType }> = {
  pending:       { labelKey: 'lifecycle.pending',     color: 'text-amber-700',  bg: 'bg-amber-50',   border: 'border-amber-200',  icon: Clock },
  active:        { labelKey: 'lifecycle.active',      color: 'text-green-700',  bg: 'bg-green-50',   border: 'border-green-200',  icon: CheckCircle2 },
  deprecated:    { labelKey: 'lifecycle.deprecated',  color: 'text-orange-600', bg: 'bg-orange-50',  border: 'border-orange-200', icon: Archive },
};

const KIND_CONFIG: Record<string, { labelKey: string; color: string; bg: string; border: string; icon: React.ElementType }> = {
  rule:    { labelKey: 'kind.rule',    color: 'text-red-700',    bg: 'bg-red-50',    border: 'border-red-200',    icon: Shield },
  pattern: { labelKey: 'kind.pattern', color: 'text-violet-700', bg: 'bg-violet-50', border: 'border-violet-200', icon: Lightbulb },
  fact:    { labelKey: 'kind.fact',    color: 'text-cyan-700',   bg: 'bg-cyan-50',   border: 'border-cyan-200',   icon: BookOpen },
};

/** 生命周期操作按钮配置（3 状态） */
const LIFECYCLE_ACTIONS: Record<string, Array<{ action: string; labelKey: string; color: string; bg: string; icon: React.ElementType; needsReason?: boolean }>> = {
  pending:       [
    { action: 'publish',    labelKey: 'knowledge.actionPublish',    color: 'text-green-700',  bg: 'bg-green-50 hover:bg-green-100', icon: CheckCircle2 },
    { action: 'deprecate',  labelKey: 'knowledge.actionDeprecate',  color: 'text-orange-700', bg: 'bg-orange-50 hover:bg-orange-100', icon: Archive, needsReason: true },
  ],
  active:        [
    { action: 'deprecate',  labelKey: 'knowledge.actionDeprecate',  color: 'text-orange-700', bg: 'bg-orange-50 hover:bg-orange-100', icon: Archive, needsReason: true },
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
  if (c == null) return { ring: 'stroke-slate-200', text: 'text-slate-400', bg: 'bg-slate-50', labelKey: '' };
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
  'cli': { labelKey: 'knowledge.sourceCli', color: 'text-slate-600 bg-slate-50 border-slate-200' },
  'agent': { labelKey: 'knowledge.sourceAgent', color: 'text-violet-600 bg-violet-50 border-violet-200' },
  'submit_with_check': { labelKey: 'knowledge.sourceSubmitCheck', color: 'text-teal-600 bg-teal-50 border-teal-200' },
};

/* ═══ 置信度环 ════════════════════════════════════════ */

const ConfidenceRing: React.FC<{ value: number | null | undefined; size?: number }> = ({ value, size = 36 }) => {
  const r = (size - 6) / 2;
  const circumference = 2 * Math.PI * r;
  const pct = value != null ? Math.max(0, Math.min(1, value)) : 0;
  const offset = circumference * (1 - pct);
  const { ring, text } = confidenceColor(value);
  return (
    <div className="relative flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeWidth={3} className="text-slate-100" />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={3} strokeLinecap="round"
          className={ring} strokeDasharray={circumference} strokeDashoffset={offset}
          style={{ transition: 'stroke-dashoffset 0.5s ease' }} />
      </svg>
      <span className={`absolute text-[9px] font-bold ${text}`}>
        {value != null ? `${Math.round(value * 100)}` : '—'}
      </span>
    </div>
  );
};

/* ═══ Props ════════════════════════════════════════════ */

interface KnowledgeViewProps {
  onRefresh?: () => void;
  idTitleMap?: Record<string, string>;
}

/* ═══ 组件 ═════════════════════════════════════════════ */

const KnowledgeView: React.FC<KnowledgeViewProps> = ({ onRefresh, idTitleMap: idTitleMapProp }) => {
  const { t } = useI18n();

  // ── i18n 映射（覆盖模块级常量中的中文标签） ──
  const lifecycleLabel = (key: string) => {
    const map: Record<string, string> = {
      pending: t('knowledge.lifecyclePending'), active: t('knowledge.lifecycleActive'), deprecated: t('knowledge.lifecycleDeprecated'),
    };
    return map[key] || key;
  };
  const actionLabel = (action: string) => {
    const map: Record<string, string> = {
      publish: t('knowledge.actionPublish'), deprecate: t('knowledge.actionDeprecate'), reactivate: t('knowledge.actionReactivate'),
    };
    return map[action] || action;
  };

  // ── 状态 ──
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [stats, setStats] = useState<KnowledgeStatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
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
    } catch (err: any) {
      notify(err?.message || t('knowledge.loadFailed'), { title: t('common.loadFailed'), type: 'error' });
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

  useEffect(() => { fetchEntries(); }, [fetchEntries]);
  useEffect(() => { fetchStats(); }, [fetchStats]);

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
    onRefresh?.();
  }, [fetchEntries, fetchStats, onRefresh]);

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
    } catch (err: any) {
      notify(err?.response?.data?.error?.message || err?.message || t('common.operationFailed'), { title: t('common.operationFailed'), type: 'error' });
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
    } catch (err: any) {
      notify(err?.message || t('knowledge.deleteFailed'), { title: t('knowledge.deleteFailed'), type: 'error' });
    }
  };

  // ── 批量操作 ──
  const handleBatchPublish = async () => {
    if (selectedIds.size === 0) return;
    setBatchLoading(true);
    try {
      const result = await api.knowledgeBatchPublish([...selectedIds]);
      notify(t('knowledge.batchPublishResult', { success: result.successCount, fail: result.failureCount }), { title: t('knowledge.batchPublish') });
      setSelectedIds(new Set());
      refresh();
    } catch (err: any) {
      notify(err?.message || t('knowledge.batchPublishFailed'), { title: t('common.operationFailed'), type: 'error' });
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
    } catch (err: any) {
      notify(err?.message || t('knowledge.batchPublishFailed'), { title: t('common.operationFailed'), type: 'error' });
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
    <div className="space-y-4">
      {/* ── 统计卡片 ── */}
      {stats && (
        <div className="grid grid-cols-3 gap-3">
          {Object.entries(LIFECYCLE_CONFIG).map(([key, cfg]) => {
            const count = (stats as Record<string, number>)[key] || 0;
            const Icon = cfg.icon;
            return (
              <button
                key={key}
                onClick={() => { setFilterLifecycle(filterLifecycle === key ? '' : key as KnowledgeLifecycle); }}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg border transition-all text-left ${
                  filterLifecycle === key ? `${cfg.bg} ${cfg.border} ${cfg.color} ring-1 ring-current` : 'bg-white dark:bg-[#252a36] border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-[#2a3040]'
                }`}
              >
                <Icon size={14} />
                <div>
                  <div className="text-xs font-medium">{lifecycleLabel(key)}</div>
                  <div className="text-lg font-bold">{count}</div>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* ── 工具栏 ── */}
      <div className="flex flex-wrap items-center gap-3">
        {/* 搜索 */}
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
          <input
            type="text"
            placeholder={t('knowledge.searchPlaceholder')}
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            className="w-full pl-9 pr-3 py-2 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
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
                  filterKind === key ? `${cfg.bg} ${cfg.border} ${cfg.color}` : 'bg-white dark:bg-[#252a36] border-slate-200 dark:border-slate-600 text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-[#2a3040]'
                }`}
              >
                <Icon size={12} />
                {t(cfg.labelKey)}
              </button>
            );
          })}
        </div>

        {/* Category 筛选 */}
        <select
          value={filterCategory}
          onChange={e => setFilterCategory(e.target.value)}
          className="px-2.5 py-1.5 rounded-md text-xs border border-slate-200 dark:border-slate-600 bg-white dark:bg-[#252a36] text-slate-600 dark:text-slate-300 focus:outline-none"
        >
          <option value="">{t('knowledge.allCategories')}</option>
          {['View', 'Service', 'Tool', 'Model', 'Network', 'Storage', 'UI', 'Utility'].map(c => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>

        {/* 刷新 */}
        <button onClick={refresh} className="p-2 rounded-md text-slate-400 hover:bg-slate-100" title={t('common.refresh')}>
          <RefreshCw size={16} />
        </button>

        {/* 批量操作 */}
        {selectedIds.size > 0 && (
          <div className="flex items-center gap-2 ml-auto">
            <span className="text-xs text-slate-500">{t('knowledge.selectedCount', { count: selectedIds.size })}</span>
            <button onClick={handleBatchPublish} disabled={batchLoading}
              className="px-2.5 py-1 text-xs font-medium text-green-700 bg-green-50 border border-green-200 rounded-md hover:bg-green-100 disabled:opacity-50">
              {batchLoading ? <Loader2 size={12} className="animate-spin" /> : t('knowledge.batchPublish')}
            </button>
            <button onClick={() => setSelectedIds(new Set())} className="p-1 text-slate-400 hover:text-slate-600">
              <X size={14} />
            </button>
          </div>
        )}
        {/* 快速批量发布可自动通过的条目 */}
        {selectedIds.size === 0 && (
          <button onClick={handleBatchPublishAutoApprovable} disabled={batchLoading}
            className="ml-auto px-3 py-1.5 text-xs font-medium text-cyan-700 bg-cyan-50 border border-cyan-200 rounded-md hover:bg-cyan-100 disabled:opacity-50 flex items-center gap-1.5">
            {batchLoading ? <Loader2 size={12} className="animate-spin" /> : <Zap size={12} />}
            {t('knowledge.quickBatchPublish')}
          </button>
        )}
      </div>

      {/* ── 列表 ── */}
      {loading ? (
        <div className="flex items-center justify-center py-20 text-slate-400">
          <Loader2 size={24} className="animate-spin mr-2" />
          <span>{t('common.loading')}</span>
        </div>
      ) : entries.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-slate-400">
          <BookOpen size={48} className="mb-4 opacity-30" />
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
              className="rounded border-slate-300"
            />
            <span className="text-xs text-slate-400">{t('knowledge.selectAll')}</span>
            <span className="text-xs text-slate-400 ml-auto">{t('knowledge.totalCount', { count: total })}</span>
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
                  className={`group bg-white dark:bg-[#1e2028] rounded-xl border shadow-sm hover:shadow-md cursor-pointer transition-all overflow-hidden ${
                    selected?.id === entry.id ? 'ring-2 ring-blue-300 border-blue-200 dark:border-blue-700' : 'border-slate-200 dark:border-slate-700'
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
                        className="rounded border-slate-300"
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
                        <span className="text-[10px] text-slate-400">{entry.category}</span>
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
                    <h3 className="text-sm font-bold text-slate-900 mb-1 break-words leading-snug">{entry.title}</h3>

                    {/* Description / Summary */}
                    {(entry.description || entry.content?.rationale) && (
                      <p className="text-xs text-slate-500 line-clamp-2 leading-relaxed">
                        {entry.description || entry.content?.rationale || ''}
                      </p>
                    )}

                    {/* 代码预览 */}
                    {entry.content?.pattern && (
                      <pre className="mt-1.5 text-[10px] text-slate-500 bg-slate-50 rounded p-1.5 line-clamp-3 font-mono overflow-hidden">
                        {codePreview(entry.content.pattern, 3)}
                      </pre>
                    )}
                  </div>

                  {/* Tags + 时间 底部行 */}
                  <div className="px-4 py-2 bg-slate-50/80 dark:bg-[#252a36] border-t border-slate-100 dark:border-slate-700 flex items-center gap-2">
                    {entry.tags?.slice(0, 3).map(tag => (
                      <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-600 border border-blue-100">{tag}</span>
                    ))}
                    {entry.tags && entry.tags.length > 3 && (
                      <span className="text-[10px] text-slate-400">+{entry.tags.length - 3}</span>
                    )}
                    <span className="text-[10px] text-slate-300 ml-auto">
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
        const LcIcon = lc.icon;
        const kc = KIND_CONFIG[selected.kind] || KIND_CONFIG.pattern;
        const catCfg = categoryConfigs[selected.category || ''] || categoryConfigs['All'] || {};
        const srcInfo = SOURCE_LABEL_KEYS[selected.source || ''] || { labelKey: '', color: 'text-slate-500 bg-slate-50 border-slate-200' };
        const srcLabel = srcInfo.labelKey ? t(srcInfo.labelKey) : (selected.source || '');
        const r = selected.reasoning;
        const hasReasoning = r && (r.whyStandard || (r.sources && r.sources.length > 0) || r.confidence != null);
        const currentIndex = entries.findIndex(e => e.id === selected.id);
        const hasPrev = currentIndex > 0;
        const hasNext = currentIndex < entries.length - 1;
        const goToPrev = () => { if (hasPrev) setSelected(entries[currentIndex - 1]); };
        const goToNext = () => { if (hasNext) setSelected(entries[currentIndex + 1]); };

        return (
        <PageOverlay className="z-30 flex justify-end" onClick={() => setSelected(null)}>
          <PageOverlay.Backdrop className="bg-black/15 backdrop-blur-[1px]" />
          <div
            className={`relative h-full bg-white dark:bg-[#1e1e1e] shadow-2xl flex flex-col border-l border-slate-200 dark:border-slate-700 ${drawerWide ? 'w-[960px] max-w-[92vw]' : 'w-[700px] max-w-[92vw]'}`}
            style={{ animation: 'slideInRight 0.25s ease-out' }}
            onClick={e => e.stopPropagation()}
          >
            {/* ── 面板头部 ── */}
            <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 dark:border-slate-700 bg-gradient-to-b from-white to-slate-50/50 dark:from-[#252526] dark:to-[#1e1e1e] shrink-0">
              <div className="flex-1 min-w-0 mr-3">
                <h3 className="font-bold text-slate-800 text-lg leading-snug break-words">{selected.title}</h3>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button onClick={goToPrev} disabled={!hasPrev} className="p-1.5 hover:bg-slate-100 rounded-lg transition-colors disabled:opacity-30" title={t('knowledge.prev')}><ChevronLeft size={ICON_SIZES.md} /></button>
                <span className="text-xs text-slate-400 tabular-nums">{currentIndex + 1}/{entries.length}</span>
                <button onClick={goToNext} disabled={!hasNext} className="p-1.5 hover:bg-slate-100 rounded-lg transition-colors disabled:opacity-30" title={t('knowledge.next')}><ChevronRight size={ICON_SIZES.md} /></button>
                <div className="w-px h-5 bg-slate-200 mx-1" />
                <button onClick={toggleDrawerWide} className="p-1.5 hover:bg-slate-100 rounded-lg transition-colors text-slate-400" title={drawerWide ? t('knowledge.narrow') : t('knowledge.widen')}>
                  {drawerWide ? <Minimize2 size={ICON_SIZES.md} /> : <Maximize2 size={ICON_SIZES.md} />}
                </button>
                <button onClick={() => { handleDelete(selected); setSelected(null); }} className="p-1.5 hover:bg-red-50 rounded-lg text-red-500 transition-colors" title={t('common.delete')}><Trash2 size={ICON_SIZES.md} /></button>
                <button onClick={() => setSelected(null)} className="p-1.5 hover:bg-slate-100 rounded-lg transition-colors"><X size={ICON_SIZES.md} /></button>
              </div>
            </div>

            {/* ── 面板内容 ── */}
            <div className="flex-1 overflow-y-auto">
              {/* 驳回原因 */}
              {selected.rejectionReason && (
                <div className="px-6 py-3 border-b border-red-200 dark:border-red-800/40 bg-red-50/80 dark:bg-red-900/15">
                  <label className="text-[10px] font-bold text-red-500 uppercase mb-1.5 block">{t('knowledge.rejectionReason')}</label>
                  <p className="text-xs text-red-600">{selected.rejectionReason}</p>
                </div>
              )}

              {/* 1. Badges + Metadata */}
              <div className="px-6 py-4 border-b border-slate-100 space-y-3">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${lc.bg} ${lc.color} ${lc.border} border`}>
                    <LcIcon size={10} />{lifecycleLabel(selected.lifecycle)}
                  </span>
                  <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${kc.bg} ${kc.color} ${kc.border} border`}>
                    {React.createElement(kc.icon, { size: 10 })}{t(kc.labelKey)}
                  </span>
                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded uppercase flex items-center gap-1 border ${catCfg?.bg || 'bg-slate-50'} ${catCfg?.color || 'text-slate-400'} ${catCfg?.border || 'border-slate-100'}`}>
                    {selected.category || 'general'}
                  </span>
                  {selected.knowledgeType && (
                    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-purple-50 text-purple-700 border border-purple-200">{selected.knowledgeType}</span>
                  )}
                  {selected.language && (
                    <span className="text-[10px] uppercase font-bold text-slate-500 bg-slate-50 border border-slate-200 px-1.5 py-0.5 rounded">{selected.language}</span>
                  )}
                  {selected.trigger && (
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200 font-bold">{selected.trigger}</span>
                  )}
                </div>
                <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs">
                  {(() => {
                    const items: { icon: React.ElementType; iconClass: string; label: string; value: string; mono?: boolean }[] = [];
                    if (selected.scope) items.push({ icon: Globe, iconClass: 'text-teal-400', label: t('knowledge.scope'), value: selected.scope === 'universal' ? t('knowledge.scopeUniversal') : selected.scope === 'project-specific' ? t('knowledge.scopeProject') : selected.scope === 'module-level' ? t('knowledge.scopeModule') : selected.scope });
                    if (selected.complexity) items.push({ icon: Layers, iconClass: 'text-orange-400', label: t('knowledge.complexity'), value: selected.complexity === 'advanced' ? t('knowledge.complexityAdvanced') : selected.complexity === 'intermediate' ? t('knowledge.complexityIntermediate') : selected.complexity === 'beginner' ? t('knowledge.complexityBeginner') : selected.complexity });
                    if (selected.source && selected.source !== 'unknown') items.push({ icon: Globe, iconClass: 'text-violet-400', label: t('knowledge.source'), value: SOURCE_LABEL_KEYS[selected.source || ''] ? t(SOURCE_LABEL_KEYS[selected.source || ''].labelKey) : (selected.source || '-') });
                    if (selected.createdAt) items.push({ icon: Clock, iconClass: 'text-slate-400', label: t('knowledge.createdAt'), value: formatDate(selected.createdAt, t) });
                    if (selected.updatedAt) items.push({ icon: Clock, iconClass: 'text-slate-400', label: t('knowledge.updatedAt'), value: formatDate(selected.updatedAt, t) });
                    if (selected.publishedAt) items.push({ icon: CheckCircle2, iconClass: 'text-emerald-400', label: t('knowledge.published'), value: formatDate(selected.publishedAt, t) });
                    return items.map((item, i) => {
                      const Icon = item.icon;
                      return (
                        <div key={i} className="flex items-center gap-1.5">
                          <Icon size={11} className={`${item.iconClass} shrink-0`} />
                          <span className="text-slate-400">{item.label}</span>
                          <span className={`font-medium text-slate-600 ${item.mono ? 'font-mono text-[11px]' : ''}`}>{item.value}</span>
                        </div>
                      );
                    });
                  })()}
                  <div className="flex items-center gap-1.5 basis-full mt-0.5">
                    <Hash size={11} className="text-slate-300 shrink-0" />
                    <span className="text-slate-400">ID</span>
                    <code className="font-mono text-[11px] text-slate-500 break-all">{selected.id}</code>
                  </div>
                  {selected.sourceFile && (
                    <div className="flex items-center gap-1.5 basis-full">
                      <FolderOpen size={11} className="text-slate-300 shrink-0" />
                      <span className="text-slate-400">{t('knowledge.sourceFile')}</span>
                      <code className="font-mono text-[11px] text-slate-500 break-all">{selected.sourceFile}</code>
                    </div>
                  )}
                </div>
              </div>

              {/* 2. Tags */}
              {selected.tags && selected.tags.length > 0 && (
                <div className="px-6 py-3 border-b border-slate-100 flex flex-wrap items-center gap-1.5">
                  <Tag size={11} className="text-slate-300 mr-0.5" />
                  {selected.tags.map((tag, i) => (
                    <span key={i} className="text-[9px] px-2 py-0.5 rounded bg-blue-50 text-blue-600 border border-blue-100 font-medium">{tag}</span>
                  ))}
                </div>
              )}

              {/* 3. Relations */}
              {selected.relations && Object.entries(selected.relations).some(([, v]) => Array.isArray(v) && v.length > 0) && (
                <div className="px-6 py-4 border-b border-slate-100">
                  <div className="flex items-center gap-1.5 mb-2">
                    <Link2 size={12} className="text-purple-400" />
                    <label className="text-[10px] font-bold text-slate-400 uppercase">{t('knowledge.relatedKnowledge')}</label>
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
                          <span className="text-[10px] font-mono text-slate-500 shrink-0 whitespace-nowrap pt-0.5 uppercase">{type}</span>
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
              {selected.stats && Object.values(selected.stats).some(v => v > 0) && (
                <div className="px-6 py-3 border-b border-slate-100">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <div className="bg-amber-50/60 dark:bg-amber-900/20 rounded-xl p-3 text-center border border-amber-100 dark:border-amber-800/40">
                      <div className="text-lg font-bold text-amber-700">{selected.stats?.authority ?? '—'}</div>
                      <div className="text-[10px] text-amber-500 font-medium">{t('knowledge.authorityScore')}</div>
                    </div>
                    <div className="bg-slate-50 rounded-xl p-3 text-center border border-slate-100">
                      <div className="text-lg font-bold text-slate-800">{selected.stats?.guardHits ?? 0}</div>
                      <div className="text-[10px] text-slate-400 font-medium">{t('knowledge.guardHits')}</div>
                    </div>
                    <div className="bg-slate-50 rounded-xl p-3 text-center border border-slate-100">
                      <div className="text-lg font-bold text-slate-800">{selected.stats?.adoptions ?? 0}</div>
                      <div className="text-[10px] text-slate-400 font-medium">{t('knowledge.adoptions')}</div>
                    </div>
                    <div className="bg-blue-50/60 dark:bg-blue-900/20 rounded-xl p-3 text-center border border-blue-100 dark:border-blue-800/40">
                      <div className="text-lg font-bold text-blue-700">{selected.stats?.searchHits ?? 0}</div>
                      <div className="text-[10px] text-blue-500 font-medium">{t('knowledge.searchHits')}</div>
                    </div>
                  </div>
                  {(selected.stats.views > 0 || selected.stats.applications > 0) && (
                    <div className="flex items-center gap-4 mt-2 text-[10px] text-slate-400">
                      <span>{t('knowledge.statViews')}: {selected.stats.views}</span>
                      <span>{t('knowledge.statApplications')}: {selected.stats.applications}</span>
                    </div>
                  )}
                </div>
              )}

              {/* 5. Reasoning — 推理依据 */}
              {hasReasoning && (
                <div className="px-6 py-4 border-b border-slate-100">
                  <label className="text-[10px] font-bold text-slate-400 uppercase mb-2 block flex items-center gap-1.5">
                    <Lightbulb size={11} className="text-amber-400" /> {t('knowledge.reasoning')}
                  </label>
                  <div className="bg-amber-50/30 dark:bg-amber-900/15 border border-amber-100 dark:border-amber-800/40 rounded-xl p-4 space-y-2.5">
                    {r!.whyStandard && !/^Submitted via /i.test(r!.whyStandard) && (
                      <p className="text-sm text-slate-700 leading-relaxed">{r!.whyStandard}</p>
                    )}
                    {r!.sources && r!.sources.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[10px] text-slate-400 font-bold">{t('knowledge.source')}:</span>
                        {r!.sources.map((src: string, i: number) => (
                          <code key={i} className="text-[10px] px-2 py-0.5 bg-white dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/40 rounded text-amber-700 dark:text-amber-400 font-mono">{src}</code>
                        ))}
                      </div>
                    )}
                    {r!.confidence != null && r!.confidence > 0 && (
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-slate-400 font-bold">{t('knowledge.confidence')}:</span>
                        <div className="flex-1 max-w-[160px] h-1.5 bg-slate-200 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-amber-400 rounded-full"
                            style={{ width: `${Math.round((r!.confidence ?? 0) * 100)}%` }}
                          />
                        </div>
                        <span className="text-[10px] font-bold text-amber-600">{Math.round((r!.confidence ?? 0) * 100)}%</span>
                      </div>
                    )}
                    {r!.alternatives && r!.alternatives.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1.5 pt-1">
                        <span className="text-[10px] text-slate-400 font-bold">{t('knowledge.alternatives')}:</span>
                        {r!.alternatives.map((alt: string, i: number) => (
                          <span key={i} className="text-[10px] px-1.5 py-0.5 bg-slate-100 border border-slate-200 rounded text-slate-600">{alt}</span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* 6. Quality — 质量评级 */}
              {selected.quality && selected.quality.grade && selected.quality.grade !== 'F' && (
                <div className="px-6 py-3 border-b border-slate-100">
                  <label className="text-[10px] font-bold text-slate-400 uppercase mb-2 block">{t('knowledge.qualityGrade')}</label>
                  <div className="flex items-center gap-4">
                    <span className={`text-2xl font-black ${
                      selected.quality.grade === 'A' ? 'text-emerald-600' :
                      selected.quality.grade === 'B' ? 'text-blue-600' :
                      selected.quality.grade === 'C' ? 'text-amber-600' :
                      selected.quality.grade === 'D' ? 'text-orange-600' : 'text-slate-400'
                    }`}>{selected.quality.grade}</span>
                    <div className="flex-1 grid grid-cols-3 gap-2 text-[10px]">
                      {selected.quality.completeness != null && selected.quality.completeness > 0 && (
                        <div className="text-center">
                          <div className="font-bold text-slate-700">{selected.quality.completeness.toFixed(2)}</div>
                          <div className="text-slate-400">{t('knowledge.qualityCompletionLabel')}</div>
                        </div>
                      )}
                      {selected.quality.adaptation != null && selected.quality.adaptation > 0 && (
                        <div className="text-center">
                          <div className="font-bold text-slate-700">{selected.quality.adaptation.toFixed(2)}</div>
                          <div className="text-slate-400">{t('knowledge.qualityAdaptation')}</div>
                        </div>
                      )}
                      {selected.quality.documentation != null && selected.quality.documentation > 0 && (
                        <div className="text-center">
                          <div className="font-bold text-slate-700">{selected.quality.documentation.toFixed(2)}</div>
                          <div className="text-slate-400">{t('knowledge.qualityDocumentation')}</div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* 7. Description / Summary */}
              {selected.description && (
                <div className="px-6 py-4 border-b border-slate-100">
                  <label className="text-[10px] font-bold text-slate-400 uppercase mb-1.5 block">{t('knowledge.summary')}</label>
                  <p className="text-sm text-slate-600 leading-relaxed">{selected.description}</p>
                </div>
              )}

              {/* 8. Markdown 文档 */}
              {selected.content?.markdown && (
                <div className="px-6 py-4 border-b border-slate-100">
                  <label className="text-[10px] font-bold text-slate-400 uppercase mb-2 block flex items-center gap-1.5">
                    <FileText size={11} className="text-blue-400" /> {t('knowledge.markdownDoc')}
                  </label>
                  <div className="bg-blue-50/30 dark:bg-blue-900/15 border border-blue-100 dark:border-blue-800/40 rounded-xl p-4">
                    <div className="markdown-body text-sm text-slate-700 leading-relaxed">
                      <MarkdownWithHighlight content={selected.content.markdown} />
                    </div>
                  </div>
                </div>
              )}

              {/* 9. Headers */}
              {selected.headers && selected.headers.length > 0 && (
                <div className="px-6 py-3 border-b border-slate-100">
                  <label className="text-[10px] font-bold text-slate-400 uppercase mb-2 block">{t('knowledge.importHeaders')}</label>
                  <div className="flex flex-wrap gap-1.5">
                    {selected.headers.map((h, i) => (
                      <code key={i} className="px-2.5 py-1 bg-violet-50 text-violet-700 border border-violet-100 rounded-md text-[10px] font-mono font-medium">{h}</code>
                    ))}
                  </div>
                </div>
              )}

              {/* 10. Code / 标准用法 */}
              {selected.content?.pattern && (
                <div className="px-6 py-4 border-b border-slate-100">
                  <label className="text-[10px] font-bold text-slate-400 uppercase mb-2 block flex items-center gap-1.5">
                    <FileCode size={11} className="text-emerald-500" /> {t('knowledge.codePattern')}
                  </label>
                  <CodeBlock code={selected.content.pattern} language={selected.language === 'objc' ? 'objectivec' : selected.language} showLineNumbers />
                </div>
              )}

              {/* 11. Delivery 字段 */}
              {(selected.doClause || selected.whenClause || selected.dontClause || selected.topicHint || selected.coreCode) && (
                <div className="px-6 py-4 border-b border-slate-100">
                  <label className="text-[10px] font-bold text-slate-400 uppercase mb-2 block flex items-center gap-1.5">
                    <Layers size={11} className="text-indigo-400" /> Cursor Delivery
                  </label>
                  <div className="bg-indigo-50/30 dark:bg-indigo-900/15 border border-indigo-100 dark:border-indigo-800/40 rounded-xl p-4 space-y-1.5 text-xs">
                    {selected.topicHint && <div><span className="text-indigo-500 font-medium">Topic：</span><span className="text-slate-700">{selected.topicHint}</span></div>}
                    {selected.whenClause && <div><span className="text-blue-500 font-medium">When：</span><span className="text-slate-700">{selected.whenClause}</span></div>}
                    {selected.doClause && <div><span className="text-emerald-500 font-medium">Do：</span><span className="text-slate-700">{selected.doClause}</span></div>}
                    {selected.dontClause && <div><span className="text-red-500 font-medium">Don't：</span><span className="text-slate-700">{selected.dontClause}</span></div>}
                    {selected.coreCode && (
                      <div>
                        <span className="text-purple-500 font-medium">Core Code：</span>
                        <div className="mt-1">
                          <CodeBlock code={selected.coreCode} language={selected.language === 'objc' ? 'objectivec' : (selected.language || 'text')} />
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* 12. Rationale */}
              {selected.content?.rationale && (
                <div className="px-6 py-4 border-b border-slate-100">
                  <label className="text-[10px] font-bold text-slate-400 uppercase mb-2 block">{t('knowledge.designRationale')}</label>
                  <div className="bg-slate-50 border border-slate-100 rounded-xl p-4">
                    <p className="text-sm text-slate-600 leading-relaxed">{selected.content.rationale}</p>
                  </div>
                </div>
              )}

              {/* 13. Steps */}
              {selected.content?.steps && selected.content.steps.length > 0 && (
                <div className="px-6 py-4 border-b border-slate-100">
                  <label className="text-[10px] font-bold text-slate-400 uppercase mb-2 block">{t('knowledge.implementSteps')}</label>
                  <div className="space-y-2">
                    {selected.content.steps.map((step: any, i: number) => {
                      if (typeof step === 'string') {
                        return (
                          <div key={i} className="bg-slate-50 rounded-lg p-3 border border-slate-100 flex items-start gap-2.5">
                            <span className="text-[10px] font-bold text-blue-600 bg-blue-50 rounded-full w-5 h-5 flex items-center justify-center shrink-0 mt-0.5">{i + 1}</span>
                            <p className="text-xs text-slate-700 leading-relaxed">{step}</p>
                          </div>
                        );
                      }
                      const title = typeof step.title === 'string' ? step.title : '';
                      const desc = typeof step.description === 'string' ? step.description : '';
                      const code = typeof step.code === 'string' ? step.code : '';
                      return (
                        <div key={i} className="bg-slate-50 rounded-lg p-3 border border-slate-100">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-[10px] font-bold text-blue-600 bg-blue-50 rounded-full w-5 h-5 flex items-center justify-center shrink-0">{i + 1}</span>
                            {title && <span className="text-xs font-bold text-slate-700">{title}</span>}
                          </div>
                          {desc && <p className="text-xs text-slate-600 ml-7 leading-relaxed">{desc}</p>}
                          {code && <pre className="text-[11px] font-mono bg-slate-800 text-green-300 p-2.5 rounded-md mt-1.5 ml-7 overflow-x-auto whitespace-pre-wrap">{code}</pre>}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* 14. Constraints */}
              {selected.constraints && (() => {
                const c = selected.constraints;
                const total = (c.guards?.length || 0) + (c.boundaries?.length || 0) + (c.preconditions?.length || 0) + (c.sideEffects?.length || 0);
                if (!total) return null;
                return (
                  <div className="px-6 py-4 border-b border-slate-100">
                    <label className="text-[10px] font-bold text-slate-400 uppercase mb-2 block flex items-center gap-1.5">
                      <Shield size={11} className="text-amber-500" /> {t('knowledge.constraintsLabel')} <span className="text-amber-500 font-mono">{total}</span>
                    </label>
                    <div className="space-y-1.5 text-xs text-slate-600">
                      {c.guards?.map((g, i) => (
                        <div key={i} className="flex gap-1.5 items-start">
                          <span className={`text-xs mt-0.5 ${g.severity === 'error' ? 'text-red-500' : 'text-yellow-500'}`}>●</span>
                          <code className="font-mono text-[10px] bg-slate-100 px-1.5 py-0.5 rounded">{g.pattern}</code>
                          {g.message && <span className="text-[10px] text-slate-400">— {g.message}</span>}
                        </div>
                      ))}
                      {c.boundaries?.map((b, i) => <div key={i} className="flex gap-1.5"><span className="text-orange-400">●</span>{b}</div>)}
                      {c.preconditions?.map((p, i) => <div key={i} className="flex gap-1.5"><span className="text-blue-400">◆</span>{p}</div>)}
                      {c.sideEffects?.map((s, i) => <div key={i} className="flex gap-1.5"><span className="text-pink-400">⚡</span>{s}</div>)}
                    </div>
                  </div>
                );
              })()}

              {/* 15. AI 洞察 */}
              {selected.aiInsight && (
                <div className="px-6 py-4 border-b border-slate-100">
                  <label className="text-[10px] font-bold text-slate-400 uppercase mb-2 block flex items-center gap-1.5">
                    <Lightbulb size={11} className="text-cyan-400" /> {t('knowledge.aiInsight')}
                  </label>
                  <p className="text-sm text-slate-600 leading-relaxed">{selected.aiInsight}</p>
                </div>
              )}

              {/* 16. 生命周期历史 */}
              {(() => {
                const hist = Array.isArray(selected.lifecycleHistory)
                  ? selected.lifecycleHistory
                  : (() => { try { const p = typeof selected.lifecycleHistory === 'string' ? JSON.parse(selected.lifecycleHistory) : null; return Array.isArray(p) ? p : []; } catch { return []; } })();
                return hist.length > 0 ? (
                <div className="px-6 py-4 border-b border-slate-100">
                  <label className="text-[10px] font-bold text-slate-400 uppercase mb-2 block flex items-center gap-1.5">
                    <Clock size={11} className="text-slate-400" /> {t('knowledge.lifecycleHistoryLabel')}
                  </label>
                  <div className="space-y-1">
                    {hist.map((h, i) => {
                      const fromCfg = LIFECYCLE_CONFIG[h.from] || LIFECYCLE_CONFIG.pending;
                      const toCfg = LIFECYCLE_CONFIG[h.to] || LIFECYCLE_CONFIG.pending;
                      return (
                        <div key={i} className="flex items-center gap-2 text-[10px]">
                          <span className="text-slate-400 w-20 shrink-0">{formatDate(h.at, t)}</span>
                          <span className={`${fromCfg.color}`}>{lifecycleLabel(h.from)}</span>
                          <span className="text-slate-300">→</span>
                          <span className={`${toCfg.color} font-medium`}>{lifecycleLabel(h.to)}</span>
                          <span className="text-slate-400 ml-auto">by {h.by}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : null;
              })()}
            </div>

            {/* ── 面板底部操作栏 ── */}
            <div className="shrink-0 border-t border-slate-200 dark:border-slate-700 px-5 py-3 bg-gradient-to-b from-slate-50/80 to-white dark:from-[#252526] dark:to-[#1e1e1e] flex items-center justify-between">
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
            </div>
          </div>
        </PageOverlay>
        );
      })()}
    </div>
  );
};

export default KnowledgeView;
