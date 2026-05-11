import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Edit3, Trash2, BookOpen, Shield, Lightbulb, FileText, FileCode, X, BadgeCheck, Eye, Save, Link2, Plus, Search, ArrowUp, ArrowDown, Code2, Layers, Globe, MoreHorizontal, Clock, Dna, AlertTriangle, Archive, ArrowUpCircle, CheckCircle2, Sparkles, TrendingDown } from 'lucide-react';
import { useDrawerWide } from '../../hooks/useDrawerWide';
import { Recipe, KnowledgeEntry } from '../../types';
import { categoryConfigs } from '../../constants';
import Pagination from '../Shared/Pagination';
import HighlightedCodeEditor from '../Shared/HighlightedCodeEditor';
import api from '../../api';
import DrawerMeta from '../Shared/DrawerMeta';
import type { BadgeItem, MetaItem } from '../Shared/DrawerMeta';
import DrawerContent from '../Shared/DrawerContent';
import { notify } from '../../utils/notification';
import { getErrorMessage } from '../../utils/error';
import { ICON_SIZES } from '../../constants/icons';
import { useI18n } from '../../i18n';
import { cn } from '../../lib/utils';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Drawer } from '../Layout/Drawer';
import PageOverlay from '../Shared/PageOverlay';
import EvolutionPanel, { fetchEvolutionCounts } from './EvolutionPanel';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from '../ui/DropdownMenu';
import Select from '../ui/Select';

/* ── Config ── */
const kindConfig: Record<string, { label: string; color: string; bg: string; border: string; icon: React.ElementType }> = {
  rule:    { label: 'Rule',    color: 'text-red-700',    bg: 'bg-red-50',    border: 'border-red-200',    icon: Shield },
  pattern: { label: 'Pattern', color: 'text-violet-700', bg: 'bg-violet-50', border: 'border-violet-200', icon: Lightbulb },
  fact:    { label: 'Fact',    color: 'text-cyan-700',   bg: 'bg-cyan-50',   border: 'border-cyan-200',   icon: BookOpen },
};

const knowledgeTypeLabelKeys: Record<string, string> = {
  'code-pattern': 'recipes.knowledgeTypes.codePattern',
  'architecture': 'recipes.knowledgeTypes.architecture',
  'best-practice': 'recipes.knowledgeTypes.bestPractice',
  'code-standard': 'recipes.knowledgeTypes.codeStandard',
  'call-chain': 'recipes.knowledgeTypes.callChain',
  'rule': 'recipes.knowledgeTypes.rule',
};

const lifecycleBadgeConfig: Record<string, { color: string; bg: string; border: string; icon: React.ElementType; labelKey: string }> = {
  pending: { color: 'text-gray-600 dark:text-gray-400', bg: 'bg-gray-500/8 dark:bg-gray-500/15', border: 'border-gray-300 dark:border-gray-600', icon: Clock, labelKey: 'knowledge.lifecyclePending' },
  staging: { color: 'text-blue-600 dark:text-blue-400', bg: 'bg-blue-500/8 dark:bg-blue-500/15', border: 'border-blue-300 dark:border-blue-600', icon: ArrowUpCircle, labelKey: 'knowledge.lifecycleStaging' },
  active: { color: 'text-green-600 dark:text-green-400', bg: 'bg-green-500/8 dark:bg-green-500/15', border: 'border-green-300 dark:border-green-600', icon: CheckCircle2, labelKey: 'knowledge.lifecycleActive' },
  evolving: { color: 'text-purple-600 dark:text-purple-400', bg: 'bg-purple-500/8 dark:bg-purple-500/15', border: 'border-purple-300 dark:border-purple-600', icon: Sparkles, labelKey: 'knowledge.lifecycleEvolving' },
  decaying: { color: 'text-orange-600 dark:text-orange-400', bg: 'bg-orange-500/8 dark:bg-orange-500/15', border: 'border-orange-300 dark:border-orange-600', icon: TrendingDown, labelKey: 'knowledge.lifecycleDecaying' },
  deprecated: { color: 'text-red-600 dark:text-red-400', bg: 'bg-red-500/8 dark:bg-red-500/15', border: 'border-red-300 dark:border-red-600', icon: Archive, labelKey: 'knowledge.lifecycleDeprecated' },
};

/* ── Types ── */
interface RecipesViewProps {
  recipes: Recipe[];
  openRecipeEdit: (recipe: Recipe) => void;
  handleDeleteRecipe: (name: string) => void;
  onRefresh?: () => void;
  idTitleMap?: Record<string, string>;
  currentPage?: number;
  onPageChange?: (page: number) => void;
  pageSize?: number;
  onPageSizeChange?: (size: number) => void;
}

/* ── Helpers ── */
function getDisplayName(recipe: Recipe): string {
  const raw = recipe.name || (recipe as { title?: string }).title || 'Untitled';
  return raw.replace(/\.md$/i, '');
}

function getCodePattern(recipe: Recipe): string {
  return recipe.content?.pattern || '';
}

function getCodeLang(recipe: Recipe): string {
  const l = (recipe.language || '').toLowerCase();
  if (['objectivec', 'objc', 'objective-c', 'obj-c'].includes(l)) return 'objectivec';
  return recipe.language || 'text';
}

function normalizeTimestamp(ts: string | number | null | undefined): number {
  if (ts == null) {
    return Number.NaN;
  }
  if (typeof ts === 'string') {
    return new Date(ts).getTime();
  }
  return ts < 1e12 ? ts * 1000 : ts;
}

function isValidTimestamp(ts: string | number | null | undefined): boolean {
  const ms = normalizeTimestamp(ts);
  return !isNaN(ms) && ms > 946684800000;
}

function formatDate(ts: string | number | null | undefined, t: (key: string, vars?: Record<string, string | number>) => string): string {
  if (!isValidTimestamp(ts)) return '';
  const ms = normalizeTimestamp(ts);
  const d = new Date(ms);
  const now = Date.now();
  const diffMs = now - ms;
  if (diffMs < 0) {
    return d.toLocaleDateString();
  }
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) {
    return t('candidates.timeJustNow');
  }
  if (diffMin < 60) {
    return t('candidates.timeMinutesAgo', { n: diffMin });
  }
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) {
    return t('candidates.timeHoursAgo', { n: diffHour });
  }
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 7) {
    return t('candidates.timeDaysAgo', { n: diffDay });
  }
  return d.toLocaleDateString();
}

function parseLifecycleHistory(
  lifecycleHistory: Recipe['lifecycleHistory']
): Array<{ from: string; to: string; at: number; by?: string }> {
  if (Array.isArray(lifecycleHistory)) {
    return lifecycleHistory;
  }
  if (typeof lifecycleHistory !== 'string') {
    return [];
  }
  try {
    const parsed = JSON.parse(lifecycleHistory);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

type TranslateFn = (key: string, vars?: Record<string, string | number>) => string;

function formatScopeLabel(scope: string, t: TranslateFn): string {
  if (scope === 'universal') {
    return t('knowledge.scopeUniversal');
  }
  if (scope === 'project-specific') {
    return t('knowledge.scopeProject');
  }
  if (scope === 'module-level' || scope === 'target-specific') {
    return t('knowledge.scopeModule');
  }
  return scope;
}

function formatComplexityLabel(complexity: string, t: TranslateFn): string {
  if (complexity === 'advanced') {
    return t('knowledge.complexityAdvanced');
  }
  if (complexity === 'intermediate') {
    return t('knowledge.complexityIntermediate');
  }
  if (complexity === 'beginner') {
    return t('knowledge.complexityBeginner');
  }
  return complexity;
}

function formatSourceLabel(source: string, t: TranslateFn): string {
  if (source === 'bootstrap-scan') {
    return t('recipes.sourceBootstrap');
  }
  if (source === 'agent') {
    return t('recipes.sourceAiScan');
  }
  if (source === 'mcp') {
    return t('knowledge.sourceMcp');
  }
  if (source === 'manual') {
    return t('knowledge.sourceManual');
  }
  return source;
}

/* ═══════════════════════════════════════════════════════
 *  Component
 * ═══════════════════════════════════════════════════════ */
const RecipesView: React.FC<RecipesViewProps> = ({
  recipes,
  handleDeleteRecipe,
  onRefresh,
  idTitleMap: idTitleMapProp,
  currentPage: controlledPage,
  onPageChange: controlledOnPageChange,
  pageSize: controlledPageSize,
  onPageSizeChange: controlledOnPageSizeChange,
}) => {
  const { t } = useI18n();
  type SortKey = 'newest' | 'quality' | 'usage' | 'alpha' | 'category';
  type SortDir = 'asc' | 'desc';
  const [sortKey, setSortKey] = useState<SortKey>('newest');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const sortOptions: { key: SortKey; label: string; defaultDir: SortDir }[] = [
    { key: 'newest',   label: t('recipes.sortNewest'),   defaultDir: 'desc' },
    { key: 'quality',  label: t('recipes.sortQuality'),  defaultDir: 'desc' },
    { key: 'usage',    label: t('recipes.sortUsage'),    defaultDir: 'desc' },
    { key: 'alpha',    label: t('recipes.sortAlpha'),    defaultDir: 'asc' },
    { key: 'category', label: t('recipes.sortCategory'), defaultDir: 'asc' },
  ];

  const [internalPage, setInternalPage] = useState(1);
  const [internalPageSize, setInternalPageSize] = useState(12);
  const currentPage = controlledPage ?? internalPage;
  const pageSize = controlledPageSize ?? internalPageSize;
  const setCurrentPage = controlledOnPageChange ?? setInternalPage;
  const handlePageSizeChange = controlledOnPageSizeChange
    ? (size: number) => controlledOnPageSizeChange(size)
    : (size: number) => { setInternalPageSize(size); setInternalPage(1); };

  const { isWide: drawerWide, toggle: toggleDrawerWide } = useDrawerWide();
  const [selectedRecipe, setSelectedRecipe] = useState<Recipe | null>(null);
  const [drawerMode, setDrawerMode] = useState<'view' | 'edit'>('view');
  const [editForm, setEditForm] = useState<{
    title: string;
    description: string;
    markdown: string;
    codePattern: string;
    rationale: string;
    tags: string[];
    tagInput: string;
  }>({ title: '', description: '', markdown: '', codePattern: '', rationale: '', tags: [], tagInput: '' });
  const [isSaving, setIsSaving] = useState(false);
  const isMountedRef = useRef(true);

  const [isAddingRelation, setIsAddingRelation] = useState(false);
  const [newRelationType, setNewRelationType] = useState('related');
  const [relationSearchQuery, setRelationSearchQuery] = useState('');

  /* ── Evolution signals state ── */
  const [showEvolution, setShowEvolution] = useState(false);
  const [evolutionCounts, setEvolutionCounts] = useState<Record<string, { proposals: number; warnings: number }>>({});

  useEffect(() => { return () => { isMountedRef.current = false; }; }, []);

  /* ── Fetch evolution counts for current page recipes ── */
  const fetchPageEvolutionCounts = useCallback(async (pageRecipes: Recipe[]) => {
    const ids = pageRecipes.map(r => r.id).filter((id): id is string => !!id);
    if (ids.length === 0) { return; }
    const entries = await Promise.all(
      ids.map(async id => {
        const counts = await fetchEvolutionCounts(id);
        return [id, counts] as const;
      }),
    );
    if (!isMountedRef.current) { return; }
    setEvolutionCounts(prev => {
      const next = { ...prev };
      for (const [id, counts] of entries) {
        next[id] = counts;
      }
      return next;
    });
  }, []);

  const RELATION_TYPES = [
    { key: 'related',    label: t('knowledgeGraph.relationAssociates'), icon: '∼' },
    { key: 'dependsOn',  label: t('knowledgeGraph.relationDependsOn'), icon: '⊕' },
    { key: 'inherits',   label: t('knowledgeGraph.relationInherits'), icon: '↑' },
    { key: 'implements', label: t('knowledgeGraph.relationImplements'), icon: '◇' },
    { key: 'calls',      label: t('knowledgeGraph.relationCalls'), icon: '→' },
    { key: 'dataFlow',   label: t('knowledgeGraph.relationDataFlow'), icon: '⇢' },
    { key: 'conflicts',  label: t('knowledgeGraph.relationConflicts'), icon: '✕' },
    { key: 'extends',    label: t('knowledgeGraph.relationExtends'), icon: '⊃' },
  ];

  const openDrawer = (recipe: Recipe) => {
    setSelectedRecipe(recipe);
    setDrawerMode('view');
    setEditForm({
      title: recipe.name?.replace(/\.md$/, '') || '',
      description: recipe.description || '',
      markdown: recipe.content?.markdown || '',
      codePattern: recipe.content?.pattern || '',
      rationale: recipe.content?.rationale || '',
      tags: recipe.tags || [],
      tagInput: '',
    });
    setIsAddingRelation(false);
    setRelationSearchQuery('');
  };

  const closeDrawer = () => {
    setSelectedRecipe(null);
    setDrawerMode('view');
    setIsAddingRelation(false);
    setRelationSearchQuery('');
  };

  const handleSaveInDrawer = async () => {
    if (!selectedRecipe || isSaving) return;
    setIsSaving(true);
    try {
      const recipeId = selectedRecipe.id || selectedRecipe.name;
      await api.knowledgeUpdate(recipeId, {
        title: editForm.title,
        description: editForm.description,
        tags: editForm.tags,
        content: {
          ...(selectedRecipe.content || {}),
          pattern: editForm.codePattern,
          markdown: editForm.markdown,
          rationale: editForm.rationale,
        },
      } as Partial<KnowledgeEntry>);
      if (isMountedRef.current) { setDrawerMode('view'); onRefresh?.(); }
    } catch (err: unknown) {
      notify(getErrorMessage(err, t('common.saveFailed')), { title: t('common.operationFailed'), type: 'error' });
    } finally {
      if (isMountedRef.current) setIsSaving(false);
    }
  };

  const handleSetAuthority = async (authority: number) => {
    if (!selectedRecipe) return;
    try {
      await api.setRecipeAuthority(selectedRecipe.id || selectedRecipe.name, authority);
      onRefresh?.();
    } catch (err: unknown) {
      notify(getErrorMessage(err, t('common.operationFailed')), { title: t('common.operationFailed'), type: 'error' });
    }
  };

  const findRecipeByName = (name: string): Recipe | undefined => {
    const normalized = name.replace(/\.md$/i, '').toLowerCase();
    return recipes.find(r => getDisplayName(r).toLowerCase() === normalized || r.id === name || r.name === name);
  };

  // ID → 标题 查找表 (将关联关系中的 UUID 解析为可读标题)
  const titleLookup = useMemo(() => {
    const map = new Map<string, string>();
    // 全局 map (包含所有 lifecycle 的 entries)
    if (idTitleMapProp) {
      for (const [id, title] of Object.entries(idTitleMapProp)) {
        map.set(id, title);
      }
    }
    // 本地 recipes 补充
    for (const r of recipes) {
      if (r.id) map.set(r.id, getDisplayName(r));
      if (r.name) map.set(r.name, getDisplayName(r));
    }
    return map;
  }, [recipes, idTitleMapProp]);

  const [relationBusy, setRelationBusy] = useState(false);

  const handleAddRelation = async (type: string, targetName: string) => {
    if (!selectedRecipe || relationBusy) return;
    const currentRelations: Record<string, any[]> = {};
    if (selectedRecipe.relations) {
      for (const [k, v] of Object.entries(selectedRecipe.relations)) currentRelations[k] = [...v];
    }
    const existing = currentRelations[type] || [];
    const targetId = targetName.replace(/\.md$/i, '');
    if (existing.some((r: any) => {
      const id = typeof r === 'string' ? r : r.target || r.id || r.title || '';
      return id.replace(/\.md$/i, '').toLowerCase() === targetId.toLowerCase();
    })) return;
    currentRelations[type] = [...existing, targetId];

    // 乐观更新：先更新本地状态，再发请求
    const previousRecipe = selectedRecipe;
    setSelectedRecipe({ ...selectedRecipe, relations: currentRelations });
    setIsAddingRelation(false); setRelationSearchQuery('');
    setRelationBusy(true);
    try {
      await api.updateRecipeRelations(selectedRecipe.id || selectedRecipe.name, currentRelations);
    } catch (err: unknown) {
      // 回滚
      setSelectedRecipe(previousRecipe);
      notify(getErrorMessage(err, t('common.operationFailed')), { title: t('common.operationFailed'), type: 'error' });
    } finally {
      setRelationBusy(false);
    }
  };

  const handleRemoveRelation = async (type: string, targetName: string) => {
    if (!selectedRecipe || relationBusy) return;
    const currentRelations: Record<string, any[]> = {};
    if (selectedRecipe.relations) {
      for (const [k, v] of Object.entries(selectedRecipe.relations)) currentRelations[k] = [...v];
    }
    const existing = currentRelations[type] || [];
    currentRelations[type] = existing.filter((r: any) => {
      const id = typeof r === 'string' ? r : r.target || r.id || r.title || '';
      return id.replace(/\.md$/i, '').toLowerCase() !== targetName.replace(/\.md$/i, '').toLowerCase();
    });
    if (currentRelations[type].length === 0) delete currentRelations[type];

    // 乐观更新：先更新本地状态，再发请求
    const previousRecipe = selectedRecipe;
    setSelectedRecipe({ ...selectedRecipe, relations: currentRelations });
    setRelationBusy(true);
    try {
      await api.updateRecipeRelations(selectedRecipe.id || selectedRecipe.name, currentRelations);
    } catch (err: unknown) {
      // 回滚
      setSelectedRecipe(previousRecipe);
      notify(getErrorMessage(err, t('common.operationFailed')), { title: t('common.operationFailed'), type: 'error' });
    } finally {
      setRelationBusy(false);
    }
  };

  useEffect(() => {
    if (selectedRecipe && !recipes.find(r => getDisplayName(r) === getDisplayName(selectedRecipe))) closeDrawer();
  }, [recipes, selectedRecipe]);

  useEffect(() => {
    if (controlledPage == null) setInternalPage(1);
  }, [recipes.length, controlledPage]);

  const sortedRecipes = React.useMemo(() => {
    if (sortKey === 'newest') {
      return recipes;
    }
    const arr = [...recipes];
    const dir = sortDir === 'asc' ? 1 : -1;
    arr.sort((a, b) => {
      let va: number | string = 0, vb: number | string = 0;
      switch (sortKey) {
        case 'alpha':
          va = getDisplayName(a).toLowerCase(); vb = getDisplayName(b).toLowerCase();
          return dir * (va < vb ? -1 : va > vb ? 1 : 0);
        case 'quality':
          va = a.quality?.overall ?? -1; vb = b.quality?.overall ?? -1; break;
        case 'usage':
          va = (a.stats?.guardUsageCount ?? 0) + (a.stats?.humanUsageCount ?? 0) + (a.stats?.aiUsageCount ?? 0);
          vb = (b.stats?.guardUsageCount ?? 0) + (b.stats?.humanUsageCount ?? 0) + (b.stats?.aiUsageCount ?? 0);
          break;
        case 'category':
          va = (a.category || '').toLowerCase(); vb = (b.category || '').toLowerCase();
          return dir * (va < vb ? -1 : va > vb ? 1 : 0);
      }
      return dir * ((va as number) - (vb as number));
    });
    return arr;
  }, [recipes, sortKey, sortDir]);

  const totalPages = Math.ceil(sortedRecipes.length / pageSize);
  const startIndex = (currentPage - 1) * pageSize;
  const paginatedRecipes = sortedRecipes.slice(startIndex, startIndex + pageSize);

  /* Fetch evolution counts when page changes */
  useEffect(() => {
    fetchPageEvolutionCounts(paginatedRecipes);
  }, [paginatedRecipes, fetchPageEvolutionCounts]);

  const handlePageChange = (page: number) => {
    setCurrentPage(page);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const currentIndex = selectedRecipe ? sortedRecipes.findIndex(r => getDisplayName(r) === getDisplayName(selectedRecipe)) : -1;
  const goToPrev = () => { if (currentIndex > 0) openDrawer(sortedRecipes[currentIndex - 1]); };
  const goToNext = () => { if (currentIndex < sortedRecipes.length - 1) openDrawer(sortedRecipes[currentIndex + 1]); };

  /* ── Badge row ── */
  /** 卡片列表用的精简标签行（纯文本） */
  const BadgeRow: React.FC<{ recipe: Recipe; compact?: boolean }> = ({ recipe }) => {
    const kc = recipe.kind ? kindConfig[recipe.kind] : null;
    const category = recipe.category || 'Utility';
    const kt = recipe.knowledgeType;
    const items: string[] = [];
    if (kc) items.push(kc.label);
    if (category) items.push(category);
    if (kt && knowledgeTypeLabelKeys[kt]) items.push(t(knowledgeTypeLabelKeys[kt]));
    if (recipe.language) items.push(recipe.language.toUpperCase());
    if (recipe.trigger) items.push(recipe.trigger);
    return (
      <span className="text-[11px] text-[var(--fg-muted)] truncate">
        {items.join('  ·  ')}
      </span>
    );
  };

  return (
    <div className="relative pb-6">
      {recipes.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <BadgeCheck size={48} className="text-[var(--fg-muted)] mb-4 opacity-40" />
          <p className="font-medium text-[var(--fg-secondary)] mb-1">{t('recipes.noResults')}</p>
          <p className="text-sm text-[var(--fg-muted)]">{t('recipes.noContent')}</p>
        </div>
      ) : (
        <>
          {/* ── Stats bar: kind filter tabs ── */}
          <div className="flex items-center gap-1.5 mb-4 border-b border-[var(--border-default)] pb-3">
            {sortOptions.map(opt => {
              const active = sortKey === opt.key;
              return (
                <button
                  key={opt.key}
                  onClick={() => {
                    if (active) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
                    else { setSortKey(opt.key); setSortDir(opt.defaultDir); }
                    setCurrentPage(1);
                  }}
                  className={cn(
                    "px-4 py-1.5 rounded-md text-xs font-medium transition-colors flex items-center gap-1",
                    active
                      ? "bg-[var(--accent-subtle)] text-[var(--accent)] border border-[var(--accent-emphasis)]"
                      : "text-[var(--fg-muted)] hover:bg-[var(--bg-subtle)] border border-transparent"
                  )}
                >
                  {opt.label}
                  {active && sortKey !== 'newest' && (sortDir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
                </button>
              );
            })}
            <span className="ml-auto text-xs text-[var(--fg-muted)]">{t('recipes.totalCount', { count: recipes.length })}</span>
          </div>

          {/* ══════════ Card list (Resend style — divider, no outer border) ══════════ */}
          <div>
            {paginatedRecipes.map(recipe => {
              const displayName = getDisplayName(recipe);
              const summary = recipe.description || recipe.usageGuide || '';
              const isSelected = selectedRecipe && getDisplayName(selectedRecipe) === displayName;
              const kc = recipe.kind ? kindConfig[recipe.kind] : null;
              return (
                <div
                  key={recipe.id || displayName}
                  onClick={() => openDrawer(recipe)}
                  className={cn(
                    "group relative cursor-pointer py-4 px-4 rounded-lg transition-colors hover:bg-[var(--bg-subtle)] after:absolute after:bottom-0 after:left-4 after:right-4 after:h-px after:bg-[var(--border-default)] last:after:hidden",
                    isSelected && "bg-[var(--accent-subtle)]"
                  )}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="font-semibold text-[var(--fg-primary)] text-sm break-words leading-snug truncate">{displayName}</h3>
                        {kc && (
                          <Badge variant={kc.label === 'Rule' ? 'red' : kc.label === 'Pattern' ? 'blue' : 'default'} className="text-[9px] uppercase shrink-0">
                            {kc.label}
                          </Badge>
                        )}
                        {recipe.stats?.authority != null && recipe.stats.authority >= 4 && (
                          <span className="text-amber-500 text-[11px] shrink-0">★ {recipe.stats.authority}</span>
                        )}
                        {/* ── Evolution signal badges ── */}
                        {(() => {
                          const ec = recipe.id ? evolutionCounts[recipe.id] : undefined;
                          if (!ec) { return null; }
                          return (
                            <>
                              {ec.proposals > 0 && (
                                <span className="inline-flex items-center gap-0.5 text-[10px] text-blue-600 shrink-0" title={t('evolution.proposals')}>
                                  <Dna size={10} /> {ec.proposals}
                                </span>
                              )}
                              {ec.warnings > 0 && (
                                <span className="inline-flex items-center gap-0.5 text-[10px] text-amber-600 shrink-0" title={t('evolution.warnings')}>
                                  <AlertTriangle size={10} /> {ec.warnings}
                                </span>
                              )}
                            </>
                          );
                        })()}
                      </div>
                      {summary && (
                        <p className="text-xs text-[var(--fg-secondary)] line-clamp-1 leading-relaxed mb-1.5">{summary.replace(/^#+\s*/gm, '').replace(/\*\*/g, '')}</p>
                      )}
                      <div className="flex items-center gap-2">
                        <BadgeRow recipe={recipe} compact />
                        {recipe.tags && recipe.tags.length > 0 && (
                          <span className="text-[11px] text-[var(--fg-muted)]">
                            {recipe.tags.slice(0, 3).join(', ')}
                            {recipe.tags.length > 3 && ` +${recipe.tags.length - 3}`}
                          </span>
                        )}
                      </div>
                    </div>
                    {/* ⋯ action menu */}
                    <div className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" onClick={e => e.stopPropagation()}>
                            <MoreHorizontal size={14} />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={e => { e.stopPropagation(); openDrawer(recipe); }}>
                            <Eye size={14} className="mr-2" /> {t('common.preview')}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={e => { e.stopPropagation(); openDrawer(recipe); setDrawerMode('edit'); }}>
                            <Edit3 size={14} className="mr-2" /> {t('common.edit')}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem className="text-[var(--status-error)]" onClick={e => { e.stopPropagation(); handleDeleteRecipe(recipe.name || recipe.id || ''); }}>
                            <Trash2 size={14} className="mr-2" /> {t('recipes.deleteRecipe')}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {recipes.length > 0 && (
        <Pagination
          currentPage={currentPage}
          totalPages={totalPages}
          totalItems={sortedRecipes.length}
          pageSize={pageSize}
          onPageChange={handlePageChange}
          onPageSizeChange={handlePageSizeChange}
        />
      )}

      {/* ══════════════════════════════════════════════════════
       *  Detail Drawer — V3 structured layout
       * ══════════════════════════════════════════════════════ */}
      {selectedRecipe && (() => {
        const recipe = selectedRecipe;
        const displayName = getDisplayName(recipe);
        const codePattern = getCodePattern(recipe);
        const codeLang = getCodeLang(recipe);
        const contentV3 = recipe.content;
        const lifecycleHistory = parseLifecycleHistory(recipe.lifecycleHistory);
        const lifecycleConfig = recipe.status ? lifecycleBadgeConfig[recipe.status] : null;
        const markdownLineCount = Math.max(1, editForm.markdown.split('\n').length);
        const codeLineCount = Math.max(1, editForm.codePattern.split('\n').length);
        const markdownCharCount = editForm.markdown.trim().length;
        const codeCharCount = editForm.codePattern.trim().length;

        const evoCount = (recipe.id ? evolutionCounts[recipe.id] : undefined) || { proposals: 0, warnings: 0 };
        const hasEvolution = evoCount.proposals > 0 || evoCount.warnings > 0;

        return (
          <PageOverlay className="z-30 flex justify-end" onClick={closeDrawer}>
            <PageOverlay.Backdrop className="bg-black/20 dark:bg-black/40 backdrop-blur-sm" />

            {/* ── Evolution side panel ── */}
            {showEvolution && (
              <Drawer.Panel size="sm" className="!border-l-0 !shadow-none border-r border-r-[var(--border-default)]">
                <Drawer.Header title={t('evolution.title')}>
                  <Drawer.HeaderActions>
                    <Drawer.CloseButton onClose={() => setShowEvolution(false)} />
                  </Drawer.HeaderActions>
                </Drawer.Header>
                <Drawer.Body padded>
                  <EvolutionPanel
                    recipeId={recipe.id || ''}
                    recipeName={displayName}
                    idTitleMap={idTitleMapProp}
                    onActionComplete={() => fetchPageEvolutionCounts(paginatedRecipes)}
                  />
                </Drawer.Body>
              </Drawer.Panel>
            )}

            {/* ── Main recipe panel ── */}
            <Drawer.Panel size={drawerWide ? 'lg' : 'md'}>
              {/* ── Header ── */}
              <Drawer.Header
                title={displayName}
                leading={
                  <button
                    onClick={() => { handleDeleteRecipe(recipe.name || recipe.id || ''); closeDrawer(); }}
                    title={t('recipes.deleteRecipe')}
                    className="p-1.5 text-[var(--fg-muted)] hover:text-red-500 rounded-md transition-colors opacity-30 hover:opacity-100 shrink-0"
                  >
                    <Trash2 size={14} />
                  </button>
                }
              >
                <Drawer.Nav currentIndex={currentIndex} total={sortedRecipes.length} onPrev={goToPrev} onNext={goToNext} />
                <Drawer.HeaderActions>
                  <div className="flex bg-[var(--bg-subtle)] p-0.5 rounded-lg mr-1">
                    <button onClick={() => setDrawerMode('view')} className={cn("px-2.5 py-1 rounded-md text-xs font-bold transition-all flex items-center gap-1", drawerMode === 'view' ? 'bg-[var(--bg-surface)] shadow-sm text-[var(--accent)]' : 'text-[var(--fg-muted)] hover:text-[var(--fg-secondary)]')}><Eye size={ICON_SIZES.sm} /> {t('common.preview')}</button>
                    <button onClick={() => { setDrawerMode('edit'); }} className={cn("px-2.5 py-1 rounded-md text-xs font-bold transition-all flex items-center gap-1", drawerMode === 'edit' ? 'bg-[var(--bg-surface)] shadow-sm text-[var(--accent)]' : 'text-[var(--fg-muted)] hover:text-[var(--fg-secondary)]')}><Edit3 size={ICON_SIZES.sm} /> {t('common.edit')}</button>
                  </div>
                  {/* ── Evolution toggle ── */}
                  <button
                    onClick={() => setShowEvolution(v => !v)}
                    title={t('evolution.togglePanel')}
                    className={cn(
                      "relative p-1.5 rounded-md transition-colors",
                      showEvolution
                        ? "text-[var(--accent)] bg-[var(--accent-subtle)]"
                        : "text-[var(--fg-muted)] hover:text-[var(--fg-secondary)]"
                    )}
                  >
                    <Dna size={ICON_SIZES.sm} />
                    {hasEvolution && !showEvolution && (
                      <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-amber-500 rounded-full" />
                    )}
                  </button>
                  <Drawer.WidthToggle isWide={drawerWide} onToggle={toggleDrawerWide} />
                  <Drawer.CloseButton onClose={closeDrawer} />
                </Drawer.HeaderActions>
              </Drawer.Header>

              {drawerMode === 'edit' ? (
                <>
                  <Drawer.Body padded>
                    <div className="space-y-5">
                      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)] gap-5">
                        <div className="space-y-5">
                          <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-4 shadow-sm">
                            <div className="flex items-center justify-between gap-3 mb-3">
                              <label className="text-[10px] font-bold text-[var(--fg-muted)] uppercase tracking-wide block">{t('recipes.recipeDetail')}</label>
                              <span className="text-[10px] text-[var(--fg-muted)]">{t('recipes.charCount', { count: editForm.title.length })}</span>
                            </div>
                            <input
                              type="text"
                              value={editForm.title}
                              onChange={e => setEditForm(f => ({ ...f, title: e.target.value }))}
                              className="w-full px-4 py-3 text-base border border-[var(--border-default)] rounded-xl bg-[var(--bg-root)] text-[var(--fg-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-emphasis)] focus:border-[var(--accent-emphasis)]"
                            />
                          </div>

                          <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-4 shadow-sm">
                            <div className="flex items-center justify-between gap-3 mb-3">
                              <label className="text-[10px] font-bold text-[var(--fg-muted)] uppercase tracking-wide block">{t('recipes.description')}</label>
                              <span className="text-[10px] text-[var(--fg-muted)]">{t('recipes.charCount', { count: editForm.description.trim().length })}</span>
                            </div>
                            <textarea
                              value={editForm.description}
                              onChange={e => setEditForm(f => ({ ...f, description: e.target.value }))}
                              rows={3}
                              className="w-full px-4 py-3 text-sm border border-[var(--border-default)] rounded-xl bg-[var(--bg-root)] text-[var(--fg-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-emphasis)] resize-y"
                            />
                          </div>
                        </div>

                        <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-4 shadow-sm">
                          <div className="flex items-center justify-between gap-3 mb-3">
                            <label className="text-[10px] font-bold text-[var(--fg-muted)] uppercase tracking-wide block">{t('recipes.tags')}</label>
                            <span className="text-[10px] text-[var(--fg-muted)]">{t('recipes.tagCount', { count: editForm.tags.length })}</span>
                          </div>
                          <div className="flex flex-wrap gap-1.5 min-h-[28px] mb-3">
                            {editForm.tags.map((tag, i) => (
                              <span key={i} className="inline-flex items-center gap-1 text-[10px] px-2 py-1 rounded-md bg-[var(--accent-subtle)] text-[var(--accent)] border border-[var(--border-default)] font-medium">
                                {tag}
                                <button onClick={() => setEditForm(f => ({ ...f, tags: f.tags.filter((_, idx) => idx !== i) }))} className="text-[var(--fg-muted)] hover:text-[var(--status-error)]"><X size={10} /></button>
                              </span>
                            ))}
                            {editForm.tags.length === 0 && (
                              <span className="text-xs text-[var(--fg-muted)]">{t('recipes.noContent')}</span>
                            )}
                          </div>
                          <div className="flex gap-2">
                            <input
                              type="text"
                              value={editForm.tagInput}
                              onChange={e => setEditForm(f => ({ ...f, tagInput: e.target.value }))}
                              onKeyDown={e => {
                                if (e.key === 'Enter' && editForm.tagInput.trim()) {
                                  e.preventDefault();
                                  setEditForm(f => ({ ...f, tags: [...f.tags, f.tagInput.trim()], tagInput: '' }));
                                }
                              }}
                              placeholder={t('recipes.tags')}
                              className="flex-1 px-3 py-2 text-xs border border-[var(--border-default)] rounded-xl bg-[var(--bg-root)] text-[var(--fg-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-emphasis)]"
                            />
                          </div>
                        </div>
                      </div>

                      <div className="rounded-2xl border border-sky-500/25 bg-[var(--bg-surface)] shadow-sm overflow-hidden">
                        <div className="px-4 py-3 border-b border-sky-500/20 bg-[var(--bg-subtle)]/70 flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2">
                            <FileText size={12} className="text-sky-400" />
                            <div>
                              <label className="text-[10px] font-bold text-[var(--fg-muted)] uppercase tracking-wide block">{t('recipes.markdown')}</label>
                              <p className="text-[11px] text-[var(--fg-muted)]">{t('recipes.editorMarkdownHint')}</p>
                            </div>
                          </div>
                          <div className="flex items-center gap-2 text-[10px] text-[var(--fg-muted)]">
                            <span className="px-2 py-1 rounded-full bg-sky-500/12 text-sky-300 border border-sky-500/20">{t('recipes.lineCount', { count: markdownLineCount })}</span>
                            <span className="px-2 py-1 rounded-full bg-[var(--bg-root)] border border-[var(--border-default)]">{t('recipes.charCount', { count: markdownCharCount })}</span>
                          </div>
                        </div>
                        <div className="p-4 bg-[var(--bg-surface)] space-y-3">
                          <div className="flex flex-wrap items-center gap-2 text-[10px] text-[var(--fg-muted)]">
                            <span className="px-2 py-1 rounded-full bg-[var(--bg-subtle)] border border-sky-500/20">{t('recipes.editorMarkdownChip1')}</span>
                            <span className="px-2 py-1 rounded-full bg-[var(--bg-subtle)] border border-sky-500/20">{t('recipes.editorMarkdownChip2')}</span>
                            <span className="px-2 py-1 rounded-full bg-[var(--bg-subtle)] border border-sky-500/20">{t('recipes.editorMarkdownChip3')}</span>
                            <span className="px-2 py-1 rounded-full bg-[var(--bg-subtle)] border border-sky-500/20">{t('recipes.editorMarkdownChip4')}</span>
                          </div>
                          <div className="rounded-xl overflow-hidden border border-[var(--border-default)] shadow-sm" style={{ minHeight: 360 }}>
                            <HighlightedCodeEditor
                              value={editForm.markdown}
                              onChange={v => setEditForm(f => ({ ...f, markdown: v }))}
                              language="markdown"
                              height="360px"
                              showLineNumbers
                              density="compact"
                              placeholder={t('recipes.editorMarkdownPlaceholder')}
                            />
                          </div>
                          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-[11px] text-[var(--fg-muted)]">
                            <div className="rounded-lg border border-sky-500/20 bg-[var(--bg-subtle)] px-3 py-2">{t('recipes.editorMarkdownTip1')}</div>
                            <div className="rounded-lg border border-sky-500/20 bg-[var(--bg-subtle)] px-3 py-2">{t('recipes.editorMarkdownTip2')}</div>
                            <div className="rounded-lg border border-sky-500/20 bg-[var(--bg-subtle)] px-3 py-2">{t('recipes.editorMarkdownTip3')}</div>
                          </div>
                        </div>
                      </div>

                      <div className="rounded-2xl border border-emerald-500/25 bg-[var(--bg-surface)] shadow-sm overflow-hidden">
                        <div className="px-4 py-3 border-b border-emerald-500/20 bg-[var(--bg-subtle)]/70 flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2">
                            <Code2 size={12} className="text-emerald-400" />
                            <div>
                              <label className="text-[10px] font-bold text-[var(--fg-muted)] uppercase tracking-wide block">{t('recipes.code')}</label>
                              <p className="text-[11px] text-[var(--fg-muted)]">{t('recipes.editorCodeHint')}</p>
                            </div>
                          </div>
                          <div className="flex items-center gap-2 text-[10px] text-[var(--fg-muted)]">
                            <span className="px-2 py-1 rounded-full bg-emerald-500/12 text-emerald-300 border border-emerald-500/20">{codeLang}</span>
                            <span className="px-2 py-1 rounded-full bg-[var(--bg-root)] border border-[var(--border-default)]">{t('recipes.lineCount', { count: codeLineCount })}</span>
                            <span className="px-2 py-1 rounded-full bg-[var(--bg-root)] border border-[var(--border-default)]">{t('recipes.charCount', { count: codeCharCount })}</span>
                          </div>
                        </div>
                        <div className="p-4 bg-[var(--bg-surface)] space-y-3">
                          <div className="flex flex-wrap items-center gap-2 text-[10px] text-[var(--fg-muted)]">
                            <span className="px-2 py-1 rounded-full bg-[var(--bg-subtle)] border border-emerald-500/20">{t('recipes.editorCodeChip1')}</span>
                            <span className="px-2 py-1 rounded-full bg-[var(--bg-subtle)] border border-emerald-500/20">{t('recipes.editorCodeChip2')}</span>
                            <span className="px-2 py-1 rounded-full bg-[var(--bg-subtle)] border border-emerald-500/20">{t('recipes.editorCodeChip3')}</span>
                          </div>
                          <div className="rounded-xl overflow-hidden border border-[var(--border-default)] shadow-sm" style={{ minHeight: 360 }}>
                            <HighlightedCodeEditor
                              value={editForm.codePattern}
                              onChange={v => setEditForm(f => ({ ...f, codePattern: v }))}
                              language={codeLang}
                              height="360px"
                              showLineNumbers
                              density="compact"
                              placeholder={t('recipes.editorCodePlaceholder')}
                            />
                          </div>
                          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-[11px] text-[var(--fg-muted)]">
                            <div className="rounded-lg border border-emerald-500/20 bg-[var(--bg-subtle)] px-3 py-2">{t('recipes.editorCodeTip1')}</div>
                            <div className="rounded-lg border border-emerald-500/20 bg-[var(--bg-subtle)] px-3 py-2">{t('recipes.editorCodeTip2')}</div>
                            <div className="rounded-lg border border-emerald-500/20 bg-[var(--bg-subtle)] px-3 py-2">{t('recipes.editorCodeTip3')}</div>
                          </div>
                        </div>
                      </div>

                      <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-4 shadow-sm">
                        <div className="flex items-center justify-between gap-3 mb-3">
                          <label className="text-[10px] font-bold text-[var(--fg-muted)] uppercase tracking-wide block">{t('recipes.designRationale')}</label>
                          <span className="text-[10px] text-[var(--fg-muted)]">{t('recipes.charCount', { count: editForm.rationale.trim().length })}</span>
                        </div>
                        <textarea
                          value={editForm.rationale}
                          onChange={e => setEditForm(f => ({ ...f, rationale: e.target.value }))}
                          rows={4}
                          className="w-full px-4 py-3 text-sm border border-[var(--border-default)] rounded-xl bg-[var(--bg-root)] text-[var(--fg-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-emphasis)] resize-y"
                          placeholder={t('recipes.designRationale')}
                        />
                      </div>
                    </div>
                  </Drawer.Body>
                  <Drawer.Footer>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-[var(--fg-muted)]">{t('recipes.qualityAuthorityScore')}</span>
                      <Select
                        value={String(recipe.stats?.authority ?? 3)}
                        onChange={v => handleSetAuthority(parseInt(v))}
                        options={[1,2,3,4,5].map(v => ({ value: String(v), label: `${'⭐'.repeat(v)} ${v}` }))}
                        size="xs"
                        className="font-bold text-amber-600 bg-amber-50 border-amber-100"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <Button variant="ghost" onClick={() => setDrawerMode('view')} disabled={isSaving}>{t('common.cancel')}</Button>
                      <Button variant="primary" onClick={handleSaveInDrawer} disabled={isSaving} loading={isSaving}>
                        {!isSaving && <Save size={ICON_SIZES.sm} />}
                        {isSaving ? t('common.saving') : t('common.save')}
                      </Button>
                    </div>
                  </Drawer.Footer>
                </>
              ) : (
                /* ═══ View mode — V3 structured ═══ */
                <Drawer.Body>

                  {/* 1–2. Badges + Metadata + Tags */}
                  <DrawerMeta
                    badges={(() => {
                      const kc = recipe.kind ? kindConfig[recipe.kind] : null;
                      const category = recipe.category || 'Utility';
                      const catCfg = categoryConfigs[category] || categoryConfigs['All'];
                      const b: BadgeItem[] = [];
                      if (lifecycleConfig) {
                        b.push({ label: t(lifecycleConfig.labelKey), className: `${lifecycleConfig.bg} ${lifecycleConfig.color} ${lifecycleConfig.border}`, icon: lifecycleConfig.icon });
                      }
                      if (kc) b.push({ label: kc.label, className: `${kc.bg} ${kc.color} ${kc.border}`, icon: kc.icon });
                      b.push({ label: category, className: `font-bold uppercase ${catCfg?.bg || 'bg-[var(--bg-subtle)]'} ${catCfg?.color || 'text-[var(--fg-muted)]'} ${catCfg?.border || 'border-[var(--border-default)]'}` });
                      if (recipe.knowledgeType) b.push({ label: knowledgeTypeLabelKeys[recipe.knowledgeType] ? t(knowledgeTypeLabelKeys[recipe.knowledgeType]) : recipe.knowledgeType, className: 'bg-purple-50 text-purple-700 border-purple-200' });
                      if (recipe.language) b.push({ label: recipe.language, className: 'uppercase font-bold text-[var(--fg-secondary)] bg-[var(--bg-subtle)] border-[var(--border-default)]' });
                      if (recipe.trigger) b.push({ label: recipe.trigger, className: 'font-mono font-bold bg-amber-50 text-amber-700 border-amber-200' });
                      return b;
                    })()}
                    metadata={(() => {
                      const m: MetaItem[] = [];
                      if (recipe.scope) m.push({ icon: Globe, iconClass: 'text-teal-400', label: t('knowledge.scope'), value: formatScopeLabel(recipe.scope, t) });
                      if (recipe.complexity) m.push({ icon: Layers, iconClass: 'text-orange-400', label: t('knowledge.complexity'), value: formatComplexityLabel(recipe.complexity, t) });
                      if (recipe.source && recipe.source !== 'unknown') m.push({ icon: Globe, iconClass: 'text-violet-400', label: t('recipes.sourceLabel'), value: formatSourceLabel(recipe.source, t) });
                      if (recipe.createdAt && isValidTimestamp(recipe.createdAt)) m.push({ icon: Clock, iconClass: 'text-[var(--fg-muted)]', label: t('knowledge.createdAt'), value: formatDate(recipe.createdAt, t) });
                      if (recipe.updatedAt && isValidTimestamp(recipe.updatedAt)) m.push({ icon: Clock, iconClass: 'text-[var(--fg-muted)]', label: t('candidates.updatedAt'), value: formatDate(recipe.updatedAt, t) });
                      return m;
                    })()}
                    tags={recipe.tags}
                    id={recipe.id}
                    sourceFile={recipe.sourceFile}
                    sourceFileLabel={t('candidates.path')}
                  />

                  {/* 3. Relations — 上方显眼位置 */}
                  <div className="px-6 py-4 border-b border-[var(--border-default)]">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-1.5">
                        <Link2 size={12} className={cn("text-purple-400", relationBusy && "animate-spin")} />
                        <label className="text-[10px] font-bold text-[var(--fg-muted)] uppercase">{t('recipes.relations')}</label>
                        {(() => {
                          const total = recipe.relations ? Object.values(recipe.relations).flat().length : 0;
                          return total > 0 ? <Badge variant="blue" className="text-[9px]">{total}</Badge> : null;
                        })()}
                      </div>
                      <Button
                        variant={isAddingRelation ? "secondary" : "primary"}
                        size="sm"
                        onClick={() => { setIsAddingRelation(!isAddingRelation); setRelationSearchQuery(''); }}
                      >
                        {isAddingRelation ? <><X size={10} /> {t('common.cancel')}</> : <><Plus size={10} /> {t('recipes.editBtn')}</>}
                      </Button>
                    </div>
                    {isAddingRelation && (
                      <div className="mb-3 bg-[var(--bg-subtle)] border border-[var(--border-default)] rounded-lg p-3 space-y-2">
                        <div className="flex items-center gap-2">
                          <Select
                            value={newRelationType}
                            onChange={v => setNewRelationType(v)}
                            options={RELATION_TYPES.map(t => ({ value: t.key, label: `${t.icon} ${t.label}` }))}
                            size="xs"
                            className="font-bold"
                          />
                          <div className="flex-1 relative">
                            <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--fg-muted)]" />
                            <input type="text" placeholder={t('recipes.searchPlaceholder')} value={relationSearchQuery} onChange={e => setRelationSearchQuery(e.target.value)} className="w-full text-xs bg-[var(--bg-root)] border border-[var(--border-default)] rounded pl-7 pr-2 py-1 outline-none text-[var(--fg-primary)]" autoFocus />
                          </div>
                        </div>
                        {relationSearchQuery.length > 0 && (
                          <div className="max-h-36 overflow-y-auto rounded border border-[var(--border-default)] bg-[var(--bg-root)] divide-y divide-[var(--border-default)]">
                            {(() => {
                              const filtered = recipes.filter(r => {
                                if (getDisplayName(r) === displayName) return false;
                                return getDisplayName(r).toLowerCase().includes(relationSearchQuery.toLowerCase());
                              }).slice(0, 10);
                              if (!filtered.length) return <div className="text-xs text-[var(--fg-muted)] py-3 text-center">{t('recipes.noResults')}</div>;
                              return filtered.map(r => {
                                const rName = getDisplayName(r);
                                const linked = recipe.relations && Object.values(recipe.relations).flat().some((rel: any) => {
                                  const id = typeof rel === 'string' ? rel : rel.target || rel.id || rel.title || '';
                                  return id.replace(/\.md$/i, '').toLowerCase() === rName.toLowerCase();
                                });
                                return (
                                  <div key={rName} className={cn("flex items-center justify-between px-3 py-1.5 text-xs", linked || relationBusy ? "bg-[var(--bg-subtle)] text-[var(--fg-muted)]" : "hover:bg-[var(--bg-subtle)] cursor-pointer")} onClick={() => !linked && !relationBusy && handleAddRelation(newRelationType, rName)}>
                                    <span className="font-medium truncate mr-2">{rName}</span>
                                    {linked ? <span className="text-[9px] text-[var(--fg-muted)] font-bold shrink-0">{t('recipes.relations')}</span> : <span className="text-[9px] text-[var(--accent)] font-bold shrink-0">+ {t('recipes.editBtn')}</span>}
                                  </div>
                                );
                              });
                            })()}
                          </div>
                        )}
                      </div>
                    )}
                    {recipe.relations && Object.entries(recipe.relations).some(([, v]) => Array.isArray(v) && v.length > 0) ? (
                      <div className="space-y-1.5">
                        {RELATION_TYPES.map(({ key, label, icon }) => {
                          const items = recipe.relations?.[key];
                          if (!items || !Array.isArray(items) || items.length === 0) return null;
                          return (
                            <div key={key} className="flex items-start gap-2">
                              <span className="text-[10px] font-mono text-[var(--fg-muted)] shrink-0 whitespace-nowrap pt-0.5">{icon} {label}</span>
                              <div className="flex flex-wrap gap-1">
                                {items.map((r: any, ri: number) => {
                                  const itemName = typeof r === 'string' ? r : r.target || r.id || r.title || JSON.stringify(r);
                                  const found = findRecipeByName(itemName) || (titleLookup.has(itemName) ? findRecipeByName(titleLookup.get(itemName)!) : undefined);
                                  const resolvedTitle = titleLookup.get(itemName);
                                  const isUnresolvedId = !found && !resolvedTitle && /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(itemName);
                                  const displayLabel = found ? getDisplayName(found) : (resolvedTitle || (isUnresolvedId ? `#${itemName.slice(0, 8)}` : itemName));
                                  return (
                                    <span
                                      key={ri}
                                      className={cn(
                                        "group/rel inline-flex items-center gap-1 px-1.5 py-0.5 border rounded text-[10px] font-mono transition-colors",
                                        found ? 'bg-[var(--accent-subtle)] border-[var(--accent-emphasis)] text-[var(--accent)] cursor-pointer hover:brightness-95' : 'bg-[var(--bg-root)] border-[var(--border-default)] text-[var(--fg-secondary)]'
                                      )}
                                      onClick={() => found && openDrawer(found)}
                                      title={found ? t('candidates.viewDetail') : displayLabel}
                                    >
                                      {displayLabel.replace(/\.md$/i, '')}
                                      <button
                                        onClick={e => {
                                          e.stopPropagation();
                                          if (relationBusy) return;
                                          if (window.confirm(`${t('common.delete')}: ${displayLabel.replace(/\.md$/i, '')}?`)) {
                                            handleRemoveRelation(key, itemName);
                                          }
                                        }}
                                        disabled={relationBusy}
                                        className="opacity-0 group-hover/rel:opacity-100 text-[var(--danger)] hover:text-[var(--danger)] transition-opacity ml-1 p-0.5 rounded hover:bg-[var(--danger-subtle)]"
                                        title={t('common.delete')}
                                      >
                                        <X size={10} />
                                      </button>
                                    </span>
                                  );
                                })}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : !isAddingRelation && (
                      <div className="text-xs text-[var(--fg-muted)] py-2 text-center">{t('recipes.noContent')}</div>
                    )}
                  </div>

                  {/* 4. Stats */}
                  <div className="px-6 py-3 border-b border-[var(--border-default)]">
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      <div className="bg-[var(--bg-subtle)] rounded-xl p-3 text-center border border-[var(--border-default)]">
                        <div className="text-lg font-bold text-amber-600">{recipe.stats?.authority ?? '—'}</div>
                        <div className="text-[10px] text-[var(--fg-muted)] font-medium">{t('recipes.qualityAuthorityScore')}</div>
                      </div>
                      <div className="bg-[var(--bg-subtle)] rounded-xl p-3 text-center border border-[var(--border-default)]">
                        <div className="text-lg font-bold text-[var(--accent)]">{recipe.stats?.authorityScore != null ? recipe.stats.authorityScore.toFixed(1) : '—'}</div>
                        <div className="text-[10px] text-[var(--fg-muted)] font-medium">{t('recipes.qualityGreat')}</div>
                      </div>
                      <div className="bg-[var(--bg-subtle)] rounded-xl p-3 text-center border border-[var(--border-default)]">
                        <div className="text-lg font-bold text-[var(--fg-primary)]">{recipe.stats ? (recipe.stats.guardUsageCount + recipe.stats.humanUsageCount + recipe.stats.aiUsageCount) : 0}</div>
                        <div className="text-[10px] text-[var(--fg-muted)] font-medium">{t('recipes.qualitySolid')}</div>
                      </div>
                      <div className="bg-[var(--bg-subtle)] rounded-xl p-3 text-center border border-[var(--border-default)]">
                        <div className="text-sm font-bold text-[var(--fg-secondary)]">{formatDate(recipe.stats?.lastUsedAt, t) || t('recipes.noContent')}</div>
                        <div className="text-[10px] text-[var(--fg-muted)] font-medium">{t('recipes.qualityGood')}</div>
                      </div>
                    </div>
                    {recipe.stats != null && (recipe.stats.guardUsageCount > 0 || recipe.stats.humanUsageCount > 0 || recipe.stats.aiUsageCount > 0) && (
                      <div className="flex items-center gap-4 mt-2 text-[10px] text-[var(--fg-muted)]">
                        <span>Guard: {recipe.stats.guardUsageCount}</span>
                        <span>Human: {recipe.stats.humanUsageCount}</span>
                        <span>AI: {recipe.stats.aiUsageCount}</span>
                      </div>
                    )}
                  </div>

                  {/* 4. Reasoning — V3 推理信息 */}
                  <DrawerContent.Reasoning
                    reasoning={recipe.reasoning}
                    labels={{ section: t('recipes.reasoning'), source: t('recipes.sourceColon'), confidence: t('recipes.confidenceColon'), alternatives: t('recipes.alternativesLabel') }}
                  />

                  {/* 5. Quality — V3 质量评级 */}
                  <DrawerContent.Quality
                    quality={recipe.quality}
                    labels={{ section: t('recipes.qualityGrade'), completeness: t('recipes.qualityCompleteness'), adaptation: t('recipes.qualityAdaptation'), documentation: t('recipes.qualityDocumentation') }}
                  />

                  {/* 6. Description / Summary */}
                  <DrawerContent.Description label={t('recipes.description')} text={recipe.description} />

                  {/* 7. Markdown 文档 */}
                  <DrawerContent.MarkdownSection label={t('recipes.markdown')} content={contentV3?.markdown} />

                  {/* 6. Headers */}
                  <DrawerContent.Headers label={t('recipes.headers')} headers={recipe.headers} />

                  {/* 7. Code / 标准用法 */}
                  <DrawerContent.CodePattern label={t('recipes.code')} code={codePattern} language={codeLang} />

                  {/* 8. Delivery */}
                  <DrawerContent.Delivery
                    delivery={{
                      topicHint: recipe.topicHint,
                      whenClause: recipe.whenClause,
                      doClause: recipe.doClause,
                      dontClause: recipe.dontClause,
                      coreCode: recipe.coreCode,
                    }}
                    language={recipe.language}
                  />

                  {/* 9. Rationale */}
                  <DrawerContent.Rationale label={t('recipes.designRationale')} text={contentV3?.rationale} />

                  {/* 10. Steps */}
                  <DrawerContent.Steps label={t('recipes.steps')} steps={contentV3?.steps} />

                  {/* 11. Code Changes */}
                  {contentV3?.codeChanges && contentV3.codeChanges.length > 0 && (
                    <div className="px-6 py-4 border-b border-[var(--border-default)]">
                      <label className="text-[10px] font-bold text-[var(--fg-muted)] uppercase mb-2 block">{t('recipes.codeChanges')}</label>
                      <div className="space-y-2">
                        {contentV3.codeChanges.map((change, i) => (
                          <div key={i} className="border border-[var(--border-default)] rounded-lg overflow-hidden">
                            <div className="px-3 py-1.5 bg-[var(--bg-subtle)] border-b border-[var(--border-default)] flex items-center gap-2">
                              <FileCode size={11} className="text-[var(--accent)]" />
                              <code className="text-[10px] font-mono text-[var(--fg-secondary)]">{change.file}</code>
                            </div>
                            {change.explanation && <p className="text-[11px] text-[var(--fg-muted)] px-3 py-1.5 border-b border-[var(--border-default)] bg-[var(--bg-subtle)]">{change.explanation}</p>}
                            <div className="p-2 bg-red-50/10 border-b border-[var(--border-default)]">
                              <div className="text-[9px] font-bold text-[var(--status-error)] mb-0.5 uppercase">Before</div>
                              <pre className="text-[11px] text-[var(--fg-secondary)] whitespace-pre-wrap break-words font-mono">{change.before || t('recipes.emptyValue')}</pre>
                            </div>
                            <div className="p-2 bg-emerald-50/10">
                              <div className="text-[9px] font-bold text-[var(--status-success)] mb-0.5 uppercase">After</div>
                              <pre className="text-[11px] text-[var(--fg-primary)] whitespace-pre-wrap break-words font-mono">{change.after}</pre>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* 12. Verification */}
                  {contentV3?.verification && (
                    <div className="px-6 py-4 border-b border-[var(--border-default)]">
                      <label className="text-[10px] font-bold text-[var(--fg-muted)] uppercase mb-2 block">{t('recipes.validation')}</label>
                      <div className="bg-[var(--bg-subtle)] border border-[var(--border-default)] rounded-xl p-4 space-y-1.5">
                        {contentV3.verification.method && <p className="text-xs text-[var(--fg-secondary)]"><span className="font-bold text-[var(--status-success)]">{t('recipes.verificationMethod')}</span> {contentV3.verification.method}</p>}
                        {contentV3.verification.expectedResult && <p className="text-xs text-[var(--fg-secondary)]"><span className="font-bold text-[var(--status-success)]">{t('recipes.verificationExpected')}</span> {contentV3.verification.expectedResult}</p>}
                        {contentV3.verification.testCode && <pre className="text-[11px] font-mono bg-slate-800 text-green-300 p-2.5 rounded-md overflow-x-auto whitespace-pre-wrap mt-1">{contentV3.verification.testCode}</pre>}
                      </div>
                    </div>
                  )}

                  {/* 13. Constraints */}
                  <DrawerContent.Constraints label={t('recipes.constraints')} constraints={recipe.constraints} />

                  {/* 14. AI 洞察 */}
                  {recipe.aiInsight && (
                    <div className="px-6 py-4 border-b border-[var(--border-default)]">
                      <label className="text-[10px] font-bold text-[var(--fg-muted)] uppercase mb-2 block flex items-center gap-1.5">
                        <Lightbulb size={11} className="text-cyan-400" /> {t('knowledge.aiInsight')}
                      </label>
                      <p className="text-sm text-[var(--fg-secondary)] leading-relaxed">{recipe.aiInsight}</p>
                    </div>
                  )}

                  {/* 15. 生命周期历史 */}
                  {lifecycleHistory.length > 0 && (
                    <div className="px-6 py-4 border-b border-[var(--border-default)]">
                      <label className="text-[10px] font-bold text-[var(--fg-muted)] uppercase mb-2 block flex items-center gap-1.5">
                        <Clock size={11} className="text-[var(--fg-muted)]" /> {t('knowledge.lifecycleHistoryLabel')}
                      </label>
                      <div className="space-y-1">
                        {lifecycleHistory.map((history, index) => {
                          const fromCfg = lifecycleBadgeConfig[history.from] ?? lifecycleBadgeConfig.pending;
                          const toCfg = lifecycleBadgeConfig[history.to] ?? lifecycleBadgeConfig.pending;
                          return (
                            <div key={`${history.from}-${history.to}-${history.at}-${index}`} className="flex items-center gap-2 text-[10px]">
                              <span className="text-[var(--fg-muted)] w-20 shrink-0">{formatDate(history.at, t)}</span>
                              <span className={fromCfg.color}>{t(fromCfg.labelKey)}</span>
                              <span className="text-[var(--fg-muted)]">→</span>
                              <span className={`${toCfg.color} font-medium`}>{t(toCfg.labelKey)}</span>
                              {history.by && <span className="text-[var(--fg-muted)] ml-auto">by {history.by}</span>}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* end of view sections */}

                </Drawer.Body>
              )}
          </Drawer.Panel>
          </PageOverlay>
        );
      })()}
    </div>
  );
};

export default RecipesView;
