import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { FileSearch, Box, Trash2, Edit3, Layers, GitCompare, Copy, Brain, Sparkles, Clock, Code2, CheckCircle2, BarChart3, ArrowUpDown, Rocket, Wand2, Loader2, Globe } from 'lucide-react';
import { useDrawerWide } from '../../hooks/useDrawerWide';
import { ProjectData, KnowledgeEntry, SimilarRecipe, Recipe } from '../../types';
import api from '../../api';
import { notify } from '../../utils/notification';
import { categoryConfigs } from '../../constants';
import CodeBlock, { normalizeCode } from '../Shared/CodeBlock';
import MarkdownWithHighlight, { stripFrontmatter } from '../Shared/MarkdownWithHighlight';
import Pagination from '../Shared/Pagination';
import { ICON_SIZES } from '../../constants/icons';
import { useGlobalChat } from '../Shared/GlobalChatDrawer';
import PageOverlay from '../Shared/PageOverlay';
import { useRefineSocket } from '../../hooks/useRefineSocket';
import RefineProgressBar from './RefineProgressBar';
import DrawerMeta from '../Shared/DrawerMeta';
import type { BadgeItem, MetaItem } from '../Shared/DrawerMeta';
import DrawerContent from '../Shared/DrawerContent';
import { useI18n } from '../../i18n';
import Select from '../ui/Select';
import { Button } from '../ui/Button';
import { Drawer } from '../Layout/Drawer';

const SILENT_LABEL_KEYS: Record<string, string> = { _watch: 'silentLabels.watch', _draft: 'silentLabels.draft', _cli: 'silentLabels.cli', _pending: 'silentLabels.pending', _recipe: 'silentLabels.recipe' };

/** dimension key → i18n locale key mapping */
const DIM_I18N_KEYS: Record<string, string> = {
  'architecture': 'bootstrap.dimLabels.architecture',
  'best-practice': 'bootstrap.dimLabels.bestPractice',
  'event-and-data-flow': 'bootstrap.dimLabels.eventAndDataFlow',
  'objc-deep-scan': 'bootstrap.dimLabels.objcDeepScan',
  'agent-guidelines': 'bootstrap.dimLabels.agentGuidelines',
  'bootstrap': 'bootstrap.dimLabels.bootstrap',
  'code-standard': 'bootstrap.dimLabels.codeStandard',
  'code-pattern': 'bootstrap.dimLabels.codePattern',
  'project-profile': 'bootstrap.dimLabels.projectProfile',
  'category-scan': 'bootstrap.dimLabels.categoryScan',
};

interface CandidatesViewProps {
  data: ProjectData | null;
  isShellTarget: (name: string) => boolean;
  isSilentTarget?: (name: string) => boolean;
  isPendingTarget?: (name: string) => boolean;
  handleDeleteCandidate: (targetName: string, candidateId: string) => void | Promise<void>;
  handleDeleteAllInTarget: (targetName: string) => void;
  onAuditCandidate: (cand: KnowledgeEntry, targetName: string) => void;
  onAuditAllInTarget: (items: KnowledgeEntry[], targetName: string) => void;
  onEditRecipe?: (recipe: Recipe) => void;
  onColdStart?: () => void;
  isScanning?: boolean;
  /** bootstrap 任务是否正在进行（隐藏冷启动按钮和空状态） */
  isBootstrapping?: boolean;
  onRefresh?: () => void;
}

/* ── 工具函数 ── */

function sortTargetNames(
  entries: [string, { targetName: string; scanTime: number; items: KnowledgeEntry[] }][],
  isShellTarget: (name: string) => boolean,
  isSilentTarget: (name: string) => boolean,
  isPendingTarget: (name: string) => boolean
): [string, { targetName: string; scanTime: number; items: KnowledgeEntry[] }][] {
  return [...entries].sort(([nameA], [nameB]) => {
    const aPending = isPendingTarget(nameA);
    const bPending = isPendingTarget(nameB);
    if (aPending && !bPending) return 1;
    if (!aPending && bPending) return -1;
    const aSilent = isSilentTarget(nameA);
    const bSilent = isSilentTarget(nameB);
    if (aSilent && !bSilent) return -1;
    if (!aSilent && bSilent) return 1;
    const aShell = isShellTarget(nameA);
    const bShell = isShellTarget(nameB);
    if (aShell && !bShell) return 1;
    if (!aShell && bShell) return -1;
    return nameA.localeCompare(nameB);
  });
}

/** 安全格式化日期 — 避免 1970 问题 */
function formatDate(raw: string | number | undefined, t: (key: string, params?: Record<string, any>) => string): string {
  if (!raw) return '';
  const ts = typeof raw === 'number' ? raw : Number(raw);
  // 如果是秒级时间戳（< 1e12）转为毫秒
  const ms = ts < 1e12 ? ts * 1000 : ts;
  const d = new Date(ms);
  if (isNaN(d.getTime()) || d.getFullYear() < 2000) return '';
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
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

/** 代码预览：取前 N 行 */
function codePreview(code: string | undefined, maxLines = 4): string {
  if (!code) return '';
  return normalizeCode(code).split('\n').slice(0, maxLines).join('\n');
}

/** 置信度颜色系统 */
function confidenceColor(c: number | null | undefined): { ring: string; text: string; bg: string; labelKey: string } {
  if (c == null) return { ring: 'stroke-slate-200', text: 'text-[var(--fg-muted)]', bg: 'bg-[var(--bg-subtle)]', labelKey: '' };
  if (c >= 0.8) return { ring: 'stroke-emerald-500', text: 'text-emerald-700', bg: 'bg-emerald-50', labelKey: 'candidates.confidenceHighLabel' };
  if (c >= 0.6) return { ring: 'stroke-blue-500', text: 'text-blue-700', bg: 'bg-blue-50', labelKey: 'candidates.confidenceMediumLabel' };
  if (c >= 0.4) return { ring: 'stroke-amber-500', text: 'text-amber-700', bg: 'bg-amber-50', labelKey: 'candidates.confidenceMediumLowLabel' };
  return { ring: 'stroke-red-500', text: 'text-red-700', bg: 'bg-red-50', labelKey: 'candidates.confidenceLowLabel' };
}

/** 来源 label */
const SOURCE_LABEL_KEYS: Record<string, { labelKey: string; color: string }> = {
  'bootstrap-scan': { labelKey: 'candidates.sourceAiScanLabel', color: 'text-violet-600 bg-violet-50 border-violet-200' },
  'mcp': { labelKey: 'candidates.sourceMcpLabel', color: 'text-blue-600 bg-blue-50 border-blue-200' },
  'manual': { labelKey: 'candidates.sourceManualLabel', color: 'text-emerald-600 bg-emerald-50 border-emerald-200' },
  'file-watcher': { labelKey: 'candidates.sourceFileWatcherLabel', color: 'text-orange-600 bg-orange-50 border-orange-200' },
  'clipboard': { labelKey: 'candidates.sourceClipboardLabel', color: 'text-pink-600 bg-pink-50 border-pink-200' },
  'cli': { labelKey: 'CLI', color: 'text-[var(--fg-secondary)] bg-[var(--bg-subtle)] border-[var(--border-default)]' },
  'agent': { labelKey: 'AI Agent', color: 'text-violet-600 bg-violet-50 border-violet-200' },
  'submit_with_check': { labelKey: 'candidates.sourceSubmitCheckLabel', color: 'text-teal-600 bg-teal-50 border-teal-200' },
  'bootstrap-fallback': { labelKey: 'candidates.sourceFallbackLabel', color: 'text-amber-600 bg-amber-50 border-amber-200' },
};

/** 小型 SVG 环形置信度 */
const ConfidenceRing: React.FC<{ value: number | null | undefined; size?: number }> = ({ value, size = 36 }) => {
  const r = (size - 6) / 2;
  const circumference = 2 * Math.PI * r;
  const pct = value != null ? Math.max(0, Math.min(1, value)) : 0;
  const offset = circumference * (1 - pct);
  const { ring, text } = confidenceColor(value);
  return (
    <div className="relative flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeWidth={3} className="text-[var(--border-default)]" />
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

/* ═══════════════════════════════════════════════════════════ */

const CandidatesView: React.FC<CandidatesViewProps> = ({
  data, isShellTarget, isSilentTarget = () => false, isPendingTarget = () => false,
  handleDeleteCandidate, handleDeleteAllInTarget,
  onAuditCandidate, onAuditAllInTarget, onEditRecipe, onColdStart, isScanning, isBootstrapping, onRefresh,
}) => {
  const { t } = useI18n();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const { isWide: drawerWide, toggle: toggleDrawerWide } = useDrawerWide();
  const [enrichingIds, setEnrichingIds] = useState<Set<string>>(new Set());
  const [refiningIds, ] = useState<Set<string>>(new Set());
  const [enrichingAll, setEnrichingAll] = useState(false);
  const [refining, ] = useState(false);
  const globalChat = useGlobalChat();
  const { refine: refineProgress, isRefining, isRefineDone, resetRefine } = useRefineSocket();
  const [targetPages, setTargetPages] = useState<Record<string, { page: number; pageSize: number }>>({});
  const [selectedTarget, setSelectedTarget] = useState<string | null>(null);
  const [similarityMap, setSimilarityMap] = useState<Record<string, SimilarRecipe[]>>({});
  const [similarityLoading, setSimilarityLoading] = useState<string | null>(null);
  /** 异步刷新后的候选覆盖——不触发整页刷新即可更新抽屉 */
  const [candidateOverrides, setCandidateOverrides] = useState<Record<string, KnowledgeEntry>>({});
  const [filters, setFilters] = useState({
    sort: 'default' as 'default' | 'score-desc' | 'score-asc' | 'confidence-desc' | 'date-desc',
    onlySimilar: false,
  });
  const [compareModal, setCompareModal] = useState<{
    candidate: KnowledgeEntry;
    targetName: string;
    recipeName: string;
    recipeContent: string;
    similarList: SimilarRecipe[];
    recipeContents: Record<string, string>;
  } | null>(null);

  const fetchedSimilarRef = useRef<Set<string>>(new Set());
  const fetchSimilarity = useCallback(async (targetName: string, candidateId: string) => {
    if (fetchedSimilarRef.current.has(candidateId)) return;
    fetchedSimilarRef.current.add(candidateId);
    setSimilarityLoading(candidateId);
    try {
      const result = await api.getCandidateSimilarityEx({ targetName, candidateId });
      setSimilarityMap(prev => ({ ...prev, [candidateId]: result.similar || [] }));
    } catch (_) {
      setSimilarityMap(prev => ({ ...prev, [candidateId]: [] }));
    } finally {
      setSimilarityLoading(null);
    }
  }, []);

  const openCompare = useCallback(async (cand: KnowledgeEntry, targetName: string, recipeName: string, similarList: SimilarRecipe[] = []) => {
    const normalizedRecipeName = recipeName.replace(/\.md$/i, '');
    let recipeContent = '';
    const existing = data?.recipes?.find(r => r.name === normalizedRecipeName || r.name.endsWith('/' + normalizedRecipeName));
    if (existing?.content) {
      recipeContent = [existing.content.pattern, existing.content.markdown].filter(Boolean).join('\n\n') || '';
    } else {
      try {
        const recipeData = await api.getRecipeContentByName(normalizedRecipeName);
        recipeContent = recipeData.content;
      } catch (err: any) {
        const status = err.response?.status;
        const message = err.response?.data?.message || err.message;
        if (status === 404) {
          notify(`"${normalizedRecipeName}" ${t('common.operationFailed')}`, { title: t('common.operationFailed'), type: 'error' });
        } else {
          notify(message, { title: t('common.loadFailed'), type: 'error' });
        }
        return;
      }
    }
    const initialCache: Record<string, string> = { [normalizedRecipeName]: recipeContent };
    // 确保详情抽屉打开 + 关闭润色面板（互斥）
    setExpandedId(cand.id);
    setCompareModal({ candidate: cand, targetName, recipeName: normalizedRecipeName, recipeContent, similarList: similarList.slice(0, 3), recipeContents: initialCache });
  }, [data?.recipes]);

  const candidateEntries = data?.candidates ? Object.entries(data.candidates) : [];
  const sortedEntries = sortTargetNames(candidateEntries, isShellTarget, isSilentTarget, isPendingTarget);
  const targetNames = sortedEntries.map(([name]) => name);
  const effectiveTarget = selectedTarget && targetNames.includes(selectedTarget) ? selectedTarget : (targetNames[0] ?? null);

  useEffect(() => {
    if (targetNames.length > 0 && (!selectedTarget || !targetNames.includes(selectedTarget))) {
      setSelectedTarget(targetNames[0]);
    }
  }, [targetNames.join(','), selectedTarget]);

  // 展开时获取相似度
  useEffect(() => {
    if (expandedId && effectiveTarget) {
      fetchSimilarity(effectiveTarget, expandedId);
    }
  }, [expandedId, effectiveTarget, fetchSimilarity]);

  // 统计数据
  const stats = useMemo(() => {
    if (!effectiveTarget || !data?.candidates?.[effectiveTarget]) return null;
    const items = data.candidates[effectiveTarget].items;
    const total = items.length;
    const avgConfidence = items.reduce((sum, c) => sum + (c.reasoning?.confidence ?? 0), 0) / (total || 1);
    const withCode = items.filter(c => (c.content?.pattern && c.content.pattern.trim().length > 0) || (c.coreCode && c.coreCode.trim().length > 0)).length;
    const sources = new Map<string, number>();
    items.forEach(c => {
      const s = c.source || 'unknown';
      sources.set(s, (sources.get(s) || 0) + 1);
    });
    return { total, avgConfidence, withCode, sources };
  }, [effectiveTarget, data?.candidates]);

  // ID → 标题 查找表 (用于将关联关系中的 UUID 解析为可读标题)
  const titleLookup = useMemo(() => {
    const map = new Map<string, string>();
    // 全局 map (包含所有 lifecycle 的 entries)
    if (data?.idTitleMap) {
      for (const [id, title] of Object.entries(data.idTitleMap)) {
        map.set(id, title);
      }
    }
    // 本地候选补充
    if (data?.candidates) {
      for (const group of Object.values(data.candidates)) {
        for (const item of group.items) {
          if (item.id && item.title) map.set(item.id, item.title);
        }
      }
    }
    if (data?.recipes) {
      for (const r of data.recipes) {
        if (r.id && r.name) map.set(r.id, r.name.replace(/\.md$/i, ''));
      }
    }
    return map;
  }, [data?.idTitleMap, data?.candidates, data?.recipes]);

  /** AI 补齐单个候选语义字段 */
  const handleEnrichCandidate = useCallback(async (candidateId: string) => {
    if (enrichingIds.has(candidateId)) return;
    setEnrichingIds(prev => new Set(prev).add(candidateId));
    try {
      const result = await api.enrichCandidates([candidateId]);
      if (result.enriched > 0) {
        notify(`${result.results?.[0]?.filledFields?.length || 0} ${t('candidates.approveSuccess')}`, { title: t('candidates.aiRefine') });
      } else {
        notify(t('recipes.noContent'), { title: t('candidates.aiRefine'), type: 'info' });
      }
      // 异步刷新抽屉内容（不刷新页面）
      try {
        const updated = await api.getCandidate(candidateId);
        setCandidateOverrides(prev => ({ ...prev, [candidateId]: updated }));
      } catch (_) {}
    } catch (err: any) {
      const raw = err.response?.data?.error;
      notify(typeof raw === 'string' ? raw : raw?.message || err.message, { title: t('common.operationFailed'), type: 'error' });
    } finally {
      setEnrichingIds(prev => { const next = new Set(prev); next.delete(candidateId); return next; });
    }
  }, [enrichingIds, onRefresh]);

  /** 批量 AI 补齐当前 Target 下所有候选 */
  const handleEnrichAll = useCallback(async () => {
    if (enrichingAll || !effectiveTarget || !data?.candidates?.[effectiveTarget]) return;
    const items = data.candidates[effectiveTarget].items;
    if (items.length === 0) return;
    setEnrichingAll(true);
    try {
      let total = 0;
      for (let i = 0; i < items.length; i += 20) {
        const batch = items.slice(i, i + 20).map(c => c.id);
        const result = await api.enrichCandidates(batch);
        total += result.enriched;
      }
      notify(`${total}/${items.length} ${t('candidates.batchDeleteDone', { count: total })}`, { title: t('candidates.aiRefine') });
      onRefresh?.();
    } catch (err: any) {
      const raw = err.response?.data?.error;
      notify(typeof raw === 'string' ? raw : raw?.message || err.message, { title: t('common.operationFailed'), type: 'error' });
    } finally {
      setEnrichingAll(false);
    }
  }, [enrichingAll, effectiveTarget, data?.candidates, onRefresh]);

  /** 润色面板中某条候选已更新 — 局部刷新抽屉（不整页刷新） */
  const handleCandidateUpdated = useCallback(async (candidateId: string) => {
    try {
      const updated = await api.getCandidate(candidateId);
      setCandidateOverrides(prev => ({ ...prev, [candidateId]: updated }));
    } catch (_) {}
  }, []);

  /** Phase 6: AI 润色所有 Bootstrap 候选 — 打开全局 AI Chat 润色模式 */
  const handleRefineBootstrap = useCallback(() => {
    if (!effectiveTarget || !data?.candidates?.[effectiveTarget]) return;
    const items = data.candidates[effectiveTarget].items;
    const ids = items.map(c => c.id);
    globalChat.openRefine({
      candidateIds: ids,
      candidates: items,
      onCandidateUpdated: handleCandidateUpdated,
    });
  }, [effectiveTarget, data?.candidates, globalChat, handleCandidateUpdated]);

  /** 单条候选润色 — 打开全局 AI Chat 润色模式 */
  const handleRefineSingle = useCallback((candidateId: string) => {
    if (!effectiveTarget || !data?.candidates?.[effectiveTarget]) return;
    setCompareModal(null);
    setExpandedId(candidateId);
    const items = data.candidates[effectiveTarget].items;
    globalChat.openRefine({
      candidateIds: [candidateId],
      candidates: items,
      onCandidateUpdated: handleCandidateUpdated,
    });
  }, [effectiveTarget, data?.candidates, globalChat, handleCandidateUpdated]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* ── 页面头部 ── */}
      <div className="mb-4 flex flex-wrap justify-between items-center gap-3 shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-xl bg-blue-50 border border-blue-100 flex items-center justify-center shrink-0">
            <Sparkles className="text-blue-600" size={20} />
          </div>
          <div className="min-w-0">
            <h2 className="text-lg xl:text-xl font-bold text-[var(--fg-primary)]">AI Scan Candidates</h2>
            <p className="text-xs text-[var(--fg-muted)] mt-0.5 truncate">{t('candidates.title')}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* 冷启动按钮 — bootstrap 进行中时隐藏 */}
          {onColdStart && !isBootstrapping && (
            <button
              onClick={onColdStart}
              disabled={isScanning}
              className={`flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-bold transition-all ${
                isScanning
                  ? 'text-[var(--fg-muted)] bg-[var(--bg-subtle)] cursor-not-allowed'
                  : 'text-white bg-gradient-to-r from-violet-500 to-purple-600 hover:from-violet-600 hover:to-purple-700 shadow-sm hover:shadow'
              }`}
              title={t('candidates.coldStartTitle')}
            >
              {isScanning ? <Loader2 size={14} className="animate-spin" /> : <Rocket size={14} />}
              {isScanning ? t('common.loading') : t('candidates.sourceBootstrap')}
            </button>
          )}
          {/* ① 结构补齐：填充缺失的语义元数据 */}
          {stats && stats.total > 0 && (
            <button
              onClick={handleEnrichAll}
              disabled={enrichingAll || refining}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold transition-all ${
                enrichingAll || refining
                  ? 'text-[var(--fg-muted)] bg-[var(--bg-subtle)] cursor-not-allowed'
                  : 'text-amber-700 bg-amber-50 border border-amber-200 hover:bg-amber-100'
              }`}
              title={t('candidates.enrichTitle')}
            >
              {enrichingAll ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
              {enrichingAll ? t('common.loading') : t('candidates.aiEnrich')}
            </button>
          )}
          {/* ② 内容润色：改善描述质量 + 推断关联 */}
          {stats && stats.total > 0 && (
            <button
              onClick={handleRefineBootstrap}
              disabled={refining || enrichingAll || isRefining}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold transition-all ${
                refining || enrichingAll || isRefining
                  ? 'text-[var(--fg-muted)] bg-[var(--bg-subtle)] cursor-not-allowed'
                  : 'text-emerald-700 bg-emerald-50 border border-emerald-200 hover:bg-emerald-100'
              }`}
              title={t('candidates.refineTitle')}
            >
              {refining || isRefining ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
              {refining || isRefining ? t('common.loading') : t('candidates.aiRefine')}
            </button>
          )}
          {stats && (
            <div className="flex items-center gap-3 text-xs">
              <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--bg-subtle)] border border-[var(--border-default)]">
                <BarChart3 size={14} className="text-[var(--fg-muted)]" />
                <span className="text-[var(--fg-secondary)]">{t('candidates.totalCount', { count: stats.total })}</span>
                {stats.withCode < stats.total && (
                  <span className="text-[var(--fg-muted)] ml-1">{t('candidates.withCode', { count: stats.withCode })}</span>
                )}
              </div>
              <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-50 border border-emerald-100">
                <span className="text-emerald-500">{t('candidates.confidence')}</span>
                <strong className="text-emerald-700">{Math.round(stats.avgConfidence * 100)}%</strong>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── AI 润色实时进度条 ── */}
      {refineProgress && (
        <RefineProgressBar
          refine={refineProgress}
          isRefineDone={isRefineDone}
          onDismiss={() => { resetRefine(); onRefresh?.(); }}
        />
      )}

      {/* ── Target 切换标签栏 ── */}
      {candidateEntries.length > 0 && (
        <div className="shrink-0 bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-xl px-3 py-2 mb-4 shadow-sm">
          <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar">
            {targetNames.map((targetName) => {
              const isSilent = isSilentTarget(targetName);
              const silentLabel = SILENT_LABEL_KEYS[targetName] ? t(SILENT_LABEL_KEYS[targetName]) : undefined;
              const group = data?.candidates[targetName];
              const count = group?.items?.length ?? 0;
              const isSelected = effectiveTarget === targetName;
              const catCfg = categoryConfigs[targetName] || categoryConfigs['All'];
              return (
                <button
                  key={targetName}
                  onClick={() => setSelectedTarget(targetName)}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-bold whitespace-nowrap transition-all border
                    ${isSelected
                      ? `${catCfg?.bg || 'bg-blue-50'} ${catCfg?.color || 'text-blue-700'} ${catCfg?.border || 'border-blue-200'} shadow-sm ring-1 ring-inset ${catCfg?.border || 'ring-blue-200'}`
                      : 'bg-[var(--bg-subtle)] text-[var(--fg-secondary)] border-[var(--border-default)] hover:border-[var(--border-emphasis)] hover:bg-[var(--bg-subtle)]'}`}
                >
                  {(() => {
                    const Icon = catCfg?.icon || Box;
                    return <Icon size={ICON_SIZES.sm} className={isSelected ? '' : 'text-[var(--fg-muted)]'} />;
                  })()}
                  <span>{DIM_I18N_KEYS[targetName] ? t(DIM_I18N_KEYS[targetName]) : targetName}</span>
                  {isSilent && silentLabel && <span className="text-[9px] text-amber-600 border border-amber-200 px-1 rounded">{silentLabel}</span>}
                  <span className={`text-[10px] font-normal rounded-full px-1.5 ${isSelected ? 'bg-white/60' : 'bg-[var(--bg-subtle)] text-[var(--fg-muted)]'}`}>{count}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* ── 内容区域 ── */}
      <div className="flex-1 overflow-y-auto pr-1 pb-6">
        {(!data?.candidates || Object.keys(data.candidates).length === 0) && !isBootstrapping && (
          <div className="h-72 flex flex-col items-center justify-center bg-[var(--bg-surface)] rounded-2xl border border-dashed border-[var(--border-default)] text-[var(--fg-muted)]">
            <div className="w-16 h-16 rounded-2xl bg-[var(--bg-subtle)] flex items-center justify-center mb-4">
              <FileSearch size={32} className="text-[var(--fg-muted)]" />
            </div>
            <p className="text-sm font-medium text-[var(--fg-secondary)]">{t('candidates.noResults')}</p>
            <p className="mt-2 text-xs max-w-sm text-center leading-relaxed text-[var(--fg-muted)]">
              {t('candidates.emptyHint')}
            </p>
            {onColdStart && (
              <button
                onClick={onColdStart}
                disabled={isScanning}
                className={`mt-4 flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-bold transition-all ${
                  isScanning
                    ? 'text-[var(--fg-muted)] bg-[var(--bg-subtle)] cursor-not-allowed'
                    : 'text-white bg-gradient-to-r from-violet-500 to-purple-600 hover:from-violet-600 hover:to-purple-700 shadow-md hover:shadow-lg'
                }`}
              >
                {isScanning ? <Loader2 size={16} className="animate-spin" /> : <Rocket size={16} />}
                {isScanning ? t('common.loading') : t('candidates.sourceBootstrap')}
              </button>
            )}
            <p className="mt-3 text-[11px] text-[var(--fg-muted)]">
              或 <code className="text-blue-600 bg-blue-50 px-1 rounded">asd ais --all</code> {t('candidates.fullScanBtn')}
              <code className="text-blue-600 bg-blue-50 px-1 rounded ml-1">asd candidate</code> {t('candidates.clipboardCreate')}
            </p>
          </div>
        )}

        {/* Bootstrap 进行中且无候选内容时，显示等待提示 */}
        {(!data?.candidates || Object.keys(data.candidates).length === 0) && isBootstrapping && (
          <div className="h-72 flex flex-col items-center justify-center bg-[var(--bg-surface)] rounded-2xl border border-dashed border-violet-500/30 text-[var(--fg-muted)]">
            <div className="w-16 h-16 rounded-2xl bg-violet-500/10 flex items-center justify-center mb-4">
              <Loader2 size={32} className="text-violet-400 animate-spin" />
            </div>
            <p className="text-sm font-medium text-violet-400">{t('common.loading')}</p>
            <p className="mt-2 text-xs max-w-sm text-center leading-relaxed text-[var(--fg-muted)]">
              {t('candidates.scanningHint')}
            </p>
          </div>
        )}

        {data && effectiveTarget && sortedEntries
          .filter(([name]) => name === effectiveTarget)
          .map(([targetName, group]) => {
            const isShell = isShellTarget(targetName);
            const isSilent = isSilentTarget(targetName);
            const silentLabel = SILENT_LABEL_KEYS[targetName] ? t(SILENT_LABEL_KEYS[targetName]) : t('candidates.silent');

            const pageState = targetPages[targetName] || { page: 1, pageSize: 12 };
            const currentPage = pageState.page;
            const pageSize = pageState.pageSize;

            const filteredItems = group.items
              .filter((cand) => {
                if (filters.onlySimilar) {
                  const simList = similarityMap[cand.id];
                  if (!Array.isArray(simList) || simList.length === 0) return false;
                }
                return true;
              })
              .sort((a, b) => {
                if (filters.sort === 'default') return 0;
                if (filters.sort === 'score-desc') return (b.quality?.overall ?? 0) - (a.quality?.overall ?? 0);
                if (filters.sort === 'score-asc') return (a.quality?.overall ?? 0) - (b.quality?.overall ?? 0);
                if (filters.sort === 'confidence-desc') return (b.reasoning?.confidence ?? 0) - (a.reasoning?.confidence ?? 0);
                if (filters.sort === 'date-desc') {
                  const ta = typeof a.createdAt === 'number' ? a.createdAt : 0;
                  const tb = typeof b.createdAt === 'number' ? b.createdAt : 0;
                  return tb - ta;
                }
                return 0;
              });

            const totalItems = filteredItems.length;
            const totalPages = Math.ceil(totalItems / pageSize);
            const startIndex = (currentPage - 1) * pageSize;
            const paginatedItems = filteredItems.slice(startIndex, startIndex + pageSize);

            const handlePageChange = (page: number) => {
              setTargetPages(prev => ({ ...prev, [targetName]: { ...pageState, page } }));
            };
            const handlePageSizeChange = (size: number) => {
              setTargetPages(prev => ({ ...prev, [targetName]: { page: 1, pageSize: size } }));
            };

            const catCfg = categoryConfigs[targetName] || categoryConfigs['All'];

            return (
              <div key={targetName} className="space-y-3">
                {/* ── 工具栏 ── */}
                <div className="flex items-center gap-3 px-4 py-2.5 rounded-xl bg-[var(--bg-surface)] border border-[var(--border-default)] shadow-sm">
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    {(() => {
                      const Icon = catCfg?.icon || Box;
                      return <Icon size={18} className={catCfg?.color || 'text-blue-600'} />;
                    })()}
                    <span className="text-base font-bold text-[var(--fg-primary)] truncate">{DIM_I18N_KEYS[targetName] ? t(DIM_I18N_KEYS[targetName]) : targetName}</span>
                    {isSilent && <span className="text-[10px] font-bold text-amber-600 border border-amber-200 bg-amber-50 px-1.5 py-0.5 rounded">{silentLabel}</span>}
                    {isShell && !isSilent && <span className="text-[10px] font-bold text-[var(--fg-muted)] border border-[var(--border-default)] bg-[var(--bg-subtle)] px-1.5 py-0.5 rounded">SHELL</span>}
                    <span className="text-[11px] text-[var(--fg-muted)] flex items-center gap-1">
                      <Clock size={11} />
                      {t('candidates.scannedAt', { time: formatDate(group.scanTime, t) || new Date(group.scanTime).toLocaleString() })}
                    </span>
                  </div>

                  {/* 筛选控件 */}
                  <div className="flex items-center gap-2">
                    <div className="flex items-center gap-1 px-2 py-1 rounded-lg bg-[var(--bg-subtle)] border border-[var(--border-default)]">
                      <ArrowUpDown size={12} className="text-[var(--fg-muted)]" />
                      <Select
                        value={filters.sort}
                        onChange={v => setFilters(prev => ({ ...prev, sort: v as any }))}
                        options={[
                          { value: 'default', label: t('candidates.sortNewest') },
                          { value: 'score-desc', label: `${t('candidates.sortConfidence')} ↓` },
                          { value: 'score-asc', label: `${t('candidates.sortConfidence')} ↑` },
                          { value: 'confidence-desc', label: `${t('candidates.confidence')} ↓` },
                          { value: 'date-desc', label: t('candidates.sortOldest') },
                        ]}
                        size="xs"
                        className="border-none bg-transparent"
                      />
                    </div>
                    <label className="text-[11px] font-medium text-[var(--fg-secondary)] flex items-center gap-1.5 px-2 py-1 rounded-lg bg-[var(--bg-subtle)] border border-[var(--border-default)] cursor-pointer hover:bg-[var(--bg-subtle)] transition-colors select-none">
                      <input
                        type="checkbox"
                        checked={filters.onlySimilar}
                        onChange={e => setFilters(prev => ({ ...prev, onlySimilar: e.target.checked }))}
                        className="rounded text-blue-600 w-3 h-3"
                      />
                      {t('candidates.similarOnly')}
                    </label>
                    {(filters.sort !== 'default' || filters.onlySimilar) && (
                      <button
                        onClick={() => setFilters({ sort: 'default', onlySimilar: false })}
                        className="text-[11px] font-medium text-[var(--fg-secondary)] hover:text-[var(--fg-primary)] px-2 py-1 rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface)] hover:bg-[var(--bg-subtle)] transition-colors"
                      >
                        {t('candidates.resetFilters')}
                      </button>
                    )}
                  </div>

                  <div className="h-5 w-px bg-[var(--border-default)]" />

                  {/* 操作按钮 */}
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] text-[var(--fg-muted)] font-medium">{t('candidates.totalCount', { count: totalItems })}</span>
                    <button
                      onClick={() => onAuditAllInTarget(paginatedItems, targetName)}
                      className="text-[11px] font-bold text-blue-600 hover:text-blue-700 px-2.5 py-1.5 rounded-lg hover:bg-blue-50 transition-colors"
                    >
                      {t('candidates.approveCurrentPage')}
                    </button>
                    <button
                      onClick={async () => {
                        if (!window.confirm(t('candidates.batchDeleteConfirm', { count: paginatedItems.length }))) return;
                        const results = await Promise.allSettled(
                          paginatedItems.map(item => handleDeleteCandidate(targetName, item.id))
                        );
                        const failed = results.filter(r => r.status === 'rejected').length;
                        if (failed > 0) notify(`${failed} ${t('common.deleteFailed')}`, { title: t('common.operationFailed'), type: 'error' });
                        onRefresh?.();
                      }}
                      className="text-[11px] font-bold text-orange-500 hover:text-orange-600 px-2.5 py-1.5 rounded-lg hover:bg-orange-50 transition-colors"
                    >
                      {t('candidates.removeCurrentPage')}
                    </button>
                    <button
                      onClick={() => handleDeleteAllInTarget(targetName)}
                      className="text-[11px] font-bold text-red-500 hover:text-red-600 px-2.5 py-1.5 rounded-lg hover:bg-red-50 transition-colors border border-red-200"
                    >
                      {t('candidates.deleteAll')}
                    </button>
                  </div>
                </div>

                {/* ── 候选卡片网格 ── */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                  {paginatedItems.map((cand) => {
                    const isExpanded = expandedId === cand.id;
                    const confidence = cand.reasoning?.confidence ?? null;
                    const overall = (cand.quality?.overall ?? 0) > 0 ? (cand.quality?.overall ?? null) : null;
                    const similarList = similarityMap[cand.id] || [];
                    const firstSimilar = similarList[0] || null;

                    const srcInfo = SOURCE_LABEL_KEYS[cand.source || ''] || { labelKey: cand.source || '', color: 'text-[var(--fg-secondary)] bg-[var(--bg-subtle)] border-[var(--border-default)]' };
                    const candCatCfg = categoryConfigs[cand.category || ''] || categoryConfigs['All'] || {};



                    return (
                      <div
                        key={cand.id}
                        onClick={() => setExpandedId(isExpanded ? null : cand.id)}
                        className={`bg-[var(--bg-surface)] rounded-xl border overflow-hidden hover:shadow-lg transition-all duration-200 flex flex-col group cursor-pointer
                          ${isShell ? 'opacity-75' : ''}
                          ${isExpanded ? 'ring-2 ring-blue-300 border-blue-300 shadow-md' : 'border-[var(--border-default)] hover:border-[var(--border-emphasis)]'}`}
                      >
                        {/* ── 卡片头部：标题 + 置信度 ── */}
                        <div className="px-4 pt-3.5 pb-2">
                          <div className="flex items-start justify-between gap-3">
                            {/* 左：标题 & 标签 */}
                            <div className="flex-1 min-w-0">
                              {/* 第一行：类别 + 来源 + 知识类型 */}
                              <div className="flex flex-wrap items-center gap-1.5 mb-1.5">
                                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded uppercase flex items-center gap-1 border ${candCatCfg?.bg || 'bg-[var(--bg-subtle)]'} ${candCatCfg?.color || 'text-[var(--fg-muted)]'} ${candCatCfg?.border || 'border-[var(--border-default)]'}`}>
                                  {(() => {
                                    const Icon = candCatCfg?.icon || Layers;
                                    return <Icon size={10} />;
                                  })()}
                                  {cand.category || 'general'}
                                </span>
                                {cand.knowledgeType && (
                                  <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-600 border border-indigo-100">
                                    {cand.knowledgeType}
                                  </span>
                                )}
                                {cand.source && cand.source !== 'unknown' && (
                                  <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded border ${srcInfo.color}`}>
                                    {srcInfo.labelKey.startsWith('candidates.') ? t(srcInfo.labelKey) : srcInfo.labelKey}
                                  </span>
                                )}
                                {cand.complexity && (
                                  <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded border
                                    ${cand.complexity === 'advanced' ? 'bg-red-50 text-red-600 border-red-100' :
                                      cand.complexity === 'intermediate' ? 'bg-amber-50 text-amber-600 border-amber-100' :
                                        'bg-emerald-50 text-emerald-600 border-emerald-100'}`}>
                                    {cand.complexity === 'advanced' ? t('candidates.confidenceHigh') : cand.complexity === 'intermediate' ? t('candidates.confidenceMedium') : t('candidates.confidenceLow')}
                                  </span>
                                )}
                              </div>

                              {/* 标题 */}
                              <h3 className="font-bold text-sm text-[var(--fg-primary)] leading-snug mb-1 line-clamp-1">{cand.title}</h3>

                              {/* 摘要 */}
                              <p className="text-xs text-[var(--fg-secondary)] line-clamp-2 leading-relaxed">{cand.description || ''}</p>
                            </div>

                            {/* 右：置信度环 + 操作 */}
                            <div className="flex flex-col items-center gap-1 shrink-0">
                              <ConfidenceRing value={confidence} />
                              <span className="text-[9px] text-[var(--fg-muted)] font-medium">{t('candidates.confidence')}</span>
                            </div>
                          </div>
                        </div>

                        {/* ── AI 推理摘要（始终可见） ── */}
                        {cand.reasoning?.whyStandard && !/^Submitted via /i.test(cand.reasoning.whyStandard) && (
                          <div className="px-4 py-2 bg-gradient-to-r from-indigo-50/50 to-transparent border-t border-indigo-50">
                            <div className="flex items-start gap-1.5">
                              <Brain size={12} className="text-indigo-400 mt-0.5 shrink-0" />
                              <p className="text-[11px] text-indigo-600/80 line-clamp-1 leading-relaxed">
                                {cand.reasoning.whyStandard}
                              </p>
                            </div>
                          </div>
                        )}

                        {/* ── 指标行：综合分 + 相似 ── */}
                        {(overall != null || firstSimilar) && (
                          <div className="flex flex-wrap items-center gap-1.5 px-4 py-2 border-t border-[var(--border-default)]">
                            {overall != null && (
                              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 flex items-center gap-1">
                                <CheckCircle2 size={10} />
                                {t('candidates.overallScore', { score: (overall * 100).toFixed(0) + '%' })}
                              </span>
                            )}
                            {firstSimilar && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  const name = String(firstSimilar.recipeName || '').trim();
                                  if (name) openCompare(cand, targetName, name, similarList);
                                }}
                                className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-100 transition-colors flex items-center gap-1"
                                title={t('candidates.similarWith', { name: firstSimilar.recipeName, score: (firstSimilar.similarity * 100).toFixed(0) })}
                              >
                                <GitCompare size={10} />
                                {t('candidates.similarPrefix')} {firstSimilar.recipeName.replace(/\.md$/i, '')} {(firstSimilar.similarity * 100).toFixed(0)}%
                              </button>
                            )}
                          </div>
                        )}

                        {/* ── 代码预览（始终显示前 3 行） ── */}
                        {cand.content?.pattern && (
                          <div className="overflow-hidden border-t border-[var(--border-default)]/60">
                            <div className="flex items-center justify-between px-3 py-1.5" style={{ background: '#282c34' }}>
                              <div className="flex items-center gap-2">
                                <Code2 size={11} className="text-[var(--fg-secondary)]" />
                                <span className="text-[10px] text-[var(--fg-muted)] font-mono uppercase tracking-wide">{cand.language || 'code'}</span>
                              </div>
                              <span className="text-[10px] text-[var(--fg-secondary)] font-mono tabular-nums">{t('candidates.linesCount', { count: cand.content.pattern.split('\n').length })}</span>
                            </div>
                            <div className="relative max-h-[80px] overflow-hidden">
                              <CodeBlock
                                code={codePreview(cand.content.pattern, 3)}
                                language={cand.language === 'objc' ? 'objectivec' : cand.language}
                                className="!rounded-none"
                              />
                              {cand.content.pattern.split('\n').length > 3 && (
                                <div className="absolute bottom-0 left-0 right-0 h-6 bg-gradient-to-t from-[#282c34] to-transparent pointer-events-none" />
                              )}
                            </div>
                          </div>
                        )}

                        {/* ── 卡片底栏：元信息 + 操作 ── */}
                        <div className="flex justify-between items-center px-4 py-2.5 border-t border-[var(--border-default)] bg-[var(--bg-subtle)] mt-auto" onClick={e => e.stopPropagation()}>
                          <div className="flex items-center gap-2 flex-wrap min-w-0">
                            {/* trigger */}
                            {cand.trigger && (
                              <span className="text-[10px] font-mono px-2 py-0.5 rounded-md bg-[var(--bg-surface)] border border-[var(--border-default)] text-[var(--fg-secondary)] font-bold">{cand.trigger}</span>
                            )}

                            {/* 语言 */}
                            <span className="text-[10px] uppercase font-bold text-[var(--fg-muted)] bg-[var(--bg-surface)] border border-[var(--border-default)] px-1.5 py-0.5 rounded-md">{cand.language}</span>

                            {/* tags */}
                            {cand.tags && cand.tags.length > 0 && cand.tags.slice(0, 3).map((tag, i) => (
                              <span key={i} className="text-[9px] px-1.5 py-0.5 rounded-md bg-blue-50 text-blue-600 border border-blue-100 font-medium">
                                {typeof tag === 'string' ? tag : String(tag)}
                              </span>
                            ))}
                            {cand.tags && cand.tags.length > 3 && (
                              <span className="text-[9px] text-[var(--fg-muted)]">+{cand.tags.length - 3}</span>
                            )}

                            {/* 日期 */}
                            {cand.createdAt && formatDate(cand.createdAt, t) && (
                              <span className="text-[9px] text-[var(--fg-muted)] flex items-center gap-0.5">
                                <Clock size={9} />
                                {formatDate(cand.createdAt, t)}
                              </span>
                            )}
                          </div>

                          <div className="flex items-center gap-1.5 shrink-0">
                            <button
                              onClick={() => handleEnrichCandidate(cand.id)}
                              disabled={enrichingIds.has(cand.id)}
                              title={t('candidates.enrichTitleSingle')}
                              className={`p-1.5 rounded-lg transition-colors flex items-center gap-1 text-[11px] font-medium ${
                                enrichingIds.has(cand.id)
                                  ? 'text-[var(--fg-muted)] cursor-not-allowed'
                                  : 'text-amber-500 hover:text-amber-600 hover:bg-amber-50'
                              }`}
                            >
                              {enrichingIds.has(cand.id) ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
                            </button>
                            <button
                              onClick={() => handleRefineSingle(cand.id)}
                              disabled={refiningIds.has(cand.id)}
                              title={t('candidates.refineTitleSingle')}
                              className={`p-1.5 rounded-lg transition-colors flex items-center gap-1 text-[11px] font-medium ${
                                refiningIds.has(cand.id)
                                  ? 'text-[var(--fg-muted)] cursor-not-allowed'
                                  : 'text-emerald-500 hover:text-emerald-600 hover:bg-emerald-50'
                              }`}
                            >
                              {refiningIds.has(cand.id) ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                            </button>
                            <button
                              onClick={() => { handleDeleteCandidate(targetName, cand.id); if (expandedId === cand.id) { setExpandedId(null); setCompareModal(null); } }}
                              title={t('common.delete')}
                              className="p-1.5 hover:bg-red-50 text-[var(--fg-muted)] hover:text-red-500 rounded-lg transition-colors"
                            >
                              <Trash2 size={14} />
                            </button>
                            <button
                              onClick={() => onAuditCandidate(cand, targetName)}
                              className="text-[11px] font-bold text-blue-600 hover:text-blue-700 px-3 py-1.5 rounded-lg bg-blue-50 hover:bg-blue-100 transition-colors flex items-center gap-1"
                            >
                              <Edit3 size={12} /> {t('candidates.approveAndSave')}
                            </button>
                            {cand.lifecycle === 'pending' && (
                              <button
                                onClick={async () => {
                                  try {
                                    await api.promoteCandidateToRecipe(cand.id);
                                    notify(t('candidates.approveSuccess'), { title: t('candidates.approveSuccess') });
                                    onRefresh?.();
                                  } catch (err: any) {
                                    notify(err.message, { title: t('common.operationFailed'), type: 'error' });
                                  }
                                }}
                                className="text-[11px] font-bold text-emerald-600 hover:text-emerald-700 px-3 py-1.5 rounded-lg bg-emerald-50 hover:bg-emerald-100 transition-colors flex items-center gap-1"
                                title={t('candidates.approve')}
                              >
                                <Rocket size={12} /> {t('candidates.approve')}
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* 分页 */}
                {totalItems > 12 && (
                  <Pagination
                    currentPage={currentPage}
                    totalPages={totalPages}
                    totalItems={totalItems}
                    pageSize={pageSize}
                    onPageChange={handlePageChange}
                    onPageSizeChange={handlePageSizeChange}
                  />
                )}
              </div>
            );
          })
        }
      </div>

      {/* ═══ 详情侧面板（抽屉） ═══ */}
      {expandedId && effectiveTarget && data?.candidates?.[effectiveTarget] && (() => {
        const allItems = data.candidates[effectiveTarget].items;
        const rawCand = allItems.find(c => c.id === expandedId);
        if (!rawCand) return null;
        // 优先使用异步刷新的覆盖数据
        const cand = candidateOverrides[expandedId] || rawCand;

        const currentIndex = allItems.findIndex(c => c.id === expandedId);
        const hasPrev = currentIndex > 0;
        const hasNext = currentIndex < allItems.length - 1;
        const goToPrev = () => { if (hasPrev) { setExpandedId(allItems[currentIndex - 1].id); setCompareModal(null); } };
        const goToNext = () => { if (hasNext) { setExpandedId(allItems[currentIndex + 1].id); setCompareModal(null); } };

        const r = cand.reasoning;
        const similar = similarityMap[cand.id] || [];
        const isLoadingSimilar = similarityLoading === cand.id;
        const candCatCfg = categoryConfigs[cand.category || ''] || categoryConfigs['All'] || {};
        const srcInfo = SOURCE_LABEL_KEYS[cand.source || ''] || { labelKey: cand.source || '', color: 'text-[var(--fg-secondary)] bg-[var(--bg-subtle)] border-[var(--border-default)]' };

        return (
          <PageOverlay className="z-30 flex justify-end" onClick={() => { setExpandedId(null); setCompareModal(null); }}>
            <PageOverlay.Backdrop className="bg-black/20 dark:bg-black/40 backdrop-blur-sm" />

            {/* ── 润色已迁移到 GlobalChatDrawer ── */}

            {/* ── 对比侧抽屉（贴在详情抽屉左侧） ── */}
            {compareModal && (() => {
              const compareCand = compareModal.candidate;
              const compareCandLang = compareCand.language === 'objc' || compareCand.language === 'objective-c' ? 'objectivec' : (compareCand.language || 'text');
              const copyCandidate = () => {
                const parts = [];
                if (compareCand.content?.pattern) parts.push('## Snippet / Code Reference\n\n```' + (compareCandLang || '') + '\n' + compareCand.content.pattern + '\n```');
                if (compareCand.content?.markdown) parts.push('\n## ' + t('candidates.projectProfile') + '\n\n' + compareCand.content.markdown);
                else if (compareCand.doClause) parts.push('\n## AI Context / Usage Guide\n\n' + compareCand.doClause);
                navigator.clipboard.writeText(parts.join('\n') || '').then(() => notify(t('common.copied'), { title: t('common.copied') }));
              };
              const copyRecipe = () => {
                const text = stripFrontmatter(compareModal.recipeContent);
                navigator.clipboard.writeText(text).then(() => notify(t('common.copied'), { title: t('common.copied') }));
              };
              const switchToRecipe = async (newName: string) => {
                if (newName === compareModal.recipeName) return;
                const cached = compareModal.recipeContents[newName];
                if (cached) {
                  setCompareModal(prev => prev ? { ...prev, recipeName: newName, recipeContent: cached } : null);
                } else {
                  let content = '';
                  const existing = data?.recipes?.find(r => r.name === newName || r.name.endsWith('/' + newName));
                  if (existing?.content) { content = [existing.content.pattern, existing.content.markdown].filter(Boolean).join('\n\n') || ''; }
                  else {
                    try {
                      const recipeData = await api.getRecipeContentByName(newName);
                      content = recipeData.content;
                    } catch (_) { return; }
                  }
                  setCompareModal(prev => prev ? { ...prev, recipeName: newName, recipeContent: content, recipeContents: { ...prev.recipeContents, [newName]: content } } : null);
                }
              };
              const handleCompareDelete = async () => {
                if (!window.confirm(t('common.areYouSure'))) return;
                try {
                  await handleDeleteCandidate(compareModal.targetName, compareCand.id);
                  setCompareModal(null);
                } catch (err: any) {
                  notify(err?.message || t('common.deleteFailed'), { title: t('common.deleteFailed'), type: 'error' });
                }
              };
              const handleCompareAudit = () => {
                onAuditCandidate(compareCand, compareModal.targetName);
                setCompareModal(null);
              };
              const handleCompareEditRecipe = () => {
                const recipe = data?.recipes?.find(r => r.name === compareModal.recipeName || r.name.endsWith('/' + compareModal.recipeName));
                if (recipe) { onEditRecipe?.(recipe); }
                else { onEditRecipe?.({ name: compareModal.recipeName, content: { markdown: compareModal.recipeContent } } as Recipe); }
                setCompareModal(null);
              };
              return (
                <Drawer.Panel
                  width={drawerWide ? 'w-[800px] max-w-[55vw]' : 'w-[600px] max-w-[45vw]'}
                  animationDuration="0.2s"
                >
                  {/* 对比面板头部 */}
                  <Drawer.Header className="bg-emerald-50/60 py-3.5">
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center">
                        <GitCompare size={16} className="text-white" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <h3 className="font-bold text-sm text-emerald-800 truncate">{t('candidates.recipeCompare')}</h3>
                        <span className="text-[11px] text-emerald-600 truncate block">{compareModal.recipeName.replace(/\.md$/i, '')}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0 ml-2">
                      <Button variant="ghost" size="icon-sm" onClick={() => copyRecipe()} title={t('common.copy')} className="text-emerald-600 hover:bg-emerald-100"><Copy size={14} /></Button>
                      <button onClick={handleCompareEditRecipe} className="text-[11px] font-medium text-emerald-600 hover:bg-emerald-100 px-2 py-1.5 rounded-lg transition-colors">{t('candidates.approveAndSave')}</button>
                      <Drawer.CloseButton onClose={() => setCompareModal(null)} />
                    </div>
                  </Drawer.Header>

                  {/* 相似 recipe 切换标签 */}
                  {compareModal.similarList.length > 1 && (
                    <div className="flex flex-wrap gap-1 px-5 py-2 border-b border-[var(--border-default)] bg-[var(--bg-surface)] shrink-0">
                      {compareModal.similarList.map(s => (
                        <button
                          key={s.recipeName}
                          onClick={() => switchToRecipe(s.recipeName)}
                          className={`text-[10px] font-bold px-2 py-1 rounded transition-colors ${compareModal.recipeName === s.recipeName ? 'bg-emerald-200 text-emerald-800' : 'bg-[var(--bg-surface)] text-emerald-600 hover:bg-emerald-50 border border-emerald-100'}`}
                        >
                          {s.recipeName.replace(/\.md$/i, '')} {(s.similarity * 100).toFixed(0)}%
                        </button>
                      ))}
                    </div>
                  )}

                  {/* 操作栏 */}
                  <div className="flex items-center gap-1.5 px-5 py-2 border-b border-[var(--border-default)] bg-[var(--bg-surface)] shrink-0">
                    <button onClick={handleCompareDelete} className="text-xs font-medium text-red-600 hover:bg-red-50 px-2.5 py-1.5 rounded-lg transition-colors flex items-center gap-1">
                      <Trash2 size={12} /> {t('common.delete')}
                    </button>
                    <button onClick={handleCompareAudit} className="text-xs font-medium text-blue-600 hover:bg-blue-50 px-2.5 py-1.5 rounded-lg transition-colors flex items-center gap-1">
                      <Edit3 size={12} /> {t('candidates.approveAndSave')}
                    </button>
                    <button onClick={() => copyCandidate()} className="text-xs font-medium text-[var(--fg-secondary)] hover:bg-[var(--bg-subtle)] px-2.5 py-1.5 rounded-lg transition-colors flex items-center gap-1">
                      <Copy size={12} /> {t('common.copy')}
                    </button>
                  </div>

                  {/* Recipe 内容 */}
                  <Drawer.Body padded>
                    <MarkdownWithHighlight content={compareModal.recipeContent} stripFrontmatter />
                  </Drawer.Body>
                </Drawer.Panel>
              );
            })()}

            <Drawer.Panel size={drawerWide ? 'lg' : 'md'}>
              {/* ── 面板头部 ── */}
              <Drawer.Header title={cand.title}>
                <Drawer.Nav
                  currentIndex={currentIndex}
                  total={allItems.length}
                  onPrev={goToPrev}
                  onNext={goToNext}
                  hasPrev={hasPrev}
                  hasNext={hasNext}
                />
                <Drawer.HeaderActions>
                  <Drawer.WidthToggle
                    isWide={drawerWide}
                    onToggle={toggleDrawerWide}
                    title={drawerWide ? t('common.collapse') : t('common.expand')}
                  />
                  <Button variant="danger" size="icon-sm" onClick={() => { handleDeleteCandidate(effectiveTarget!, cand.id); setExpandedId(null); setCompareModal(null); }}><Trash2 size={16} /></Button>
                  <Drawer.CloseButton onClose={() => { setExpandedId(null); setCompareModal(null); }} />
                </Drawer.HeaderActions>
              </Drawer.Header>

              {/* ── 面板内容 ── */}
              <Drawer.Body>

                {/* 1–2. Badges + Metadata + Tags */}
                <DrawerMeta
                  badges={(() => {
                    const b: BadgeItem[] = [];
                    b.push({ label: cand.category || 'general', className: `font-bold uppercase ${candCatCfg?.bg || 'bg-[var(--bg-subtle)]'} ${candCatCfg?.color || 'text-[var(--fg-muted)]'} ${candCatCfg?.border || 'border-[var(--border-default)]'}` });
                    if (cand.knowledgeType) b.push({ label: cand.knowledgeType, className: 'bg-purple-50 text-purple-700 border-purple-200' });
                    if (cand.language) b.push({ label: cand.language, className: 'uppercase font-bold text-[var(--fg-secondary)] bg-[var(--bg-subtle)] border-[var(--border-default)]' });
                    if (cand.complexity) b.push({ label: cand.complexity === 'advanced' ? t('candidates.confidenceHigh') : cand.complexity === 'intermediate' ? t('candidates.confidenceMedium') : t('candidates.confidenceLow'), className: cand.complexity === 'advanced' ? 'bg-red-50 text-red-600 border-red-100' : cand.complexity === 'intermediate' ? 'bg-amber-50 text-amber-600 border-amber-100' : 'bg-emerald-50 text-emerald-600 border-emerald-100' });
                    if (cand.trigger) b.push({ label: cand.trigger, className: 'font-mono font-bold bg-amber-50 text-amber-700 border-amber-200' });
                    if (cand.source && cand.source !== 'unknown') b.push({ label: srcInfo.labelKey.startsWith('candidates.') ? t(srcInfo.labelKey) : srcInfo.labelKey, className: srcInfo.color });
                    if (cand.lifecycle && cand.lifecycle !== 'pending') b.push({ label: cand.lifecycle, className: 'bg-blue-50 text-blue-600 border-blue-200' });
                    return b;
                  })()}
                  metadata={(() => {
                    const m: MetaItem[] = [];
                    if (cand.scope) m.push({ icon: Globe, iconClass: 'text-teal-400', label: t('candidates.path'), value: cand.scope === 'universal' ? t('common.all') : cand.scope === 'project-specific' ? t('candidates.category') : cand.scope === 'module-level' ? t('candidates.category') : cand.scope });
                    if (cand.source && cand.source !== 'unknown') m.push({ icon: Globe, iconClass: 'text-violet-400', label: t('candidates.source'), value: srcInfo.labelKey.startsWith('candidates.') ? t(srcInfo.labelKey) : srcInfo.labelKey });
                    if (cand.createdAt && formatDate(cand.createdAt, t)) m.push({ icon: Clock, iconClass: 'text-[var(--fg-muted)]', label: t('candidates.createdAt'), value: formatDate(cand.createdAt, t) });
                    return m;
                  })()}
                  tags={cand.tags}
                  maxTags={10}
                />

                {/* 3. Description / Summary */}
                <DrawerContent.Description label={t('candidates.description')} text={cand.description} />

                {/* 4. Reasoning — 推理依据 */}
                <DrawerContent.Reasoning
                  reasoning={r}
                  labels={{ section: t('knowledge.reasoning'), source: `${t('candidates.source')}:`, confidence: `${t('candidates.confidence')}:`, alternatives: `${t('candidates.viewDetail')}:` }}
                  filterSubmitted
                />

                {/* 5. Quality — 质量评级 */}
                <DrawerContent.Quality
                  quality={cand.quality}
                  labels={{ section: t('candidates.qualityDimensions'), completeness: t('recipes.qualityCompleteness'), adaptation: t('recipes.qualityAdaptation'), documentation: t('recipes.qualityDocumentation') }}
                />

                {/* 6. AI 润色增强信息 */}
                {(() => {
                  const allRelations = cand.relations ? Object.entries(cand.relations).flatMap(([type, arr]) => (Array.isArray(arr) ? arr.map((r: any) => ({ ...r, type })) : [])) : [];
                  const hasEnhanced = cand.agentNotes || cand.aiInsight || allRelations.length > 0;
                  if (!hasEnhanced) return null;
                  return (
                    <div className="px-6 py-4 border-b border-[var(--border-default)]">
                      <label className="text-[10px] font-bold text-[var(--fg-muted)] uppercase mb-2 block flex items-center gap-1.5">
                        <Sparkles size={11} className="text-emerald-400" /> {t('candidates.refineEnhanced')}
                      </label>
                      <div className="bg-emerald-50/30 border border-emerald-100 rounded-xl p-4 space-y-2.5 text-xs">
                        {cand.aiInsight && (
                          <div>
                            <span className="text-[10px] text-[var(--fg-muted)] font-bold">{t('candidates.viewDetail')}:</span>
                            <p className="text-sm text-[var(--fg-primary)] leading-relaxed mt-0.5">{cand.aiInsight}</p>
                          </div>
                        )}
                        {cand.agentNotes && cand.agentNotes.length > 0 && (
                          <div>
                            <span className="text-[10px] text-[var(--fg-muted)] font-bold">{t('candidates.agentNotes')}</span>
                            <ul className="mt-1 space-y-0.5">
                              {cand.agentNotes.map((note: string, i: number) => (
                                <li key={i} className="flex items-start gap-1.5 text-[var(--fg-secondary)]">
                                  <span className="text-emerald-400 mt-0.5">•</span>{note}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {allRelations.length > 0 && (
                          <div>
                            <span className="text-[10px] text-[var(--fg-muted)] font-bold">{t('recipes.relations')}:</span>
                            <div className="mt-1 space-y-1">
                              {allRelations.map((rel: any, i: number) => (
                                <div key={i} className="flex items-start gap-1.5 text-[var(--fg-secondary)]">
                                  <span className="text-[9px] font-bold px-1 py-0.5 rounded bg-emerald-100 text-emerald-700 shrink-0 uppercase">
                                    {rel.type}
                                  </span>
                                  <span className="font-medium text-[var(--fg-primary)]">{titleLookup.get(rel.target) || rel.target}</span>
                                  {rel.description && <span className="text-[var(--fg-muted)]">— {rel.description}</span>}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })()}

                {/* 7. 相似 Recipe — 仅在有结果时渲染，避免 loading 态导致布局跳动 */}
                {similar.length > 0 && (
                  <div className="px-6 py-3 border-b border-[var(--border-default)]">
                    <label className="text-[10px] font-bold text-[var(--fg-muted)] uppercase mb-2 block flex items-center gap-1.5">
                      {t('candidates.similarRecipe')}
                      {isLoadingSimilar && <span className="text-[10px] text-[var(--fg-muted)] animate-pulse">{t('common.loading')}</span>}
                    </label>
                    <div className="flex flex-wrap gap-1.5">
                      {similar.slice(0, 5).map(s => (
                        <button
                          key={s.recipeName}
                          onClick={() => openCompare(cand, effectiveTarget!, s.recipeName, similar)}
                          className="text-[10px] font-bold px-2 py-1 rounded-lg bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-100 transition-colors flex items-center gap-1"
                          title={t('candidates.similarWith', { name: s.recipeName, score: (s.similarity * 100).toFixed(0) })}
                        >
                          <GitCompare size={10} />
                          {s.recipeName.replace(/\.md$/i, '')} {(s.similarity * 100).toFixed(0)}%
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* 8. Code / 标准用法 */}
                <DrawerContent.CodePattern label={t('knowledge.codePattern')} code={cand.content?.pattern} language={cand.language} />

                {/* 9. Markdown 文档 */}
                <DrawerContent.MarkdownSection label={t('knowledge.markdownDoc')} content={cand.content?.markdown} />

                {/* 10. Delivery 字段 */}
                <DrawerContent.Delivery
                  delivery={{ topicHint: cand.topicHint, whenClause: cand.whenClause, doClause: cand.doClause, dontClause: cand.dontClause, coreCode: cand.coreCode }}
                  language={cand.language}
                />

                {/* 11. Rationale + Headers + Steps */}
                <DrawerContent.Rationale label={t('candidates.rationale')} text={cand.content?.rationale} />
                <DrawerContent.Headers label={t('candidates.headers')} headers={cand.headers} />
                <DrawerContent.Steps label={t('recipes.steps')} steps={cand.content?.steps} />
              </Drawer.Body>

              {/* ── 面板底部操作栏 ── */}
              <Drawer.Footer>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleEnrichCandidate(cand.id)}
                    disabled={enrichingIds.has(cand.id)}
                    title={t('candidates.enrichTitleBottom')}
                    className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
                      enrichingIds.has(cand.id) ? 'text-[var(--fg-muted)] cursor-not-allowed' : 'text-amber-600 hover:bg-amber-50 border border-amber-200'
                    }`}
                  >
                    {enrichingIds.has(cand.id) ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
                    {t('candidates.enrichShort')}
                  </button>
                  <button
                    onClick={() => handleRefineSingle(cand.id)}
                    disabled={refiningIds.has(cand.id)}
                    title={t('candidates.refineTitleBottom')}
                    className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
                      refiningIds.has(cand.id) ? 'text-[var(--fg-muted)] cursor-not-allowed' : 'text-emerald-600 hover:bg-emerald-50 border border-emerald-200'
                    }`}
                  >
                    {refiningIds.has(cand.id) ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                    {t('candidates.refineShort')}
                  </button>
                  <button
                    onClick={() => { handleDeleteCandidate(effectiveTarget!, cand.id); setExpandedId(null); setCompareModal(null); }}
                    title={t('common.delete')}
                    className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium text-red-500 hover:bg-red-50 border border-red-200 transition-colors`}
                  >
                    <Trash2 size={14} /> {t('common.delete')}
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  {cand.lifecycle === 'pending' && (
                    <button
                      onClick={async () => {
                        try {
                          await api.promoteCandidateToRecipe(cand.id);
                          notify(t('candidates.approveSuccess'), { title: t('candidates.approveSuccess') });
                          onRefresh?.();
                        } catch (err: any) {
                          notify(err.message, { title: t('common.operationFailed'), type: 'error' });
                        }
                      }}
                      className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-bold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 transition-colors"
                    >
                      <Rocket size={14} /> {t('candidates.approve')}
                    </button>
                  )}
                  <button
                    onClick={() => { onAuditCandidate(cand, effectiveTarget!); setExpandedId(null); setCompareModal(null); }}
                    className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 transition-colors shadow-sm"
                  >
                    <Edit3 size={14} /> {t('candidates.approveAndSave')}
                  </button>
                </div>
              </Drawer.Footer>
            </Drawer.Panel>
          </PageOverlay>
        );
      })()}

      {/* ═══ 双栏对比弹窗 — 已迁移到详情抽屉内的并列抽屉 ═══ */}

      {/* ═══ 润色面板已迁移到 GlobalChatDrawer ═══ */}
    </div>
  );
};

export default CandidatesView;
