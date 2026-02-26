import React, { useState, useRef, useEffect } from 'react';
import { X, Save, Eye, Edit3, Loader2, Shield, Lightbulb, BookOpen, FileText, FileCode, Code2, Tag } from 'lucide-react';
import { Recipe } from '../../types';
import api from '../../api';
import MarkdownWithHighlight from '../Shared/MarkdownWithHighlight';
import HighlightedCodeEditor from '../Shared/HighlightedCodeEditor';
import CodeBlock from '../Shared/CodeBlock';
import { ICON_SIZES } from '../../constants/icons';
import PageOverlay from '../Shared/PageOverlay';
import { useI18n } from '../../i18n';
import Select from '../ui/Select';

interface RecipeEditorProps {
  editingRecipe: Recipe;
  setEditingRecipe: (recipe: Recipe | null) => void;
  handleSaveRecipe: () => void;
  closeRecipeEdit: () => void;
  isSavingRecipe?: boolean;
}

const defaultStats = {
  authority: 0,
  guardUsageCount: 0,
  humanUsageCount: 0,
  aiUsageCount: 0,
  lastUsedAt: null as string | null,
  authorityScore: 0
};

const RecipeEditor: React.FC<RecipeEditorProps> = ({ editingRecipe, setEditingRecipe, handleSaveRecipe, closeRecipeEdit, isSavingRecipe = false }) => {
  const { t } = useI18n();
  const [viewMode, setViewMode] = useState<'edit' | 'preview'>('preview');
  const isMountedRef = useRef(true);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const codeLang = (() => {
    const l = (editingRecipe.language || '').toLowerCase();
    if (['objectivec', 'objc', 'objective-c', 'obj-c'].includes(l)) return 'objectivec';
    return editingRecipe.language || 'text';
  })();

  const handleSetAuthority = async (authority: number) => {
    try {
      await api.setRecipeAuthority(editingRecipe.name, authority);
      if (isMountedRef.current) {
        const stats = editingRecipe.stats ? { ...editingRecipe.stats, authority } : { ...defaultStats, authority };
        setEditingRecipe({ ...editingRecipe, stats });
      }
    } catch (err: any) {
      console.warn(t('recipeEditor.authorityFailed'), err?.message);
    }
  };

  const formatTimestamp = (ts: number | string | null | undefined) => {
    if (!ts) return '';
    const ms = typeof ts === 'string' ? new Date(ts).getTime() : (ts as number);
    if (isNaN(ms)) return '';
    return new Date(ms).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  };

  return (
  <PageOverlay className="z-40 flex items-center justify-center p-4">
    <PageOverlay.Backdrop className="bg-slate-900/50 backdrop-blur-sm" />
    <div className="relative bg-[var(--bg-surface)] w-full max-w-6xl rounded-2xl shadow-2xl flex flex-col h-[85vh]">
    <div className="p-6 border-b border-[var(--border-default)] flex justify-between items-center flex-wrap gap-4">
      <div className="flex items-center gap-3">
      <h2 className="text-xl font-bold">{t('recipeEditor.title')}</h2>
      {/* V2 Kind badge */}
      {editingRecipe.kind && (() => {
        const kc: Record<string, { label: string; color: string; bg: string; border: string; icon: React.ElementType }> = {
        rule: { label: 'Rule', color: 'text-red-700', bg: 'bg-red-50', border: 'border-red-200', icon: Shield },
        pattern: { label: 'Pattern', color: 'text-violet-700', bg: 'bg-violet-50', border: 'border-violet-200', icon: Lightbulb },
        fact: { label: 'Fact', color: 'text-cyan-700', bg: 'bg-cyan-50', border: 'border-cyan-200', icon: BookOpen },
        };
        const cfg = kc[editingRecipe.kind];
        if (!cfg) return null;
        const KindIcon = cfg.icon;
        return (
        <span className={`text-[10px] font-bold px-2 py-1 rounded uppercase flex items-center gap-1 border ${cfg.bg} ${cfg.color} ${cfg.border}`}>
          <KindIcon size={ICON_SIZES.sm} />{cfg.label}
        </span>
        );
      })()}
      {/* V2 Status badge */}
      {editingRecipe.status && editingRecipe.status !== 'active' && editingRecipe.status !== 'published' && (
        <span className={`text-[10px] font-bold px-2 py-1 rounded uppercase border ${
        editingRecipe.status === 'draft' ? 'bg-[var(--bg-subtle)] text-[var(--fg-muted)] border-[var(--border-default)]' :
        editingRecipe.status === 'archived' ? 'bg-orange-50 text-orange-600 border-orange-200' :
        'bg-[var(--bg-subtle)] text-[var(--fg-muted)] border-[var(--border-default)]'
        }`}>{editingRecipe.status}</span>
      )}
      </div>
      <div className="flex items-center gap-4">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-[var(--fg-muted)]">{t('recipeEditor.authorityScore')}</span>
        {viewMode === 'preview' ? (
        <span className="text-sm text-[var(--fg-primary)]">{(editingRecipe.stats?.authority ?? 3)}</span>
        ) : (
        <Select
          value={String(editingRecipe.stats?.authority ?? 3)}
          onChange={v => handleSetAuthority(parseInt(v))}
          options={[
            { value: '1', label: `1 - ${t('recipeEditor.qualityLevels.basic')}`, icon: '⭐' },
            { value: '2', label: `2 - ${t('recipeEditor.qualityLevels.good')}`, icon: '⭐⭐' },
            { value: '3', label: `3 - ${t('recipeEditor.qualityLevels.solid')}`, icon: '⭐⭐⭐' },
            { value: '4', label: `4 - ${t('recipeEditor.qualityLevels.great')}`, icon: '⭐⭐⭐⭐' },
            { value: '5', label: `5 - ${t('recipeEditor.qualityLevels.excellent')}`, icon: '⭐⭐⭐⭐⭐' },
          ]}
          size="xs"
          className="font-bold text-amber-600 bg-amber-50 border-amber-100"
        />
        )}
      </div>
      <div className="flex bg-[var(--bg-subtle)] p-1 rounded-lg mr-4">
        <button 
        onClick={() => setViewMode('preview')} 
        className={`px-4 py-1.5 rounded-md text-xs font-bold transition-all flex items-center gap-2 ${viewMode === 'preview' ? 'bg-[var(--bg-surface)] shadow-sm text-[var(--accent)]' : 'text-[var(--fg-muted)]'}`}
        >
        <Eye size={ICON_SIZES.sm} /> {t('recipeEditor.preview')}
        </button>
        <button 
        onClick={() => setViewMode('edit')} 
        className={`px-4 py-1.5 rounded-md text-xs font-bold transition-all flex items-center gap-2 ${viewMode === 'edit' ? 'bg-[var(--bg-surface)] shadow-sm text-[var(--accent)]' : 'text-[var(--fg-muted)]'}`}
        >
        <Edit3 size={ICON_SIZES.sm} /> {t('recipeEditor.edit')}
        </button>
      </div>
      <button onClick={closeRecipeEdit} className="p-2 hover:bg-[var(--bg-subtle)] rounded-full"><X size={ICON_SIZES.lg} /></button>
      </div>
    </div>
    <div className="p-6 space-y-4 flex-1 flex flex-col overflow-hidden">
      <div className="flex-1 flex flex-col min-h-0">
      {viewMode === 'edit' ? (
        <div className="flex-1 overflow-y-auto space-y-5 pr-1">
        {/* Path */}
        <div>
          <label className="block text-xs font-bold text-[var(--fg-muted)] uppercase mb-1">{t('recipeEditor.path')}</label>
          <input className="w-full p-2 bg-[var(--bg-subtle)] border border-[var(--border-default)] rounded-lg text-sm" value={editingRecipe.name} onChange={e => setEditingRecipe({ ...editingRecipe, name: e.target.value })} />
        </div>

        {/* Description */}
        <div>
          <label className="block text-xs font-bold text-[var(--fg-muted)] uppercase mb-1">{t('recipeEditor.description')}</label>
          <textarea
          className="w-full px-3 py-2 text-sm border border-[var(--border-default)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--accent-emphasis)] resize-none"
          rows={2}
          value={editingRecipe.description || ''}
          onChange={e => setEditingRecipe({ ...editingRecipe, description: e.target.value })}
          placeholder={t('recipeEditor.descPlaceholder')}
          />
        </div>

        {/* Markdown 文档 */}
        <div>
          <label className="block text-xs font-bold text-[var(--fg-muted)] uppercase mb-1.5 flex items-center gap-1.5">
          <FileText size={11} className="text-blue-400" /> {t('recipeEditor.markdown')}
          </label>
          <div className="border border-[var(--border-default)] rounded-lg overflow-hidden" style={{ minHeight: 180 }}>
          <HighlightedCodeEditor
            value={editingRecipe.content?.markdown || ''}
            onChange={e => setEditingRecipe({ ...editingRecipe, content: { ...editingRecipe.content, markdown: e } as any })}
            language="markdown"
            height="180px"
            showLineNumbers={true}
          />
          </div>
        </div>

        {/* Code / 标准用法 */}
        <div>
          <label className="block text-xs font-bold text-[var(--fg-muted)] uppercase mb-1.5 flex items-center gap-1.5">
          <Code2 size={11} className="text-emerald-500" /> {t('recipeEditor.code')}
          </label>
          <div className="border border-[var(--border-default)] rounded-lg overflow-hidden" style={{ minHeight: 180 }}>
          <HighlightedCodeEditor
            value={editingRecipe.content?.pattern || ''}
            onChange={e => setEditingRecipe({ ...editingRecipe, content: { ...editingRecipe.content, pattern: e } as any })}
            language={codeLang}
            height="180px"
            showLineNumbers={true}
          />
          </div>
        </div>

        {/* 设计原理 */}
        <div>
          <label className="block text-xs font-bold text-[var(--fg-muted)] uppercase mb-1">{t('recipeEditor.rationale')}</label>
          <textarea
          className="w-full px-3 py-2 text-sm border border-[var(--border-default)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--accent-emphasis)] resize-y"
          rows={3}
          value={editingRecipe.content?.rationale || ''}
          onChange={e => setEditingRecipe({ ...editingRecipe, content: { ...editingRecipe.content, rationale: e.target.value } as any })}
          placeholder={t('recipeEditor.rationalePlaceholder')}
          />
        </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto space-y-6 scrollbar-light">
        {/* Recipe Metadata */}
        {(() => {
          const metaFields = ([
          ['trigger', editingRecipe.trigger],
          ['language', editingRecipe.language],
          ['category', editingRecipe.category],
          ['kind', editingRecipe.kind],
          ['knowledgeType', editingRecipe.knowledgeType],
          ['status', editingRecipe.status],
          ['complexity', editingRecipe.complexity],
          ['scope', editingRecipe.scope],
          ['source', editingRecipe.source],
          ['updatedAt', editingRecipe.updatedAt ? formatTimestamp(editingRecipe.updatedAt) : undefined],
          ] as [string, string | undefined][]).filter(([, v]) => !!v);
          if (metaFields.length === 0) return null;
          return (
          <div className="bg-[var(--bg-subtle)] border border-[var(--border-default)] rounded-2xl p-6">
            <h3 className="text-[10px] font-bold text-[var(--fg-muted)] uppercase tracking-widest mb-4">Recipe Metadata</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-y-4 gap-x-8">
            {metaFields.map(([key, value]) => (
              <div key={key} className="flex flex-col">
              <span className="text-[10px] text-[var(--fg-muted)] font-bold uppercase mb-1">{key}</span>
              <span className="text-sm text-[var(--fg-primary)] break-all font-medium">{value}</span>
              </div>
            ))}
            </div>
          </div>
          );
        })()}

        {/* Description */}
        {editingRecipe.description && (
          <div className="bg-[var(--bg-surface)] rounded-2xl border border-[var(--border-default)] p-6">
          <label className="text-[10px] font-bold text-[var(--fg-muted)] uppercase mb-2 block">{t('recipeEditor.description')}</label>
          <p className="text-sm text-[var(--fg-secondary)] leading-relaxed">{editingRecipe.description}</p>
          </div>
        )}

        {/* Markdown 文档 */}
        {editingRecipe.content?.markdown && (
          <div className="bg-[var(--bg-surface)] rounded-2xl border border-blue-100 p-6">
          <label className="text-[10px] font-bold text-[var(--fg-muted)] uppercase mb-3 block flex items-center gap-1.5">
            <FileText size={11} className="text-blue-400" /> {t('recipeEditor.markdown')}
          </label>
          <div className="bg-blue-50/30 border border-blue-100 rounded-xl p-4">
            <div className="markdown-body text-sm text-[var(--fg-primary)] leading-relaxed">
            <MarkdownWithHighlight content={editingRecipe.content.markdown} />
            </div>
          </div>
          </div>
        )}

        {/* Code / 标准用法 */}
        {editingRecipe.content?.pattern && (
          <div className="bg-[var(--bg-surface)] rounded-2xl border border-emerald-100 p-6">
          <label className="text-[10px] font-bold text-[var(--fg-muted)] uppercase mb-3 block flex items-center gap-1.5">
            <Code2 size={11} className="text-emerald-500" /> {t('recipeEditor.code')}
          </label>
          <CodeBlock code={editingRecipe.content.pattern} language={codeLang} showLineNumbers />
          </div>
        )}

        {/* 设计原理 */}
        {editingRecipe.content?.rationale && (
          <div className="bg-[var(--bg-surface)] rounded-2xl border border-[var(--border-default)] p-6">
          <label className="text-[10px] font-bold text-[var(--fg-muted)] uppercase mb-2 block">{t('recipeEditor.rationale')}</label>
          <div className="bg-[var(--bg-subtle)] border border-[var(--border-default)] rounded-xl p-4">
            <p className="text-sm text-[var(--fg-secondary)] leading-relaxed">{editingRecipe.content.rationale}</p>
          </div>
          </div>
        )}

        {/* 实施步骤 */}
        {editingRecipe.content?.steps && editingRecipe.content.steps.length > 0 && (
          <div className="bg-[var(--bg-surface)] rounded-2xl border border-[var(--border-default)] p-6">
          <label className="text-[10px] font-bold text-[var(--fg-muted)] uppercase mb-2 block">{t('recipeEditor.steps')}</label>
          <div className="space-y-2">
            {editingRecipe.content.steps.map((step: any, i: number) => {
            if (typeof step === 'string') {
              return (
              <div key={i} className="bg-[var(--bg-subtle)] rounded-lg p-3 border border-[var(--border-default)] flex items-start gap-2.5">
                <span className="text-[10px] font-bold text-blue-600 bg-blue-50 rounded-full w-5 h-5 flex items-center justify-center shrink-0 mt-0.5">{i + 1}</span>
                <p className="text-xs text-[var(--fg-primary)] leading-relaxed">{step}</p>
              </div>
              );
            }
            return (
              <div key={i} className="bg-[var(--bg-subtle)] rounded-lg p-3 border border-[var(--border-default)]">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[10px] font-bold text-blue-600 bg-blue-50 rounded-full w-5 h-5 flex items-center justify-center shrink-0">{i + 1}</span>
                {step.title && <span className="text-xs font-bold text-[var(--fg-primary)]">{step.title}</span>}
              </div>
              {step.description && <p className="text-xs text-[var(--fg-secondary)] ml-7 leading-relaxed">{step.description}</p>}
              {step.code && <pre className="text-[11px] font-mono bg-slate-800 text-green-300 p-2.5 rounded-md mt-1.5 ml-7 overflow-x-auto whitespace-pre-wrap">{step.code}</pre>}
              </div>
            );
            })}
          </div>
          </div>
        )}

        {/* 代码变更 */}
        {editingRecipe.content?.codeChanges && editingRecipe.content.codeChanges.length > 0 && (
          <div className="bg-[var(--bg-surface)] rounded-2xl border border-[var(--border-default)] p-6">
          <label className="text-[10px] font-bold text-[var(--fg-muted)] uppercase mb-2 block">{t('recipeEditor.codeChanges')}</label>
          <div className="space-y-2">
            {editingRecipe.content.codeChanges.map((change, i) => (
            <div key={i} className="border border-[var(--border-default)] rounded-lg overflow-hidden">
              <div className="px-3 py-1.5 bg-[var(--bg-subtle)] border-b border-[var(--border-default)] flex items-center gap-2">
              <FileCode size={11} className="text-blue-400" />
              <code className="text-[10px] font-mono text-[var(--fg-secondary)]">{change.file}</code>
              </div>
              {change.explanation && <p className="text-[11px] text-[var(--fg-muted)] px-3 py-1.5 border-b border-[var(--border-default)] bg-yellow-50/30">{change.explanation}</p>}
              <div className="p-2 bg-red-50/20 border-b border-[var(--border-default)]">
              <div className="text-[9px] font-bold text-red-400 mb-0.5 uppercase">Before</div>
              <pre className="text-[11px] text-[var(--fg-secondary)] whitespace-pre-wrap break-words font-mono">{change.before || t('recipes.emptyValue')}</pre>
              </div>
              <div className="p-2 bg-emerald-50/20">
              <div className="text-[9px] font-bold text-emerald-500 mb-0.5 uppercase">After</div>
              <pre className="text-[11px] text-[var(--fg-primary)] whitespace-pre-wrap break-words font-mono">{change.after}</pre>
              </div>
            </div>
            ))}
          </div>
          </div>
        )}

        {/* 验证方法 */}
        {editingRecipe.content?.verification && (
          <div className="bg-[var(--bg-surface)] rounded-2xl border border-teal-100 p-6">
          <label className="text-[10px] font-bold text-[var(--fg-muted)] uppercase mb-2 block">{t('recipeEditor.validation')}</label>
          <div className="bg-teal-50/50 border border-teal-100 rounded-xl p-4 space-y-1.5">
            {editingRecipe.content.verification.method && <p className="text-xs text-[var(--fg-secondary)]"><span className="font-bold text-teal-600">{t('recipeEditor.validationMethod')}</span> {editingRecipe.content.verification.method}</p>}
            {editingRecipe.content.verification.expectedResult && <p className="text-xs text-[var(--fg-secondary)]"><span className="font-bold text-teal-600">{t('recipeEditor.validationExpected')}</span> {editingRecipe.content.verification.expectedResult}</p>}
            {editingRecipe.content.verification.testCode && <pre className="text-[11px] font-mono bg-slate-800 text-green-300 p-2.5 rounded-md overflow-x-auto whitespace-pre-wrap mt-1">{editingRecipe.content.verification.testCode}</pre>}
          </div>
          </div>
        )}

        {/* Tags */}
        {editingRecipe.tags && editingRecipe.tags.length > 0 && (
          <div className="bg-[var(--bg-subtle)] border border-[var(--border-default)] rounded-2xl p-6">
          <h3 className="text-[10px] font-bold text-[var(--fg-muted)] uppercase tracking-widest mb-3 flex items-center gap-1.5"><Tag size={11} className="text-blue-400" /> {t('recipeEditor.tags')}</h3>
          <div className="flex flex-wrap gap-1.5">
            {editingRecipe.tags.map((tag, i) => (
            <span key={i} className="px-2.5 py-1 bg-blue-50 text-blue-700 border border-blue-100 rounded-full text-xs font-medium">{tag}</span>
            ))}
          </div>
          </div>
        )}

        {/* Constraints */}
        {!!(editingRecipe.constraints && (
          editingRecipe.constraints.guards?.length || editingRecipe.constraints.boundaries?.length || editingRecipe.constraints.preconditions?.length || editingRecipe.constraints.sideEffects?.length
        )) && (
          <div className="bg-[var(--bg-subtle)] border border-[var(--border-default)] rounded-2xl p-6 space-y-4">
          <h3 className="text-[10px] font-bold text-[var(--fg-muted)] uppercase tracking-widest flex items-center gap-1.5"><Shield size={11} className="text-amber-500" /> {t('recipeEditor.constraints')}</h3>
          {editingRecipe.constraints.guards && editingRecipe.constraints.guards.length > 0 && (
            <div>
            <span className="text-xs font-semibold text-[var(--fg-muted)] block mb-1.5">{t('recipeEditor.guardRules')}</span>
            <ul className="text-sm text-[var(--fg-secondary)] space-y-1">
              {editingRecipe.constraints.guards.map((g, i) => (
              <li key={i} className="flex gap-2 items-start">
                <span className={`text-xs mt-0.5 ${g.severity === 'error' ? 'text-red-500' : 'text-yellow-500'}`}>●</span>
                <code className="font-mono text-xs bg-[var(--bg-subtle)] px-1.5 py-0.5 rounded">{g.pattern}</code>
                {g.message && <span className="text-xs text-[var(--fg-muted)]">— {g.message}</span>}
              </li>
              ))}
            </ul>
            </div>
          )}
          {editingRecipe.constraints.boundaries && editingRecipe.constraints.boundaries.length > 0 && (
            <div>
            <span className="text-xs font-semibold text-[var(--fg-muted)] block mb-1.5">{t('recipeEditor.boundaryConstraints')}</span>
            <ul className="text-sm text-[var(--fg-secondary)] space-y-1">
              {editingRecipe.constraints.boundaries.map((b, i) => (
              <li key={i} className="flex gap-2"><span className="text-orange-400">●</span>{b}</li>
              ))}
            </ul>
            </div>
          )}
          {editingRecipe.constraints.preconditions && editingRecipe.constraints.preconditions.length > 0 && (
            <div>
            <span className="text-xs font-semibold text-[var(--fg-muted)] block mb-1.5">{t('recipeEditor.preconditions')}</span>
            <ul className="text-sm text-[var(--fg-secondary)] space-y-1">
              {editingRecipe.constraints.preconditions.map((p, i) => (
              <li key={i} className="flex gap-2"><span className="text-blue-400">◆</span>{p}</li>
              ))}
            </ul>
            </div>
          )}
          {editingRecipe.constraints.sideEffects && editingRecipe.constraints.sideEffects.length > 0 && (
            <div>
            <span className="text-xs font-semibold text-[var(--fg-muted)] block mb-1.5">{t('recipeEditor.sideEffects')}</span>
            <ul className="text-sm text-[var(--fg-secondary)] space-y-1">
              {editingRecipe.constraints.sideEffects.map((s, i) => (
              <li key={i} className="flex gap-2"><span className="text-pink-400">⚡</span>{s}</li>
              ))}
            </ul>
            </div>
          )}
          </div>
        )}

        {/* Relations */}
        {editingRecipe.relations && Object.entries(editingRecipe.relations).some(([, v]) => Array.isArray(v) && v.length > 0) && (
          <div className="bg-[var(--bg-subtle)] border border-[var(--border-default)] rounded-2xl p-6">
          <h3 className="text-[10px] font-bold text-[var(--fg-muted)] uppercase tracking-widest mb-4">{t('recipeEditor.relations')}</h3>
          <div className="space-y-2">
            {([
            { key: 'inherits', label: t('recipeEditor.relationTypes.inherits'), color: 'text-green-600', icon: '↑' },
            { key: 'implements', label: t('recipeEditor.relationTypes.implements'), color: 'text-blue-600', icon: '◇' },
            { key: 'calls', label: t('recipeEditor.relationTypes.calls'), color: 'text-cyan-600', icon: '→' },
            { key: 'dependsOn', label: t('recipeEditor.relationTypes.dependsOn'), color: 'text-yellow-600', icon: '⊕' },
            { key: 'dataFlow', label: t('recipeEditor.relationTypes.dataFlow'), color: 'text-purple-600', icon: '⇢' },
            { key: 'conflicts', label: t('recipeEditor.relationTypes.conflicts'), color: 'text-red-600', icon: '✕' },
            { key: 'extends', label: t('recipeEditor.relationTypes.extends'), color: 'text-teal-600', icon: '⊃' },
            { key: 'related', label: t('recipeEditor.relationTypes.associates'), color: 'text-[var(--fg-muted)]', icon: '∼' },
            ] as const).map(({ key, label, color, icon }) => {
            const items = editingRecipe.relations?.[key];
            if (!items || !Array.isArray(items) || items.length === 0) return null;
            return (
              <div key={key} className="flex items-start gap-3">
              <span className={`text-xs font-mono ${color} shrink-0 whitespace-nowrap pt-0.5`}>{icon} {label}</span>
              <div className="flex flex-wrap gap-1.5">
                {items.map((r: any, i: number) => (
                <span key={i} className="px-2 py-0.5 bg-[var(--bg-surface)] border border-[var(--border-default)] text-[var(--fg-secondary)] rounded-lg text-xs font-mono">
                  {typeof r === 'string' ? r : r.id || r.title || JSON.stringify(r)}
                </span>
                ))}
              </div>
              </div>
            );
            })}
          </div>
          </div>
        )}

        {/* 无内容时的提示 */}
        {!editingRecipe.content?.markdown && !editingRecipe.content?.pattern && !editingRecipe.description && (
          <div className="bg-[var(--bg-surface)] p-8 rounded-2xl border border-[var(--border-default)] shadow-sm min-h-[200px] flex items-center justify-center">
          <div className="text-[var(--fg-muted)] italic">{t('recipeEditor.noContent')}</div>
          </div>
        )}
        </div>
      )}
      </div>
    </div>
    <div className="p-6 border-t border-[var(--border-default)] flex justify-end gap-3">
      <button onClick={closeRecipeEdit} disabled={isSavingRecipe} className="px-4 py-2 text-[var(--fg-secondary)] font-medium disabled:opacity-50">{t('recipeEditor.cancel')}</button>
      <button onClick={handleSaveRecipe} disabled={isSavingRecipe} className="px-6 py-2 bg-blue-600 text-white rounded-lg font-medium flex items-center gap-2 hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed">
      {isSavingRecipe ? <Loader2 size={ICON_SIZES.lg} className="animate-spin" /> : <Save size={ICON_SIZES.lg} />}
      {isSavingRecipe ? t('recipeEditor.saving') : t('recipeEditor.saveChanges')}
      </button>
    </div>
    </div>
  </PageOverlay>
  );
};

export default RecipeEditor;
