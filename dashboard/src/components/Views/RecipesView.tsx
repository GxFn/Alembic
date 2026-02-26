import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Edit3, Trash2, BookOpen, Shield, Lightbulb, FileText, FileCode, X, BookOpenCheck, Eye, Save, Link2, Plus, Search, ArrowUp, ArrowDown, Code2, Layers, Globe, MoreHorizontal, Clock } from 'lucide-react';
import { useDrawerWide } from '../../hooks/useDrawerWide';
import { Recipe } from '../../types';
import { categoryConfigs } from '../../constants';
import Pagination from '../Shared/Pagination';
import HighlightedCodeEditor from '../Shared/HighlightedCodeEditor';
import api from '../../api';
import DrawerMeta from '../Shared/DrawerMeta';
import type { BadgeItem, MetaItem } from '../Shared/DrawerMeta';
import DrawerContent from '../Shared/DrawerContent';
import { notify } from '../../utils/notification';
import { ICON_SIZES } from '../../constants/icons';
import { useI18n } from '../../i18n';
import { cn } from '../../lib/utils';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Drawer } from '../Layout/Drawer';
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
  const raw = recipe.name || (recipe as any).title || 'Untitled';
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

function isValidTimestamp(ts: string | number | null | undefined): boolean {
  if (ts == null) return false;
  const ms = typeof ts === 'string' ? new Date(ts).getTime() : ts;
  return !isNaN(ms) && ms > 946684800000;
}

function formatDate(ts: string | number | null | undefined): string {
  if (!isValidTimestamp(ts)) return '';
  const d = typeof ts === 'string' ? new Date(ts) : new Date(ts as number);
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
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
  type SortKey = 'default' | 'name' | 'authorityScore' | 'authority' | 'totalUsage' | 'lastUsed' | 'category';
  type SortDir = 'asc' | 'desc';
  const [sortKey, setSortKey] = useState<SortKey>('default');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const sortOptions: { key: SortKey; label: string; defaultDir: SortDir }[] = [
    { key: 'default',        label: t('recipes.sortNewest'),   defaultDir: 'desc' },
    { key: 'authorityScore', label: t('recipes.qualityAuthorityScore'), defaultDir: 'desc' },
    { key: 'authority',      label: t('recipes.qualityExcellent'), defaultDir: 'desc' },
    { key: 'totalUsage',     label: t('recipes.qualityBasic'),   defaultDir: 'desc' },
    { key: 'lastUsed',       label: t('recipes.sortQuality'),   defaultDir: 'desc' },
    { key: 'name',           label: t('recipes.sortAlpha'),   defaultDir: 'asc' },
    { key: 'category',       label: t('recipes.knowledgeType'),   defaultDir: 'asc' },
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

  useEffect(() => { return () => { isMountedRef.current = false; }; }, []);

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
      } as any);
      if (isMountedRef.current) { setDrawerMode('view'); onRefresh?.(); }
    } catch (err: any) {
      notify(err?.message || t('common.saveFailed'), { title: t('common.operationFailed'), type: 'error' });
    } finally {
      if (isMountedRef.current) setIsSaving(false);
    }
  };

  const handleSetAuthority = async (authority: number) => {
    if (!selectedRecipe) return;
    try {
      await api.setRecipeAuthority(selectedRecipe.id || selectedRecipe.name, authority);
      onRefresh?.();
    } catch (err: any) {
      notify(err?.message || t('common.operationFailed'), { title: t('common.operationFailed'), type: 'error' });
    }
  };

  const findRecipeByName = (name: string): Recipe | undefined => {
    const normalized = name.replace(/\.md$/i, '').toLowerCase();
    return recipes.find(r => getDisplayName(r).toLowerCase() === normalized);
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
    } catch (err: any) {
      // 回滚
      setSelectedRecipe(previousRecipe);
      notify(err?.message || t('common.operationFailed'), { title: t('common.operationFailed'), type: 'error' });
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
    } catch (err: any) {
      // 回滚
      setSelectedRecipe(previousRecipe);
      notify(err?.message || t('common.operationFailed'), { title: t('common.operationFailed'), type: 'error' });
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
    if (sortKey === 'default') return recipes;
    const arr = [...recipes];
    const dir = sortDir === 'asc' ? 1 : -1;
    arr.sort((a, b) => {
      let va: number | string = 0, vb: number | string = 0;
      switch (sortKey) {
        case 'name':
          va = getDisplayName(a).toLowerCase(); vb = getDisplayName(b).toLowerCase();
          return dir * (va < vb ? -1 : va > vb ? 1 : 0);
        case 'authorityScore':
          va = a.stats?.authorityScore ?? -1; vb = b.stats?.authorityScore ?? -1; break;
        case 'authority':
          va = a.stats?.authority ?? -1; vb = b.stats?.authority ?? -1; break;
        case 'totalUsage':
          va = (a.stats?.guardUsageCount ?? 0) + (a.stats?.humanUsageCount ?? 0) + (a.stats?.aiUsageCount ?? 0);
          vb = (b.stats?.guardUsageCount ?? 0) + (b.stats?.humanUsageCount ?? 0) + (b.stats?.aiUsageCount ?? 0);
          break;
        case 'lastUsed': {
          const ta = a.stats?.lastUsedAt ? new Date(a.stats.lastUsedAt).getTime() : 0;
          const tb = b.stats?.lastUsedAt ? new Date(b.stats.lastUsedAt).getTime() : 0;
          va = isNaN(ta) ? 0 : ta; vb = isNaN(tb) ? 0 : tb; break;
        }
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
          <BookOpenCheck size={48} className="text-[var(--fg-muted)] mb-4 opacity-40" />
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
                  {active && sortKey !== 'default' && (sortDir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
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
                          <DropdownMenuItem className="text-[var(--status-error)]" onClick={e => { e.stopPropagation(); handleDeleteRecipe(recipe.name || (recipe as any).id); }}>
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

        return (
          <Drawer open={!!selectedRecipe} onClose={closeDrawer} size={drawerWide ? 'lg' : 'md'}>
              {/* ── Header ── */}
              <Drawer.Header title={displayName}>
                <Drawer.Nav currentIndex={currentIndex} total={sortedRecipes.length} onPrev={goToPrev} onNext={goToNext} />
                <Drawer.HeaderActions>
                  <div className="flex bg-[var(--bg-subtle)] p-0.5 rounded-lg mr-1">
                    <button onClick={() => setDrawerMode('view')} className={cn("px-2.5 py-1 rounded-md text-xs font-bold transition-all flex items-center gap-1", drawerMode === 'view' ? 'bg-[var(--bg-surface)] shadow-sm text-[var(--accent)]' : 'text-[var(--fg-muted)] hover:text-[var(--fg-secondary)]')}><Eye size={ICON_SIZES.sm} /> {t('common.preview')}</button>
                    <button onClick={() => { setDrawerMode('edit'); }} className={cn("px-2.5 py-1 rounded-md text-xs font-bold transition-all flex items-center gap-1", drawerMode === 'edit' ? 'bg-[var(--bg-surface)] shadow-sm text-[var(--accent)]' : 'text-[var(--fg-muted)] hover:text-[var(--fg-secondary)]')}><Edit3 size={ICON_SIZES.sm} /> {t('common.edit')}</button>
                  </div>
                  <Drawer.WidthToggle isWide={drawerWide} onToggle={toggleDrawerWide} />
                  <Button variant="danger" size="icon-sm" onClick={() => { handleDeleteRecipe(recipe.name || (recipe as any).id); closeDrawer(); }}><Trash2 size={16} /></Button>
                  <Drawer.CloseButton onClose={closeDrawer} />
                </Drawer.HeaderActions>
              </Drawer.Header>

              {drawerMode === 'edit' ? (
                <>
                  <Drawer.Body padded>
                    {/* 标题 */}
                    <div>
                      <label className="text-[10px] font-bold text-[var(--fg-muted)] uppercase mb-1.5 block">{t('recipes.recipeDetail')}</label>
                      <input
                        type="text"
                        value={editForm.title}
                        onChange={e => setEditForm(f => ({ ...f, title: e.target.value }))}
                        className="w-full px-3 py-2 text-sm border border-[var(--border-default)] rounded-lg bg-[var(--bg-root)] text-[var(--fg-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-emphasis)] focus:border-[var(--accent-emphasis)]"
                      />
                    </div>

                    {/* 描述 */}
                    <div>
                      <label className="text-[10px] font-bold text-[var(--fg-muted)] uppercase mb-1.5 block">{t('recipes.description')}</label>
                      <textarea
                        value={editForm.description}
                        onChange={e => setEditForm(f => ({ ...f, description: e.target.value }))}
                        rows={2}
                        className="w-full px-3 py-2 text-sm border border-[var(--border-default)] rounded-lg bg-[var(--bg-root)] text-[var(--fg-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-emphasis)] resize-none"
                      />
                    </div>

                    {/* 标签 */}
                    <div>
                      <label className="text-[10px] font-bold text-[var(--fg-muted)] uppercase mb-1.5 block">{t('recipes.tags')}</label>
                      <div className="flex flex-wrap gap-1.5 mb-2">
                        {editForm.tags.map((tag, i) => (
                          <span key={i} className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded bg-[var(--accent-subtle)] text-[var(--accent)] border border-[var(--border-default)] font-medium">
                            {tag}
                            <button onClick={() => setEditForm(f => ({ ...f, tags: f.tags.filter((_, idx) => idx !== i) }))} className="text-[var(--fg-muted)] hover:text-[var(--status-error)]"><X size={10} /></button>
                          </span>
                        ))}
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
                          className="flex-1 px-3 py-1.5 text-xs border border-[var(--border-default)] rounded-lg bg-[var(--bg-root)] text-[var(--fg-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-emphasis)]"
                        />
                      </div>
                    </div>

                    {/* Markdown 文档 */}
                    <div>
                      <label className="text-[10px] font-bold text-[var(--fg-muted)] uppercase mb-1.5 block flex items-center gap-1.5">
                        <FileText size={11} className="text-[var(--accent)]" /> {t('recipes.markdown')}
                      </label>
                      <textarea
                        value={editForm.markdown}
                        onChange={e => setEditForm(f => ({ ...f, markdown: e.target.value }))}
                        rows={4}
                        className="w-full px-3 py-2 text-sm border border-[var(--border-default)] rounded-lg bg-[var(--bg-root)] text-[var(--fg-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-emphasis)] resize-y font-mono"
                        placeholder={t('recipes.markdown')}
                      />
                    </div>

                    {/* 代码 / 标准用法 */}
                    <div>
                      <label className="text-[10px] font-bold text-[var(--fg-muted)] uppercase mb-1.5 block flex items-center gap-1.5">
                        <Code2 size={11} className="text-[var(--status-success)]" /> {t('recipes.code')}
                      </label>
                      <div className="border border-[var(--border-default)] rounded-lg overflow-hidden" style={{ minHeight: 200 }}>
                        <HighlightedCodeEditor
                          value={editForm.codePattern}
                          onChange={v => setEditForm(f => ({ ...f, codePattern: v }))}
                          language={codeLang}
                          height="200px"
                          showLineNumbers
                        />
                      </div>
                    </div>

                    {/* 设计原理 */}
                    <div>
                      <label className="text-[10px] font-bold text-[var(--fg-muted)] uppercase mb-1.5 block">{t('recipes.designRationale')}</label>
                      <textarea
                        value={editForm.rationale}
                        onChange={e => setEditForm(f => ({ ...f, rationale: e.target.value }))}
                        rows={3}
                        className="w-full px-3 py-2 text-sm border border-[var(--border-default)] rounded-lg bg-[var(--bg-root)] text-[var(--fg-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-emphasis)] resize-y"
                        placeholder={t('recipes.designRationale')}
                      />
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
                      if (kc) b.push({ label: kc.label, className: `${kc.bg} ${kc.color} ${kc.border}`, icon: kc.icon });
                      b.push({ label: category, className: `font-bold uppercase ${catCfg?.bg || 'bg-[var(--bg-subtle)]'} ${catCfg?.color || 'text-[var(--fg-muted)]'} ${catCfg?.border || 'border-[var(--border-default)]'}` });
                      if (recipe.knowledgeType) b.push({ label: knowledgeTypeLabelKeys[recipe.knowledgeType] ? t(knowledgeTypeLabelKeys[recipe.knowledgeType]) : recipe.knowledgeType, className: 'bg-purple-50 text-purple-700 border-purple-200' });
                      if (recipe.language) b.push({ label: recipe.language, className: 'uppercase font-bold text-[var(--fg-secondary)] bg-[var(--bg-subtle)] border-[var(--border-default)]' });
                      if (recipe.trigger) b.push({ label: recipe.trigger, className: 'font-mono font-bold bg-amber-50 text-amber-700 border-amber-200' });
                      if (recipe.source && recipe.source !== 'unknown') b.push({ label: recipe.source, className: 'bg-[var(--bg-subtle)] text-[var(--fg-secondary)] border-[var(--border-default)]' });
                      return b;
                    })()}
                    metadata={(() => {
                      const m: MetaItem[] = [];
                      if (recipe.scope) m.push({ icon: Globe, iconClass: 'text-teal-400', label: t('candidates.path'), value: recipe.scope === 'universal' ? t('common.all') : recipe.scope === 'project-specific' ? t('candidates.category') : recipe.scope });
                      if (recipe.complexity) m.push({ icon: Layers, iconClass: 'text-orange-400', label: t('candidates.category'), value: recipe.complexity === 'advanced' ? t('candidates.confidenceHigh') : recipe.complexity === 'intermediate' ? t('candidates.confidenceMedium') : recipe.complexity === 'basic' ? t('candidates.confidenceLow') : recipe.complexity });
                      if (recipe.source && recipe.source !== 'unknown') m.push({ icon: Globe, iconClass: 'text-violet-400', label: t('recipes.sourceLabel'), value: recipe.source === 'bootstrap-scan' ? t('recipes.sourceBootstrap') : recipe.source === 'agent' ? t('recipes.sourceAiScan') : recipe.source });
                      if (recipe.updatedAt && isValidTimestamp(recipe.updatedAt)) m.push({ icon: Clock, iconClass: 'text-[var(--fg-muted)]', label: t('candidates.updatedAt'), value: formatDate(recipe.updatedAt) });
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
                                  const displayLabel = found ? getDisplayName(found) : (titleLookup.get(itemName) || itemName);
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
                        <div className="text-sm font-bold text-[var(--fg-secondary)]">{formatDate(recipe.stats?.lastUsedAt) || t('recipes.noContent')}</div>
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

                  {/* 8. Rationale */}
                  <DrawerContent.Rationale label={t('recipes.designRationale')} text={contentV3?.rationale} />

                  {/* 9. Steps */}
                  <DrawerContent.Steps label={t('recipes.steps')} steps={contentV3?.steps} />

                  {/* 10. Code Changes */}
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

                  {/* 11. Verification */}
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

                  {/* 12. Constraints */}
                  <DrawerContent.Constraints label={t('recipes.constraints')} constraints={recipe.constraints} />

                  {/* end of view sections */}

                </Drawer.Body>
              )}
          </Drawer>
        );
      })()}
    </div>
  );
};

export default RecipesView;
