import React from 'react';
import { Zap, CheckCircle, Pencil, Check, GitCompare, Inbox, Layers, Loader2 } from 'lucide-react';
import { ScanResultItem, SimilarRecipe } from '../../types';
import { categories } from '../../constants';
import { ICON_SIZES } from '../../constants/icons';
import CodeBlock from '../Shared/CodeBlock';
import HighlightedCodeEditor from '../Shared/HighlightedCodeEditor';

interface ScanResultCardProps {
  res: ScanResultItem;
  index: number;
  /* code editing */
  editingCodeIndex: number | null;
  setEditingCodeIndex: (i: number | null) => void;
  /* translation */
  translatingIndex: number | null;
  /* header expansion */
  expandedEditIndex: number | null;
  setExpandedEditIndex: (i: number | null) => void;
  /* similarity */
  similarityMap: Record<string, SimilarRecipe[]>;
  /* callbacks */
  handleUpdateScanResult: (index: number, updates: any) => void;
  handleSaveExtracted: (res: any) => void;
  handlePromoteToCandidate?: (res: ScanResultItem, index: number) => void;
  handleContentLangChange: (i: number, lang: 'cn' | 'en', res: ScanResultItem) => void;
  openCompare: (res: ScanResultItem, recipeName: string, similarList: SimilarRecipe[]) => void;
  isSavingRecipe?: boolean;
}

/* ── helpers ── */
const codeLang = (res: { language?: string }) => {
  const l = (res.language || '').toLowerCase();
  return l === 'objectivec' || l === 'objc' || l === 'objective-c' || l === 'obj-c'
    ? 'objectivec'
    : (res.language || 'swift');
};

/**
 * 从 header 字符串中提取核心模块/文件名，用于在代码中搜索引用
 * e.g. '#import "BDVideoPlayerView.h"' → ['BDVideoPlayerView']
 *      '#import <SDWebImage/SDWebImage.h>' → ['SDWebImage']
 *      'import BDUIKit' → ['BDUIKit']
 */
function extractHeaderSymbols(header: string): string[] {
  const symbols: string[] = [];
  // ObjC: #import "Foo.h" or #import <Module/Foo.h>
  const objcQuote = header.match(/#import\s+"([^"]+)"/);
  if (objcQuote) {
    const fname = objcQuote[1].replace(/\.h$/, '');
    symbols.push(fname);
  }
  const objcAngle = header.match(/#import\s+<([^>]+)>/);
  if (objcAngle) {
    const parts = objcAngle[1].replace(/\.h$/, '').split('/');
    symbols.push(...parts);  // e.g. ['SDWebImage', 'SDWebImage'] → both module and header
  }
  // Swift: import ModuleName
  const swiftImport = header.match(/^import\s+(\w+)/);
  if (swiftImport) {
    symbols.push(swiftImport[1]);
  }
  // @import Module;
  const atImport = header.match(/@import\s+(\w+)/);
  if (atImport) {
    symbols.push(atImport[1]);
  }
  return [...new Set(symbols.filter(Boolean))];
}

/** 判断 header 是否在代码中被引用（通过检测类名/模块名出现） */
function isHeaderUsedInCode(header: string, code: string): 'used' | 'unused' | 'unknown' {
  if (!code || !code.trim()) return 'unknown';
  const symbols = extractHeaderSymbols(header);
  if (symbols.length === 0) return 'unknown';
  return symbols.some(sym => code.includes(sym)) ? 'used' : 'unused';
}

/** 归一化 ObjC header 格式：统一 #import 风格 */
function normalizeObjCHeader(header: string): string {
  // 已经是标准格式则保留
  if (header.startsWith('#import ') || header.startsWith('import ') || header.startsWith('@import ')) {
    return header.trim();
  }
  // 可能是裸的 <Module/Header.h> 或 "Header.h"
  if (header.startsWith('<') || header.startsWith('"')) {
    return `#import ${header.trim()}`;
  }
  return header.trim();
}

/* ── V3 字段安全访问 ── */
const getCode = (res: ScanResultItem): string => res.code || res.content?.pattern || '';
const getSummary = (res: ScanResultItem): string => res.summary || res.summary_cn || res.description || '';
const getUsageGuide = (res: ScanResultItem): string => res.usageGuide || res.usage_guide_cn || '';
const getKnowledgeType = (res: ScanResultItem): string => res.knowledgeType || res.knowledge_type || 'code-pattern';
const getScope = (res: ScanResultItem): string => res.scope || 'project-specific';
const getDifficulty = (res: ScanResultItem): string => res.difficulty || res.complexity || 'intermediate';
const getAuthority = (res: ScanResultItem): number => res.authority || res.stats?.authority || 3;
const getHeaders = (res: ScanResultItem): string[] => res.headers || [];
const getTags = (res: ScanResultItem): string[] => res.tags || [];
const getModuleName = (res: ScanResultItem): string => res.moduleName || res.module_name || '';
const getKind = (res: ScanResultItem): string => res.kind || 'pattern';

/**
 * 判断该条目是否可以提取为 Xcode Snippet。
 * 仅当 knowledge_type=code-pattern 且 content.pattern 看起来是实际代码（而非 Markdown/纯文本）时才能生成 Snippet。
 */
const canExtractSnippet = (res: ScanResultItem): boolean => {
  const kt = getKnowledgeType(res);
  if (kt !== 'code-pattern') return false;
  const codeText = (res.code || res.content?.pattern || '').trim();
  if (!codeText) return false;
  // Markdown 特征：以 # / - / > / * 开头，或大段中文文本无代码特征
  const lines = codeText.split('\n').filter(l => l.trim());
  const mdLines = lines.filter(l => /^\s*(#{1,6}\s|[-*>]\s|\d+\.\s)/.test(l));
  if (mdLines.length > lines.length * 0.3) return false;
  return true;
};

const ScanResultCard: React.FC<ScanResultCardProps> = ({
  res,
  index: i,
  editingCodeIndex,
  setEditingCodeIndex,
  translatingIndex,
  expandedEditIndex,
  setExpandedEditIndex,
  similarityMap,
  handleUpdateScanResult,
  handleSaveExtracted,
  handlePromoteToCandidate,
  handleContentLangChange,
  openCompare,
  isSavingRecipe = false,
}) => {
  const isExpanded = expandedEditIndex === i;
  const headers = getHeaders(res);
  const code = getCode(res);
  const summary = getSummary(res);
  const usageGuide = getUsageGuide(res);
  const snippetAble = canExtractSnippet(res);

  return (
    <div className="bg-slate-50 rounded-2xl border border-slate-200 overflow-hidden shadow-sm">
      {/* ── Header: Title + Actions ── */}
      <div className="px-5 pt-4 pb-3 bg-gradient-to-b from-white to-slate-50/50 border-b border-slate-100">
        <div className="flex items-start justify-between gap-4 mb-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <label className="text-[9px] font-bold text-slate-400 uppercase tracking-wider ml-0.5">知识条目标题</label>
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
                  {res.lifecycle === 'pending' ? '待审核' :
                   res.lifecycle === 'active' ? '已发布' :
                   res.lifecycle === 'deprecated' ? '已废弃' : res.lifecycle}
                </span>
              ) : null}
              {res.source && res.source !== 'unknown' && (
                <span className="text-[9px] font-medium px-1.5 py-0.5 rounded bg-violet-50 text-violet-600 border border-violet-100">
                  {res.source === 'agent' ? 'AI Agent' : res.source === 'bootstrap-scan' ? 'AI 扫描' : res.source}
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
                className="text-xs px-4 py-2 rounded-lg font-bold transition-all shadow-sm flex items-center gap-1.5 active:scale-95 bg-white text-emerald-600 border border-emerald-200 hover:bg-emerald-50 whitespace-nowrap"
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
                  ? 'bg-blue-600 text-white hover:bg-blue-700'
                  : 'bg-amber-600 text-white hover:bg-amber-700'
              }`}
            >
              {isSavingRecipe ? <Loader2 size={ICON_SIZES.md} className="animate-spin" /> : <CheckCircle size={ICON_SIZES.md} />}
              {isSavingRecipe ? '保存中...' : snippetAble ? '保存为 Recipe' : '保存知识'}
            </button>
          </div>
        </div>

        {/* ── Controls row ── */}
        <div className="flex items-end gap-4 flex-wrap">
          {snippetAble && (
          <div className="flex flex-col">
            <label className="text-[9px] font-bold text-slate-400 uppercase tracking-wider ml-0.5 mb-1">Trigger</label>
            <input
              className="font-mono font-bold text-blue-600 bg-blue-50/80 border border-blue-100 px-2.5 py-1 rounded-md outline-none text-xs focus:ring-2 focus:ring-blue-500/20 w-40"
              value={res.trigger || ''}
              placeholder="@cmd"
              onChange={e => handleUpdateScanResult(i, { trigger: e.target.value })}
            />
          </div>
          )}
          <div className="flex flex-col">
            <label className="text-[9px] font-bold text-slate-400 uppercase tracking-wider ml-0.5 mb-1">分类</label>
            <select
              className="font-bold text-slate-600 bg-white border border-slate-200 px-2 py-1 rounded-md outline-none text-[11px] focus:ring-2 focus:ring-blue-500/20"
              value={res.category || ''}
              onChange={e => handleUpdateScanResult(i, { category: e.target.value })}
            >
              {categories.filter(c => c !== 'All').map(cat => (
                <option key={cat} value={cat}>{cat}</option>
              ))}
            </select>
          </div>
          <div className="w-px h-6 bg-slate-200 self-end mb-0.5" />
          {snippetAble && (
          <div className="flex flex-col">
            <label className="text-[9px] font-bold text-slate-400 uppercase tracking-wider ml-0.5 mb-1">语言</label>
            <div className="flex bg-slate-100 p-0.5 rounded-md">
              <button
                onClick={() => handleUpdateScanResult(i, { language: 'swift' })}
                className={`px-2.5 py-0.5 rounded text-[10px] font-bold transition-all ${res.language === 'swift' ? 'bg-white shadow-sm text-blue-600' : 'text-slate-400 hover:text-slate-500'}`}
              >
                Swift
              </button>
              <button
                onClick={() => handleUpdateScanResult(i, { language: 'objectivec' })}
                className={`px-2.5 py-0.5 rounded text-[10px] font-bold transition-all ${res.language === 'objectivec' || res.language === 'objc' ? 'bg-white shadow-sm text-blue-600' : 'text-slate-400 hover:text-slate-500'}`}
              >
                ObjC
              </button>
            </div>
          </div>
          )}
          <div className="flex flex-col">
            <label className="text-[9px] font-bold text-slate-400 uppercase tracking-wider ml-0.5 mb-1">内容语言</label>
            <div className="flex bg-slate-100 p-0.5 rounded-md items-center">
              <button
                onClick={() => handleContentLangChange(i, 'cn', res)}
                disabled={translatingIndex !== null}
                className={`px-2.5 py-0.5 rounded text-[10px] font-bold transition-all ${res.lang === 'cn' ? 'bg-white shadow-sm text-blue-600' : 'text-slate-400 hover:text-slate-500'} disabled:opacity-50 disabled:cursor-not-allowed`}
              >
                中文
              </button>
              <button
                onClick={() => handleContentLangChange(i, 'en', res)}
                disabled={translatingIndex !== null}
                className={`px-2.5 py-0.5 rounded text-[10px] font-bold transition-all flex items-center gap-0.5 ${res.lang === 'en' ? 'bg-white shadow-sm text-blue-600' : 'text-slate-400 hover:text-slate-500'} disabled:opacity-50 disabled:cursor-not-allowed`}
              >
                {translatingIndex === i ? <Loader2 size={10} className="animate-spin" /> : null}
                EN
              </button>
            </div>
          </div>
          {snippetAble && (
          <div className="flex flex-col">
            <label className="text-[9px] font-bold text-slate-400 uppercase tracking-wider ml-0.5 mb-1">模式</label>
            <div className="flex bg-slate-100 p-0.5 rounded-md">
              <button
                onClick={() => handleUpdateScanResult(i, { mode: 'full' })}
                className={`px-2.5 py-0.5 rounded text-[10px] font-bold transition-all ${res.mode === 'full' ? 'bg-white shadow-sm text-blue-600' : 'text-slate-400 hover:text-slate-500'}`}
              >
                Snippet+Recipe
              </button>
              <button
                onClick={() => handleUpdateScanResult(i, { mode: 'preview' })}
                className={`px-2.5 py-0.5 rounded text-[10px] font-bold transition-all ${res.mode === 'preview' ? 'bg-white shadow-sm text-amber-600' : 'text-slate-400 hover:text-slate-500'}`}
              >
                Recipe Only
              </button>
            </div>
          </div>
          )}
          <div className="w-px h-6 bg-slate-200 self-end mb-0.5" />
          <div className="flex flex-col">
            <label className="text-[9px] font-bold text-slate-400 uppercase tracking-wider ml-0.5 mb-1">难度</label>
            <select
              className="font-bold text-slate-600 bg-white border border-slate-200 px-2 py-1 rounded-md outline-none text-[11px] focus:ring-2 focus:ring-purple-500/20"
              value={getDifficulty(res)}
              onChange={e => handleUpdateScanResult(i, { difficulty: e.target.value, complexity: e.target.value })}
            >
              <option value="beginner">初级</option>
              <option value="intermediate">中级</option>
              <option value="advanced">高级</option>
            </select>
          </div>
          <div className="flex flex-col">
            <label className="text-[9px] font-bold text-slate-400 uppercase tracking-wider ml-0.5 mb-1">权威分</label>
            <select
              className="font-bold text-amber-600 bg-amber-50/60 border border-amber-100 px-2 py-1 rounded-md outline-none text-[11px] focus:ring-2 focus:ring-amber-500/20"
              value={getAuthority(res)}
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
      </div>

      {/* ── Metadata row: Kind / Knowledge Type / Scope / Module / Headers / Tags ── */}
      <div className="px-6 pt-5 pb-0 space-y-3">
        <div className="flex flex-wrap gap-x-4 gap-y-2 items-end">
          <div className="flex flex-col">
            <label className="text-[9px] font-bold text-slate-400 uppercase tracking-wider ml-0.5 mb-1">Kind</label>
            <select
              className="font-bold text-slate-600 bg-white border border-slate-200 px-2 py-1 rounded-md outline-none text-[11px] focus:ring-2 focus:ring-blue-500/20"
              value={getKind(res)}
              onChange={e => handleUpdateScanResult(i, { kind: e.target.value })}
            >
              <option value="rule">Rule</option>
              <option value="pattern">Pattern</option>
              <option value="fact">Fact</option>
            </select>
          </div>
          <div className="flex flex-col">
            <label className="text-[9px] font-bold text-slate-400 uppercase tracking-wider ml-0.5 mb-1">知识类型</label>
            <select
              className="font-bold text-slate-600 bg-white border border-slate-200 px-2 py-1 rounded-md outline-none text-[11px] focus:ring-2 focus:ring-blue-500/20"
              value={getKnowledgeType(res)}
              onChange={e => handleUpdateScanResult(i, { knowledgeType: e.target.value, knowledge_type: e.target.value })}
            >
              <option value="code-pattern">代码模式</option>
              <option value="architecture">架构设计</option>
              <option value="best-practice">最佳实践</option>
              <option value="code-standard">代码规范</option>
              <option value="call-chain">调用链路</option>
              <option value="rule">规则</option>
            </select>
          </div>
          <div className="flex flex-col">
            <label className="text-[9px] font-bold text-slate-400 uppercase tracking-wider ml-0.5 mb-1">适用范围</label>
            <select
              className="font-bold text-slate-600 bg-white border border-slate-200 px-2 py-1 rounded-md outline-none text-[11px] focus:ring-2 focus:ring-blue-500/20"
              value={getScope(res)}
              onChange={e => handleUpdateScanResult(i, { scope: e.target.value })}
            >
              <option value="universal">通用</option>
              <option value="project-specific">项目级</option>
              <option value="target-specific">模块级</option>
            </select>
          </div>
          <div className="w-px h-6 bg-slate-200 self-end mb-0.5" />
          {getModuleName(res) && (
            <div className="flex flex-col">
              <label className="text-[9px] font-bold text-slate-400 uppercase tracking-wider ml-0.5 mb-1">模块</label>
              <span className="text-[11px] bg-purple-50 text-purple-700 border border-purple-100 px-2 py-1 rounded-md font-mono font-bold">{getModuleName(res)}</span>
            </div>
          )}
          {snippetAble && headers.length > 0 && (
            <div className="flex items-end gap-2">
              <div className="flex flex-col">
                <label className="text-[9px] font-bold text-slate-400 uppercase tracking-wider ml-0.5 mb-1">Headers</label>
                <button
                  onClick={() => setExpandedEditIndex(expandedEditIndex === i ? null : i)}
                  className={`text-[11px] font-bold px-2 py-1 rounded-md transition-colors border ${isExpanded ? 'text-blue-700 bg-blue-100 border-blue-300' : 'text-blue-600 bg-blue-50 border-blue-100 hover:bg-blue-100'}`}
                >
                  {isExpanded ? '收起' : '编辑'} ({headers.length})
                </button>
              </div>
              <div className="flex items-center gap-1.5 mb-0.5">
                <span className="text-[9px] text-slate-400">Snippet:</span>
                <button
                  onClick={() => handleUpdateScanResult(i, { includeHeaders: !(res.includeHeaders !== false) })}
                  className={`w-7 h-4 rounded-full relative transition-colors ${res.includeHeaders !== false ? 'bg-blue-600' : 'bg-slate-300'}`}
                  title={res.includeHeaders !== false ? '开启：snippet 内写入 // as:include 标记' : '关闭：不写入头文件标记'}
                >
                  <div className={`absolute top-0.5 w-2.5 h-2.5 bg-white rounded-full transition-all ${res.includeHeaders !== false ? 'right-0.5' : 'left-0.5'}`} />
                </button>
                <span className="text-[9px] font-bold text-slate-600">{res.includeHeaders !== false ? 'ON' : 'OFF'}</span>
              </div>
            </div>
          )}
          <div className="w-px h-6 bg-slate-200 self-end mb-0.5" />
          <div className="flex flex-col flex-1 min-w-[160px]">
            <label className="text-[9px] font-bold text-slate-400 uppercase tracking-wider ml-0.5 mb-1">标签</label>
            <div className="flex flex-wrap gap-1 items-center bg-white border border-slate-200 rounded-md px-1.5 py-0.5 min-h-[28px] focus-within:ring-2 focus-within:ring-blue-500/20">
              {getTags(res).map((tag: string, ti: number) => (
                <span key={ti} className="flex items-center gap-0.5 text-[10px] font-bold bg-blue-50 text-blue-700 border border-blue-200 px-1.5 py-0 rounded">
                  {tag}
                  <button
                    onClick={() => { const newTags = [...getTags(res)]; newTags.splice(ti, 1); handleUpdateScanResult(i, { tags: newTags }); }}
                    className="text-blue-400 hover:text-red-500 transition-colors leading-none text-[10px]"
                    title="移除"
                  >
                    &times;
                  </button>
                </span>
              ))}
              <input
                className="flex-1 min-w-[80px] text-[11px] text-slate-600 outline-none bg-transparent py-0.5"
                placeholder={getTags(res).length === 0 ? '按 Enter/逗号添加...' : ''}
                onKeyDown={e => {
                  const input = e.currentTarget;
                  const val = input.value.trim();
                  if ((e.key === 'Enter' || e.key === ',' || e.key === '，') && val) {
                    e.preventDefault();
                    const newTag = val.replace(/[,，]/g, '').trim();
                    if (newTag && !getTags(res).includes(newTag)) {
                      handleUpdateScanResult(i, { tags: [...getTags(res), newTag] });
                    }
                    input.value = '';
                  } else if (e.key === 'Backspace' && !input.value && getTags(res).length > 0) {
                    const newTags = [...getTags(res)];
                    newTags.pop();
                    handleUpdateScanResult(i, { tags: newTags });
                  }
                }}
                onBlur={e => {
                  const val = e.currentTarget.value.trim().replace(/[,，]/g, '').trim();
                  if (val && !getTags(res).includes(val)) {
                    handleUpdateScanResult(i, { tags: [...getTags(res), val] });
                  }
                  e.currentTarget.value = '';
                }}
              />
            </div>
          </div>
        </div>

        {/* Headers expanded editing */}
        {snippetAble && isExpanded && headers.length > 0 && (
          <div className="space-y-2 bg-slate-50/80 rounded-lg p-3 border border-slate-200">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <label className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">导入头文件</label>
                {/* Usage summary */}
                {(() => {
                  const usedCount = headers.filter(h => isHeaderUsedInCode(h, code) === 'used').length;
                  const unusedCount = headers.filter(h => isHeaderUsedInCode(h, code) === 'unused').length;
                  return (
                    <span className="text-[9px] text-slate-400">
                      {usedCount > 0 && <span className="text-green-600 font-bold">{usedCount} 引用</span>}
                      {usedCount > 0 && unusedCount > 0 && ' · '}
                      {unusedCount > 0 && <span className="text-amber-600 font-bold">{unusedCount} 未引用</span>}
                    </span>
                  );
                })()}
              </div>
              <div className="flex items-center gap-1.5">
                {/* Normalize format */}
                <button
                  onClick={() => {
                    const normalized = headers.map(h => normalizeObjCHeader(h));
                    handleUpdateScanResult(i, { headers: normalized });
                  }}
                  className="text-[9px] px-2 py-0.5 bg-slate-200 text-slate-600 rounded hover:bg-slate-300 font-bold"
                  title="统一 #import 格式"
                >
                  格式化
                </button>
                {/* Remove unused */}
                {headers.some(h => isHeaderUsedInCode(h, code) === 'unused') && (
                  <button
                    onClick={() => {
                      const kept = headers.filter(h => isHeaderUsedInCode(h, code) !== 'unused');
                      handleUpdateScanResult(i, { headers: kept });
                    }}
                    className="text-[9px] px-2 py-0.5 bg-amber-100 text-amber-700 rounded hover:bg-amber-200 font-bold"
                    title="移除代码中未引用的头文件"
                  >
                    清理未引用
                  </button>
                )}
                <button
                  onClick={() => {
                    const newHeaders = [...headers, res.language === 'objectivec' ? '#import <Module/Header.h>' : 'import ModuleName'];
                    handleUpdateScanResult(i, { headers: newHeaders });
                  }}
                  className="text-[9px] px-2 py-0.5 bg-green-500 text-white rounded hover:bg-green-600 font-bold"
                >
                  + 添加
                </button>
              </div>
            </div>
            <div className="space-y-1">
              {headers.map((h, hi) => {
                const usage = isHeaderUsedInCode(h, code);
                return (
                  <div key={hi} className="flex items-center gap-2">
                    {/* Usage indicator */}
                    <span
                      className={`w-2 h-2 rounded-full shrink-0 ${
                        usage === 'used' ? 'bg-green-500' : usage === 'unused' ? 'bg-amber-400' : 'bg-slate-300'
                      }`}
                      title={usage === 'used' ? '代码中有引用' : usage === 'unused' ? '代码中未找到引用' : '无法判断'}
                    />
                    <input
                      className={`flex-1 text-xs font-mono bg-white border rounded px-2 py-1 outline-none focus:border-blue-400 ${
                        usage === 'unused' ? 'border-amber-300 text-amber-700' : 'border-slate-200'
                      }`}
                      value={h}
                      onChange={e => {
                        const newHeaders = [...headers];
                        newHeaders[hi] = e.target.value;
                        handleUpdateScanResult(i, { headers: newHeaders });
                      }}
                      placeholder={res.language === 'objectivec' ? '#import <Module/Header.h>' : 'import ModuleName'}
                    />
                    {usage === 'unused' && (
                      <span className="text-[8px] text-amber-500 font-bold shrink-0">未引用</span>
                    )}
                    <button
                      onClick={() => {
                        const newHeaders = headers.filter((_, idx) => idx !== hi);
                        handleUpdateScanResult(i, { headers: newHeaders });
                      }}
                      className="px-2 py-1 bg-red-500 text-white rounded hover:bg-red-600 text-[9px] font-bold shrink-0"
                    >
                      删除
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* ── Content area: Summary, UsageGuide, AI Info, Similarity, Code ── */}
      <div className="px-6 pb-6 pt-3 space-y-3">
        {/* AI 推理信息（来自候选的 reasoning） */}
        {res.reasoning && (res.reasoning.confidence != null || (res.reasoning.why_standard && !/^Submitted via /i.test(res.reasoning.why_standard))) && (
          <div className="rounded-xl border border-indigo-100 bg-indigo-50/40 p-3 text-xs space-y-1.5">
            <div className="flex items-center gap-1.5 text-indigo-600 font-bold text-[10px]">
              AI 推理
              {res.reasoning.confidence != null && (
                <span className={`ml-auto font-mono text-[10px] ${
                  res.reasoning.confidence >= 0.7 ? 'text-emerald-600' : res.reasoning.confidence >= 0.4 ? 'text-amber-600' : 'text-red-600'
                }`}>
                  置信度 {Math.round(res.reasoning.confidence * 100)}%
                </span>
              )}
            </div>
            {res.reasoning.why_standard && !/^Submitted via /i.test(res.reasoning.why_standard) && (
              <p className="text-slate-600">{res.reasoning.why_standard}</p>
            )}
            {res.reasoning.sources && res.reasoning.sources.length > 0 && (
              <p className="text-slate-400">来源: {res.reasoning.sources.join(', ')}</p>
            )}
          </div>
        )}

        {/* Summary */}
        <div>
          <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">摘要 - {res.lang === 'cn' ? '中文' : 'EN'}</label>
          <textarea
            rows={1}
            className="w-full text-sm text-slate-600 bg-white border border-slate-200 rounded-xl px-3 py-2 outline-none resize-none leading-relaxed focus:ring-2 focus:ring-blue-500/10"
            value={summary}
            onChange={e => handleUpdateScanResult(i, { summary: e.target.value })}
          />
        </div>

        {/* Usage Guide */}
        <div>
          <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">使用指南 - {res.lang === 'cn' ? '中文' : 'EN'}</label>
          <textarea
            rows={3}
            className="w-full text-sm text-slate-600 bg-white border border-slate-200 rounded-xl px-3 py-2 outline-none resize-y leading-relaxed focus:ring-2 focus:ring-blue-500/10"
            value={typeof usageGuide === 'object' ? JSON.stringify(usageGuide) : usageGuide}
            onChange={e => handleUpdateScanResult(i, { usageGuide: e.target.value })}
            placeholder="何时用 / 关键点 / 依赖..."
          />
        </div>

        {/* Similarity warnings — 仅在有 ≥60% 相似结果时才显示，不产生布局变化 */}
        {(() => {
          const simKey = res.candidateId ?? res.id ?? `scan-${i}`;
          const similar = similarityMap[simKey];
          // 只过滤出有意义的相似结果（≥60%），低于此阈值不显示
          const meaningfulSimilar = (similar || []).filter(s => s.similarity >= 0.6);
          if (meaningfulSimilar.length === 0) return null;
          const highSimilar = meaningfulSimilar.filter(s => s.similarity >= 0.85);
          const hasHighSimilar = highSimilar.length > 0;
          return (
            <div className="space-y-1.5">
              {hasHighSimilar && (
                <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                  <span className="text-red-500 text-sm">⚠️</span>
                  <span className="text-[11px] font-bold text-red-700">高重复风险：</span>
                  {highSimilar.map(s => (
                    <button
                      key={s.recipeName}
                      onClick={() => openCompare(res, s.recipeName, similar || [])}
                      className="text-[11px] font-bold px-2 py-0.5 rounded bg-red-100 text-red-800 border border-red-300 hover:bg-red-200 transition-colors"
                    >
                      {s.recipeName.replace(/\.md$/i, '')} {(s.similarity * 100).toFixed(0)}%
                    </button>
                  ))}
                  <span className="text-[10px] text-red-500">建议先对比再保存</span>
                </div>
              )}
              <div className="flex flex-wrap gap-1.5 items-center">
                <span className="text-[10px] text-slate-400 font-bold">相似 Recipe：</span>
                {meaningfulSimilar.slice(0, 5).map(s => (
                  <button
                    key={s.recipeName}
                    onClick={() => openCompare(res, s.recipeName, similar || [])}
                    className={`text-[10px] font-bold px-2 py-1 rounded border transition-colors flex items-center gap-1 ${
                      s.similarity >= 0.85
                        ? 'bg-red-50 text-red-700 border-red-200 hover:bg-red-100'
                        : 'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100'
                    }`}
                    title={`与 ${s.recipeName} 相似 ${(s.similarity * 100).toFixed(0)}%，点击对比`}
                  >
                    <GitCompare size={ICON_SIZES.xs} />
                    {s.recipeName.replace(/\.md$/i, '')} {(s.similarity * 100).toFixed(0)}%
                  </button>
                ))}
              </div>
            </div>
          );
        })()}

        {/* Code editing */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-[10px] font-bold text-slate-400 uppercase">代码 / 标准用法示例</label>
            {editingCodeIndex === i ? (
              <button
                type="button"
                onClick={() => setEditingCodeIndex(null)}
                className="flex items-center gap-1 text-[10px] font-bold text-blue-600 hover:text-blue-700 px-2 py-1 rounded bg-blue-50"
              >
                <Check size={ICON_SIZES.xs} /> 完成
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setEditingCodeIndex(i)}
                className="flex items-center gap-1 text-[10px] font-bold text-slate-500 hover:text-slate-700 px-2 py-1 rounded hover:bg-slate-100"
                title="编辑代码"
              >
                <Pencil size={ICON_SIZES.xs} /> 编辑
              </button>
            )}
          </div>
          {editingCodeIndex === i ? (
            <div className="rounded-xl overflow-hidden">
              <HighlightedCodeEditor
                value={code}
                onChange={(newCode) => handleUpdateScanResult(i, { code: newCode })}
                language={codeLang(res)}
                height={`${Math.min(12, code.split('\n').length) * 20 + 16}px`}
              />
            </div>
          ) : code ? (
            <CodeBlock code={code} language={codeLang(res)} showLineNumbers />
          ) : (
            <p className="text-xs text-slate-400 italic py-4">（无代码内容）</p>
          )}
        </div>
      </div>
    </div>
  );
};

export default ScanResultCard;
