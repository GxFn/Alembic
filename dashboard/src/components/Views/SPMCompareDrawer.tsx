import React from 'react';
import { Copy, Loader2 } from 'lucide-react';
import { ScanResultItem, Recipe, SimilarRecipe } from '../../types';
import api from '../../api';
import { notify } from '../../utils/notification';
import { ICON_SIZES } from '../../constants/icons';
import CodeBlock from '../Shared/CodeBlock';
import MarkdownWithHighlight, { stripFrontmatter } from '../Shared/MarkdownWithHighlight';
import { Drawer } from '../Layout/Drawer';
import { Button } from '../ui/Button';
import { useI18n } from '../../i18n';
import { getErrorMessage } from '../../utils/error';

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
  if (['objectivec', 'objc', 'objective-c', 'obj-c'].includes(l)) return 'objectivec';
  return res.language || 'text';
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
  const { t } = useI18n();
  const cand = data.candidate;
  const candLang = codeLang(cand);

  const copyCandidate = () => {
    const parts = [];
    const candCode = cand.content?.pattern || '';
    const candGuide = cand.content?.markdown || cand.doClause || '';
    if (candCode) parts.push('## Snippet / Code Reference\n\n```' + candLang + '\n' + candCode + '\n```');
    if (candGuide) parts.push('\n## AI Context / Usage Guide\n\n' + candGuide);
    navigator.clipboard.writeText(parts.join('\n') || '').then(() => notify(t('spmCompare.candidateCopied'), { title: t('spmCompare.copied') })).catch(() => { /* clipboard fallback: user denied or insecure context */ });
  };
  const copyRecipe = () => {
    const text = stripFrontmatter(data.recipeContent);
    navigator.clipboard.writeText(text).then(() => notify(t('spmCompare.recipeCopied'), { title: t('spmCompare.copied') })).catch(() => { /* clipboard fallback: user denied or insecure context */ });
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
        content = [existing.content.pattern, existing.content.markdown].filter(Boolean).join('\n\n') || '';
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
    if (!window.confirm(t('spmCompare.deleteConfirm'))) return;
    try {
      await handleDeleteCandidate(data.targetName, cand.candidateId);
      onClose();
    } catch (err: unknown) {
      notify(getErrorMessage(err, t('spmCompare.deleteFailed')), { title: t('spmCompare.deleteFailed'), type: 'error' });
    }
  };

  const handleAuditCandidate = () => {
    handleSaveExtracted(cand);
    onClose();
  };

  const handleEditRecipe = () => {
    const recipe = recipes?.find(r => r.name === data.recipeName || r.name.endsWith('/' + data.recipeName));
    if (recipe) { onEditRecipe?.(recipe); }
    else { onEditRecipe?.({ name: data.recipeName, content: { markdown: data.recipeContent } } as Recipe); }
    onClose();
  };

  return (
    <Drawer open onClose={onClose} size="full">
      {/* Header */}
      <Drawer.Header title={t('spmCompare.compareTitle')}>
        <Drawer.HeaderActions>
          {cand.candidateId && data.targetName && (
            <Button variant="danger" size="sm" onClick={handleDelete}>{t('spmCompare.deleteCandidate')}</Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={handleAuditCandidate}
            disabled={isSavingRecipe}
          >
            {isSavingRecipe ? <Loader2 size={ICON_SIZES.xs} className="animate-spin" /> : null}
            {t('spmCompare.auditCandidate')}
          </Button>
          <Button variant="ghost" size="sm" onClick={handleEditRecipe}>{t('spmCompare.editRecipe')}</Button>
        </Drawer.HeaderActions>
        <Drawer.CloseButton onClose={onClose} />
      </Drawer.Header>

      <Drawer.Body>
        {/* Similar recipe switcher */}
        {data.similarList.length > 1 && (
          <div className="flex flex-wrap gap-1.5 px-5 py-2 border-b border-[var(--border-default)] bg-[var(--bg-subtle)] shrink-0">
            <span className="text-[10px] text-[var(--fg-muted)] font-bold self-center">{t('spmCompare.switchRecipe')}</span>
            {data.similarList.map(s => (
              <button
                key={s.recipeName}
                onClick={() => switchToRecipe(s.recipeName)}
                className={`text-[10px] font-bold px-2 py-1 rounded transition-colors ${
                  data.recipeName === s.recipeName
                    ? 'bg-emerald-200 text-emerald-800'
                    : 'bg-[var(--bg-surface)] text-emerald-600 hover:bg-emerald-100 border border-emerald-200'
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
          <div className="flex-1 flex flex-col min-w-0 border-r border-[var(--border-default)]">
            <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--border-default)] bg-blue-50/40 shrink-0">
              <span className="text-xs font-bold text-blue-700 truncate">{t('spmCompare.candidateTitle', { title: cand.title || '' })}</span>
              <button onClick={copyCandidate} className="p-1 hover:bg-blue-100 rounded text-blue-500 shrink-0" title={t('spmCompare.copyCandidate')}>
                <Copy size={ICON_SIZES.xs} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              <div className="markdown-body text-[var(--fg-secondary)] space-y-4">
                <h3 className="text-sm font-bold">Snippet / Code Reference</h3>
                {(cand.content?.pattern) ? (
                  <CodeBlock code={cand.content?.pattern || ''} language={candLang} className="!overflow-visible" />
                ) : (
                  <p className="text-[var(--fg-muted)] italic text-xs">{t('spmCompare.noCode')}</p>
                )}
                <h3 className="text-sm font-bold mt-4">{t('spmCompare.aiContextProfile')}</h3>
                {(cand.content?.markdown || cand.doClause) ? (
                  <MarkdownWithHighlight content={cand.content?.markdown || cand.doClause || ''} />
                ) : (
                  <p className="text-[var(--fg-muted)] italic text-xs">{t('spmCompare.noGuide')}</p>
                )}
              </div>
            </div>
          </div>

          {/* Right: Recipe */}
          <div className="flex-1 flex flex-col min-w-0">
            <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--border-default)] bg-emerald-50/40 shrink-0">
              <span className="text-xs font-bold text-emerald-700 truncate">Recipe：{data.recipeName.replace(/\.md$/i, '')}</span>
              <button onClick={copyRecipe} className="p-1 hover:bg-emerald-100 rounded text-emerald-500 shrink-0" title={t('spmCompare.copyRecipe')}>
                <Copy size={ICON_SIZES.xs} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              <MarkdownWithHighlight content={data.recipeContent} stripFrontmatter />
            </div>
          </div>
        </div>
      </Drawer.Body>
    </Drawer>
  );
};

export default SPMCompareDrawer;
