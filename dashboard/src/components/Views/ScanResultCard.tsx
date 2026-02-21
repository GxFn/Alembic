import React, { useState } from 'react';
import { Zap, CheckCircle, Pencil, Check, GitCompare, Inbox, Layers, Loader2 } from 'lucide-react';
import { ScanResultItem, SimilarRecipe } from '../../types';
import { categories, LANGUAGE_OPTIONS, normalizeLanguageId, languageDisplayName, importPlaceholder } from '../../constants';
import { ICON_SIZES } from '../../constants/icons';
import CodeBlock from '../Shared/CodeBlock';
import HighlightedCodeEditor from '../Shared/HighlightedCodeEditor';
import { useI18n } from '../../i18n';

/* ═══════════════════════════════════════════════════════
 *  ScanResultCard — Pipeline Unification v2 审核卡片
 *
 *  基于全新字段结构重构：
 *  - Cursor Delivery (doClause / dontClause / whenClause) 作为核心编辑区
 *  - content.markdown (项目特写) + content.pattern (代码模板) 分离
 *  - TopicHint 路由控制
 *  - 移除: 内容语言切换、知识类型、适用范围等冗余控件
 * ═══════════════════════════════════════════════════════ */

interface ScanResultCardProps {
  res: ScanResultItem;
  index: number;
  /* code editing */
  editingCodeIndex: number | null;
  setEditingCodeIndex: (i: number | null) => void;
  /* header expansion */
  expandedEditIndex: number | null;
  setExpandedEditIndex: (i: number | null) => void;
  /* similarity */
  similarityMap: Record<string, SimilarRecipe[]>;
  /* callbacks */
  handleUpdateScanResult: (index: number, updates: any) => void;
  handleSaveExtracted: (res: any) => void;
  handlePromoteToCandidate?: (res: ScanResultItem, index: number) => void;
  openCompare: (res: ScanResultItem, recipeName: string, similarList: SimilarRecipe[]) => void;
  isSavingRecipe?: boolean;
}

/* ── helpers ── */
const codeLang = (res: { language?: string }) => {
  return normalizeLanguageId(res.language) || 'text';
};

/**
 * 从 header 字符串中提取核心模块/文件名，用于在代码中搜索引用
 * e.g. '#import "BDVideoPlayerView.h"' → ['BDVideoPlayerView']
 *      '#import <SDWebImage/SDWebImage.h>' → ['SDWebImage']
 *      'import BDUIKit' → ['BDUIKit']
 */
function extractHeaderSymbols(header: string): string[] {
  const symbols: string[] = [];
  const objcQuote = header.match(/#import\s+"([^"]+)"/);
  if (objcQuote) {
    const fname = objcQuote[1].replace(/\.h$/, '');
    symbols.push(fname);
  }
  const objcAngle = header.match(/#import\s+<([^>]+)>/);
  if (objcAngle) {
    const parts = objcAngle[1].replace(/\.h$/, '').split('/');
    symbols.push(...parts);
  }
  const swiftImport = header.match(/^import\s+(\w+)/);
  if (swiftImport) symbols.push(swiftImport[1]);
  const atImport = header.match(/@import\s+(\w+)/);
  if (atImport) symbols.push(atImport[1]);
  return [...new Set(symbols.filter(Boolean))];
}

/** 判断 header 是否在代码中被引用 */
function isHeaderUsedInCode(header: string, code: string): 'used' | 'unused' | 'unknown' {
  if (!code || !code.trim()) return 'unknown';
  const symbols = extractHeaderSymbols(header);
  if (symbols.length === 0) return 'unknown';
  return symbols.some(sym => code.includes(sym)) ? 'used' : 'unused';
}

/** 归一化 ObjC header 格式 */
function normalizeObjCHeader(header: string): string {
  if (header.startsWith('#import ') || header.startsWith('import ') || header.startsWith('@import ')) {
    return header.trim();
  }
  if (header.startsWith('<') || header.startsWith('"')) {
    return `#import ${header.trim()}`;
  }
  return header.trim();
}

/* ── V3 统一数据模型：直接使用 KnowledgeEntry 原生字段 ── */

const TOPIC_OPTIONS = [
  { value: '', label: '—' },
  { value: 'networking', label: 'Networking' },
  { value: 'ui', label: 'UI' },
  { value: 'data', label: 'Data' },
  { value: 'architecture', label: 'Architecture' },
  { value: 'conventions', label: 'Conventions' },
];

/**
 * 判断该条目是否可以提取为 Xcode Snippet。
 * 仅当 content.pattern 看起来是实际代码（而非 Markdown/纯文本）时才能生成 Snippet。
 */
const canExtractSnippet = (res: ScanResultItem): boolean => {
  const codeText = (res.content?.pattern || '').trim();
  if (!codeText) return false;
  const lines = codeText.split('\n').filter(l => l.trim());
  const mdLines = lines.filter(l => /^\s*(#{1,6}\s|[-*>]\s|\d+\.\s)/.test(l));
  if (mdLines.length > lines.length * 0.3) return false;
  return true;
};

/* ═══════════════════════════════════════════════════════
 *  Main Component
 * ═══════════════════════════════════════════════════════ */

const ScanResultCard: React.FC<ScanResultCardProps> = ({
  res,
  index: i,
  editingCodeIndex,
  setEditingCodeIndex,
  expandedEditIndex,
  setExpandedEditIndex,
  similarityMap,
  handleUpdateScanResult,
  handleSaveExtracted,
  handlePromoteToCandidate,
  openCompare,
  isSavingRecipe = false,
}) => {
  const { t } = useI18n();
  const [editingArticle, setEditingArticle] = useState(false);

  const isExpanded = expandedEditIndex === i;
  const headers = res.headers || [];
  const code = res.content?.pattern || '';
  const article = res.content?.markdown || '';
  const description = res.description || '';
  const tags = res.tags || [];
  const snippetAble = canExtractSnippet(res);

  /** 安全更新 content 子字段 */
  const updateContent = (field: 'pattern' | 'markdown', value: string) => {
    handleUpdateScanResult(i, {
      content: { ...(res.content || {}), [field]: value },
    });
  };

  return (
    <div className="bg-slate-50 dark:bg-[#1a1d24] rounded-2xl border border-slate-200 dark:border-slate-700 overflow-hidden shadow-sm">

      {/* ═══ SECTION 1: Header — Title + Badges + Actions ═══ */}
      <div className="px-5 pt-4 pb-3 bg-gradient-to-b from-white to-slate-50/50 dark:from-[#252526] dark:to-[#1e1e1e] border-b border-slate-100 dark:border-slate-700">
        <div className="flex items-start justify-between gap-4 mb-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <label className="text-[9px] font-bold text-slate-400 uppercase tracking-wider ml-0.5">{t('scanResult.knowledgeEntryTitle')}</label>
              {res.scanMode === 'project' ? (
                <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700 border border-indigo-200 flex items-center gap-1">
                  <Layers size={10} /> PROJECT
                </span>
              ) : res.scanMode === 'target' ? (
                <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 border border-blue-200 flex items-center gap-1">
                  <Zap size={10} /> {res.candidateTargetName || 'TARGET'}
                </span>
              ) : res.lifecycle ? (
                <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded flex items-center gap-1 ${
                  res.lifecycle === 'pending' ? 'bg-amber-100 text-amber-700 border border-amber-200' :
                  res.lifecycle === 'active' ? 'bg-green-100 text-green-700 border border-green-200' :
                  'bg-slate-100 text-slate-600 border border-slate-200'
                }`}>
                  {res.lifecycle === 'pending' ? t('scanResult.lifecyclePending') :
                   res.lifecycle === 'active' ? t('scanResult.lifecycleActive') :
                   res.lifecycle === 'deprecated' ? t('scanResult.lifecycleDeprecated') : res.lifecycle}
                </span>
              ) : null}
              {res.source && res.source !== 'unknown' && (
                <span className="text-[9px] font-medium px-1.5 py-0.5 rounded bg-violet-50 text-violet-600 border border-violet-100">
                  {res.source === 'agent' ? 'AI Agent' : res.source === 'bootstrap-scan' ? t('scanResult.aiScan') : res.source}
                </span>
              )}
            </div>
            <input
              className="font-semibold bg-transparent border-b-2 border-transparent hover:border-slate-200 focus:border-blue-500 outline-none px-0.5 text-lg w-full text-slate-800 placeholder:text-slate-300"
              value={res.title || ''}
              onChange={e => handleUpdateScanResult(i, { title: e.target.value })}
            />
          </div>
          <div className="flex gap-2 shrink-0 pt-3">
            {handlePromoteToCandidate && (
              <button
                onClick={() => handlePromoteToCandidate(res, i)}
                className="text-xs px-4 py-2 rounded-lg font-bold transition-all shadow-sm flex items-center gap-1.5 active:scale-95 bg-white dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-700/40 hover:bg-emerald-50 dark:hover:bg-emerald-500/20 whitespace-nowrap"
              >
                <Inbox size={ICON_SIZES.md} />
                Candidate
              </button>
            )}
            <button
              onClick={() => handleSaveExtracted(res)}
              disabled={isSavingRecipe}
              className={`text-xs px-4 py-2 rounded-lg font-bold transition-all shadow-sm flex items-center gap-1.5 active:scale-95 disabled:opacity-60 disabled:cursor-not-allowed whitespace-nowrap ${
                snippetAble && res.mode === 'full'
                  ? 'bg-blue-600 text-white hover:bg-blue-700 dark:bg-blue-500/20 dark:text-blue-300 dark:hover:bg-blue-500/30 dark:border dark:border-blue-500/30'
                  : 'bg-amber-600 text-white hover:bg-amber-700 dark:bg-amber-500/20 dark:text-amber-300 dark:hover:bg-amber-500/30 dark:border dark:border-amber-500/30'
              }`}
            >
              {isSavingRecipe ? <Loader2 size={ICON_SIZES.md} className="animate-spin" /> : <CheckCircle size={ICON_SIZES.md} />}
              {isSavingRecipe ? t('scanResult.saving') : snippetAble ? t('scanResult.saveAsRecipe') : t('scanResult.saveAsKnowledge')}
            </button>
          </div>
        </div>

        {/* ═══ SECTION 2: Controls — Trigger / Kind / Topic / Category / Language ═══ */}
        <div className="flex items-end gap-3 flex-wrap">
          <div className="flex flex-col">
            <label className="text-[9px] font-bold text-slate-400 uppercase tracking-wider ml-0.5 mb-1">{t('scanResult.trigger')}</label>
            <input
              className="font-mono font-bold text-blue-600 bg-blue-50/80 border border-blue-100 px-2.5 py-1 rounded-md outline-none text-xs focus:ring-2 focus:ring-blue-500/20 w-44"
              value={res.trigger || ''}
              placeholder={t('scanResult.triggerPlaceholder')}
              onChange={e => handleUpdateScanResult(i, { trigger: e.target.value })}
            />
          </div>
          <div className="flex flex-col">
            <label className="text-[9px] font-bold text-slate-400 uppercase tracking-wider ml-0.5 mb-1">Kind</label>
            <select
              className="font-bold text-slate-600 dark:text-slate-300 bg-white dark:bg-[#252a36] border border-slate-200 dark:border-slate-600 px-2 py-1 rounded-md outline-none text-[11px] focus:ring-2 focus:ring-blue-500/20"
              value={res.kind || 'pattern'}
              onChange={e => handleUpdateScanResult(i, { kind: e.target.value })}
            >
              <option value="rule">Rule</option>
              <option value="pattern">Pattern</option>
              <option value="fact">Fact</option>
            </select>
          </div>
          <div className="flex flex-col">
            <label className="text-[9px] font-bold text-slate-400 uppercase tracking-wider ml-0.5 mb-1">Topic</label>
            <select
              className="font-bold text-slate-600 dark:text-slate-300 bg-white dark:bg-[#252a36] border border-slate-200 dark:border-slate-600 px-2 py-1 rounded-md outline-none text-[11px] focus:ring-2 focus:ring-blue-500/20"
              value={res.topicHint || ''}
              onChange={e => handleUpdateScanResult(i, { topicHint: e.target.value })}
            >
              {TOPIC_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
          <div className="flex flex-col">
            <label className="text-[9px] font-bold text-slate-400 uppercase tracking-wider ml-0.5 mb-1">{t('scanResult.category')}</label>
            <select
              className="font-bold text-slate-600 dark:text-slate-300 bg-white dark:bg-[#252a36] border border-slate-200 dark:border-slate-600 px-2 py-1 rounded-md outline-none text-[11px] focus:ring-2 focus:ring-blue-500/20"
              value={res.category || ''}
              onChange={e => handleUpdateScanResult(i, { category: e.target.value })}
            >
              {categories.filter(c => c !== 'All').map(cat => (
                <option key={cat} value={cat}>{cat}</option>
              ))}
            </select>
          </div>
          <>
            <div className="w-px h-6 bg-slate-200 self-end mb-0.5" />
            <div className="flex flex-col">
              <label className="text-[9px] font-bold text-slate-400 uppercase tracking-wider ml-0.5 mb-1">{t('scanResult.language')}</label>
              <select
                className="font-bold text-slate-600 dark:text-slate-300 bg-white dark:bg-[#252a36] border border-slate-200 dark:border-slate-600 px-2 py-1 rounded-md outline-none text-[11px] focus:ring-2 focus:ring-blue-500/20"
                value={normalizeLanguageId(res.language)}
                onChange={e => handleUpdateScanResult(i, { language: e.target.value })}
              >
                {LANGUAGE_OPTIONS.map(opt => (
                  <option key={opt.id} value={opt.id}>{opt.label}</option>
                ))}
              </select>
            </div>
          </>
          {res.moduleName && (
            <>
              <div className="w-px h-6 bg-slate-200 self-end mb-0.5" />
              <div className="flex flex-col">
                <label className="text-[9px] font-bold text-slate-400 uppercase tracking-wider ml-0.5 mb-1">{t('scanResult.module')}</label>
                <span className="text-[11px] bg-purple-50 text-purple-700 border border-purple-100 px-2 py-1 rounded-md font-mono font-bold">{res.moduleName}</span>
              </div>
            </>
          )}
          {/* ── Mode / Difficulty / Authority ── */}
          <div className="w-px h-6 bg-slate-200 self-end mb-0.5" />
          {snippetAble && (
            <div className="flex flex-col">
              <label className="text-[9px] font-bold text-slate-400 uppercase tracking-wider ml-0.5 mb-1">{t('scanResult.mode')}</label>
              <div className="flex bg-white dark:bg-[#252a36] p-0.5 rounded-md border border-slate-200 dark:border-slate-600">
                <button
                  onClick={() => handleUpdateScanResult(i, { mode: 'full' })}
                  className={`px-2.5 py-0.5 rounded text-[10px] font-bold transition-all ${res.mode === 'full' ? 'bg-blue-100 shadow-sm text-blue-600' : 'text-slate-400 hover:text-slate-500'}`}
                >
                  Snippet+Recipe
                </button>
                <button
                  onClick={() => handleUpdateScanResult(i, { mode: 'preview' })}
                  className={`px-2.5 py-0.5 rounded text-[10px] font-bold transition-all ${res.mode === 'preview' ? 'bg-amber-100 shadow-sm text-amber-600' : 'text-slate-400 hover:text-slate-500'}`}
                >
                  Recipe Only
                </button>
              </div>
            </div>
          )}
          <div className="flex flex-col">
            <label className="text-[9px] font-bold text-slate-400 uppercase tracking-wider ml-0.5 mb-1">{t('scanResult.difficulty')}</label>
            <select
              className="font-bold text-slate-600 dark:text-slate-300 bg-white dark:bg-[#252a36] border border-slate-200 dark:border-slate-600 px-2 py-1 rounded-md outline-none text-[11px] focus:ring-2 focus:ring-purple-500/20"
              value={res.difficulty || 'intermediate'}
              onChange={e => handleUpdateScanResult(i, { difficulty: e.target.value, complexity: e.target.value })}
            >
              <option value="beginner">{t('scanResult.difficultyBeginner')}</option>
              <option value="intermediate">{t('scanResult.difficultyIntermediate')}</option>
              <option value="advanced">{t('scanResult.difficultyAdvanced')}</option>
            </select>
          </div>
          <div className="flex flex-col">
            <label className="text-[9px] font-bold text-slate-400 uppercase tracking-wider ml-0.5 mb-1">{t('scanResult.authorityScore')}</label>
            <select
              className="font-bold text-amber-600 bg-amber-50/60 border border-amber-100 px-2 py-1 rounded-md outline-none text-[11px] focus:ring-2 focus:ring-amber-500/20"
              value={res.authority ?? res.stats?.authority ?? 3}
              onChange={e => handleUpdateScanResult(i, { authority: parseInt(e.target.value) })}
            >
              <option value="1">⭐ 1</option>
              <option value="2">⭐⭐ 2</option>
              <option value="3">⭐⭐⭐ 3</option>
              <option value="4">⭐⭐⭐⭐ 4</option>
              <option value="5">⭐⭐⭐⭐⭐ 5</option>
            </select>
          </div>
        </div>

        {/* Tags */}
        <div className="mt-2.5">
          <div className="flex flex-wrap gap-1 items-center bg-white dark:bg-[#252a36] border border-slate-200 dark:border-slate-600 rounded-md px-1.5 py-0.5 min-h-[28px] focus-within:ring-2 focus-within:ring-blue-500/20">
            {tags.map((tag: string, ti: number) => (
              <span key={ti} className="flex items-center gap-0.5 text-[10px] font-bold bg-blue-50 text-blue-700 border border-blue-200 px-1.5 py-0 rounded">
                {tag}
                <button
                  onClick={() => { const newTags = [...tags]; newTags.splice(ti, 1); handleUpdateScanResult(i, { tags: newTags }); }}
                  className="text-blue-400 hover:text-red-500 transition-colors leading-none text-[10px]"
                  title="{t('scanResult.removeTag')}"
                >
                  &times;
                </button>
              </span>
            ))}
            <input
              className="flex-1 min-w-[80px] text-[11px] text-slate-600 outline-none bg-transparent py-0.5"
              placeholder={tags.length === 0 ? t('scanResult.tagsPlaceholder') : ''}
              onKeyDown={e => {
                const input = e.currentTarget;
                const val = input.value.trim();
                if ((e.key === 'Enter' || e.key === ',' || e.key === '，') && val) {
                  e.preventDefault();
                  const newTag = val.replace(/[,，]/g, '').trim();
                  if (newTag && !tags.includes(newTag)) {
                    handleUpdateScanResult(i, { tags: [...tags, newTag] });
                  }
                  input.value = '';
                } else if (e.key === 'Backspace' && !input.value && tags.length > 0) {
                  const newTags = [...tags];
                  newTags.pop();
                  handleUpdateScanResult(i, { tags: newTags });
                }
              }}
              onBlur={e => {
                const val = e.currentTarget.value.trim().replace(/[,，]/g, '').trim();
                if (val && !tags.includes(val)) {
                  handleUpdateScanResult(i, { tags: [...tags, val] });
                }
                e.currentTarget.value = '';
              }}
            />
          </div>
        </div>

        {/* ── Imports / Dependencies ── */}
        {snippetAble && headers.length > 0 && (
          <div className="mt-2 space-y-2">
            <div className="flex items-center gap-2">
              <label className="text-[10px] font-bold text-slate-400 uppercase">{t('scanResult.headers')}</label>
              <button
                onClick={() => setExpandedEditIndex(expandedEditIndex === i ? null : i)}
                className={`text-[10px] font-bold px-2 py-0.5 rounded-md transition-colors border ${isExpanded ? 'text-blue-700 bg-blue-100 border-blue-300' : 'text-blue-600 bg-blue-50 border-blue-100 hover:bg-blue-100'}`}
              >
                {isExpanded ? t('scanResult.collapseHeaders') : t('scanResult.editHeaders')} ({headers.length})
              </button>
              <div className="flex items-center gap-1.5">
                <span className="text-[9px] text-slate-400">Snippet:</span>
                <button
                  onClick={() => handleUpdateScanResult(i, { includeHeaders: !(res.includeHeaders !== false) })}
                  className={`w-7 h-4 rounded-full relative transition-colors ${res.includeHeaders !== false ? 'bg-blue-600' : 'bg-slate-300'}`}
                  title={res.includeHeaders !== false ? t('scanResultCard.includeMarkOn') : t('scanResultCard.includeMarkOff')}
                >
                  <div className={`absolute top-0.5 w-2.5 h-2.5 bg-white rounded-full transition-all ${res.includeHeaders !== false ? 'right-0.5' : 'left-0.5'}`} />
                </button>
                <span className="text-[9px] font-bold text-slate-600">{res.includeHeaders !== false ? 'ON' : 'OFF'}</span>
              </div>
              {/* Usage summary */}
              {(() => {
                const usedCount = headers.filter(h => isHeaderUsedInCode(h, code) === 'used').length;
                const unusedCount = headers.filter(h => isHeaderUsedInCode(h, code) === 'unused').length;
                return (
                  <span className="text-[9px] text-slate-400">
                    {usedCount > 0 && <span className="text-green-600 font-bold">{usedCount} {t('scanResult.referenced')}</span>}
                    {usedCount > 0 && unusedCount > 0 && ' · '}
                    {unusedCount > 0 && <span className="text-amber-600 font-bold">{unusedCount} {t('scanResult.unreferenced')}</span>}
                  </span>
                );
              })()}
            </div>

            {/* Headers expanded editing */}
            {isExpanded && (
              <div className="space-y-2 bg-slate-50/80 dark:bg-[#1e2028] rounded-lg p-3 border border-slate-200 dark:border-slate-700">
                <div className="flex items-center justify-end gap-1.5">
                  <button
                    onClick={() => {
                      const normalized = headers.map(h => normalizeObjCHeader(h));
                      handleUpdateScanResult(i, { headers: normalized });
                    }}
                    className="text-[9px] px-2 py-0.5 bg-slate-200 text-slate-600 rounded hover:bg-slate-300 font-bold"
                    title={t('scanResultCard.formatHeaders')}
                  >
                    {t('scanResult.formatHeaders')}
                  </button>
                  {headers.some(h => isHeaderUsedInCode(h, code) === 'unused') && (
                    <button
                      onClick={() => {
                        const kept = headers.filter(h => isHeaderUsedInCode(h, code) !== 'unused');
                        handleUpdateScanResult(i, { headers: kept });
                      }}
                      className="text-[9px] px-2 py-0.5 bg-amber-100 text-amber-700 rounded hover:bg-amber-200 font-bold"
                      title={t('scanResultCard.cleanUnused')}
                    >
                      {t('scanResult.cleanUnused')}
                    </button>
                  )}
                  <button
                    onClick={() => {
                      const newHeaders = [...headers, importPlaceholder(res.language)];
                      handleUpdateScanResult(i, { headers: newHeaders });
                    }}
                    className="text-[9px] px-2 py-0.5 bg-green-500 text-white rounded hover:bg-green-600 font-bold"
                  >
                    {t('scanResult.addHeader')}
                  </button>
                </div>
                <div className="space-y-1">
                  {headers.map((h, hi) => {
                    const usage = isHeaderUsedInCode(h, code);
                    return (
                      <div key={hi} className="flex items-center gap-2">
                        <span
                          className={`w-2 h-2 rounded-full shrink-0 ${
                            usage === 'used' ? 'bg-green-500' : usage === 'unused' ? 'bg-amber-400' : 'bg-slate-300'
                          }`}
                          title={usage === 'used' ? t('scanResult.usedInCode') : usage === 'unused' ? t('scanResult.unusedInCode') : t('scanResult.unknown')}
                        />
                        <input
                          className={`flex-1 text-xs font-mono bg-white dark:bg-[#252a36] border rounded px-2 py-1 outline-none focus:border-blue-400 ${
                            usage === 'unused' ? 'border-amber-300 text-amber-700 dark:border-amber-700 dark:text-amber-400' : 'border-slate-200 dark:border-slate-600'
                          }`}
                          value={h}
                          onChange={e => {
                            const newHeaders = [...headers];
                            newHeaders[hi] = e.target.value;
                            handleUpdateScanResult(i, { headers: newHeaders });
                          }}
                          placeholder={importPlaceholder(res.language)}
                        />
                        {usage === 'unused' && (
                          <span className="text-[8px] text-amber-500 font-bold shrink-0">{t('scanResult.unreferenced')}</span>
                        )}
                        <button
                          onClick={() => {
                            const newHeaders = headers.filter((_, idx) => idx !== hi);
                            handleUpdateScanResult(i, { headers: newHeaders });
                          }}
                          className="px-2 py-1 bg-red-500 text-white rounded hover:bg-red-600 text-[9px] font-bold shrink-0"
                        >
                          {t('scanResult.deleteHeader')}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ═══ SECTION 3: Content Area ═══ */}
      <div className="px-6 pb-6 pt-4 space-y-4">

        {/* ── 3.1 Cursor Delivery — DO / DON'T / WHEN ── */}
        <div className="rounded-xl border border-cyan-200 dark:border-cyan-800/40 bg-gradient-to-br from-cyan-50/60 to-blue-50/40 dark:from-cyan-900/15 dark:to-blue-900/10 p-4 space-y-3">
          <div className="text-[10px] font-bold text-cyan-700 uppercase tracking-wider flex items-center gap-1.5">
            <Zap size={12} />
            {t('scanResult.cursorDelivery')}
          </div>
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 items-start">
            <span className="text-[10px] font-bold text-emerald-600 uppercase pt-1.5 select-none">Do</span>
            <input
              className="text-sm text-slate-700 dark:text-slate-300 bg-white/80 dark:bg-[#252a36] border border-slate-200 dark:border-slate-600 rounded-lg px-3 py-1.5 outline-none focus:ring-2 focus:ring-cyan-500/20"
              value={res.doClause || ''}
              onChange={e => handleUpdateScanResult(i, { doClause: e.target.value })}
              placeholder="English imperative ≤60 tokens, e.g. Use dispatch_once for thread-safe singleton"
            />
            <span className="text-[10px] font-bold text-red-500 uppercase pt-1.5 select-none">Don't</span>
            <input
              className="text-sm text-slate-700 dark:text-slate-300 bg-white/80 dark:bg-[#252a36] border border-slate-200 dark:border-slate-600 rounded-lg px-3 py-1.5 outline-none focus:ring-2 focus:ring-cyan-500/20"
              value={res.dontClause || ''}
              onChange={e => handleUpdateScanResult(i, { dontClause: e.target.value })}
              placeholder="English constraint (omit 'Don't' prefix), e.g. use @synchronized for singleton"
            />
            <span className="text-[10px] font-bold text-amber-600 uppercase pt-1.5 select-none">When</span>
            <input
              className="text-sm text-slate-700 dark:text-slate-300 bg-white/80 dark:bg-[#252a36] border border-slate-200 dark:border-slate-600 rounded-lg px-3 py-1.5 outline-none focus:ring-2 focus:ring-cyan-500/20"
              value={res.whenClause || ''}
              onChange={e => handleUpdateScanResult(i, { whenClause: e.target.value })}
              placeholder="When implementing singleton pattern or global shared instance"
            />
          </div>
        </div>

        {/* ── 3.2 AI 推理 ── */}
        {res.reasoning && (res.reasoning.confidence != null || (res.reasoning.whyStandard && !/^Submitted via /i.test(res.reasoning.whyStandard))) && (
          <div className="rounded-xl border border-indigo-100 dark:border-indigo-800/40 bg-indigo-50/40 dark:bg-indigo-900/15 p-3 text-xs space-y-1.5">
            <div className="flex items-center gap-1.5 text-indigo-600 font-bold text-[10px]">
              {t('scanResult.aiReasoning')}
              {res.reasoning.confidence != null && (
                <span className={`ml-auto font-mono text-[10px] ${
                  res.reasoning.confidence >= 0.7 ? 'text-emerald-600' : res.reasoning.confidence >= 0.4 ? 'text-amber-600' : 'text-red-600'
                }`}>
                  {t('scanResult.confidenceLabel', { value: Math.round(res.reasoning.confidence * 100) })}
                </span>
              )}
            </div>
            {res.reasoning.whyStandard && !/^Submitted via /i.test(res.reasoning.whyStandard) && (
              <p className="text-slate-600">{res.reasoning.whyStandard}</p>
            )}
            {res.reasoning.sources && res.reasoning.sources.length > 0 && (
              <p className="text-slate-400">{t('scanResult.sourceLabel')} {res.reasoning.sources.join(', ')}</p>
            )}
          </div>
        )}

        {/* ── 3.3 描述 (Chinese ≤80字) ── */}
        <div>
          <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">{t('scanResult.description')}</label>
          <textarea
            rows={1}
            className="w-full text-sm text-slate-600 dark:text-slate-300 bg-white dark:bg-[#252a36] border border-slate-200 dark:border-slate-600 rounded-xl px-3 py-2 outline-none resize-none leading-relaxed focus:ring-2 focus:ring-blue-500/10"
            value={description}
            onChange={e => handleUpdateScanResult(i, { description: e.target.value, summary: e.target.value })}
            placeholder={t('scanResult.descPlaceholder')}
          />
        </div>

        {/* ── 3.4 项目特写 (content.markdown) ── */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-[10px] font-bold text-slate-400 uppercase">{t('scanResult.markdown')}</label>
            <button
              type="button"
              onClick={() => setEditingArticle(!editingArticle)}
              className={`flex items-center gap-1 text-[10px] font-bold px-2 py-1 rounded transition-colors ${
                editingArticle ? 'text-blue-600 hover:text-blue-700 bg-blue-50' : 'text-slate-500 hover:text-slate-700 hover:bg-slate-100'
              }`}
            >
              {editingArticle ? <><Check size={ICON_SIZES.xs} /> {t('scanResult.done')}</> : <><Pencil size={ICON_SIZES.xs} /> {t('common.edit')}</>}
            </button>
          </div>
          {editingArticle ? (
            <textarea
              rows={Math.max(6, (article || '').split('\n').length)}
              className="w-full text-sm text-slate-600 dark:text-slate-300 bg-white dark:bg-[#252a36] border border-slate-200 dark:border-slate-600 rounded-xl px-3 py-2 outline-none resize-y leading-relaxed focus:ring-2 focus:ring-blue-500/10 font-mono"
              value={article}
              onChange={e => updateContent('markdown', e.target.value)}
            />
          ) : article ? (
            <div className="text-sm text-slate-600 dark:text-slate-300 bg-white dark:bg-[#252a36] border border-slate-200 dark:border-slate-600 rounded-xl px-4 py-3 leading-relaxed whitespace-pre-wrap max-h-64 overflow-y-auto">
              {article}
            </div>
          ) : (
            <p className="text-xs text-slate-400 italic py-2">{t('scanResult.noArticle')}</p>
          )}
        </div>

        {/* ── 3.5 代码模板 (content.pattern / coreCode) ── */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-[10px] font-bold text-slate-400 uppercase">{t('scanResult.code')}</label>
            {editingCodeIndex === i ? (
              <button
                type="button"
                onClick={() => setEditingCodeIndex(null)}
                className="flex items-center gap-1 text-[10px] font-bold text-blue-600 hover:text-blue-700 px-2 py-1 rounded bg-blue-50"
              >
                <Check size={ICON_SIZES.xs} /> {t('scanResult.done')}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setEditingCodeIndex(i)}
                className="flex items-center gap-1 text-[10px] font-bold text-slate-500 hover:text-slate-700 px-2 py-1 rounded hover:bg-slate-100"
                title={t('common.edit')}
              >
                <Pencil size={ICON_SIZES.xs} /> {t('common.edit')}
              </button>
            )}
          </div>
          {editingCodeIndex === i ? (
            <div className="rounded-xl overflow-hidden">
              <HighlightedCodeEditor
                value={code}
                onChange={(newCode) => updateContent('pattern', newCode)}
                language={codeLang(res)}
                height={`${Math.min(12, code.split('\n').length) * 20 + 16}px`}
              />
            </div>
          ) : code ? (
            <CodeBlock code={code} language={codeLang(res)} showLineNumbers />
          ) : (
            <p className="text-xs text-slate-400 italic py-4">{t('scanResult.noCode')}</p>
          )}
        </div>

        {/* ── 3.7 Similarity warnings ── */}
        {(() => {
          const simKey = res.candidateId ?? res.id ?? `scan-${i}`;
          const similar = similarityMap[simKey];
          const meaningfulSimilar = (similar || []).filter(s => s.similarity >= 0.6);
          if (meaningfulSimilar.length === 0) return null;
          const highSimilar = meaningfulSimilar.filter(s => s.similarity >= 0.85);
          const hasHighSimilar = highSimilar.length > 0;
          return (
            <div className="space-y-1.5">
              {hasHighSimilar && (
                <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                  <span className="text-red-500 text-sm">⚠️</span>
                  <span className="text-[11px] font-bold text-red-700">{t('scanResult.highDuplicateRisk')}</span>
                  {highSimilar.map(s => (
                    <button
                      key={s.recipeName}
                      onClick={() => openCompare(res, s.recipeName, similar || [])}
                      className="text-[11px] font-bold px-2 py-0.5 rounded bg-red-100 text-red-800 border border-red-300 hover:bg-red-200 transition-colors"
                    >
                      {s.recipeName.replace(/\.md$/i, '')} {(s.similarity * 100).toFixed(0)}%
                    </button>
                  ))}
                  <span className="text-[10px] text-red-500">{t('scanResult.compareBeforeSave')}</span>
                </div>
              )}
              <div className="flex flex-wrap gap-1.5 items-center">
                <span className="text-[10px] text-slate-400 font-bold">{t('scanResult.similarRecipes')}</span>
                {meaningfulSimilar.slice(0, 5).map(s => (
                  <button
                    key={s.recipeName}
                    onClick={() => openCompare(res, s.recipeName, similar || [])}
                    className={`text-[10px] font-bold px-2 py-1 rounded border transition-colors flex items-center gap-1 ${
                      s.similarity >= 0.85
                        ? 'bg-red-50 text-red-700 border-red-200 hover:bg-red-100'
                        : 'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100'
                    }`}
                    title={t('scanResultCard.similarWithClick', { name: s.recipeName, score: (s.similarity * 100).toFixed(0) })}
                  >
                    <GitCompare size={ICON_SIZES.xs} />
                    {s.recipeName.replace(/\.md$/i, '')} {(s.similarity * 100).toFixed(0)}%
                  </button>
                ))}
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
};

export default ScanResultCard;
