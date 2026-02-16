import React from 'react';
import { X, Copy, Loader2 } from 'lucide-react';
import { ScanResultItem, Recipe, SimilarRecipe } from '../../types';
import api from '../../api';
import { notify } from '../../utils/notification';
import { ICON_SIZES } from '../../constants/icons';
import CodeBlock from '../Shared/CodeBlock';
import MarkdownWithHighlight, { stripFrontmatter } from '../Shared/MarkdownWithHighlight';
import PageOverlay from '../Shared/PageOverlay';

export type { SimilarRecipe };

export interface CompareDrawerData {
  candidate: ScanResultItem;
  targetName: string;
  recipeName: string;
  recipeContent: string;
  similarList: SimilarRecipe[];
  recipeContents: Record<string, string>;
}

interface SPMCompareDrawerProps {
  data: CompareDrawerData;
  onClose: () => void;
  onDataChange: (data: CompareDrawerData | null) => void;
  /* actions */
  recipes?: Recipe[];
  handleSaveExtracted: (res: any) => void;
  handleDeleteCandidate?: (targetName: string, candidateId: string) => void;
  onEditRecipe?: (recipe: Recipe) => void;
  isSavingRecipe?: boolean;
}

/* ── helper ── */
const codeLang = (res: { language?: string }) => {
  const l = (res.language || '').toLowerCase();
  return l === 'objectivec' || l === 'objc' || l === 'objective-c' || l === 'obj-c'
    ? 'objectivec'
    : (res.language || 'swift');
};

const SPMCompareDrawer: React.FC<SPMCompareDrawerProps> = ({
  data,
  onClose,
  onDataChange,
  recipes,
  handleSaveExtracted,
  handleDeleteCandidate,
  onEditRecipe,
  isSavingRecipe = false,
}) => {
  const cand = data.candidate;
  const candLang = codeLang(cand);

  const copyCandidate = () => {
    const parts = [];
    const candCode = cand.code || cand.content?.pattern || '';
    const candGuide = cand.usageGuide || cand.usage_guide_cn || '';
    if (candCode) parts.push('## Snippet / Code Reference\n\n```' + candLang + '\n' + candCode + '\n```');
    if (candGuide) parts.push('\n## AI Context / Usage Guide\n\n' + candGuide);
    navigator.clipboard.writeText(parts.join('\n') || '').then(() => notify('候选内容已复制到剪贴板', { title: '已复制' }));
  };
  const copyRecipe = () => {
    const text = stripFrontmatter(data.recipeContent);
    navigator.clipboard.writeText(text).then(() => notify('Recipe 内容已复制到剪贴板', { title: '已复制' }));
  };

  const switchToRecipe = async (newName: string) => {
    if (newName === data.recipeName) return;
    const cached = data.recipeContents[newName];
    if (cached) {
      onDataChange({ ...data, recipeName: newName, recipeContent: cached });
    } else {
      let content = '';
      const existing = recipes?.find(r => r.name === newName || r.name.endsWith('/' + newName));
      if (existing?.content) {
        content = existing.content;
      } else {
        try {
          const recipeData = await api.getRecipeContentByName(newName);
          content = recipeData.content;
        } catch (_) { return; }
      }
      onDataChange({ ...data, recipeName: newName, recipeContent: content, recipeContents: { ...data.recipeContents, [newName]: content } });
    }
  };

  const handleDelete = async () => {
    if (!cand.candidateId || !data.targetName || !handleDeleteCandidate) return;
    if (!window.confirm('确定删除该候选？')) return;
    try {
      await handleDeleteCandidate(data.targetName, cand.candidateId);
      onClose();
    } catch (err: any) {
      notify(err?.message || '删除失败', { title: '删除失败', type: 'error' });
    }
  };

  const handleAuditCandidate = () => {
    handleSaveExtracted(cand);
    onClose();
  };

  const handleEditRecipe = () => {
    const recipe = recipes?.find(r => r.name === data.recipeName || r.name.endsWith('/' + data.recipeName))
      || { name: data.recipeName, content: data.recipeContent };
    onEditRecipe?.(recipe);
    onClose();
  };

  return (
    <PageOverlay
      className="z-30 flex justify-end"
      onClick={onClose}
    >
      <PageOverlay.Backdrop className="bg-black/30 backdrop-blur-[1px]" />

      {/* Drawer — wider for side-by-side */}
      <div
        className="relative w-[min(96vw,1280px)] h-full bg-white shadow-2xl flex flex-col"
        style={{ animation: 'slideInRight 0.25s ease-out' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 shrink-0">
          <div className="flex items-center gap-3 flex-1 min-w-0">
            <h3 className="font-bold text-slate-800">对比：候选 vs Recipe</h3>
            <div className="flex items-center gap-1.5 shrink-0">
              {cand.candidateId && data.targetName && (
                <button onClick={handleDelete} className="text-xs text-red-600 hover:bg-red-50 px-2 py-1 rounded transition-colors">删除候选</button>
              )}
              <button
                onClick={handleAuditCandidate}
                disabled={isSavingRecipe}
                className="text-xs text-blue-600 hover:bg-blue-50 px-2 py-1 rounded disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1 transition-colors"
              >
                {isSavingRecipe ? <Loader2 size={ICON_SIZES.xs} className="animate-spin" /> : null}
                审核候选
              </button>
              <button onClick={handleEditRecipe} className="text-xs text-emerald-600 hover:bg-emerald-50 px-2 py-1 rounded transition-colors">编辑 Recipe</button>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-lg transition-colors shrink-0 ml-2">
            <X size={ICON_SIZES.md} />
          </button>
        </div>

        {/* Similar recipe switcher */}
        {data.similarList.length > 1 && (
          <div className="flex flex-wrap gap-1.5 px-5 py-2 border-b border-slate-100 bg-slate-50/50 shrink-0">
            <span className="text-[10px] text-slate-400 font-bold self-center">切换 Recipe：</span>
            {data.similarList.map(s => (
              <button
                key={s.recipeName}
                onClick={() => switchToRecipe(s.recipeName)}
                className={`text-[10px] font-bold px-2 py-1 rounded transition-colors ${
                  data.recipeName === s.recipeName
                    ? 'bg-emerald-200 text-emerald-800'
                    : 'bg-white text-emerald-600 hover:bg-emerald-100 border border-emerald-200'
                }`}
              >
                {s.recipeName.replace(/\.md$/i, '')} {(s.similarity * 100).toFixed(0)}%
              </button>
            ))}
          </div>
        )}

        {/* Side-by-side content */}
        <div className="flex-1 flex min-h-0">
          {/* Left: Candidate */}
          <div className="flex-1 flex flex-col min-w-0 border-r border-slate-200">
            <div className="flex items-center justify-between px-4 py-2 border-b border-slate-100 bg-blue-50/40 shrink-0">
              <span className="text-xs font-bold text-blue-700 truncate">候选：{cand.title}</span>
              <button onClick={copyCandidate} className="p-1 hover:bg-blue-100 rounded text-blue-500 shrink-0" title="复制候选">
                <Copy size={ICON_SIZES.xs} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              <div className="markdown-body text-slate-700 space-y-4">
                <h3 className="text-sm font-bold">Snippet / Code Reference</h3>
                {(cand.code || cand.content?.pattern) ? (
                  <CodeBlock code={cand.code || cand.content?.pattern || ''} language={candLang} className="!overflow-visible" />
                ) : (
                  <p className="text-slate-400 italic text-xs">（无代码）</p>
                )}
                <h3 className="text-sm font-bold mt-4">AI Context / Usage Guide</h3>
                {(cand.usageGuide || cand.usage_guide_cn) ? (
                  <MarkdownWithHighlight content={cand.usageGuide || cand.usage_guide_cn || ''} />
                ) : (
                  <p className="text-slate-400 italic text-xs">（无使用指南）</p>
                )}
              </div>
            </div>
          </div>

          {/* Right: Recipe */}
          <div className="flex-1 flex flex-col min-w-0">
            <div className="flex items-center justify-between px-4 py-2 border-b border-slate-100 bg-emerald-50/40 shrink-0">
              <span className="text-xs font-bold text-emerald-700 truncate">Recipe：{data.recipeName.replace(/\.md$/i, '')}</span>
              <button onClick={copyRecipe} className="p-1 hover:bg-emerald-100 rounded text-emerald-500 shrink-0" title="复制 Recipe">
                <Copy size={ICON_SIZES.xs} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              <MarkdownWithHighlight content={data.recipeContent} stripFrontmatter />
            </div>
          </div>
        </div>
      </div>
    </PageOverlay>
  );
};

export default SPMCompareDrawer;
