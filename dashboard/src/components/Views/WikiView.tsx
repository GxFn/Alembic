import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  BookOpen, RefreshCw, FileText, FolderOpen, ArrowLeft, Loader2,
  Square, CheckCircle, AlertCircle, Clock, ChevronRight,
  ChevronDown, Search, Sparkles, GitBranch, Download, Copy, Check,
  Hash, Bot, FileCode, FolderTree, Layers,
  ArrowUpRight, CircleDot, Trash2,
} from 'lucide-react';
import { ICON_SIZES } from '../../constants/icons';
import api from '../../api';
import MarkdownWithHighlight from '../Shared/MarkdownWithHighlight';

/* ═══════════════════════════════════════════════════════
 *  Types
 * ═══════════════════════════════════════════════════════ */

interface WikiFile {
  path: string;
  name: string;
  size: number;
  modifiedAt: string;
}

interface WikiMetaFile {
  path: string;
  hash: string;
  size: number;
  source?: string;
  polished?: boolean;
}

interface WikiMeta {
  version?: string;
  generatedAt?: string;
  duration?: number;
  files?: WikiMetaFile[];
  dedup?: { removed: string[]; kept: number };
  sourceHash?: string;
}

interface WikiStatus {
  task: {
    status: 'idle' | 'running' | 'done' | 'error';
    phase?: string;
    progress?: number;
    message?: string;
    startedAt?: number;
    finishedAt?: number;
    result?: any;
    error?: string;
  };
  wiki?: {
    exists: boolean;
    generatedAt?: string;
    filesCount?: number;
    version?: string;
    hasChanges?: boolean;
  };
}

/* ═══════════════════════════════════════════════════════
 *  Constants & Config
 * ═══════════════════════════════════════════════════════ */

/** 生成阶段配置 */
const PHASE_CONFIG: Record<string, { label: string; icon: React.ElementType }> = {
  'init':        { label: '初始化',       icon: CircleDot },
  'scan':        { label: '扫描项目',     icon: FolderTree },
  'ast-analyze': { label: 'AST 分析',    icon: FileCode },
  'spm-parse':   { label: 'SPM 解析',    icon: GitBranch },
  'knowledge':   { label: '整合知识库',   icon: BookOpen },
  'generate':    { label: '生成骨架',     icon: FileText },
  'ai-compose':  { label: 'AI 增强',     icon: Sparkles },
  'sync-docs':   { label: '同步文档',     icon: Download },
  'dedup':       { label: '去重',         icon: Layers },
  'finalize':    { label: '写入元数据',   icon: CheckCircle },
};

const PHASE_ORDER = [
  'init', 'scan', 'ast-analyze', 'spm-parse',
  'knowledge', 'generate', 'ai-compose',
  'sync-docs', 'dedup', 'finalize',
];

/** 文件类型 → 图标 & 颜色 */
const FILE_TYPE_CONFIG: Record<string, { icon: React.ElementType; color: string; label: string }> = {
  'index':           { icon: BookOpen,   color: 'text-blue-600',    label: '项目概述' },
  'architecture':    { icon: Layers,     color: 'text-violet-600',  label: '架构总览' },
  'getting-started': { icon: FileCode,   color: 'text-emerald-600', label: '快速上手' },
  'protocols':       { icon: Sparkles,   color: 'text-amber-600',   label: '协议与组件' },
  'components':      { icon: FileCode,   color: 'text-emerald-600', label: '组件清单' },
  'patterns':        { icon: Sparkles,   color: 'text-amber-600',   label: '代码模式' },
  'module':          { icon: FolderOpen, color: 'text-cyan-600',    label: '模块文档' },
  'document':        { icon: FileText,   color: 'text-orange-600',  label: '开发文档' },
  '_index':          { icon: Hash,       color: 'text-slate-500',   label: '目录索引' },
};

function getFileTypeConfig(filePath: string) {
  const name = filePath.split('/').pop()?.replace('.md', '') || '';
  if (name === '_index') return FILE_TYPE_CONFIG['_index'];
  if (filePath.startsWith('modules/')) return FILE_TYPE_CONFIG['module'];
  if (filePath.startsWith('documents/')) return FILE_TYPE_CONFIG['document'];
  return FILE_TYPE_CONFIG[name] || { icon: FileText, color: 'text-slate-500', label: '文档' };
}

/** 来源标签配置 */
const SOURCE_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  'cursor-devdocs': { label: 'Cursor Docs',  color: 'text-orange-700', bg: 'bg-orange-50 border-orange-200' },

};

const DIR_LABELS: Record<string, string> = {
  modules: '模块',
  documents: '开发文档',
};

/* ═══════════════════════════════════════════════════════
 *  Utilities
 * ═══════════════════════════════════════════════════════ */

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatDate(dateStr: string | undefined): string {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '';
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 60_000) return '刚刚';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
  if (diff < 604800_000) return `${Math.floor(diff / 86400_000)} 天前`;
  return d.toLocaleDateString('zh-CN');
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/* ═══════════════════════════════════════════════════════
 *  Stats Overview Cards
 * ═══════════════════════════════════════════════════════ */

/** 内联统计指标（用于 Header 右侧） */
const InlineStats: React.FC<{
  meta: WikiMeta | null;
  filesCount: number;
}> = ({ meta, filesCount }) => {
  const aiPolished = meta?.files?.filter(f => f.polished).length || 0;
  const synced = meta?.files?.filter(f => f.source).length || 0;

  return (
    <div className="flex items-center gap-3 text-xs">
      <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-50 border border-slate-100">
        <FileText size={14} className="text-slate-400" />
        <span className="text-slate-500">共 <strong className="text-slate-700">{filesCount}</strong> 篇</span>
        {aiPolished > 0 && (
          <span className="text-violet-500 ml-1">（AI {aiPolished}）</span>
        )}
      </div>
      {synced > 0 && (
        <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-orange-50 border border-orange-100">
          <Download size={14} className="text-orange-400" />
          <span className="text-orange-600">同步 <strong className="text-orange-700">{synced}</strong></span>
        </div>
      )}
      {meta?.generatedAt && (
        <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-50 border border-emerald-100">
          <Clock size={14} className="text-emerald-400" />
          <span className="text-emerald-600">{formatDate(meta.generatedAt)}</span>
        </div>
      )}
    </div>
  );
};

/* ═══════════════════════════════════════════════════════
 *  Generation Progress (Pipeline)
 * ═══════════════════════════════════════════════════════ */

const GenerationProgress: React.FC<{
  task: WikiStatus['task'];
  onAbort: () => void;
}> = ({ task, onAbort }) => {
  if (task.status !== 'running') return null;

  const currentPhaseIndex = PHASE_ORDER.indexOf(task.phase || '');

  return (
    <div className="bg-white border border-blue-200 rounded-xl p-5 mb-6 shadow-sm">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-blue-100 rounded-lg">
            <Loader2 size={ICON_SIZES.lg} className="text-blue-600 animate-spin" />
          </div>
          <div>
            <h3 className="font-semibold text-slate-800">Wiki 生成中</h3>
            <p className="text-sm text-slate-500">{task.message || '处理中...'}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-lg font-bold text-blue-600 font-mono">{task.progress || 0}%</span>
          <button
            onClick={onAbort}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-red-50 text-red-600 rounded-lg border border-red-200 hover:bg-red-100 transition-colors"
          >
            <Square size={ICON_SIZES.sm} />
            中止
          </button>
        </div>
      </div>

      {/* Progress bar */}
      <div className="w-full bg-slate-100 rounded-full h-2 mb-4">
        <div
          className="bg-gradient-to-r from-blue-500 to-blue-400 h-2 rounded-full transition-all duration-500 ease-out"
          style={{ width: `${Math.max(task.progress || 0, 2)}%` }}
        />
      </div>

      {/* Phase pipeline */}
      <div className="flex items-center gap-1 overflow-x-auto pb-1">
        {PHASE_ORDER.map((phaseKey, index) => {
          const cfg = PHASE_CONFIG[phaseKey];
          const Icon = cfg?.icon || CircleDot;
          const isDone = index < currentPhaseIndex;
          const isCurrent = index === currentPhaseIndex;

          return (
            <React.Fragment key={phaseKey}>
              {index > 0 && (
                <div className={`w-3 h-px flex-shrink-0 ${isDone ? 'bg-emerald-400' : 'bg-slate-200'}`} />
              )}
              <div
                className={`flex items-center gap-1 px-2 py-1 rounded-md text-xs whitespace-nowrap transition-all flex-shrink-0 ${
                  isDone    ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' :
                  isCurrent ? 'bg-blue-50 text-blue-700 border border-blue-300 shadow-sm' :
                              'bg-slate-50 text-slate-400 border border-slate-100'
                }`}
              >
                {isDone ? (
                  <CheckCircle size={12} className="text-emerald-500" />
                ) : isCurrent ? (
                  <Loader2 size={12} className="text-blue-500 animate-spin" />
                ) : (
                  <Icon size={12} />
                )}
                <span className="hidden sm:inline">{cfg?.label || phaseKey}</span>
              </div>
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
};

/* ═══════════════════════════════════════════════════════
 *  Status Banner
 * ═══════════════════════════════════════════════════════ */

const StatusBanner: React.FC<{
  task: WikiStatus['task'];
  wiki: WikiStatus['wiki'];
}> = ({ task, wiki }) => {
  if (task.status === 'running') return null;

  if (task.status === 'error') {
    return (
      <div className="bg-red-50 border border-red-200 rounded-xl p-4 mb-6 flex items-center gap-3">
        <div className="p-1.5 bg-red-100 rounded-lg">
          <AlertCircle size={ICON_SIZES.md} className="text-red-600" />
        </div>
        <div>
          <span className="font-semibold text-red-800">生成失败</span>
          <span className="text-sm text-red-600 ml-3">{task.error || '未知错误'}</span>
        </div>
      </div>
    );
  }

  if (wiki?.exists && wiki.hasChanges) {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-6 flex items-center gap-3">
        <div className="p-1.5 bg-amber-100 rounded-lg">
          <AlertCircle size={ICON_SIZES.md} className="text-amber-600" />
        </div>
        <span className="text-sm text-amber-700">检测到代码变更，Wiki 可能已过期，建议增量更新</span>
      </div>
    );
  }

  return null;
};

/* ═══════════════════════════════════════════════════════
 *  File Tree
 * ═══════════════════════════════════════════════════════ */

interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children?: TreeNode[];
  file?: WikiFile;
  metaInfo?: WikiMetaFile;
}

function buildTree(files: WikiFile[], metaFiles?: WikiMetaFile[]): TreeNode[] {
  const root: TreeNode[] = [];
  const metaMap = new Map(metaFiles?.map(f => [f.path, f]) || []);

  const rootFiles: TreeNode[] = [];
  const dirMap = new Map<string, TreeNode[]>();

  for (const file of files) {
    const parts = file.path.split('/');
    const metaInfo = metaMap.get(file.path);

    if (parts.length === 1) {
      rootFiles.push({ name: parts[0], path: file.path, isDir: false, file, metaInfo });
    } else {
      const dir = parts[0];
      if (!dirMap.has(dir)) dirMap.set(dir, []);
      dirMap.get(dir)!.push({
        name: parts.slice(1).join('/'),
        path: file.path,
        isDir: false,
        file,
        metaInfo,
      });
    }
  }

  // Sort root files
  const fileOrder = ['index.md', 'architecture.md', 'getting-started.md', 'patterns.md', 'protocols.md', 'components.md'];
  rootFiles.sort((a, b) => {
    const ai = fileOrder.indexOf(a.name);
    const bi = fileOrder.indexOf(b.name);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.name.localeCompare(b.name);
  });
  root.push(...rootFiles);

  // Sort directories
  const dirOrder = ['modules', 'patterns', 'documents'];
  const sortedDirs = [...dirMap.entries()].sort(([a], [b]) => {
    const ai = dirOrder.indexOf(a);
    const bi = dirOrder.indexOf(b);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.localeCompare(b);
  });

  for (const [dirName, children] of sortedDirs) {
    const sortedChildren = children
      .filter(c => !c.name.startsWith('_index'))
      .sort((a, b) => a.name.localeCompare(b.name));

    root.push({
      name: dirName,
      path: dirName,
      isDir: true,
      children: sortedChildren,
    });
  }

  return root;
}

const FileTree: React.FC<{
  tree: TreeNode[];
  selectedFile: string | null;
  onSelect: (path: string) => void;
  searchQuery: string;
}> = ({ tree, selectedFile, onSelect, searchQuery }) => {
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set(['modules', 'documents']));

  const toggleDir = (dirPath: string) => {
    setExpandedDirs(prev => {
      const next = new Set(prev);
      next.has(dirPath) ? next.delete(dirPath) : next.add(dirPath);
      return next;
    });
  };

  const filterNodes = (nodes: TreeNode[]): TreeNode[] => {
    if (!searchQuery) return nodes;
    const q = searchQuery.toLowerCase();
    return nodes.filter(node => {
      if (node.isDir) {
        return node.children?.some(c =>
          c.name.toLowerCase().includes(q) || c.path.toLowerCase().includes(q)
        );
      }
      return node.name.toLowerCase().includes(q) || node.path.toLowerCase().includes(q);
    });
  };

  const filtered = filterNodes(tree);

  return (
    <div className="space-y-0.5">
      {filtered.map(node => {
        if (node.isDir) {
          const isExpanded = expandedDirs.has(node.path);
          const q = searchQuery.toLowerCase();
          const filteredChildren = searchQuery
            ? node.children?.filter(c => c.name.toLowerCase().includes(q) || c.path.toLowerCase().includes(q))
            : node.children;

          return (
            <div key={node.path}>
              <button
                onClick={() => toggleDir(node.path)}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50 rounded-lg transition-colors"
              >
                {isExpanded
                  ? <ChevronDown size={14} className="text-slate-400 flex-shrink-0" />
                  : <ChevronRight size={14} className="text-slate-400 flex-shrink-0" />
                }
                <FolderOpen size={14} className="text-amber-500 flex-shrink-0" />
                <span className="font-medium truncate">{DIR_LABELS[node.name] || node.name}</span>
                <span className="ml-auto text-xs text-slate-400">{filteredChildren?.length || 0}</span>
              </button>
              {isExpanded && filteredChildren && (
                <div className="ml-3">
                  {filteredChildren.map(child => (
                    <FileTreeItem key={child.path} node={child} isActive={selectedFile === child.path} onSelect={onSelect} />
                  ))}
                </div>
              )}
            </div>
          );
        }
        return <FileTreeItem key={node.path} node={node} isActive={selectedFile === node.path} onSelect={onSelect} />;
      })}
    </div>
  );
};

const FileTreeItem: React.FC<{
  node: TreeNode;
  isActive: boolean;
  onSelect: (p: string) => void;
}> = ({ node, isActive, onSelect }) => {
  const config = getFileTypeConfig(node.path);
  const Icon = config.icon;
  const isPolished = node.metaInfo?.polished;
  const source = node.metaInfo?.source;

  return (
    <button
      onClick={() => onSelect(node.path)}
      className={`w-full flex items-center gap-2 px-3 py-2 text-sm rounded-lg transition-all ${
        isActive
          ? 'bg-blue-50 text-blue-700 border border-blue-200 shadow-sm'
          : 'text-slate-600 hover:bg-slate-50'
      }`}
    >
      <Icon size={14} className={`flex-shrink-0 ${isActive ? 'text-blue-500' : config.color}`} />
      <span className="truncate text-left">{node.name.replace('.md', '')}</span>
      <span className="ml-auto flex items-center gap-1 flex-shrink-0">
        {isPolished && <span title="AI 增强"><Sparkles size={10} className="text-violet-400" /></span>}
        {source && <span title={`来源: ${source}`}><ArrowUpRight size={10} className="text-orange-400" /></span>}
      </span>
    </button>
  );
};

/* ═══════════════════════════════════════════════════════
 *  Document Reader
 * ═══════════════════════════════════════════════════════ */

const DocumentReader: React.FC<{
  filePath: string;
  content: string;
  loading: boolean;
  meta: WikiMeta | null;
  onBack: () => void;
}> = ({ filePath, content, loading, meta, onBack }) => {
  const [copied, setCopied] = useState(false);
  const fileMeta = meta?.files?.find(f => f.path === filePath);

  const handleCopy = () => {
    navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const parts = filePath.split('/');
  const breadcrumbs = parts.map((part, i) => ({
    label: i === parts.length - 1 ? part.replace('.md', '') : part,
    isLast: i === parts.length - 1,
  }));

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-5 py-3 bg-slate-50 border-b border-slate-200 flex-shrink-0">
        <div className="flex items-center gap-2">
          <button
            onClick={onBack}
            className="p-1.5 hover:bg-slate-200 rounded-lg transition-colors lg:hidden"
            title="返回文件列表"
          >
            <ArrowLeft size={ICON_SIZES.md} />
          </button>
          <div className="flex items-center gap-1 text-sm">
            <BookOpen size={14} className="text-slate-400" />
            <span className="text-slate-400">wiki</span>
            {breadcrumbs.map((bc, i) => (
              <React.Fragment key={i}>
                <ChevronRight size={12} className="text-slate-300" />
                <span className={bc.isLast ? 'font-medium text-slate-700' : 'text-slate-400'}>{bc.label}</span>
              </React.Fragment>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {fileMeta?.polished && (
            <span className="flex items-center gap-1 text-xs text-violet-700 bg-violet-50 border border-violet-200 px-2 py-0.5 rounded-full">
              <Sparkles size={10} />
              AI 增强
            </span>
          )}
          {fileMeta?.source && (() => {
            const sc = SOURCE_CONFIG[fileMeta.source];
            return (
              <span className={`flex items-center gap-1 text-xs border px-2 py-0.5 rounded-full ${sc?.bg || 'bg-slate-50 border-slate-200'} ${sc?.color || 'text-slate-600'}`}>
                {sc?.label || fileMeta.source}
              </span>
            );
          })()}
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 px-2.5 py-1 text-xs text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-md transition-colors"
          >
            {copied ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
            {copied ? '已复制' : '复制'}
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto scrollbar-light" style={{ scrollbarGutter: 'stable' }}>
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 size={ICON_SIZES.xl} className="text-blue-500 animate-spin" />
          </div>
        ) : (
          <div className="px-8 py-6 max-w-4xl mx-auto">
            <MarkdownWithHighlight content={content} className="wiki-reader" />
          </div>
        )}
      </div>
    </div>
  );
};

/* ═══════════════════════════════════════════════════════
 *  Empty State
 * ═══════════════════════════════════════════════════════ */

const EmptyState: React.FC = () => (
  <div className="h-72 flex flex-col items-center justify-center bg-white rounded-2xl border border-dashed border-slate-200 text-slate-400">
    <div className="w-16 h-16 rounded-2xl bg-slate-50 flex items-center justify-center mb-4">
      <BookOpen size={32} className="text-slate-300" />
    </div>
    <p className="text-sm font-medium text-slate-500">尚未生成 Repo Wiki</p>
    <p className="mt-2 text-xs max-w-sm text-center leading-relaxed text-slate-400">
      Wiki 在冷启动时自动全量生成，后续通过增量更新保持同步
    </p>
    <p className="mt-3 text-[11px] text-slate-400">
      运行 <code className="text-blue-600 bg-blue-50 px-1 rounded">asd setup</code> 冷启动 ·
      <code className="text-blue-600 bg-blue-50 px-1 rounded ml-1">asd wiki --update</code> 增量更新
    </p>
  </div>
);

/* ═══════════════════════════════════════════════════════
 *  Content Placeholder (no file selected)
 * ═══════════════════════════════════════════════════════ */

const ContentPlaceholder: React.FC<{
  meta: WikiMeta | null;
  onSelectFile: (path: string) => void;
  isGenerating?: boolean;
  progress?: number;
  message?: string;
}> = ({ meta, onSelectFile, isGenerating, progress, message }) => {
  /* 快捷入口：从实际 Wiki 文件列表中匹配，只显示存在的文件 */
  const quickLinkCandidates = [
    { path: 'index.md',          label: '项目概述', desc: '项目信息、技术栈与数据统计',   icon: BookOpen,  color: 'bg-blue-50 text-blue-600 border-blue-200' },
    { path: 'architecture.md',   label: '架构总览', desc: '模块依赖图、SPM Target 结构', icon: Layers,    color: 'bg-violet-50 text-violet-600 border-violet-200' },
    { path: 'getting-started.md',label: '快速上手', desc: '构建、运行与入口分析',         icon: FileCode,  color: 'bg-emerald-50 text-emerald-600 border-emerald-200' },
    { path: 'protocols.md',      label: '协议与组件', desc: '核心协议、委托和组件关系',   icon: Sparkles,  color: 'bg-amber-50 text-amber-600 border-amber-200' },
  ];
  const fileSet = new Set(meta?.files?.map((f: any) => f.path || f.name) ?? []);
  const quickLinks = quickLinkCandidates.filter(l => fileSet.size === 0 || fileSet.has(l.path));

  return (
    <div className="p-8 overflow-y-auto flex-1">
      {/* 生成中的沿浸式提示 */}
      {isGenerating && (
        <div className="mb-8 flex flex-col items-center">
          <div className="relative w-20 h-20 mb-5">
            {/* 背景脉冲圈 */}
            <span className="absolute inset-0 rounded-full bg-blue-100 animate-ping opacity-20" />
            <span className="absolute inset-2 rounded-full bg-blue-50 animate-pulse" />
            <div className="absolute inset-0 flex items-center justify-center">
              <Bot size={36} className="text-blue-500 animate-pulse" />
            </div>
          </div>
          <h3 className="text-lg font-semibold text-slate-700 mb-1">Wiki 正在生成中…</h3>
          <p className="text-sm text-slate-500 max-w-md text-center leading-relaxed">
            {message || 'AI 正在分析项目结构并撰写文档，新文件会自动出现在左侧文件树中'}
          </p>
          {typeof progress === 'number' && (
            <div className="mt-4 w-48">
              <div className="w-full bg-slate-100 rounded-full h-2">
                <div
                  className="bg-gradient-to-r from-blue-500 to-indigo-500 h-2 rounded-full transition-all duration-700 ease-out"
                  style={{ width: `${Math.max(progress, 3)}%` }}
                />
              </div>
              <p className="text-xs text-center text-blue-500 mt-1.5 font-mono">{progress}%</p>
            </div>
          )}
        </div>
      )}

      {/* 常规选择文件提示 + 快捷入口 */}
      {!isGenerating && (
        <div className="text-center mb-8">
          <div className="w-12 h-12 bg-slate-100 rounded-xl flex items-center justify-center mx-auto mb-3">
            <FileText size={24} className="text-slate-400" />
          </div>
          <h3 className="text-lg font-semibold text-slate-700">选择一个文件开始阅读</h3>
          <p className="text-sm text-slate-500 mt-1">从左侧文件树选择，或使用下方快捷入口</p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 max-w-lg mx-auto">
        {quickLinks.map(link => {
          const Icon = link.icon;
          return (
            <button
              key={link.path}
              onClick={() => onSelectFile(link.path)}
              className={`text-left p-4 rounded-xl border ${link.color} hover:shadow-sm transition-all group`}
            >
              <Icon size={20} className="mb-2 opacity-70 group-hover:opacity-100" />
              <div className="font-medium text-sm">{link.label}</div>
              <div className="text-xs opacity-60 mt-0.5">{link.desc}</div>
            </button>
          );
        })}
      </div>

      {meta && (
        <div className="mt-8 text-center text-xs text-slate-400">
          {meta.generatedAt && `最后生成: ${new Date(meta.generatedAt).toLocaleString('zh-CN')}`}
          {meta.duration != null && ` · 耗时 ${formatDuration(meta.duration)}`}
          {meta.version && ` · v${meta.version}`}
        </div>
      )}
    </div>
  );
};

/* ═══════════════════════════════════════════════════════
 *  Main Component
 * ═══════════════════════════════════════════════════════ */

const WikiView: React.FC = () => {
  const [status, setStatus] = useState<WikiStatus>({ task: { status: 'idle' } });
  const [files, setFiles] = useState<WikiFile[]>([]);
  const [wikiExists, setWikiExists] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string>('');
  const [fileLoading, setFileLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [meta, setMeta] = useState<WikiMeta | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Data Loading ──

  const loadStatus = useCallback(async () => {
    try {
      const s = await api.wikiStatus();
      setStatus(s);
      return s;
    } catch { return null; }
  }, []);

  const loadFiles = useCallback(async () => {
    try {
      const result = await api.wikiFiles();
      setFiles(result.files || []);
      setWikiExists(result.exists);
    } catch { /* silent */ }
  }, []);

  const loadMeta = useCallback(async () => {
    try {
      const result = await api.wikiFileContent('meta.json');
      if (result?.content) setMeta(JSON.parse(result.content));
    } catch { /* no meta */ }
  }, []);

  // ── Init ──

  useEffect(() => {
    const init = async () => {
      setInitialLoading(true);
      await Promise.all([loadStatus(), loadFiles(), loadMeta()]);
      setInitialLoading(false);
    };
    init();
  }, [loadStatus, loadFiles, loadMeta]);

  // ── Polling ──

  useEffect(() => {
    if (status.task.status === 'running') {
      let filePollCounter = 0;
      pollRef.current = setInterval(async () => {
        const s = await loadStatus();
        filePollCounter++;
        // 每 3 次状态轮询刷新一次文件列表（~4.5s），让新文件实时出现
        if (filePollCounter % 3 === 0) {
          await loadFiles();
        }
        if (s && s.task.status !== 'running') {
          await Promise.all([loadFiles(), loadMeta()]);
          if (pollRef.current) clearInterval(pollRef.current);
        }
      }, 1500);
    } else {
      if (pollRef.current) clearInterval(pollRef.current);
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [status.task.status, loadStatus, loadFiles, loadMeta]);

  // ── Actions ──

  const handleUpdate = async () => {
    try {
      await api.wikiUpdate();
      setStatus(prev => ({
        ...prev,
        task: { ...prev.task, status: 'running', progress: 0, message: '增量更新中...' },
      }));
    } catch (err: any) {
      console.error('Wiki update failed:', err);
    }
  };

  const handleAbort = async () => {
    try {
      await api.wikiAbort();
      await loadStatus();
    } catch (err: any) {
      console.error('Wiki abort failed:', err);
    }
  };

  const handleFileSelect = async (filePath: string) => {
    if (filePath === 'meta.json') return;
    setSelectedFile(filePath);
    setFileLoading(true);
    try {
      const result = await api.wikiFileContent(filePath);
      setFileContent(result.content);
    } catch {
      setFileContent('# 加载失败\n\n无法读取文件内容。');
    } finally {
      setFileLoading(false);
    }
  };

  const handleBack = () => {
    setSelectedFile(null);
    setFileContent('');
  };

  // ── Memoized tree ──

  const displayFiles = useMemo(
    () => files.filter(f => f.path !== 'meta.json'),
    [files],
  );

  const tree = useMemo(
    () => buildTree(displayFiles, meta?.files),
    [displayFiles, meta],
  );

  // ── Render ──

  if (initialLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 size={ICON_SIZES.xl} className="text-blue-500 animate-spin" />
      </div>
    );
  }

  const showEmpty = !wikiExists && displayFiles.length === 0 && status.task.status !== 'running';

  return (
    <div className="h-full flex flex-col overflow-hidden p-6 pt-4">
      {/* Progress / Status — 仅在错误或变更提示时显示 */}
      <StatusBanner task={status.task} wiki={status.wiki} />

      {showEmpty ? (
        <EmptyState />
      ) : (
        <>
          {/* 紧凑生成中提示条 */}
          {status.task.status === 'running' && (
            <div className="mb-3 flex items-center gap-3 px-4 py-2.5 bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200/70 rounded-xl shrink-0">
              <div className="relative flex items-center justify-center w-6 h-6">
                <span className="absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-30 animate-ping" />
                <Loader2 size={16} className="text-blue-600 animate-spin relative" />
              </div>
              <div className="flex-1 min-w-0">
                <span className="text-sm font-medium text-blue-800">Wiki 正在生成中</span>
                {status.task.message && (
                  <span className="text-xs text-blue-500 ml-2 truncate">{status.task.message}</span>
                )}
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <div className="w-24 bg-blue-100 rounded-full h-1.5">
                  <div
                    className="bg-blue-500 h-1.5 rounded-full transition-all duration-700 ease-out"
                    style={{ width: `${Math.max(status.task.progress || 0, 3)}%` }}
                  />
                </div>
                <span className="text-xs font-mono text-blue-600 w-8 text-right">{status.task.progress || 0}%</span>
              </div>
            </div>
          )}

          {/* Split Layout: Tree + Content */}
          <div className="flex gap-4 flex-1 min-h-0 overflow-hidden">
            {/* Sidebar — 固定，独立滚动 */}
            <div className={`w-64 flex-shrink-0 bg-white border border-slate-200 rounded-xl flex flex-col overflow-hidden ${
              selectedFile ? 'hidden lg:flex' : ''
            }`}>
              {/* Sidebar Header — 标题 + 搜索 + 操作 */}
              <div className="px-3 pt-3 pb-2 border-b border-slate-100 shrink-0">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <BookOpen size={16} className="text-blue-500" />
                    <span className="text-sm font-semibold text-slate-700">Wiki</span>
                    {meta?.version && <span className="text-[10px] text-slate-300">v{meta.version}</span>}
                  </div>
                  <div className="flex items-center gap-1">
                    {wikiExists && (
                      <span className="text-[10px] text-slate-400">{displayFiles.length} 篇</span>
                    )}
                    {status.task.status !== 'running' && wikiExists && (
                      <button
                        onClick={handleUpdate}
                        title="增量更新"
                        className="p-1 rounded-md text-blue-500 hover:bg-blue-50 transition-colors"
                      >
                        <RefreshCw size={13} />
                      </button>
                    )}
                  </div>
                </div>
                <div className="relative">
                  <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input
                    type="text"
                    placeholder="搜索文件..."
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    className="w-full pl-8 pr-3 py-2 text-sm bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-200 focus:border-blue-300 transition-all"
                  />
                </div>
              </div>
              <div className="p-2 overflow-y-auto flex-1 min-h-0 scrollbar-light">
                <FileTree tree={tree} selectedFile={selectedFile} onSelect={handleFileSelect} searchQuery={searchQuery} />
                {/* 文件树底部 — 生成中提示 */}
                {status.task.status === 'running' && (
                  <div className="mx-2 mt-3 mb-1 flex items-center gap-2 px-3 py-2 bg-blue-50 border border-blue-100 rounded-lg">
                    <Loader2 size={12} className="text-blue-500 animate-spin flex-shrink-0" />
                    <span className="text-[11px] text-blue-600 leading-tight">文件生成中，新文档将自动出现…</span>
                  </div>
                )}
              </div>
              {/* Sidebar Footer — 生成时间 */}
              {meta?.generatedAt && (
                <div className="px-3 py-2 border-t border-slate-100 shrink-0">
                  <div className="flex items-center gap-1.5 text-[10px] text-slate-400">
                    <Clock size={10} />
                    <span>{formatDate(meta.generatedAt)}</span>
                    {meta.duration != null && <span>· {formatDuration(meta.duration)}</span>}
                  </div>
                </div>
              )}
            </div>

            {/* Content Area — 独立滚动 */}
            <div className={`flex-1 bg-white border border-slate-200 rounded-xl overflow-hidden flex flex-col min-h-0 ${
              !selectedFile ? 'hidden lg:flex' : ''
            }`}>
              {selectedFile ? (
                <DocumentReader
                  filePath={selectedFile}
                  content={fileContent}
                  loading={fileLoading}
                  meta={meta}
                  onBack={handleBack}
                />
              ) : (
                <ContentPlaceholder
                  meta={meta}
                  onSelectFile={handleFileSelect}
                  isGenerating={status.task.status === 'running'}
                  progress={status.task.progress}
                  message={status.task.message}
                />
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default WikiView;
