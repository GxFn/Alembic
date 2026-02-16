import React, { useState, useEffect, useRef } from 'react';
import { Edit3, Trash2, Tag, BookOpen, Shield, Lightbulb, FileText, FileCode, X, BookOpenCheck, ChevronLeft, ChevronRight, Eye, Save, Loader2, Link2, Plus, Search, ArrowUpDown, ArrowUp, ArrowDown, Maximize2, Minimize2, Code2, Hash, Layers, Globe, FolderOpen } from 'lucide-react';
import { useDrawerWide } from '../../hooks/useDrawerWide';
import { Recipe } from '../../types';
import { categoryConfigs } from '../../constants';
import Pagination from '../Shared/Pagination';
import MarkdownWithHighlight from '../Shared/MarkdownWithHighlight';
import HighlightedCodeEditor from '../Shared/HighlightedCodeEditor';
import CodeBlock from '../Shared/CodeBlock';
import api from '../../api';
import { notify } from '../../utils/notification';
import { ICON_SIZES } from '../../constants/icons';
import PageOverlay from '../Shared/PageOverlay';

/* ── Config ── */
const kindConfig: Record<string, { label: string; color: string; bg: string; border: string; icon: React.ElementType }> = {
  rule:    { label: 'Rule',    color: 'text-red-700',    bg: 'bg-red-50',    border: 'border-red-200',    icon: Shield },
  pattern: { label: 'Pattern', color: 'text-violet-700', bg: 'bg-violet-50', border: 'border-violet-200', icon: Lightbulb },
  fact:    { label: 'Fact',    color: 'text-cyan-700',   bg: 'bg-cyan-50',   border: 'border-cyan-200',   icon: BookOpen },
};

const knowledgeTypeLabels: Record<string, string> = {
  'code-pattern': '代码模式',
  'architecture': '架构设计',
  'best-practice': '最佳实践',
  'code-standard': '代码规范',
  'call-chain': '调用链路',
  'rule': '规则',
};

/* ── Types ── */
interface RecipesViewProps {
  recipes: Recipe[];
  openRecipeEdit: (recipe: Recipe) => void;
  handleDeleteRecipe: (name: string) => void;
  onRefresh?: () => void;
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

function getContentStr(recipe: Recipe): string {
  if (typeof recipe.content === 'string') return recipe.content;
  const obj = recipe.content as Record<string, string> | null;
  return obj?.pattern || obj?.markdown || JSON.stringify(recipe.content, null, 2);
}

function getCodePattern(recipe: Recipe): string {
  return recipe.v2Content?.pattern || '';
}

function getCodeLang(recipe: Recipe): string {
  const l = (recipe.language || '').toLowerCase();
  if (['objectivec', 'objc', 'objective-c', 'obj-c'].includes(l)) return 'objectivec';
  return recipe.language || 'swift';
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
  currentPage: controlledPage,
  onPageChange: controlledOnPageChange,
  pageSize: controlledPageSize,
  onPageSizeChange: controlledOnPageSizeChange,
}) => {
  type SortKey = 'default' | 'name' | 'authorityScore' | 'authority' | 'totalUsage' | 'lastUsed' | 'category';
  type SortDir = 'asc' | 'desc';
  const [sortKey, setSortKey] = useState<SortKey>('default');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const sortOptions: { key: SortKey; label: string; defaultDir: SortDir }[] = [
    { key: 'default',        label: '默认',   defaultDir: 'desc' },
    { key: 'authorityScore', label: '综合分', defaultDir: 'desc' },
    { key: 'authority',      label: '权威分', defaultDir: 'desc' },
    { key: 'totalUsage',     label: '使用',   defaultDir: 'desc' },
    { key: 'lastUsed',       label: '最近',   defaultDir: 'desc' },
    { key: 'name',           label: '名称',   defaultDir: 'asc' },
    { key: 'category',       label: '分类',   defaultDir: 'asc' },
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
  const [editContent, setEditContent] = useState('');
  const [editForm, setEditForm] = useState<{
    title: string;
    description: string;
    summaryCn: string;
    usageGuideCn: string;
    codePattern: string;
    rationale: string;
    tags: string[];
    tagInput: string;
  }>({ title: '', description: '', summaryCn: '', usageGuideCn: '', codePattern: '', rationale: '', tags: [], tagInput: '' });
  const [isSaving, setIsSaving] = useState(false);
  const isMountedRef = useRef(true);

  const [isAddingRelation, setIsAddingRelation] = useState(false);
  const [newRelationType, setNewRelationType] = useState('related');
  const [relationSearchQuery, setRelationSearchQuery] = useState('');

  useEffect(() => { return () => { isMountedRef.current = false; }; }, []);

  const RELATION_TYPES = [
    { key: 'related',    label: '关联', icon: '∼' },
    { key: 'dependsOn',  label: '依赖', icon: '⊕' },
    { key: 'inherits',   label: '继承', icon: '↑' },
    { key: 'implements', label: '实现', icon: '◇' },
    { key: 'calls',      label: '调用', icon: '→' },
    { key: 'dataFlow',   label: '数据流', icon: '⇢' },
    { key: 'conflicts',  label: '冲突', icon: '✕' },
    { key: 'extends',    label: '扩展', icon: '⊃' },
  ];

  const openDrawer = (recipe: Recipe) => {
    setSelectedRecipe(recipe);
    setDrawerMode('view');
    setEditContent(getContentStr(recipe));
    setEditForm({
      title: recipe.name?.replace(/\.md$/, '') || '',
      description: recipe.description || '',
      summaryCn: recipe.usageGuide_cn || recipe.usageGuide || '',
      usageGuideCn: recipe.usageGuide_cn || recipe.usageGuide || '',
      codePattern: recipe.v2Content?.pattern || '',
      rationale: recipe.v2Content?.rationale || '',
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
        summary_cn: editForm.summaryCn,
        usage_guide_cn: editForm.usageGuideCn,
        tags: editForm.tags,
        content: {
          ...(selectedRecipe.v2Content || {}),
          pattern: editForm.codePattern,
          rationale: editForm.rationale,
        },
      } as any);
      if (isMountedRef.current) { setDrawerMode('view'); onRefresh?.(); }
    } catch (err: any) {
      notify(err?.message || '保存失败', { title: '操作失败', type: 'error' });
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
      notify(err?.message || '设置权威分失败', { title: '操作失败', type: 'error' });
    }
  };

  const findRecipeByName = (name: string): Recipe | undefined => {
    const normalized = name.replace(/\.md$/i, '').toLowerCase();
    return recipes.find(r => getDisplayName(r).toLowerCase() === normalized);
  };

  const handleAddRelation = async (type: string, targetName: string) => {
    if (!selectedRecipe) return;
    const currentRelations: Record<string, any[]> = {};
    if (selectedRecipe.relations) {
      for (const [k, v] of Object.entries(selectedRecipe.relations)) currentRelations[k] = [...v];
    }
    const existing = currentRelations[type] || [];
    const targetId = targetName.replace(/\.md$/i, '');
    if (existing.some((r: any) => {
      const id = typeof r === 'string' ? r : r.id || r.title || '';
      return id.replace(/\.md$/i, '').toLowerCase() === targetId.toLowerCase();
    })) return;
    currentRelations[type] = [...existing, targetId];
    try {
      await api.updateRecipeRelations(selectedRecipe.id || selectedRecipe.name, currentRelations);
      setSelectedRecipe({ ...selectedRecipe, relations: currentRelations });
      setIsAddingRelation(false); setRelationSearchQuery('');
      onRefresh?.();
    } catch (err: any) {
      notify(err?.message || '添加关联失败', { title: '操作失败', type: 'error' });
    }
  };

  const handleRemoveRelation = async (type: string, targetName: string) => {
    if (!selectedRecipe) return;
    const currentRelations: Record<string, any[]> = {};
    if (selectedRecipe.relations) {
      for (const [k, v] of Object.entries(selectedRecipe.relations)) currentRelations[k] = [...v];
    }
    const existing = currentRelations[type] || [];
    currentRelations[type] = existing.filter((r: any) => {
      const id = typeof r === 'string' ? r : r.id || r.title || '';
      return id.replace(/\.md$/i, '').toLowerCase() !== targetName.replace(/\.md$/i, '').toLowerCase();
    });
    if (currentRelations[type].length === 0) delete currentRelations[type];
    try {
      await api.updateRecipeRelations(selectedRecipe.id || selectedRecipe.name, currentRelations);
      setSelectedRecipe({ ...selectedRecipe, relations: currentRelations });
      onRefresh?.();
    } catch (err: any) {
      notify(err?.message || '移除关联失败', { title: '操作失败', type: 'error' });
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
  const BadgeRow: React.FC<{ recipe: Recipe; compact?: boolean }> = ({ recipe, compact }) => {
    const kc = recipe.kind ? kindConfig[recipe.kind] : null;
    const KindIcon = kc?.icon || FileText;
    const category = recipe.category || 'Utility';
    const catCfg = categoryConfigs[category] || categoryConfigs.Utility;
    const CatIcon = catCfg.icon;
    const kt = recipe.knowledgeType;
    const sz = compact ? 'text-[8px]' : 'text-[9px]';
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        {kc && (
          <span className={`${sz} font-bold px-1.5 py-0.5 rounded uppercase flex items-center gap-1 border ${kc.bg} ${kc.color} ${kc.border}`}>
            <KindIcon size={compact ? 9 : 10} />{kc.label}
          </span>
        )}
        <span className={`${sz} font-bold px-1.5 py-0.5 rounded uppercase flex items-center gap-1 border ${catCfg.bg} ${catCfg.color} ${catCfg.border}`}>
          <CatIcon size={compact ? 9 : 10} />{category}
        </span>
        {kt && (
          <span className={`${sz} font-medium px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-600 border border-indigo-100`}>{knowledgeTypeLabels[kt] || kt}</span>
        )}
        {recipe.language && (
          <span className={`${sz} font-medium px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 uppercase`}>{recipe.language}</span>
        )}
        {recipe.trigger && (
          <span className={`${sz} font-mono font-bold px-1.5 py-0.5 rounded bg-blue-50 text-blue-600 border border-blue-100`}>{recipe.trigger}</span>
        )}
      </div>
    );
  };

  /* ── Metadata row: only non-empty fields ── */
  const MetadataRow: React.FC<{ recipe: Recipe }> = ({ recipe }) => {
    const items: { icon: React.ElementType; iconClass: string; label: string; value: string; mono?: boolean }[] = [];
    if (recipe.scope) items.push({ icon: Globe, iconClass: 'text-teal-400', label: '作用域', value: recipe.scope === 'universal' ? '通用' : recipe.scope === 'project-specific' ? '项目级' : recipe.scope });
    if (recipe.complexity) items.push({ icon: Layers, iconClass: 'text-orange-400', label: '复杂度', value: recipe.complexity === 'advanced' ? '高级' : recipe.complexity === 'intermediate' ? '中级' : recipe.complexity === 'basic' ? '初级' : recipe.complexity });
    if (recipe.difficulty && recipe.difficulty !== recipe.complexity) items.push({ icon: Layers, iconClass: 'text-amber-400', label: '难度', value: recipe.difficulty });
    if (recipe.module_name) items.push({ icon: Layers, iconClass: 'text-purple-400', label: '模块', value: recipe.module_name, mono: true });
    if (recipe.source && recipe.source !== 'unknown') items.push({ icon: Globe, iconClass: 'text-violet-400', label: '来源', value: recipe.source === 'bootstrap-scan' ? 'AI 扫描' : recipe.source === 'agent' ? 'AI Agent' : recipe.source });
    if (recipe.version) items.push({ icon: Hash, iconClass: 'text-slate-400', label: '版本', value: recipe.version });
    if (recipe.updatedAt && isValidTimestamp(recipe.updatedAt)) items.push({ icon: Hash, iconClass: 'text-slate-400', label: '更新', value: formatDate(recipe.updatedAt) });
    if (items.length === 0 && !recipe.source_file) return null;
    return (
      <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs">
        {items.map((item, i) => {
          const Icon = item.icon;
          return (
            <div key={i} className="flex items-center gap-1.5">
              <Icon size={11} className={`${item.iconClass} shrink-0`} />
              <span className="text-slate-400">{item.label}</span>
              <span className={`font-medium text-slate-600 ${item.mono ? 'font-mono text-[11px]' : ''}`}>{item.value}</span>
            </div>
          );
        })}
        {recipe.source_file && (
          <div className="flex items-center gap-1.5 basis-full mt-0.5">
            <FolderOpen size={11} className="text-slate-300 shrink-0" />
            <span className="text-slate-400">源文件</span>
            <code className="font-mono text-[11px] text-slate-500 break-all" title={recipe.source_file}>{recipe.source_file}</code>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="relative">
      {recipes.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <BookOpenCheck size={48} className="text-slate-200 mb-4" />
          <p className="font-medium text-slate-600 mb-1">暂无 Recipe</p>
          <p className="text-sm text-slate-400">通过 SPM 扫描或手动创建来添加知识条目</p>
        </div>
      ) : (
        <>
          {/* ── Sort bar ── */}
          <div className="flex items-center gap-2 mb-4 text-xs">
            <ArrowUpDown size={14} className="text-slate-400 shrink-0" />
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
                  className={`px-2 py-1 rounded-md flex items-center gap-0.5 transition-colors ${
                    active ? 'bg-blue-50 text-blue-700 font-medium border border-blue-200' : 'text-slate-500 hover:bg-slate-100 border border-transparent'
                  }`}
                >
                  {opt.label}
                  {active && sortKey !== 'default' && (sortDir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
                </button>
              );
            })}
            <span className="ml-auto text-slate-400">{recipes.length} 条</span>
          </div>

          {/* ══════════ Card grid ══════════ */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {paginatedRecipes.map(recipe => {
              const displayName = getDisplayName(recipe);
              const codePattern = getCodePattern(recipe);
              const summary = recipe.usageGuide_cn || recipe.usageGuide || recipe.description || '';
              const isSelected = selectedRecipe && getDisplayName(selectedRecipe) === displayName;
              return (
                <div
                  key={recipe.id || displayName}
                  onClick={() => openDrawer(recipe)}
                  className={`bg-white rounded-xl border shadow-sm hover:shadow-md transition-all group relative cursor-pointer overflow-hidden ${
                    isSelected ? 'border-blue-300 ring-1 ring-blue-200' : 'border-slate-200'
                  }`}
                >
                  <div className="absolute top-3 right-3 flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity z-10">
                    <button onClick={e => { e.stopPropagation(); openDrawer(recipe); setDrawerMode('edit'); }} className="p-1.5 bg-white/90 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-md transition-colors shadow-sm border border-slate-100" title="编辑"><Edit3 size={ICON_SIZES.sm} /></button>
                    <button onClick={e => { e.stopPropagation(); handleDeleteRecipe(recipe.name || (recipe as any).id); }} className="p-1.5 bg-white/90 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors shadow-sm border border-slate-100" title="删除"><Trash2 size={ICON_SIZES.sm} /></button>
                  </div>
                  <div className="px-5 pt-4 pb-3">
                    <h3 className="font-bold text-slate-900 text-sm mb-2 pr-16 break-words leading-snug">{displayName}</h3>
                    <BadgeRow recipe={recipe} compact />
                  </div>
                  {recipe.tags && recipe.tags.length > 0 && (
                    <div className="px-5 pb-2 flex flex-wrap gap-1">
                      {recipe.tags.slice(0, 4).map((tag, i) => (
                        <span key={i} className="text-[9px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-600 border border-blue-100 flex items-center gap-0.5"><Tag size={7} />{tag}</span>
                      ))}
                      {recipe.tags.length > 4 && <span className="text-[9px] text-slate-400">+{recipe.tags.length - 4}</span>}
                    </div>
                  )}
                  {summary && (
                    <div className="px-5 pb-3">
                      <p className="text-xs text-slate-500 line-clamp-2 leading-relaxed">{summary}</p>
                    </div>
                  )}
                  {codePattern && (
                    <div className="mx-4 mb-3 rounded-lg overflow-hidden max-h-[120px]">
                      <CodeBlock code={codePattern.split('\n').slice(0, 6).join('\n')} language={getCodeLang(recipe)} />
                    </div>
                  )}
                  <div className="px-5 py-2.5 bg-slate-50/80 border-t border-slate-100 flex items-center gap-3 text-[10px] text-slate-400">
                    <span className="font-bold text-amber-600">★ {recipe.stats?.authority ?? 0}</span>
                    <span>使用 {recipe.stats ? (recipe.stats.guardUsageCount + recipe.stats.humanUsageCount + recipe.stats.aiUsageCount) : 0}</span>
                    {recipe.source && recipe.source !== 'unknown' && (
                      <>
                        <span className="text-slate-200">|</span>
                        <span>{recipe.source === 'bootstrap-scan' ? 'AI 扫描' : recipe.source === 'agent' ? 'AI Agent' : recipe.source}</span>
                      </>
                    )}
                    {recipe.module_name && (
                      <>
                        <span className="text-slate-200">|</span>
                        <span className="font-mono">{recipe.module_name}</span>
                      </>
                    )}
                    {recipe.relations && Object.values(recipe.relations).flat().length > 0 && (
                      <span className="ml-auto text-purple-500 font-medium">关系 {Object.values(recipe.relations).flat().length}</span>
                    )}
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
        const v2 = recipe.v2Content;

        return (
          <PageOverlay className="z-30 flex justify-end" onClick={closeDrawer}>
            <PageOverlay.Backdrop />
            <div
              className={`relative h-full bg-white shadow-2xl flex flex-col ${drawerWide ? 'w-[min(92vw,1100px)]' : 'w-[min(92vw,800px)]'}`}
              style={{ animation: 'slideInRight 0.25s ease-out' }}
              onClick={e => e.stopPropagation()}
            >
              {/* ── Header ── */}
              <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 bg-gradient-to-b from-white to-slate-50/50 shrink-0">
                <div className="flex-1 min-w-0 mr-3">
                  <h3 className="font-bold text-slate-800 text-lg leading-snug break-words">{displayName}</h3>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button onClick={goToPrev} disabled={currentIndex <= 0} className="p-1.5 hover:bg-slate-100 rounded-lg transition-colors disabled:opacity-30" title="上一条"><ChevronLeft size={ICON_SIZES.md} /></button>
                  <span className="text-xs text-slate-400 tabular-nums">{currentIndex + 1}/{sortedRecipes.length}</span>
                  <button onClick={goToNext} disabled={currentIndex >= sortedRecipes.length - 1} className="p-1.5 hover:bg-slate-100 rounded-lg transition-colors disabled:opacity-30" title="下一条"><ChevronRight size={ICON_SIZES.md} /></button>
                  <div className="w-px h-5 bg-slate-200 mx-1" />
                  <div className="flex bg-slate-100 p-0.5 rounded-lg mr-1">
                    <button onClick={() => setDrawerMode('view')} className={`px-2.5 py-1 rounded-md text-xs font-bold transition-all flex items-center gap-1 ${drawerMode === 'view' ? 'bg-white shadow-sm text-blue-600' : 'text-slate-400 hover:text-slate-600'}`}><Eye size={ICON_SIZES.sm} /> 预览</button>
                    <button onClick={() => { setDrawerMode('edit'); }} className={`px-2.5 py-1 rounded-md text-xs font-bold transition-all flex items-center gap-1 ${drawerMode === 'edit' ? 'bg-white shadow-sm text-blue-600' : 'text-slate-400 hover:text-slate-600'}`}><Edit3 size={ICON_SIZES.sm} /> 编辑</button>
                  </div>
                  <button onClick={toggleDrawerWide} className="p-1.5 hover:bg-slate-100 rounded-lg transition-colors text-slate-400" title={drawerWide ? '收窄' : '展宽'}>
                    {drawerWide ? <Minimize2 size={ICON_SIZES.md} /> : <Maximize2 size={ICON_SIZES.md} />}
                  </button>
                  <button onClick={() => { handleDeleteRecipe(recipe.name || (recipe as any).id); closeDrawer(); }} className="p-1.5 hover:bg-red-50 rounded-lg text-red-500 transition-colors" title="删除"><Trash2 size={ICON_SIZES.md} /></button>
                  <button onClick={closeDrawer} className="p-1.5 hover:bg-slate-100 rounded-lg transition-colors"><X size={ICON_SIZES.md} /></button>
                </div>
              </div>

              {drawerMode === 'edit' ? (
                <>
                  <div className="flex-1 overflow-y-auto p-5 space-y-5">
                    {/* 标题 */}
                    <div>
                      <label className="text-[10px] font-bold text-slate-400 uppercase mb-1.5 block">标题</label>
                      <input
                        type="text"
                        value={editForm.title}
                        onChange={e => setEditForm(f => ({ ...f, title: e.target.value }))}
                        className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-300 focus:border-blue-300"
                      />
                    </div>

                    {/* 描述 */}
                    <div>
                      <label className="text-[10px] font-bold text-slate-400 uppercase mb-1.5 block">描述</label>
                      <textarea
                        value={editForm.description}
                        onChange={e => setEditForm(f => ({ ...f, description: e.target.value }))}
                        rows={2}
                        className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-300 resize-none"
                      />
                    </div>

                    {/* 标签 */}
                    <div>
                      <label className="text-[10px] font-bold text-slate-400 uppercase mb-1.5 block">标签</label>
                      <div className="flex flex-wrap gap-1.5 mb-2">
                        {editForm.tags.map((tag, i) => (
                          <span key={i} className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded bg-blue-50 text-blue-600 border border-blue-100 font-medium">
                            {tag}
                            <button onClick={() => setEditForm(f => ({ ...f, tags: f.tags.filter((_, idx) => idx !== i) }))} className="text-blue-400 hover:text-red-500"><X size={10} /></button>
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
                          placeholder="输入标签后按 Enter"
                          className="flex-1 px-3 py-1.5 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-300"
                        />
                      </div>
                    </div>

                    {/* 使用指南 */}
                    <div>
                      <label className="text-[10px] font-bold text-slate-400 uppercase mb-1.5 block">使用指南</label>
                      <textarea
                        value={editForm.usageGuideCn}
                        onChange={e => setEditForm(f => ({ ...f, usageGuideCn: e.target.value }))}
                        rows={4}
                        className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-300 resize-y font-mono"
                        placeholder="Markdown 格式..."
                      />
                    </div>

                    {/* 代码 / 标准用法 */}
                    <div>
                      <label className="text-[10px] font-bold text-slate-400 uppercase mb-1.5 block flex items-center gap-1.5">
                        <Code2 size={11} className="text-emerald-500" /> 代码 / 标准用法
                      </label>
                      <div className="border border-slate-200 rounded-lg overflow-hidden" style={{ minHeight: 200 }}>
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
                      <label className="text-[10px] font-bold text-slate-400 uppercase mb-1.5 block">设计原理</label>
                      <textarea
                        value={editForm.rationale}
                        onChange={e => setEditForm(f => ({ ...f, rationale: e.target.value }))}
                        rows={3}
                        className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-300 resize-y"
                        placeholder="为何采用此方案..."
                      />
                    </div>
                  </div>
                  <div className="px-5 py-3 border-t border-slate-200 flex items-center justify-between shrink-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-slate-400">权威分</span>
                      <select className="font-bold text-amber-600 bg-amber-50 border border-amber-100 px-2 py-1 rounded-lg outline-none text-[10px]" value={recipe.stats?.authority ?? 3} onChange={e => handleSetAuthority(parseInt(e.target.value))}>
                        {[1,2,3,4,5].map(v => <option key={v} value={v}>{'⭐'.repeat(v)} {v}</option>)}
                      </select>
                    </div>
                    <div className="flex items-center gap-2">
                      <button onClick={() => setDrawerMode('view')} disabled={isSaving} className="px-4 py-1.5 text-sm text-slate-600 font-medium rounded-lg hover:bg-slate-50">取消</button>
                      <button onClick={handleSaveInDrawer} disabled={isSaving} className="px-5 py-1.5 bg-blue-600 text-white text-sm font-medium rounded-lg flex items-center gap-1.5 hover:bg-blue-700 disabled:opacity-60">
                        {isSaving ? <Loader2 size={ICON_SIZES.sm} className="animate-spin" /> : <Save size={ICON_SIZES.sm} />}
                        {isSaving ? '保存中...' : '保存'}
                      </button>
                    </div>
                  </div>
                </>
              ) : (
                /* ═══ View mode — V3 structured ═══ */
                <div className="flex-1 overflow-y-auto">

                  {/* 1. Badges + Metadata — only non-empty */}
                  <div className="px-6 py-4 border-b border-slate-100 space-y-3">
                    <BadgeRow recipe={recipe} />
                    <MetadataRow recipe={recipe} />
                  </div>

                  {/* 2. Tags */}
                  {recipe.tags && recipe.tags.length > 0 && (
                    <div className="px-6 py-3 border-b border-slate-100 flex flex-wrap items-center gap-1.5">
                      <Tag size={11} className="text-slate-300 mr-0.5" />
                      {recipe.tags.map((tag, i) => (
                        <span key={i} className="text-[9px] px-2 py-0.5 rounded bg-blue-50 text-blue-600 border border-blue-100 font-medium">{tag}</span>
                      ))}
                    </div>
                  )}

                  {/* 3. Relations — 上方显眼位置 */}
                  <div className="px-6 py-4 border-b border-slate-100">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-1.5">
                        <Link2 size={12} className="text-purple-400" />
                        <label className="text-[10px] font-bold text-slate-400 uppercase">关联知识</label>
                        {(() => {
                          const total = recipe.relations ? Object.values(recipe.relations).flat().length : 0;
                          return total > 0 ? <span className="text-[9px] bg-purple-100 text-purple-600 px-1.5 py-0.5 rounded-full font-bold">{total}</span> : null;
                        })()}
                      </div>
                      <button
                        onClick={() => { setIsAddingRelation(!isAddingRelation); setRelationSearchQuery(''); }}
                        className={`text-[9px] px-2 py-0.5 rounded font-bold flex items-center gap-1 transition-colors ${isAddingRelation ? 'bg-slate-200 text-slate-600' : 'bg-purple-500 text-white hover:bg-purple-600'}`}
                      >
                        {isAddingRelation ? <><X size={10} /> 取消</> : <><Plus size={10} /> 添加</>}
                      </button>
                    </div>
                    {isAddingRelation && (
                      <div className="mb-3 bg-purple-50/80 border border-purple-200 rounded-lg p-3 space-y-2">
                        <div className="flex items-center gap-2">
                          <select value={newRelationType} onChange={e => setNewRelationType(e.target.value)} className="text-[10px] font-bold bg-white border border-purple-200 text-purple-700 rounded px-2 py-1 outline-none">
                            {RELATION_TYPES.map(t => <option key={t.key} value={t.key}>{t.icon} {t.label}</option>)}
                          </select>
                          <div className="flex-1 relative">
                            <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-300" />
                            <input type="text" placeholder="搜索..." value={relationSearchQuery} onChange={e => setRelationSearchQuery(e.target.value)} className="w-full text-xs bg-white border border-purple-200 rounded pl-7 pr-2 py-1 outline-none" autoFocus />
                          </div>
                        </div>
                        {relationSearchQuery.length > 0 && (
                          <div className="max-h-36 overflow-y-auto rounded border border-purple-100 bg-white divide-y divide-slate-100">
                            {(() => {
                              const filtered = recipes.filter(r => {
                                if (getDisplayName(r) === displayName) return false;
                                return getDisplayName(r).toLowerCase().includes(relationSearchQuery.toLowerCase());
                              }).slice(0, 10);
                              if (!filtered.length) return <div className="text-xs text-slate-400 py-3 text-center">未找到</div>;
                              return filtered.map(r => {
                                const rName = getDisplayName(r);
                                const linked = recipe.relations && Object.values(recipe.relations).flat().some((rel: any) => {
                                  const id = typeof rel === 'string' ? rel : rel.id || rel.title || '';
                                  return id.replace(/\.md$/i, '').toLowerCase() === rName.toLowerCase();
                                });
                                return (
                                  <div key={rName} className={`flex items-center justify-between px-3 py-1.5 text-xs ${linked ? 'bg-slate-50 text-slate-400' : 'hover:bg-purple-50 cursor-pointer'}`} onClick={() => !linked && handleAddRelation(newRelationType, rName)}>
                                    <span className="font-medium truncate mr-2">{rName}</span>
                                    {linked ? <span className="text-[9px] text-slate-400 font-bold shrink-0">已关联</span> : <span className="text-[9px] text-purple-600 font-bold shrink-0">+ 添加</span>}
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
                              <span className="text-[10px] font-mono text-slate-500 w-14 shrink-0 pt-0.5">{icon} {label}</span>
                              <div className="flex flex-wrap gap-1">
                                {items.map((r: any, ri: number) => {
                                  const itemName = typeof r === 'string' ? r : r.id || r.title || JSON.stringify(r);
                                  const found = findRecipeByName(itemName);
                                  return (
                                    <span
                                      key={ri}
                                      className={`group/rel inline-flex items-center gap-1 px-1.5 py-0.5 border rounded text-[10px] font-mono transition-colors ${
                                        found ? 'bg-purple-50 border-purple-200 text-purple-700 cursor-pointer hover:bg-purple-100' : 'bg-white border-slate-200 text-slate-600'
                                      }`}
                                      onClick={() => found && openDrawer(found)}
                                      title={found ? '点击查看' : itemName}
                                    >
                                      {itemName.replace(/\.md$/i, '')}
                                      <button onClick={e => { e.stopPropagation(); handleRemoveRelation(key, itemName); }} className="opacity-0 group-hover/rel:opacity-100 text-red-400 hover:text-red-600 transition-opacity ml-0.5" title="移除"><X size={10} /></button>
                                    </span>
                                  );
                                })}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : !isAddingRelation && (
                      <div className="text-xs text-slate-300 py-2 text-center">暂无关联</div>
                    )}
                  </div>

                  {/* 4. Stats */}
                  <div className="px-6 py-3 border-b border-slate-100">
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      <div className="bg-amber-50/60 rounded-xl p-3 text-center border border-amber-100">
                        <div className="text-lg font-bold text-amber-700">{recipe.stats?.authority ?? '—'}</div>
                        <div className="text-[10px] text-amber-500 font-medium">权威分</div>
                      </div>
                      <div className="bg-blue-50/60 rounded-xl p-3 text-center border border-blue-100">
                        <div className="text-lg font-bold text-blue-700">{recipe.stats?.authorityScore != null ? recipe.stats.authorityScore.toFixed(1) : '—'}</div>
                        <div className="text-[10px] text-blue-500 font-medium">综合分</div>
                      </div>
                      <div className="bg-slate-50 rounded-xl p-3 text-center border border-slate-100">
                        <div className="text-lg font-bold text-slate-800">{recipe.stats ? (recipe.stats.guardUsageCount + recipe.stats.humanUsageCount + recipe.stats.aiUsageCount) : 0}</div>
                        <div className="text-[10px] text-slate-400 font-medium">总使用</div>
                      </div>
                      <div className="bg-slate-50 rounded-xl p-3 text-center border border-slate-100">
                        <div className="text-sm font-bold text-slate-700">{formatDate(recipe.stats?.lastUsedAt) || '从未使用'}</div>
                        <div className="text-[10px] text-slate-400 font-medium">最近使用</div>
                      </div>
                    </div>
                    {recipe.stats != null && (recipe.stats.guardUsageCount > 0 || recipe.stats.humanUsageCount > 0 || recipe.stats.aiUsageCount > 0) && (
                      <div className="flex items-center gap-4 mt-2 text-[10px] text-slate-400">
                        <span>Guard: {recipe.stats.guardUsageCount}</span>
                        <span>Human: {recipe.stats.humanUsageCount}</span>
                        <span>AI: {recipe.stats.aiUsageCount}</span>
                      </div>
                    )}
                  </div>

                  {/* 4. Description / Summary */}
                  {recipe.description && (
                    <div className="px-6 py-4 border-b border-slate-100">
                      <label className="text-[10px] font-bold text-slate-400 uppercase mb-1.5 block">摘要</label>
                      <p className="text-sm text-slate-600 leading-relaxed">{recipe.description}</p>
                    </div>
                  )}

                  {/* 5. Usage Guide */}
                  {(recipe.usageGuide || recipe.usageGuide_cn || recipe.usageGuide_en) && (
                    <div className="px-6 py-4 border-b border-slate-100">
                      <label className="text-[10px] font-bold text-slate-400 uppercase mb-2 block flex items-center gap-1.5">
                        <BookOpen size={11} className="text-blue-400" /> 使用指南
                      </label>
                      <div className="bg-blue-50/30 border border-blue-100 rounded-xl p-4">
                        <div className="markdown-body text-sm text-slate-700 leading-relaxed">
                          <MarkdownWithHighlight content={recipe.usageGuide_cn || recipe.usageGuide || ''} />
                        </div>
                      </div>
                      {recipe.usageGuide_en && (
                        <div className="mt-3 bg-slate-50 border border-slate-100 rounded-xl p-4">
                          <span className="text-[9px] text-slate-400 font-bold uppercase block mb-1.5">Usage Guide (EN)</span>
                          <div className="markdown-body text-sm text-slate-500 leading-relaxed">
                            <MarkdownWithHighlight content={recipe.usageGuide_en} />
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* 6. Headers */}
                  {recipe.headers && recipe.headers.length > 0 && (
                    <div className="px-6 py-3 border-b border-slate-100">
                      <label className="text-[10px] font-bold text-slate-400 uppercase mb-2 block">导入头文件</label>
                      <div className="flex flex-wrap gap-1.5">
                        {recipe.headers.map((h, i) => (
                          <code key={i} className="px-2.5 py-1 bg-violet-50 text-violet-700 border border-violet-100 rounded-md text-[10px] font-mono font-medium">{h}</code>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* 7. Code Pattern */}
                  {codePattern && (
                    <div className="px-6 py-4 border-b border-slate-100">
                      <label className="text-[10px] font-bold text-slate-400 uppercase mb-2 block flex items-center gap-1.5">
                        <Code2 size={11} className="text-emerald-500" /> 代码 / 标准用法
                      </label>
                      <CodeBlock code={codePattern} language={codeLang} showLineNumbers />
                    </div>
                  )}

                  {/* 8. Rationale */}
                  {v2?.rationale && (
                    <div className="px-6 py-4 border-b border-slate-100">
                      <label className="text-[10px] font-bold text-slate-400 uppercase mb-2 block">设计原理</label>
                      <div className="bg-slate-50 border border-slate-100 rounded-xl p-4">
                        <p className="text-sm text-slate-600 leading-relaxed">{v2.rationale}</p>
                      </div>
                    </div>
                  )}

                  {/* 9. Steps */}
                  {v2?.steps && v2.steps.length > 0 && (
                    <div className="px-6 py-4 border-b border-slate-100">
                      <label className="text-[10px] font-bold text-slate-400 uppercase mb-2 block">实施步骤</label>
                      <div className="space-y-2">
                        {v2.steps.map((step: any, i: number) => {
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

                  {/* 10. Code Changes */}
                  {v2?.codeChanges && v2.codeChanges.length > 0 && (
                    <div className="px-6 py-4 border-b border-slate-100">
                      <label className="text-[10px] font-bold text-slate-400 uppercase mb-2 block">代码变更</label>
                      <div className="space-y-2">
                        {v2.codeChanges.map((change, i) => (
                          <div key={i} className="border border-slate-200 rounded-lg overflow-hidden">
                            <div className="px-3 py-1.5 bg-slate-50 border-b border-slate-200 flex items-center gap-2">
                              <FileCode size={11} className="text-blue-400" />
                              <code className="text-[10px] font-mono text-slate-600">{change.file}</code>
                            </div>
                            {change.explanation && <p className="text-[11px] text-slate-500 px-3 py-1.5 border-b border-slate-100 bg-yellow-50/30">{change.explanation}</p>}
                            <div className="p-2 bg-red-50/20 border-b border-slate-100">
                              <div className="text-[9px] font-bold text-red-400 mb-0.5 uppercase">Before</div>
                              <pre className="text-[11px] text-slate-600 whitespace-pre-wrap break-words font-mono">{change.before || '(空)'}</pre>
                            </div>
                            <div className="p-2 bg-emerald-50/20">
                              <div className="text-[9px] font-bold text-emerald-500 mb-0.5 uppercase">After</div>
                              <pre className="text-[11px] text-slate-700 whitespace-pre-wrap break-words font-mono">{change.after}</pre>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* 11. Verification */}
                  {v2?.verification && (
                    <div className="px-6 py-4 border-b border-slate-100">
                      <label className="text-[10px] font-bold text-slate-400 uppercase mb-2 block">验证方法</label>
                      <div className="bg-teal-50/50 border border-teal-100 rounded-xl p-4 space-y-1.5">
                        {v2.verification.method && <p className="text-xs text-slate-600"><span className="font-bold text-teal-600">方法:</span> {v2.verification.method}</p>}
                        {v2.verification.expectedResult && <p className="text-xs text-slate-600"><span className="font-bold text-teal-600">预期:</span> {v2.verification.expectedResult}</p>}
                        {v2.verification.testCode && <pre className="text-[11px] font-mono bg-slate-800 text-green-300 p-2.5 rounded-md overflow-x-auto whitespace-pre-wrap mt-1">{v2.verification.testCode}</pre>}
                      </div>
                    </div>
                  )}

                  {/* 12. Constraints */}
                  {recipe.constraints && (() => {
                    const c = recipe.constraints;
                    const total = (c.guards?.length || 0) + (c.boundaries?.length || 0) + (c.preconditions?.length || 0) + (c.sideEffects?.length || 0);
                    if (!total) return null;
                    return (
                      <div className="px-6 py-4 border-b border-slate-100">
                        <label className="text-[10px] font-bold text-slate-400 uppercase mb-2 block flex items-center gap-1.5">
                          <Shield size={11} className="text-amber-500" /> 约束条件 <span className="text-amber-500 font-mono">{total}</span>
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

                  {/* end of view sections */}

                </div>
              )}
            </div>
          </PageOverlay>
        );
      })()}
    </div>
  );
};

export default RecipesView;
