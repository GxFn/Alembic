import React, { useState, useRef, useEffect } from 'react';
import { X, Save, Eye, Edit3, Loader2, Shield, Lightbulb, BookOpen, FileText, FileCode, Code2, Tag } from 'lucide-react';
import { Recipe } from '../../types';
import api from '../../api';
import MarkdownWithHighlight from '../Shared/MarkdownWithHighlight';
import HighlightedCodeEditor from '../Shared/HighlightedCodeEditor';
import CodeBlock from '../Shared/CodeBlock';
import { ICON_SIZES } from '../../constants/icons';
import PageOverlay from '../Shared/PageOverlay';

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
    return editingRecipe.language || 'swift';
  })();

  const handleSetAuthority = async (authority: number) => {
    try {
      await api.setRecipeAuthority(editingRecipe.name, authority);
      if (isMountedRef.current) {
        const stats = editingRecipe.stats ? { ...editingRecipe.stats, authority } : { ...defaultStats, authority };
        setEditingRecipe({ ...editingRecipe, stats });
      }
    } catch (err: any) {
      console.warn('设置权威分失败:', err?.message);
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
    <div className="relative bg-white w-full max-w-6xl rounded-2xl shadow-2xl flex flex-col h-[85vh]">
    <div className="p-6 border-b border-slate-100 flex justify-between items-center flex-wrap gap-4">
      <div className="flex items-center gap-3">
      <h2 className="text-xl font-bold">Edit Recipe</h2>
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
        editingRecipe.status === 'draft' ? 'bg-slate-50 text-slate-500 border-slate-200' :
        editingRecipe.status === 'archived' ? 'bg-orange-50 text-orange-600 border-orange-200' :
        'bg-slate-50 text-slate-500 border-slate-200'
        }`}>{editingRecipe.status}</span>
      )}
      </div>
      <div className="flex items-center gap-4">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-slate-500">权威分</span>
        {viewMode === 'preview' ? (
        <span className="text-sm text-slate-700">{(editingRecipe.stats?.authority ?? 3)}</span>
        ) : (
        <select 
          className="font-bold text-amber-600 bg-amber-50 border border-amber-100 px-2 py-1 rounded-lg outline-none text-[10px] focus:ring-2 focus:ring-amber-500"
          value={editingRecipe.stats?.authority ?? 3}
          onChange={e => handleSetAuthority(parseInt(e.target.value))}
        >
          <option value="1">⭐ 1 - Basic</option>
          <option value="2">⭐⭐ 2 - Good</option>
          <option value="3">⭐⭐⭐ 3 - Solid</option>
          <option value="4">⭐⭐⭐⭐ 4 - Great</option>
          <option value="5">⭐⭐⭐⭐⭐ 5 - Excellent</option>
        </select>
        )}
      </div>
      <div className="flex bg-slate-100 p-1 rounded-lg mr-4">
        <button 
        onClick={() => setViewMode('preview')} 
        className={`px-4 py-1.5 rounded-md text-xs font-bold transition-all flex items-center gap-2 ${viewMode === 'preview' ? 'bg-white shadow-sm text-blue-600' : 'text-slate-400'}`}
        >
        <Eye size={ICON_SIZES.sm} /> Preview
        </button>
        <button 
        onClick={() => setViewMode('edit')} 
        className={`px-4 py-1.5 rounded-md text-xs font-bold transition-all flex items-center gap-2 ${viewMode === 'edit' ? 'bg-white shadow-sm text-blue-600' : 'text-slate-400'}`}
        >
        <Edit3 size={ICON_SIZES.sm} /> Edit
        </button>
      </div>
      <button onClick={closeRecipeEdit} className="p-2 hover:bg-slate-100 rounded-full"><X size={ICON_SIZES.lg} /></button>
      </div>
    </div>
    <div className="p-6 space-y-4 flex-1 flex flex-col overflow-hidden">
      <div className="flex-1 flex flex-col min-h-0">
      {viewMode === 'edit' ? (
        <div className="flex-1 overflow-y-auto space-y-5 pr-1">
        {/* Path */}
        <div>
          <label className="block text-xs font-bold text-slate-400 uppercase mb-1">Path</label>
          <input className="w-full p-2 bg-slate-50 border border-slate-200 rounded-lg text-sm" value={editingRecipe.name} onChange={e => setEditingRecipe({ ...editingRecipe, name: e.target.value })} />
        </div>

        {/* Description */}
        <div>
          <label className="block text-xs font-bold text-slate-400 uppercase mb-1">描述</label>
          <textarea
          className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-300 resize-none"
          rows={2}
          value={editingRecipe.description || ''}
          onChange={e => setEditingRecipe({ ...editingRecipe, description: e.target.value })}
          placeholder="Recipe 摘要描述..."
          />
        </div>

        {/* Markdown 文档 */}
        <div>
          <label className="block text-xs font-bold text-slate-400 uppercase mb-1.5 flex items-center gap-1.5">
          <FileText size={11} className="text-blue-400" /> Markdown 文档
          </label>
          <div className="border border-slate-200 rounded-lg overflow-hidden" style={{ minHeight: 180 }}>
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
          <label className="block text-xs font-bold text-slate-400 uppercase mb-1.5 flex items-center gap-1.5">
          <Code2 size={11} className="text-emerald-500" /> 代码 / 标准用法
          </label>
          <div className="border border-slate-200 rounded-lg overflow-hidden" style={{ minHeight: 180 }}>
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
          <label className="block text-xs font-bold text-slate-400 uppercase mb-1">设计原理</label>
          <textarea
          className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-300 resize-y"
          rows={3}
          value={editingRecipe.content?.rationale || ''}
          onChange={e => setEditingRecipe({ ...editingRecipe, content: { ...editingRecipe.content, rationale: e.target.value } as any })}
          placeholder="为何采用此方案..."
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
          <div className="bg-slate-50 border border-slate-200 rounded-2xl p-6">
            <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-4">Recipe Metadata</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-y-4 gap-x-8">
            {metaFields.map(([key, value]) => (
              <div key={key} className="flex flex-col">
              <span className="text-[10px] text-slate-400 font-bold uppercase mb-1">{key}</span>
              <span className="text-sm text-slate-700 break-all font-medium">{value}</span>
              </div>
            ))}
            </div>
          </div>
          );
        })()}

        {/* Description */}
        {editingRecipe.description && (
          <div className="bg-white rounded-2xl border border-slate-100 p-6">
          <label className="text-[10px] font-bold text-slate-400 uppercase mb-2 block">摘要</label>
          <p className="text-sm text-slate-600 leading-relaxed">{editingRecipe.description}</p>
          </div>
        )}

        {/* Markdown 文档 */}
        {editingRecipe.content?.markdown && (
          <div className="bg-white rounded-2xl border border-blue-100 p-6">
          <label className="text-[10px] font-bold text-slate-400 uppercase mb-3 block flex items-center gap-1.5">
            <FileText size={11} className="text-blue-400" /> Markdown 文档
          </label>
          <div className="bg-blue-50/30 border border-blue-100 rounded-xl p-4">
            <div className="markdown-body text-sm text-slate-700 leading-relaxed">
            <MarkdownWithHighlight content={editingRecipe.content.markdown} />
            </div>
          </div>
          </div>
        )}

        {/* Code / 标准用法 */}
        {editingRecipe.content?.pattern && (
          <div className="bg-white rounded-2xl border border-emerald-100 p-6">
          <label className="text-[10px] font-bold text-slate-400 uppercase mb-3 block flex items-center gap-1.5">
            <Code2 size={11} className="text-emerald-500" /> 代码 / 标准用法
          </label>
          <CodeBlock code={editingRecipe.content.pattern} language={codeLang} showLineNumbers />
          </div>
        )}

        {/* 设计原理 */}
        {editingRecipe.content?.rationale && (
          <div className="bg-white rounded-2xl border border-slate-100 p-6">
          <label className="text-[10px] font-bold text-slate-400 uppercase mb-2 block">设计原理</label>
          <div className="bg-slate-50 border border-slate-100 rounded-xl p-4">
            <p className="text-sm text-slate-600 leading-relaxed">{editingRecipe.content.rationale}</p>
          </div>
          </div>
        )}

        {/* 实施步骤 */}
        {editingRecipe.content?.steps && editingRecipe.content.steps.length > 0 && (
          <div className="bg-white rounded-2xl border border-slate-100 p-6">
          <label className="text-[10px] font-bold text-slate-400 uppercase mb-2 block">实施步骤</label>
          <div className="space-y-2">
            {editingRecipe.content.steps.map((step: any, i: number) => {
            if (typeof step === 'string') {
              return (
              <div key={i} className="bg-slate-50 rounded-lg p-3 border border-slate-100 flex items-start gap-2.5">
                <span className="text-[10px] font-bold text-blue-600 bg-blue-50 rounded-full w-5 h-5 flex items-center justify-center shrink-0 mt-0.5">{i + 1}</span>
                <p className="text-xs text-slate-700 leading-relaxed">{step}</p>
              </div>
              );
            }
            return (
              <div key={i} className="bg-slate-50 rounded-lg p-3 border border-slate-100">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[10px] font-bold text-blue-600 bg-blue-50 rounded-full w-5 h-5 flex items-center justify-center shrink-0">{i + 1}</span>
                {step.title && <span className="text-xs font-bold text-slate-700">{step.title}</span>}
              </div>
              {step.description && <p className="text-xs text-slate-600 ml-7 leading-relaxed">{step.description}</p>}
              {step.code && <pre className="text-[11px] font-mono bg-slate-800 text-green-300 p-2.5 rounded-md mt-1.5 ml-7 overflow-x-auto whitespace-pre-wrap">{step.code}</pre>}
              </div>
            );
            })}
          </div>
          </div>
        )}

        {/* 代码变更 */}
        {editingRecipe.content?.codeChanges && editingRecipe.content.codeChanges.length > 0 && (
          <div className="bg-white rounded-2xl border border-slate-100 p-6">
          <label className="text-[10px] font-bold text-slate-400 uppercase mb-2 block">代码变更</label>
          <div className="space-y-2">
            {editingRecipe.content.codeChanges.map((change, i) => (
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

        {/* 验证方法 */}
        {editingRecipe.content?.verification && (
          <div className="bg-white rounded-2xl border border-teal-100 p-6">
          <label className="text-[10px] font-bold text-slate-400 uppercase mb-2 block">验证方法</label>
          <div className="bg-teal-50/50 border border-teal-100 rounded-xl p-4 space-y-1.5">
            {editingRecipe.content.verification.method && <p className="text-xs text-slate-600"><span className="font-bold text-teal-600">方法:</span> {editingRecipe.content.verification.method}</p>}
            {editingRecipe.content.verification.expectedResult && <p className="text-xs text-slate-600"><span className="font-bold text-teal-600">预期:</span> {editingRecipe.content.verification.expectedResult}</p>}
            {editingRecipe.content.verification.testCode && <pre className="text-[11px] font-mono bg-slate-800 text-green-300 p-2.5 rounded-md overflow-x-auto whitespace-pre-wrap mt-1">{editingRecipe.content.verification.testCode}</pre>}
          </div>
          </div>
        )}

        {/* Tags */}
        {editingRecipe.tags && editingRecipe.tags.length > 0 && (
          <div className="bg-slate-50 border border-slate-200 rounded-2xl p-6">
          <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-3 flex items-center gap-1.5"><Tag size={11} className="text-blue-400" /> 标签</h3>
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
          <div className="bg-slate-50 border border-slate-200 rounded-2xl p-6 space-y-4">
          <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest flex items-center gap-1.5"><Shield size={11} className="text-amber-500" /> 约束条件</h3>
          {editingRecipe.constraints.guards && editingRecipe.constraints.guards.length > 0 && (
            <div>
            <span className="text-xs font-semibold text-slate-500 block mb-1.5">Guard 规则</span>
            <ul className="text-sm text-slate-600 space-y-1">
              {editingRecipe.constraints.guards.map((g, i) => (
              <li key={i} className="flex gap-2 items-start">
                <span className={`text-xs mt-0.5 ${g.severity === 'error' ? 'text-red-500' : 'text-yellow-500'}`}>●</span>
                <code className="font-mono text-xs bg-slate-100 px-1.5 py-0.5 rounded">{g.pattern}</code>
                {g.message && <span className="text-xs text-slate-400">— {g.message}</span>}
              </li>
              ))}
            </ul>
            </div>
          )}
          {editingRecipe.constraints.boundaries && editingRecipe.constraints.boundaries.length > 0 && (
            <div>
            <span className="text-xs font-semibold text-slate-500 block mb-1.5">边界约束</span>
            <ul className="text-sm text-slate-600 space-y-1">
              {editingRecipe.constraints.boundaries.map((b, i) => (
              <li key={i} className="flex gap-2"><span className="text-orange-400">●</span>{b}</li>
              ))}
            </ul>
            </div>
          )}
          {editingRecipe.constraints.preconditions && editingRecipe.constraints.preconditions.length > 0 && (
            <div>
            <span className="text-xs font-semibold text-slate-500 block mb-1.5">前置条件</span>
            <ul className="text-sm text-slate-600 space-y-1">
              {editingRecipe.constraints.preconditions.map((p, i) => (
              <li key={i} className="flex gap-2"><span className="text-blue-400">◆</span>{p}</li>
              ))}
            </ul>
            </div>
          )}
          {editingRecipe.constraints.sideEffects && editingRecipe.constraints.sideEffects.length > 0 && (
            <div>
            <span className="text-xs font-semibold text-slate-500 block mb-1.5">副作用</span>
            <ul className="text-sm text-slate-600 space-y-1">
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
          <div className="bg-slate-50 border border-slate-200 rounded-2xl p-6">
          <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-4">关系图 (Relations)</h3>
          <div className="space-y-2">
            {([
            { key: 'inherits', label: '继承', color: 'text-green-600', icon: '↑' },
            { key: 'implements', label: '实现', color: 'text-blue-600', icon: '◇' },
            { key: 'calls', label: '调用', color: 'text-cyan-600', icon: '→' },
            { key: 'dependsOn', label: '依赖', color: 'text-yellow-600', icon: '⊕' },
            { key: 'dataFlow', label: '数据流', color: 'text-purple-600', icon: '⇢' },
            { key: 'conflicts', label: '冲突', color: 'text-red-600', icon: '✕' },
            { key: 'extends', label: '扩展', color: 'text-teal-600', icon: '⊃' },
            { key: 'related', label: '关联', color: 'text-slate-500', icon: '∼' },
            ] as const).map(({ key, label, color, icon }) => {
            const items = editingRecipe.relations?.[key];
            if (!items || !Array.isArray(items) || items.length === 0) return null;
            return (
              <div key={key} className="flex items-start gap-3">
              <span className={`text-xs font-mono ${color} w-16 shrink-0 pt-0.5`}>{icon} {label}</span>
              <div className="flex flex-wrap gap-1.5">
                {items.map((r: any, i: number) => (
                <span key={i} className="px-2 py-0.5 bg-white border border-slate-200 text-slate-600 rounded-lg text-xs font-mono">
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
          <div className="bg-white p-8 rounded-2xl border border-slate-100 shadow-sm min-h-[200px] flex items-center justify-center">
          <div className="text-slate-300 italic">No content</div>
          </div>
        )}
        </div>
      )}
      </div>
    </div>
    <div className="p-6 border-t border-slate-100 flex justify-end gap-3">
      <button onClick={closeRecipeEdit} disabled={isSavingRecipe} className="px-4 py-2 text-slate-600 font-medium disabled:opacity-50">Cancel</button>
      <button onClick={handleSaveRecipe} disabled={isSavingRecipe} className="px-6 py-2 bg-blue-600 text-white rounded-lg font-medium flex items-center gap-2 hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed">
      {isSavingRecipe ? <Loader2 size={ICON_SIZES.lg} className="animate-spin" /> : <Save size={ICON_SIZES.lg} />}
      {isSavingRecipe ? '保存中...' : 'Save Changes'}
      </button>
    </div>
    </div>
  </PageOverlay>
  );
};

export default RecipeEditor;
