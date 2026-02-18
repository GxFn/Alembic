import React, { useState, useEffect } from 'react';
import { Search, X, Zap, Target, Code, AlertCircle, Loader2, ChevronRight } from 'lucide-react';
import api from '../../api';
import CodeBlock from '../Shared/CodeBlock';
import { ICON_SIZES } from '../../constants/icons';
import PageOverlay from '../Shared/PageOverlay';

interface ContextInfo {
  fileInfo?: {
  fileName?: string;
  imports?: string[];
  classes?: string[];
  functions?: string[];
  };
  targetInfo?: {
  targetName?: string;
  suggestedApis?: string[];
  };
  language?: string;
}

interface SearchResult {
  name: string;
  content: string;
  similarity: number;
  authority?: number;
  usageCount?: number;
  isContextRelevant?: boolean;
  matchType?: 'semantic' | 'keyword';
  qualityScore?: number;
  recommendReason?: string;
  stats?: {
  authority?: number;
  guardUsageCount?: number;
  humanUsageCount?: number;
  aiUsageCount?: number;
  authorityScore?: number;
  };
}

interface ContextAwareSearchPanelProps {
  isOpen: boolean;
  onClose: () => void;
  currentFile?: string;
  targetName?: string;
  language?: string;
  onSelectRecipe?: (recipeName: string) => void;
}

const ContextAwareSearchPanel: React.FC<ContextAwareSearchPanelProps> = ({
  isOpen,
  onClose,
  currentFile,
  targetName,
  language = 'swift',
  onSelectRecipe
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [contextInfo, setContextInfo] = useState<ContextInfo | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [selectedResult, setSelectedResult] = useState<SearchResult | null>(null);

  const performSearch = async () => {
  if (!searchQuery.trim()) return;
  
  setIsSearching(true);
  try {
    const data = await api.search(searchQuery, {
    context: { language },
    limit: 10,
    });

    setSearchResults((data.items || []).map((r: any) => ({
    name: (r.title || r.name || '') + '.md',
    content: r.content?.pattern || r.content?.markdown || r.content?.code || '',
    similarity: r.score || 0,
    authority: r.authorityScore || 0,
    matchType: r.matchType || 'ranked',
    qualityScore: r.qualityScore || 0,
    usageCount: r.usageCount || 0,
    })));
    setContextInfo(null);
  } catch (error) {
    console.error('Context-aware search failed:', error);
    alert('搜索失败。请重试。');
  } finally {
    setIsSearching(false);
  }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
  if (e.key === 'Enter') {
    performSearch();
  }
  };

  if (!isOpen) return null;

  return (
  <PageOverlay className="z-30 flex">
    <PageOverlay.Backdrop className="bg-black/20" />
    <div className="relative w-full max-w-2xl ml-auto bg-white shadow-xl flex flex-col max-h-screen">
    {/* Header */}
    <div className="border-b border-slate-200 p-6">
      <div className="flex items-center justify-between mb-4">
      <h2 className="text-xl font-bold text-slate-900">智能搜索</h2>
      <button
        onClick={onClose}
        className="p-1 hover:bg-slate-100 rounded-lg transition-colors"
      >
        <X size={ICON_SIZES.lg} className="text-slate-500" />
      </button>
      </div>

      {/* 上下文信息 */}
      {contextInfo && (
      <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-lg text-sm">
        <div className="flex items-start gap-3">
        <Zap size={ICON_SIZES.md} className="text-blue-600 mt-0.5 shrink-0" />
        <div className="flex-1">
          {contextInfo.targetInfo?.targetName && (
          <div className="text-blue-900 font-medium flex items-center gap-2 mb-1">
            <Target size={ICON_SIZES.sm} />
            Target: {contextInfo.targetInfo.targetName}
          </div>
          )}
          {contextInfo.fileInfo?.imports && contextInfo.fileInfo.imports.length > 0 && (
          <div className="text-blue-800 text-xs mt-2">
            <strong>导入的框架：</strong> {contextInfo.fileInfo.imports.slice(0, 3).join(', ')}
            {contextInfo.fileInfo.imports.length > 3 && ` +${contextInfo.fileInfo.imports.length - 3}`}
          </div>
          )}
          {contextInfo.targetInfo?.suggestedApis && contextInfo.targetInfo.suggestedApis.length > 0 && (
          <div className="text-blue-800 text-xs mt-1">
            <strong>相关 APIs：</strong> {contextInfo.targetInfo.suggestedApis.slice(0, 3).join(', ')}
          </div>
          )}
        </div>
        </div>
      </div>
      )}

      {/* 搜索框 */}
      <div className="relative">
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={ICON_SIZES.md} />
      <input
        type="text"
        placeholder="输入搜索关键词..."
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        className="w-full pl-10 pr-4 py-2 border border-slate-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-500/20 transition-all"
      />
      </div>
      <button
      onClick={performSearch}
      disabled={!searchQuery.trim() || isSearching}
      className="mt-3 w-full py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:bg-blue-300 transition-colors flex items-center justify-center gap-2"
      >
      {isSearching && <Loader2 size={ICON_SIZES.sm} className="animate-spin" />}
      {isSearching ? '搜索中...' : '搜索'}
      </button>
    </div>

    {/* 搜索结果 */}
    <div className="flex-1 overflow-auto">
      {searchResults.length === 0 && !isSearching && (
      <div className="flex items-center justify-center h-full text-slate-500">
        <div className="text-center">
        <Code size={ICON_SIZES.xxl} className="mx-auto mb-2 opacity-50" />
        <p className="text-sm">输入关键词后点击搜索</p>
        </div>
      </div>
      )}

      {searchResults.map((result, idx) => (
      <div
        key={idx}
        className="border-b border-slate-200 p-4 hover:bg-slate-50 transition-colors cursor-pointer"
        onClick={() => {
        setExpandedIndex(expandedIndex === idx ? null : idx);
        if (result.name) onSelectRecipe?.(result.name);
        }}
      >
        <div className="flex items-start justify-between mb-2">
        <div className="flex-1">
          <h3 className="font-semibold text-slate-900 text-sm">{result.name}</h3>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
          <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-slate-100 rounded text-xs text-slate-600">
            <Zap size={ICON_SIZES.xs} />
            {Math.round(result.similarity * 100)}%
          </span>
          {result.isContextRelevant && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-green-100 rounded text-xs text-green-700">
            <Target size={ICON_SIZES.xs} />
            上下文相关
            </span>
          )}
          {result.matchType && (
            <span className="text-xs text-slate-500">
            {result.matchType === 'semantic' ? '语义匹配' : '关键词匹配'}
            </span>
          )}
          </div>
        </div>
        <button
          onClick={(e) => {
          e.stopPropagation();
          setExpandedIndex(expandedIndex === idx ? null : idx);
          }}
          className="p-1 hover:bg-slate-200 rounded transition-colors"
        >
          {expandedIndex === idx ? '▼' : '▶'}
        </button>
        </div>

        {/* 权威分和使用统计 */}
        {result.stats && (
        <div className="text-xs text-slate-500 mb-2 flex gap-3">
          {result.stats.authorityScore !== undefined && (
          <span>权威分: {result.stats.authorityScore}</span>
          )}
          {result.usageCount !== undefined && (
          <span>使用: {result.usageCount}次</span>
          )}
        </div>
        )}

        {/* 展开的内容预览 */}
        {expandedIndex === idx && (
        <div className="mt-3 pt-3 border-t border-slate-200">
          {result.recommendReason && (
          <div className="text-xs text-slate-600 bg-blue-50 p-2 rounded mb-2 border border-blue-100">
            <p className="font-medium text-blue-700 mb-0.5">推荐理由</p>
            <p>{result.recommendReason}</p>
          </div>
          )}
          <div className="text-xs text-slate-600 max-h-[200px] overflow-auto bg-slate-50 p-3 rounded">
          {result.content.substring(0, 500)}...
          </div>
          <button
          onClick={(e) => {
            e.stopPropagation();
            setSelectedResult(result);
            setDetailsOpen(true);
          }}
          className="mt-2 w-full py-1.5 bg-blue-50 text-blue-600 rounded text-xs font-medium hover:bg-blue-100 transition-colors"
          >
          查看完整内容
          </button>
        </div>
        )}
      </div>
      ))}

      {isSearching && (
      <div className="flex items-center justify-center h-32">
        <Loader2 size={ICON_SIZES.lg} className="animate-spin text-blue-600" />
      </div>
      )}

      {searchResults.length === 0 && searchQuery && !isSearching && (
      <div className="flex items-center justify-center h-32">
        <div className="text-center text-slate-500">
        <AlertCircle size={ICON_SIZES.xl} className="mx-auto mb-2 opacity-50" />
        <p className="text-sm">未找到匹配的结果</p>
        </div>
      </div>
      )}
    </div>
    </div>

    {/* 详情模态框 */}
    {detailsOpen && selectedResult && (
    <PageOverlay className="z-40 flex items-center justify-center p-4">
      <PageOverlay.Backdrop className="bg-black/40" />
      <div className="relative bg-white rounded-lg shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden">
      {/* Header */}
      <div className="border-b border-slate-200 p-6 flex items-start justify-between shrink-0">
        <div>
        <h3 className="text-lg font-bold text-slate-900">{selectedResult.name}</h3>
        <div className="flex items-center gap-4 mt-2">
          <span className="text-xs bg-blue-100 text-blue-700 px-2 py-1 rounded">
          相似度: {Math.round(selectedResult.similarity * 100)}%
          </span>
          {selectedResult.isContextRelevant && (
          <span className="text-xs bg-green-100 text-green-700 px-2 py-1 rounded">
            ✓ 上下文相关
          </span>
          )}
          {selectedResult.qualityScore !== undefined && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-100 rounded text-xs text-blue-700 font-medium">
            🤖 质量: {(selectedResult.qualityScore * 100).toFixed(0)}%
          </span>
          )}
          {selectedResult.stats?.authorityScore !== undefined && (
          <span className="text-xs bg-purple-100 text-purple-700 px-2 py-1 rounded">
            权威分: {Math.round(selectedResult.stats.authorityScore * 100) / 100}
          </span>
          )}
        </div>
        </div>
        <button
        onClick={() => setDetailsOpen(false)}
        className="p-1 hover:bg-slate-100 rounded transition-colors shrink-0"
        >
        <X size={ICON_SIZES.lg} className="text-slate-500" />
        </button>
      </div>

      {/* Content */}
      <div className="overflow-auto flex-1 p-6">
        <div className="prose prose-sm max-w-none">
        {selectedResult.content ? (
          <CodeBlock code={selectedResult.content} language="markdown" />
        ) : (
          <p className="text-slate-500 text-sm">无内容</p>
        )}
        </div>
      </div>

      {/* Footer */}
      <div className="border-t border-slate-200 p-4 bg-slate-50 flex justify-end gap-2 shrink-0">
        <button
        onClick={() => setDetailsOpen(false)}
        className="px-4 py-2 text-slate-700 hover:bg-slate-200 rounded transition-colors text-sm font-medium"
        >
        关闭
        </button>
        {onSelectRecipe && (
        <button
          onClick={() => {
          onSelectRecipe(selectedResult.name);
          setDetailsOpen(false);
          }}
          className="px-4 py-2 bg-blue-600 text-white hover:bg-blue-700 rounded transition-colors text-sm font-medium flex items-center gap-2"
        >
          <ChevronRight size={ICON_SIZES.md} />
          使用此片段
        </button>
        )}
      </div>
      </div>
    </PageOverlay>
    )}
  </PageOverlay>
  );
};

export default ContextAwareSearchPanel;
