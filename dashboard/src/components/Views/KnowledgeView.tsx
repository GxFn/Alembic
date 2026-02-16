import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  BookOpen, Shield, Lightbulb, Search, Filter, ArrowUpDown, ChevronDown, ChevronUp,
  Eye, Code2, Tag, Clock, CheckCircle2, Zap, Archive, RotateCcw, Trash2,
  Loader2, BarChart3, Maximize2, Minimize2, X, Copy, RefreshCw,
  Globe, Layers, Hash, FolderOpen
} from 'lucide-react';
import { useDrawerWide } from '../../hooks/useDrawerWide';
import type {
  KnowledgeEntry, KnowledgeLifecycle, KnowledgeKind,
  KnowledgeStatsResponse
} from '../../types';
import api from '../../api';
import { notify } from '../../utils/notification';
import { categoryConfigs } from '../../constants';
import CodeBlock from '../Shared/CodeBlock';
import MarkdownWithHighlight from '../Shared/MarkdownWithHighlight';
import Pagination from '../Shared/Pagination';
import { ICON_SIZES } from '../../constants/icons';
import PageOverlay from '../Shared/PageOverlay';

/* ═══ 配置 ══════════════════════════════════════════════ */

const LIFECYCLE_CONFIG: Record<string, { label: string; color: string; bg: string; border: string; icon: React.ElementType }> = {
  pending:       { label: '待审核',   color: 'text-amber-700',  bg: 'bg-amber-50',   border: 'border-amber-200',  icon: Clock },
  active:        { label: '已发布',   color: 'text-green-700',  bg: 'bg-green-50',   border: 'border-green-200',  icon: CheckCircle2 },
  deprecated:    { label: '已废弃',   color: 'text-orange-600', bg: 'bg-orange-50',  border: 'border-orange-200', icon: Archive },
};

const KIND_CONFIG: Record<string, { label: string; color: string; bg: string; border: string; icon: React.ElementType }> = {
  rule:    { label: 'Rule',    color: 'text-red-700',    bg: 'bg-red-50',    border: 'border-red-200',    icon: Shield },
  pattern: { label: 'Pattern', color: 'text-violet-700', bg: 'bg-violet-50', border: 'border-violet-200', icon: Lightbulb },
  fact:    { label: 'Fact',    color: 'text-cyan-700',   bg: 'bg-cyan-50',   border: 'border-cyan-200',   icon: BookOpen },
};

/** 生命周期操作按钮配置（3 状态） */
const LIFECYCLE_ACTIONS: Record<string, Array<{ action: string; label: string; color: string; bg: string; icon: React.ElementType; needsReason?: boolean }>> = {
  pending:       [
    { action: 'publish',    label: '发布',       color: 'text-green-700',  bg: 'bg-green-50 hover:bg-green-100', icon: CheckCircle2 },
    { action: 'deprecate',  label: '废弃',       color: 'text-orange-700', bg: 'bg-orange-50 hover:bg-orange-100', icon: Archive, needsReason: true },
  ],
  active:        [
    { action: 'deprecate',  label: '废弃',       color: 'text-orange-700', bg: 'bg-orange-50 hover:bg-orange-100', icon: Archive, needsReason: true },
  ],
  deprecated:    [
    { action: 'reactivate', label: '重新激活',   color: 'text-green-700',  bg: 'bg-green-50 hover:bg-green-100', icon: RotateCcw },
  ],
};

/* ═══ 工具函数 ═════════════════════════════════════════ */

function formatDate(ts: number | undefined | null): string {
  if (!ts) return '';
  const ms = ts < 1e12 ? ts * 1000 : ts;
  const d = new Date(ms);
  if (isNaN(d.getTime()) || d.getFullYear() < 2000) return '';
  const now = Date.now();
  const diffMs = now - ms;
  if (diffMs < 0) return d.toLocaleDateString('zh-CN');
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour} 小时前`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 7) return `${diffDay} 天前`;
  return d.toLocaleDateString('zh-CN');
}

function confidenceColor(c: number | null | undefined): { ring: string; text: string; bg: string; label: string } {
  if (c == null) return { ring: 'stroke-slate-200', text: 'text-slate-400', bg: 'bg-slate-50', label: '—' };
  if (c >= 0.8) return { ring: 'stroke-emerald-500', text: 'text-emerald-700', bg: 'bg-emerald-50', label: '高' };
  if (c >= 0.6) return { ring: 'stroke-blue-500', text: 'text-blue-700', bg: 'bg-blue-50', label: '中' };
  if (c >= 0.4) return { ring: 'stroke-amber-500', text: 'text-amber-700', bg: 'bg-amber-50', label: '中低' };
  return { ring: 'stroke-red-500', text: 'text-red-700', bg: 'bg-red-50', label: '低' };
}

function codePreview(code: string | undefined, maxLines = 4): string {
  if (!code) return '';
  return code.split('\n').slice(0, maxLines).join('\n');
}

/* ═══ 来源标签 ════════════════════════════════════════ */

const SOURCE_LABELS: Record<string, { label: string; color: string }> = {
  'bootstrap-scan': { label: 'AI 全量扫描', color: 'text-violet-600 bg-violet-50 border-violet-200' },
  'mcp': { label: 'MCP 提交', color: 'text-blue-600 bg-blue-50 border-blue-200' },
  'manual': { label: '手动创建', color: 'text-emerald-600 bg-emerald-50 border-emerald-200' },
  'file-watcher': { label: '文件监听', color: 'text-orange-600 bg-orange-50 border-orange-200' },
  'clipboard': { label: '剪贴板', color: 'text-pink-600 bg-pink-50 border-pink-200' },
  'cli': { label: 'CLI', color: 'text-slate-600 bg-slate-50 border-slate-200' },
  'agent': { label: 'AI Agent', color: 'text-violet-600 bg-violet-50 border-violet-200' },
  'submit_with_check': { label: 'AI 审查提交', color: 'text-teal-600 bg-teal-50 border-teal-200' },
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
}

/* ═══ 组件 ═════════════════════════════════════════════ */

const KnowledgeView: React.FC<KnowledgeViewProps> = ({ onRefresh }) => {
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
      notify(err?.message || '加载知识条目失败', { title: '加载失败', type: 'error' });
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

  // ── 生命周期操作 ──
  const handleLifecycleAction = async (entry: KnowledgeEntry, action: string, reason?: string) => {
    setActionLoading(true);
    try {
      const updated = await api.knowledgeLifecycle(entry.id, action, reason);
      notify(`${entry.title} → ${LIFECYCLE_CONFIG[updated.lifecycle]?.label || updated.lifecycle}`, { title: '操作成功' });
      // 更新本地列表
      setEntries(prev => prev.map(e => e.id === entry.id ? updated : e));
      if (selected?.id === entry.id) setSelected(updated);
      fetchStats();
    } catch (err: any) {
      notify(err?.response?.data?.error?.message || err?.message || '操作失败', { title: '操作失败', type: 'error' });
    } finally {
      if (isMountedRef.current) setActionLoading(false);
    }
  };

  const handleDelete = async (entry: KnowledgeEntry) => {
    if (!confirm(`确定删除「${entry.title}」？此操作不可恢复。`)) return;
    try {
      await api.knowledgeDelete(entry.id);
      notify(`已删除「${entry.title}」`, { title: '删除成功' });
      setEntries(prev => prev.filter(e => e.id !== entry.id));
      if (selected?.id === entry.id) setSelected(null);
      fetchStats();
    } catch (err: any) {
      notify(err?.message || '删除失败', { title: '删除失败', type: 'error' });
    }
  };

  // ── 批量操作 ──
  const handleBatchPublish = async () => {
    if (selectedIds.size === 0) return;
    setBatchLoading(true);
    try {
      const result = await api.knowledgeBatchPublish([...selectedIds]);
      notify(`发布 ${result.successCount} 条，失败 ${result.failureCount} 条`, { title: '批量发布' });
      setSelectedIds(new Set());
      refresh();
    } catch (err: any) {
      notify(err?.message || '批量发布失败', { title: '操作失败', type: 'error' });
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
      const autoIds = (result.data || []).filter((e: KnowledgeEntry) => e.auto_approvable).map((e: KnowledgeEntry) => e.id);
      if (autoIds.length === 0) {
        notify('当前没有可自动通过的待审核条目', { title: '无可发布项' });
        return;
      }
      const pub = await api.knowledgeBatchPublish(autoIds);
      notify(`已发布 ${pub.successCount} 条可自动通过的条目`, { title: '批量发布完成' });
      refresh();
    } catch (err: any) {
      notify(err?.message || '批量发布失败', { title: '操作失败', type: 'error' });
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
    const reason = prompt('请输入废弃原因：');
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
                  filterLifecycle === key ? `${cfg.bg} ${cfg.border} ${cfg.color} ring-1 ring-current` : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}
              >
                <Icon size={14} />
                <div>
                  <div className="text-xs font-medium">{cfg.label}</div>
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
            placeholder="搜索知识条目..."
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
                  filterKind === key ? `${cfg.bg} ${cfg.border} ${cfg.color}` : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50'
                }`}
              >
                <Icon size={12} />
                {cfg.label}
              </button>
            );
          })}
        </div>

        {/* Category 筛选 */}
        <select
          value={filterCategory}
          onChange={e => setFilterCategory(e.target.value)}
          className="px-2.5 py-1.5 rounded-md text-xs border border-slate-200 bg-white text-slate-600 focus:outline-none"
        >
          <option value="">所有分类</option>
          {['View', 'Service', 'Tool', 'Model', 'Network', 'Storage', 'UI', 'Utility'].map(c => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>

        {/* 刷新 */}
        <button onClick={refresh} className="p-2 rounded-md text-slate-400 hover:bg-slate-100" title="刷新">
          <RefreshCw size={16} />
        </button>

        {/* 批量操作 */}
        {selectedIds.size > 0 && (
          <div className="flex items-center gap-2 ml-auto">
            <span className="text-xs text-slate-500">已选 {selectedIds.size} 条</span>
            <button onClick={handleBatchPublish} disabled={batchLoading}
              className="px-2.5 py-1 text-xs font-medium text-green-700 bg-green-50 border border-green-200 rounded-md hover:bg-green-100 disabled:opacity-50">
              {batchLoading ? <Loader2 size={12} className="animate-spin" /> : '批量发布'}
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
            快速批量发布
          </button>
        )}
      </div>

      {/* ── 列表 ── */}
      {loading ? (
        <div className="flex items-center justify-center py-20 text-slate-400">
          <Loader2 size={24} className="animate-spin mr-2" />
          <span>加载中...</span>
        </div>
      ) : entries.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-slate-400">
          <BookOpen size={48} className="mb-4 opacity-30" />
          <p className="text-sm">暂无知识条目</p>
          {(keyword || filterLifecycle || filterKind || filterCategory) && (
            <button
              onClick={() => { setSearchInput(''); setFilterLifecycle(''); setFilterKind(''); setFilterCategory(''); }}
              className="mt-2 text-xs text-blue-500 hover:text-blue-700"
            >
              清除筛选条件
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
            <span className="text-xs text-slate-400">全选</span>
            <span className="text-xs text-slate-400 ml-auto">共 {total} 条</span>
          </div>

          <div className="space-y-2">
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
                  className={`group flex items-start gap-3 p-3 rounded-xl border bg-white hover:shadow-sm cursor-pointer transition-all ${
                    selected?.id === entry.id ? 'ring-2 ring-blue-300 border-blue-200' : 'border-slate-200'
                  }`}
                >
                  {/* 复选框 */}
                  <input
                    type="checkbox"
                    checked={selectedIds.has(entry.id)}
                    onChange={e => { e.stopPropagation(); toggleSelect(entry.id); }}
                    onClick={e => e.stopPropagation()}
                    className="mt-1 rounded border-slate-300"
                  />

                  {/* 主体 */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      {/* Lifecycle */}
                      <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${lc.bg} ${lc.color} ${lc.border} border`}>
                        <LcIcon size={10} />{lc.label}
                      </span>
                      {/* Kind */}
                      <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${kc.bg} ${kc.color} ${kc.border} border`}>
                        <KindIcon size={10} />{kc.label}
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
                      {entry.auto_approvable && entry.lifecycle === 'pending' && (
                        <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-cyan-50 text-cyan-600 border border-cyan-200">
                          <Zap size={9} />可自动通过
                        </span>
                      )}
                      {/* Source */}
                      <span className="text-[10px] text-slate-300 ml-auto">{entry.source}</span>
                    </div>

                    {/* Title */}
                    <h3 className="text-sm font-medium text-slate-800 truncate">{entry.title}</h3>

                    {/* Description / Summary */}
                    <p className="text-xs text-slate-500 mt-0.5 line-clamp-2">
                      {entry.summary_cn || entry.description || entry.content?.rationale || ''}
                    </p>

                    {/* 代码预览 */}
                    {entry.content?.pattern && (
                      <pre className="mt-1.5 text-[10px] text-slate-500 bg-slate-50 rounded p-1.5 line-clamp-3 font-mono overflow-hidden">
                        {codePreview(entry.content.pattern, 3)}
                      </pre>
                    )}

                    {/* Tags + 时间 */}
                    <div className="flex items-center gap-2 mt-2">
                      {entry.tags?.slice(0, 3).map(tag => (
                        <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">{tag}</span>
                      ))}
                      {entry.tags && entry.tags.length > 3 && (
                        <span className="text-[10px] text-slate-400">+{entry.tags.length - 3}</span>
                      )}
                      <span className="text-[10px] text-slate-300 ml-auto">
                        {entry.trigger && <span className="text-blue-400 mr-2">{entry.trigger}</span>}
                        {formatDate(entry.updated_at)}
                      </span>
                    </div>
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
        const srcInfo = SOURCE_LABELS[selected.source || ''] || { label: selected.source || '', color: 'text-slate-500 bg-slate-50 border-slate-200' };
        const r = selected.reasoning;
        const hasReasoning = r && (r.why_standard || (r.sources && r.sources.length > 0) || r.confidence != null);
        const currentIndex = entries.findIndex(e => e.id === selected.id);
        const hasPrev = currentIndex > 0;
        const hasNext = currentIndex < entries.length - 1;
        const goToPrev = () => { if (hasPrev) setSelected(entries[currentIndex - 1]); };
        const goToNext = () => { if (hasNext) setSelected(entries[currentIndex + 1]); };

        return (
        <PageOverlay className="z-30 flex justify-end" onClick={() => setSelected(null)}>
          <PageOverlay.Backdrop className="bg-black/15 backdrop-blur-[1px]" />
          <div
            className={`relative h-full bg-white shadow-2xl flex flex-col border-l border-slate-200 ${drawerWide ? 'w-[960px] max-w-[92vw]' : 'w-[700px] max-w-[92vw]'}`}
            style={{ animation: 'slideInRight 0.25s ease-out' }}
            onClick={e => e.stopPropagation()}
          >
            {/* ── 面板头部 ── */}
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-200 shrink-0 bg-slate-50/80">
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <ConfidenceRing value={selected.reasoning?.confidence ?? null} size={40} />
                <div className="flex-1 min-w-0">
                  <h3 className="font-bold text-sm text-slate-800 truncate">{selected.title}</h3>
                  <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${lc.bg} ${lc.color} ${lc.border} border`}>
                      <LcIcon size={10} />{lc.label}
                    </span>
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded uppercase flex items-center gap-1 border ${catCfg?.bg || 'bg-slate-50'} ${catCfg?.color || 'text-slate-400'} ${catCfg?.border || 'border-slate-100'}`}>
                      {selected.category || 'general'}
                    </span>
                    {selected.source && selected.source !== 'unknown' && (
                      <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded border ${srcInfo.color}`}>
                        {srcInfo.label}
                      </span>
                    )}
                    <span className="text-[10px] text-slate-400">{currentIndex + 1}/{entries.length}</span>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0 ml-2">
                <button onClick={goToPrev} disabled={!hasPrev} title="上一条"
                  className={`p-1.5 rounded-lg transition-colors ${hasPrev ? 'hover:bg-slate-200 text-slate-500' : 'text-slate-300 cursor-not-allowed'}`}>
                  <ChevronUp size={16} />
                </button>
                <button onClick={goToNext} disabled={!hasNext} title="下一条"
                  className={`p-1.5 rounded-lg transition-colors ${hasNext ? 'hover:bg-slate-200 text-slate-500' : 'text-slate-300 cursor-not-allowed'}`}>
                  <ChevronDown size={16} />
                </button>
                <button onClick={toggleDrawerWide} className="p-1.5 hover:bg-slate-200 rounded-lg transition-colors text-slate-400" title={drawerWide ? '收窄面板' : '展开更宽'}>
                  {drawerWide ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
                </button>
                <button onClick={() => setSelected(null)} className="p-1.5 hover:bg-slate-200 rounded-lg transition-colors text-slate-400">
                  <X size={18} />
                </button>
              </div>
            </div>

            {/* ── 面板内容 ── */}
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
              {/* 驳回原因 */}
              {selected.rejection_reason && (
                <section className="bg-red-50 border border-red-200 rounded p-3">
                  <h3 className="text-xs font-semibold text-red-500 uppercase tracking-wider mb-2">驳回原因</h3>
                  <p className="text-xs text-red-600">{selected.rejection_reason}</p>
                </section>
              )}

              {/* 基本信息 */}
              <section>
                <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">基本信息</h3>
                <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs">
                  {(() => {
                    const KindIcon = kc.icon;
                    const items: { icon: React.ElementType; iconClass: string; label: string; value: string; mono?: boolean }[] = [
                      { icon: KindIcon, iconClass: kc.color.replace('text-', 'text-'), label: 'Kind', value: kc.label },
                      { icon: Code2, iconClass: 'text-sky-400', label: '语言', value: selected.language?.toUpperCase() || '-' },
                      { icon: Tag, iconClass: 'text-indigo-400', label: '分类', value: selected.category || '-' },
                    ];
                    if (selected.knowledge_type) items.push({ icon: Layers, iconClass: 'text-purple-400', label: '类型', value: selected.knowledge_type });
                    if (selected.complexity) items.push({ icon: Layers, iconClass: 'text-orange-400', label: '复杂度', value: selected.complexity === 'advanced' ? '高级' : selected.complexity === 'intermediate' ? '中级' : selected.complexity === 'beginner' ? '初级' : selected.complexity });
                    if (selected.scope) items.push({ icon: Globe, iconClass: 'text-teal-400', label: '范围', value: selected.scope === 'universal' ? '通用' : selected.scope === 'project-specific' ? '项目级' : selected.scope === 'module-level' ? '模块级' : selected.scope });
                    items.push({ icon: Globe, iconClass: 'text-violet-400', label: '来源', value: (SOURCE_LABELS[selected.source || ''] || { label: selected.source || '-' }).label });
                    if (selected.trigger) items.push({ icon: Zap, iconClass: 'text-amber-400', label: '触发词', value: selected.trigger, mono: true });
                    if (selected.created_at) items.push({ icon: Clock, iconClass: 'text-slate-400', label: '创建', value: formatDate(selected.created_at) });
                    if (selected.updated_at) items.push({ icon: Clock, iconClass: 'text-slate-400', label: '更新', value: formatDate(selected.updated_at) });
                    if (selected.published_at) items.push({ icon: CheckCircle2, iconClass: 'text-emerald-400', label: '发布', value: formatDate(selected.published_at) });
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
                  {selected.source_file && (
                    <div className="flex items-center gap-1.5 basis-full">
                      <FolderOpen size={11} className="text-slate-300 shrink-0" />
                      <span className="text-slate-400">源文件</span>
                      <code className="font-mono text-[11px] text-slate-500 break-all">{selected.source_file}</code>
                    </div>
                  )}
                </div>
              </section>

              {/* 摘要 */}
              {(selected.summary_cn || selected.description || selected.summary_en) && (
                <section>
                  <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">摘要</h3>
                  {(selected.summary_cn || selected.description) && <p className="text-sm text-slate-600 leading-relaxed">{selected.summary_cn || selected.description}</p>}
                  {selected.summary_en && <p className="text-sm text-slate-400 italic mt-1">{selected.summary_en}</p>}
                </section>
              )}

              {/* 代码 */}
              {selected.content?.pattern && (
                <section>
                  <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">代码</h3>
                  <CodeBlock code={selected.content.pattern} language={selected.language === 'objc' ? 'objectivec' : selected.language} showLineNumbers />
                </section>
              )}

              {/* Markdown */}
              {selected.content?.markdown && (
                <section>
                  <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Markdown</h3>
                  <div className="prose prose-sm max-w-none">
                    <MarkdownWithHighlight content={selected.content.markdown} />
                  </div>
                </section>
              )}

              {/* 使用指南 */}
              {selected.usage_guide_cn && (
                <section>
                  <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">使用指南</h3>
                  <div className="prose prose-sm prose-slate max-w-none">
                    <MarkdownWithHighlight content={selected.usage_guide_cn} />
                  </div>
                </section>
              )}

              {/* 设计原理 */}
              {selected.content?.rationale && (
                <section>
                  <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">设计原理</h3>
                  <p className="text-xs text-slate-600 leading-relaxed">{selected.content.rationale}</p>
                </section>
              )}

              {/* 实施步骤 */}
              {selected.content?.steps && selected.content.steps.length > 0 && (
                <section>
                  <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">实施步骤</h3>
                  <ol className="ml-4 list-decimal space-y-0.5 text-xs text-slate-600">
                    {selected.content.steps.map((step: any, i: number) => (
                      <li key={i}>{typeof step === 'string' ? step : step.description || String(step)}</li>
                    ))}
                  </ol>
                </section>
              )}

              {/* 推理依据 */}
              {hasReasoning && (
                <section>
                  <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">推理依据</h3>
                  <div className="space-y-2 text-xs">
                    {r!.why_standard && !/^Submitted via /i.test(r!.why_standard) && (
                      <div>
                        <span className="text-slate-500 font-medium">Why Standard：</span>
                        <span className="text-slate-700">{r!.why_standard}</span>
                      </div>
                    )}
                    {r!.confidence != null && (
                      <div className="flex items-center gap-2">
                        <span className="text-slate-500 font-medium">置信度：</span>
                        <div className="flex-1 max-w-[180px] bg-slate-100 rounded-full h-1.5">
                          <div
                            className={`h-full rounded-full ${r!.confidence >= 0.7 ? 'bg-emerald-500' : r!.confidence >= 0.4 ? 'bg-amber-500' : 'bg-red-500'}`}
                            style={{ width: `${Math.round((r!.confidence ?? 0) * 100)}%` }}
                          />
                        </div>
                        <span className="font-medium text-slate-700">{Math.round((r!.confidence ?? 0) * 100)}%</span>
                      </div>
                    )}
                    {r!.sources && r!.sources.length > 0 && (
                      <div>
                        <span className="text-slate-500 font-medium">来源：</span>
                        <span className="text-slate-700">{r!.sources.join('、')}</span>
                      </div>
                    )}
                    {r!.alternatives && r!.alternatives.length > 0 && (
                      <div>
                        <span className="text-slate-500 font-medium">备选方案：</span>
                        <span className="text-slate-700">{r!.alternatives.join('、')}</span>
                      </div>
                    )}
                  </div>
                </section>
              )}

              {/* 约束 */}
              {selected.constraints && Object.values(selected.constraints).some(v => v && (Array.isArray(v) ? v.length > 0 : true)) && (
                <section>
                  <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">约束</h3>
                  <div className="space-y-2 text-xs">
                    {selected.constraints.guards && selected.constraints.guards.length > 0 && (
                      <div>
                        <span className="text-slate-500 font-medium">Guards：</span>
                        {selected.constraints.guards.map((g, i) => (
                          <div key={i} className="ml-3 mt-1 bg-slate-50 rounded p-1.5">
                            <code className="font-mono text-red-700">{g.pattern}</code>
                            <span className="ml-2 text-slate-500">{g.message || ''}</span>
                            <span className={`ml-2 ${g.severity === 'error' ? 'text-red-600' : 'text-amber-600'}`}>[{g.severity}]</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {selected.constraints.boundaries && selected.constraints.boundaries.length > 0 && (
                      <div><span className="text-slate-500 font-medium">Boundaries：</span><span className="text-slate-700">{selected.constraints.boundaries.join('；')}</span></div>
                    )}
                    {selected.constraints.preconditions && selected.constraints.preconditions.length > 0 && (
                      <div><span className="text-slate-500 font-medium">Preconditions：</span><span className="text-slate-700">{selected.constraints.preconditions.join('；')}</span></div>
                    )}
                    {selected.constraints.side_effects && selected.constraints.side_effects.length > 0 && (
                      <div><span className="text-slate-500 font-medium">Side Effects：</span><span className="text-slate-700">{selected.constraints.side_effects.join('；')}</span></div>
                    )}
                  </div>
                </section>
              )}

              {/* 关系 */}
              {selected.relations && Object.keys(selected.relations).length > 0 && (
                <section>
                  <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">关系</h3>
                  <div className="space-y-2 text-xs">
                    {Object.entries(selected.relations).map(([type, arr]) => (
                      Array.isArray(arr) && arr.length > 0 ? (
                        <div key={type}>
                          <span className="text-slate-500 font-medium uppercase">{type}：</span>
                          <ul className="ml-3 mt-0.5 space-y-0.5">
                            {arr.map((rel: any, i: number) => (
                              <li key={i} className="text-slate-700">
                                <span className="font-medium">{rel.target}</span>
                                {rel.description && <span className="text-slate-400 ml-1">— {rel.description}</span>}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null
                    ))}
                  </div>
                </section>
              )}

              {/* 质量评分 */}
              {selected.quality && (selected.quality.overall ?? 0) > 0 && (
                <section>
                  <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">质量评分</h3>
                  <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs">
                    <div className="flex items-center justify-between"><span className="text-slate-400">完整性</span><span className="text-slate-700 font-medium">{selected.quality.completeness?.toFixed(2) || '0'}</span></div>
                    <div className="flex items-center justify-between"><span className="text-slate-400">适配度</span><span className="text-slate-700 font-medium">{selected.quality.adaptation?.toFixed(2) || '0'}</span></div>
                    <div className="flex items-center justify-between"><span className="text-slate-400">文档</span><span className="text-slate-700 font-medium">{selected.quality.documentation?.toFixed(2) || '0'}</span></div>
                    <div className="flex items-center justify-between"><span className="text-slate-400">综合 ({selected.quality.grade || 'F'})</span><span className="text-slate-700 font-medium">{selected.quality.overall?.toFixed(2) || '0'}</span></div>
                  </div>
                </section>
              )}

              {/* 使用统计 */}
              {selected.stats && Object.values(selected.stats).some(v => v > 0) && (
                <section>
                  <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">使用统计</h3>
                  <div className="grid grid-cols-3 gap-x-6 gap-y-1.5 text-xs">
                    {[
                      { label: '浏览', value: selected.stats?.views || 0 },
                      { label: '采纳', value: selected.stats?.adoptions || 0 },
                      { label: '应用', value: selected.stats?.applications || 0 },
                      { label: 'Guard', value: selected.stats?.guard_hits || 0 },
                      { label: '搜索', value: selected.stats?.search_hits || 0 },
                      { label: '权威', value: selected.stats?.authority || 0 },
                    ].map(s => (
                      <div key={s.label} className="flex items-center justify-between">
                        <span className="text-slate-400">{s.label}</span>
                        <span className="text-slate-700 font-medium">{s.value}</span>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {/* 标签 */}
              {selected.tags && selected.tags.length > 0 && (
                <section>
                  <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">标签</h3>
                  <div className="flex flex-wrap gap-1.5">
                    {selected.tags.map((tag, i) => (
                      <span key={i} className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">{tag}</span>
                    ))}
                  </div>
                </section>
              )}

              {/* Headers */}
              {selected.headers && selected.headers.length > 0 && (
                <section>
                  <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Headers</h3>
                  <div className="flex flex-wrap gap-1.5">
                    {selected.headers.map((h, i) => (
                      <span key={i} className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 font-mono">{h}</span>
                    ))}
                  </div>
                </section>
              )}

              {/* AI 洞察 */}
              {selected.ai_insight && (
                <section>
                  <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">AI 洞察</h3>
                  <p className="text-xs text-slate-600 leading-relaxed">{selected.ai_insight}</p>
                </section>
              )}

              {/* 生命周期历史 */}
              {selected.lifecycle_history && selected.lifecycle_history.length > 0 && (
                <section>
                  <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">生命周期历史</h3>
                  <div className="space-y-1">
                    {selected.lifecycle_history.map((h, i) => {
                      const fromCfg = LIFECYCLE_CONFIG[h.from] || LIFECYCLE_CONFIG.pending;
                      const toCfg = LIFECYCLE_CONFIG[h.to] || LIFECYCLE_CONFIG.pending;
                      return (
                        <div key={i} className="flex items-center gap-2 text-[10px]">
                          <span className="text-slate-400 w-20 shrink-0">{formatDate(h.at)}</span>
                          <span className={`${fromCfg.color}`}>{fromCfg.label}</span>
                          <span className="text-slate-300">→</span>
                          <span className={`${toCfg.color} font-medium`}>{toCfg.label}</span>
                          <span className="text-slate-400 ml-auto">by {h.by}</span>
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}
            </div>

            {/* ── 面板底部操作栏 ── */}
            <div className="shrink-0 border-t border-slate-200 px-5 py-3 bg-slate-50/80 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleDelete(selected)}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium text-red-500 hover:bg-red-50 border border-red-200 transition-colors"
                >
                  <Trash2 size={14} /> 删除
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
                      {act.label}
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
