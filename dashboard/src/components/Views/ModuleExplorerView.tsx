import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Box, Zap, Edit3, Cpu, Loader2, Layers, Shield, AlertTriangle, RefreshCw, Trash2, FolderOpen, ChevronRight } from 'lucide-react';
import { SPMTarget, ScanResultItem, Recipe, GuardAuditResult, ProjectDirectory } from '../../types';
import api from '../../api';
import { notify } from '../../utils/notification';
import { ICON_SIZES } from '../../constants/icons';
import { useI18n } from '../../i18n';
import { getErrorMessage, getErrorStatus } from '../../utils/error';
import ContextAwareSearchPanel from './ContextAwareSearchPanel';
import ScanResultCard from './ScanResultCard';
import SPMCompareDrawer, { type CompareDrawerData, type SimilarRecipe } from './SPMCompareDrawer';

interface ModuleExplorerViewProps {
  targets: SPMTarget[];
  filteredTargets: SPMTarget[];
  selectedTargetName: string | null;
  isScanning: boolean;
  scanProgress: { current: number; total: number; status: string };
  scanFileList: { name: string; path: string }[];
  scanResults: ScanResultItem[];
  guardAudit?: GuardAuditResult | null;
  handleScanTarget: (target: SPMTarget) => void;
  handleScanProject?: () => void;
  handleUpdateScanResult: (index: number, updates: any) => void;
  handleSaveExtracted: (res: any) => void;
  handlePromoteToCandidate?: (res: ScanResultItem, index: number) => void;
  handleDeleteCandidate?: (targetName: string, candidateId: string) => void;
  onEditRecipe?: (recipe: Recipe) => void;
  isShellTarget: (name: string) => boolean;
  recipes?: Recipe[];
  isSavingRecipe?: boolean;
  handleRefreshProject?: () => void;
  /** 添加自定义目录到常驻列表（localStorage 持久化） */
  onAddCustomFolder?: (target: SPMTarget) => void;
  /** 移除常驻自定义目录 */
  onRemoveCustomFolder?: (folderPath: string) => void;
}

/** 语言 → 徽章颜色映射 */
const LANG_COLORS: Record<string, string> = {
  swift: 'bg-orange-100 text-orange-700 border-orange-200',
  objectivec: 'bg-blue-100 text-blue-700 border-blue-200',
  go: 'bg-cyan-100 text-cyan-700 border-cyan-200',
  python: 'bg-yellow-100 text-yellow-700 border-yellow-200',
  java: 'bg-red-100 text-red-700 border-red-200',
  kotlin: 'bg-purple-100 text-purple-700 border-purple-200',
  javascript: 'bg-amber-100 text-amber-700 border-amber-200',
  typescript: 'bg-blue-100 text-blue-700 border-blue-200',
  rust: 'bg-orange-100 text-orange-800 border-orange-300',
  ruby: 'bg-rose-100 text-rose-700 border-rose-200',
  c: 'bg-gray-100 text-gray-700 border-gray-200',
  cpp: 'bg-gray-100 text-gray-700 border-gray-200',
};

/** 语言 → 缩写显示名 */
const LANG_ABBR: Record<string, string> = {
  swift: 'Swift',
  objectivec: 'ObjC',
  go: 'Go',
  python: 'Py',
  java: 'Java',
  kotlin: 'KT',
  javascript: 'JS',
  typescript: 'TS',
  rust: 'RS',
  ruby: 'RB',
  c: 'C',
  cpp: 'C++',
};

const ModuleExplorerView: React.FC<ModuleExplorerViewProps> = ({
  targets,
  filteredTargets,
  selectedTargetName,
  isScanning,
  scanProgress,
  scanFileList,
  scanResults,
  guardAudit,
  handleScanTarget,
  handleScanProject,
  handleUpdateScanResult,
  handleSaveExtracted,
  handlePromoteToCandidate,
  handleDeleteCandidate,
  onEditRecipe,
  isShellTarget,
  recipes = [],
  isSavingRecipe = false,
  handleRefreshProject,
  onAddCustomFolder,
  onRemoveCustomFolder
}) => {
  const { t } = useI18n();
  const [editingCodeIndex, setEditingCodeIndex] = useState<number | null>(null);
  const [expandedEditIndex, setExpandedEditIndex] = useState<number | null>(null);
  const [similarityMap, setSimilarityMap] = useState<Record<string, SimilarRecipe[]>>({});
  const [, setSimilarityLoading] = useState<string | null>(null);
  const [compareDrawer, setCompareDrawer] = useState<CompareDrawerData | null>(null);
  const [isContextSearchOpen, setIsContextSearchOpen] = useState(false);
  const [selectedContextFile, ] = useState<string | undefined>();
  const [selectedContextTarget, ] = useState<string | undefined>();
  const fetchedSimilarRef = useRef<Set<string>>(new Set());
  const prevSimilarKeysRef = useRef<string[]>([]);

  // ── 目录浏览器状态（内联替代弹窗） ──
  const [projectDirs, setProjectDirs] = useState<ProjectDirectory[]>([]);
  const [loadingDirs, setLoadingDirs] = useState(false);
  const dirsLoaded = useRef(false);

  // ── 侧栏标签页状态 ──
  const MODULE_THRESHOLD = 3;
  const [sidebarTab, setSidebarTab] = useState<'modules' | 'folders'>('modules');
  const smartDefaultApplied = useRef(false);
  const nonShellTargetCount = useMemo(
    () => filteredTargets.filter(t => !isShellTarget(t.name)).length,
    [filteredTargets, isShellTarget]
  );

  // 智能默认（仅首次 targets 加载后执行一次）：
  // 模块数 >= 阈值 → 显示模块；模块数少（如 TS 项目无模块概念）→ 显示目录
  useEffect(() => {
    if (smartDefaultApplied.current) return;
    if (targets.length === 0) return;
    smartDefaultApplied.current = true;
    if (nonShellTargetCount < MODULE_THRESHOLD) {
      setSidebarTab('folders');
    } else {
      setSidebarTab('modules');
    }
  }, [targets.length, nonShellTargetCount]);

  // 切到目录标签时自动加载目录列表（仅加载一次）
  useEffect(() => {
    if (sidebarTab !== 'folders' || dirsLoaded.current) return;
    dirsLoaded.current = true;
    setLoadingDirs(true);
    api.browseDirectories('', 3).then(dirs => {
      setProjectDirs(dirs);
    }).catch(() => {
      setProjectDirs([]);
    }).finally(() => {
      setLoadingDirs(false);
    });
  }, [sidebarTab]);

  /** 选择目录并触发扫描 — 构建虚拟 Target，持久化到侧边栏 */
  const handleSelectFolder = useCallback((dir: ProjectDirectory) => {
    const virtualTarget: SPMTarget = {
      name: dir.name,
      packageName: dir.name,
      packagePath: dir.path,
      targetDir: dir.path,
      path: dir.path,
      type: 'directory',
      language: dir.language || 'unknown',
      discovererId: 'folder-scan',
      discovererName: t('moduleExplorer.discovererFolderScan'),
      info: { source: 'manual-folder-scan', originalPath: dir.path },
      isVirtual: true,
    };
    onAddCustomFolder?.(virtualTarget);
    handleScanTarget(virtualTarget);
    // 切回模块标签，以便看到新添加的虚拟目录
    setSidebarTab('modules');
  }, [handleScanTarget, onAddCustomFolder, t]);


  const fetchSimilarity = useCallback(async (key: string, opts: { targetName?: string; candidateId?: string; candidate?: { title?: string; summary?: string; code?: string; usageGuide?: string } }) => {
  if (fetchedSimilarRef.current.has(key)) return;
  fetchedSimilarRef.current.add(key);
  setSimilarityLoading(key);
  try {
    const body = opts.candidateId && opts.targetName
    ? { targetName: opts.targetName, candidateId: opts.candidateId }
    : { candidate: opts.candidate || {} };
    const resp = await api.getCandidateSimilarityEx(body);
    setSimilarityMap(prev => ({ ...prev, [key]: resp.similar || [] }));
  } catch (_) {
    setSimilarityMap(prev => ({ ...prev, [key]: [] }));
  } finally {
    setSimilarityLoading(null);
  }
  }, []);

  const openCompare = useCallback(async (res: ScanResultItem, recipeName: string, similarList: SimilarRecipe[] = []) => {
  const targetName = res.candidateTargetName || '';
  // 移除 .md 后缀（如果有的话）
  const normalizedRecipeName = recipeName.replace(/\.md$/i, '');
  let recipeContent = '';
  const existing = recipes?.find(r => r.name === normalizedRecipeName || r.name.endsWith('/' + normalizedRecipeName));
  if (existing?.content) {
    recipeContent = [existing.content.pattern, existing.content.markdown].filter(Boolean).join('\n\n') || '';
  } else {
    try {
    const recipeData = await api.getRecipeContentByName(normalizedRecipeName);
    recipeContent = recipeData.content;
    } catch (err: unknown) {
    const status = getErrorStatus(err);
    const message = getErrorMessage(err);
    if (status === 404) {
      notify(t('moduleExplorer.recipeNotExist', { name: normalizedRecipeName }), { title: t('moduleExplorer.recipeNotExistTitle'), type: 'error' });
    } else {
      notify(message, { title: t('moduleExplorer.loadRecipeFailed'), type: 'error' });
    }
    return;
    }
  }
  const initialCache: Record<string, string> = { [normalizedRecipeName]: recipeContent };
  setCompareDrawer({ candidate: res, targetName, recipeName: normalizedRecipeName, recipeContent, similarList: similarList.slice(0, 3), recipeContents: initialCache });
  }, [recipes]);



  useEffect(() => {
  const keys = scanResults.map((r, i) => r.candidateId ?? `scan-${i}`);
  const prevKeys = prevSimilarKeysRef.current;
  const keysChanged = keys.length !== prevKeys.length || keys.some((k, i) => k !== prevKeys[i]);
  if (keysChanged) {
    fetchedSimilarRef.current.clear();
    prevSimilarKeysRef.current = keys;
  }
  // 延迟请求相似度 — 等待卡片动画渲染完成后再发起，避免布局抖动
  const timer = setTimeout(() => {
    scanResults.forEach((res, i) => {
      const key = res.candidateId ?? res.id ?? `scan-${i}`;
      if (res.candidateId && res.candidateTargetName) {
        fetchSimilarity(key, { targetName: res.candidateTargetName, candidateId: res.candidateId });
      } else {
        fetchSimilarity(key, { candidate: { title: res.title, summary: res.description || '', code: res.content?.pattern || '', usageGuide: res.content?.markdown || '' } });
      }
    });
  }, 800);
  return () => clearTimeout(timer);
  }, [scanResults, fetchSimilarity]);

  return (
  <div className="flex gap-4 xl:gap-6 2xl:gap-8 h-full">
    <div className="w-64 xl:w-72 2xl:w-80 bg-[var(--bg-surface)] rounded-xl border border-[var(--border-default)] flex flex-col overflow-hidden shrink-0">
    {/* ── 标签页切换 ── */}
    <div className="p-3 bg-[var(--bg-subtle)] border-b border-[var(--border-default)]">
      <div className="flex items-center justify-between">
      <div className="flex items-center gap-0.5 bg-[var(--bg-subtle)] rounded-lg p-0.5">
        <button
        onClick={() => setSidebarTab('modules')}
        className={`text-[11px] px-2.5 py-1.5 rounded-md font-bold transition-all ${
          sidebarTab === 'modules'
          ? 'bg-[var(--bg-surface)] text-blue-700 shadow-sm'
          : 'text-[var(--fg-secondary)] hover:text-[var(--fg-primary)]'
        }`}
        >
        {t('moduleExplorer.modulesTabLabel', { count: nonShellTargetCount })}
        </button>
        <button
        onClick={() => setSidebarTab('folders')}
        className={`text-[11px] px-2.5 py-1.5 rounded-md font-bold transition-all ${
          sidebarTab === 'folders'
          ? 'bg-[var(--bg-surface)] text-blue-700 shadow-sm'
          : 'text-[var(--fg-secondary)] hover:text-[var(--fg-primary)]'
        }`}
        >
        {t('moduleExplorer.foldersTabLabel')}
        </button>
      </div>
      {handleRefreshProject && (
        <button
        onClick={handleRefreshProject}
        title={t('moduleExplorer.refreshProject')}
        className="p-1.5 rounded-md hover:bg-blue-50 text-[var(--fg-secondary)] hover:text-blue-600 border border-transparent hover:border-blue-200 transition-all"
        >
        <RefreshCw size={ICON_SIZES.md} />
        </button>
      )}
      </div>
    </div>
    <div className="flex-1 overflow-y-auto p-2 space-y-1">
      {sidebarTab === 'modules' ? (
      <>
      {filteredTargets.map(tgt => {
      const isShell = isShellTarget(tgt.name);
      const isSelected = selectedTargetName === tgt.name;
      const isVirtual = tgt.isVirtual || tgt.discovererId === 'folder-scan';
      const lang = tgt.language || '';
      const langBadgeClass = LANG_COLORS[lang] || 'bg-[var(--bg-subtle)] text-[var(--fg-secondary)] border-[var(--border-default)]';
      const subtitle = tgt.packageName && tgt.packageName !== tgt.name ? tgt.packageName : (tgt.discovererName || '');
      return (
        <button 
        key={`${tgt.discovererId || 'default'}::${tgt.name}`} 
        onClick={() => handleScanTarget(tgt)} 
        disabled={isScanning}
        className={`w-full text-left p-3 rounded-lg flex items-center justify-between group transition-all border ${
          isScanning ? 'opacity-50 cursor-not-allowed' : 'hover:bg-[var(--bg-subtle)]'
        } ${isSelected ? 'bg-blue-50 border-blue-200 ring-1 ring-blue-200' : 'bg-[var(--bg-surface)] border-transparent'} ${isShell ? 'opacity-90' : ''}`}
        >
        <div className={`flex flex-col max-w-[85%] ${isShell ? 'opacity-60' : ''}`}>
          <div className="flex items-center gap-2">
          {!isShell && <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${isVirtual ? 'bg-emerald-500' : isSelected ? 'bg-blue-600' : 'bg-blue-600'}`} />}
          <span className={`text-sm truncate ${!isShell ? 'font-bold' : 'font-medium'} ${isSelected ? 'text-blue-700' : ''}`}>{tgt.name}</span>
          {lang && !isShell && !isVirtual && lang !== 'unknown' && (
            <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border shrink-0 ${langBadgeClass}`}>
            {LANG_ABBR[lang] || lang.toUpperCase()}
            </span>
          )}
          </div>
          {subtitle && <span className="text-[10px] text-[var(--fg-muted)] truncate pl-3">{subtitle}</span>}
        </div>
        {isShell ? (
          <span className="text-[9px] font-bold text-[var(--fg-muted)] border border-[var(--border-default)] px-1 rounded">SHELL</span>
        ) : isVirtual && onRemoveCustomFolder ? (
          <div className="flex items-center gap-0.5 shrink-0">
          <Zap size={ICON_SIZES.sm} className={`${isSelected ? 'text-blue-500 opacity-100' : 'text-blue-500 opacity-0 group-hover:opacity-100'} transition-opacity`} />
          <button
            onClick={(e) => { e.stopPropagation(); onRemoveCustomFolder(tgt.path || ''); }}
            title={t('moduleExplorer.removeFolder')}
            className="p-0.5 rounded text-[var(--fg-muted)] hover:text-red-500 hover:bg-red-50 opacity-0 group-hover:opacity-100 transition-all"
          >
            <Trash2 size={12} />
          </button>
          </div>
        ) : (
          <Zap size={ICON_SIZES.sm} className={`shrink-0 ${isSelected ? 'text-blue-500 opacity-100' : 'text-blue-500 opacity-0 group-hover:opacity-100'} transition-opacity`} />
        )}
        </button>
      );
      })}
      </>
      ) : (
      <>
      {loadingDirs ? (
        <div className="flex flex-col items-center justify-center py-12 text-[var(--fg-muted)]">
        <Loader2 size={ICON_SIZES.lg} className="animate-spin mb-3 opacity-40" />
        <p className="text-xs">{t('moduleExplorer.scanningDirs')}</p>
        </div>
      ) : projectDirs.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-[var(--fg-muted)]">
        <FolderOpen size={ICON_SIZES.xl} className="mb-3 opacity-20" />
        <p className="text-xs text-center px-4 leading-relaxed">
          {t('moduleExplorer.noDirs')}
        </p>
        </div>
      ) : (
        projectDirs.map(dir => {
        const dirLangClass = LANG_COLORS[dir.language] || 'bg-[var(--bg-subtle)] text-[var(--fg-secondary)] border-[var(--border-default)]';
        return (
          <button
          key={dir.path}
          onClick={() => handleSelectFolder(dir)}
          disabled={isScanning || !dir.hasSourceFiles}
          className={`w-full text-left p-2.5 rounded-lg flex items-center gap-2.5 transition-all border border-transparent
            ${dir.hasSourceFiles
            ? (isScanning ? 'opacity-50 cursor-not-allowed' : 'hover:bg-emerald-50 hover:border-emerald-200 cursor-pointer')
            : 'opacity-40 cursor-not-allowed'}
          `}
          style={{ paddingLeft: `${dir.depth * 14 + 10}px` }}
          >
          <FolderOpen size={ICON_SIZES.sm} className={dir.hasSourceFiles ? 'text-emerald-500 shrink-0' : 'text-[var(--fg-muted)] shrink-0'} />
          <span className="text-sm font-medium flex-1 truncate">{dir.name}</span>
          {dir.hasSourceFiles && dir.language !== 'unknown' && (
            <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border shrink-0 ${dirLangClass}`}>
            {LANG_ABBR[dir.language] || dir.language.toUpperCase()}
            </span>
          )}
          {dir.hasSourceFiles && (
            <span className="text-[10px] text-[var(--fg-muted)] shrink-0">{t('moduleExplorer.sourceFileCount', { count: dir.sourceFileCount })}</span>
          )}
          <ChevronRight size={12} className="text-[var(--fg-muted)] shrink-0" />
          </button>
        );
        })
      )}
      <div className="px-3 py-2 text-[10px] text-[var(--fg-muted)] text-center">
        {t('moduleExplorer.selectFolderHint')}
      </div>
      </>
      )}
    </div>
    </div>
    <div className="flex-1 bg-[var(--bg-surface)] rounded-xl border border-[var(--border-default)] flex flex-col overflow-hidden relative">
    <div className="p-4 bg-[var(--bg-subtle)] border-b border-[var(--border-default)] font-bold text-sm flex justify-between items-center">
      <div className="flex items-center gap-2">
      {selectedTargetName === '__project__' ? (
        <>
        <Layers size={ICON_SIZES.md} className="text-indigo-500" />
        <span>{t('moduleExplorer.fullProjectResults')}</span>
        {scanResults.length > 0 && (
          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 border border-indigo-200">PROJECT</span>
        )}
        </>
      ) : selectedTargetName ? (
        <>
        <Zap size={ICON_SIZES.md} className="text-blue-500" />
        <span>{t('moduleExplorer.moduleLabel', { name: selectedTargetName })}</span>
        {scanResults.length > 0 && (
          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 border border-blue-200">MODULE</span>
        )}
        </>
      ) : (
        <>
        <Edit3 size={ICON_SIZES.md} className="text-[var(--fg-muted)]" />
        <span>{t('moduleExplorer.reviewResults')}</span>
        </>
      )}
      {scanResults.length > 0 && <span className="text-[var(--fg-muted)] font-normal text-xs ml-1">({t('moduleExplorer.resultsCount', { count: scanResults.length })}{scanResults[0]?.trigger ? t('moduleExplorer.candidateSuffix') : ''})</span>}
      </div>
    </div>
    
    <div className="flex-1 overflow-y-auto p-6 space-y-8 relative">
      {isScanning && (
      <div className="absolute inset-0 bg-[var(--bg-surface)] backdrop-blur-[2px] z-10 flex flex-col items-center justify-center text-blue-600 px-4 xl:px-8 overflow-y-auto">
        <div className="relative mb-6">
        <div className="w-16 h-16 border-4 border-blue-100 border-t-blue-600 rounded-full animate-spin"></div>
        <Cpu size={ICON_SIZES.xxl} className="absolute inset-0 m-auto text-blue-600 animate-pulse" />
        </div>
        <p className="font-bold text-lg animate-pulse mb-1">
        {selectedTargetName === '__project__' ? t('moduleExplorer.fullProjectScanning') : t('moduleExplorer.moduleScanLabel', { name: selectedTargetName || '...' })}
        </p>
        <p className="text-sm text-[var(--fg-secondary)] mb-4">{scanProgress.status}</p>
        <div className="w-full max-w-md bg-[var(--bg-subtle)] rounded-full h-2.5 overflow-hidden">
        <div
          className="h-full bg-blue-600 rounded-full transition-all duration-500 ease-out"
          style={{ width: `${Math.min(scanProgress.total ? (scanProgress.current / scanProgress.total) * 100 : 0, 98)}%` }}
        />
        </div>
        <p className="text-xs text-[var(--fg-muted)] mt-3">
        {scanProgress.total ? `${Math.round((scanProgress.current / scanProgress.total) * 100)}%` : '0%'}
        </p>
      </div>
      )}

      {!isScanning && scanResults.length === 0 && (
      <div className="h-full flex flex-col items-center justify-center text-[var(--fg-muted)] text-center">
        <Box size={ICON_SIZES.xxxl} className="mb-4 opacity-20" />
        <p className="font-medium text-[var(--fg-secondary)]">{t('moduleExplorer.knowledgeExtract')}</p>
        <p className="text-xs mt-2 max-w-sm leading-relaxed">
        {t('moduleExplorer.knowledgeExtractHint')}
        </p>
      </div>
      )}

      {/* Guard 审计摘要 — 仅全项目扫描模式显示 */}
      {!isScanning && selectedTargetName === '__project__' && guardAudit?.summary && (
      <div className={`rounded-xl border p-4 ${guardAudit.summary.totalViolations > 0 ? 'border-amber-200 bg-amber-50' : 'border-emerald-200 bg-emerald-50'}`}>
        <div className="flex items-center gap-2 mb-2">
        <Shield size={ICON_SIZES.md} className={guardAudit.summary.totalViolations > 0 ? 'text-amber-600' : 'text-emerald-600'} />
        <span className="text-sm font-bold text-[var(--fg-primary)]">{t('moduleExplorer.guardAuditSummary')}</span>
        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 border border-indigo-200">PROJECT SCAN</span>
        </div>
        <div className="flex flex-wrap gap-3 xl:gap-6 text-sm">
        <div className="flex items-center gap-1.5">
          <span className="text-[var(--fg-secondary)]">{t('moduleExplorer.auditedFiles')}</span>
          <span className="font-bold text-[var(--fg-primary)]">{guardAudit.summary.totalFiles}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[var(--fg-secondary)]">{t('moduleExplorer.totalViolationsLabel')}</span>
          <span className={`font-bold ${guardAudit.summary.totalViolations > 0 ? 'text-amber-700' : 'text-emerald-700'}`}>{guardAudit.summary.totalViolations}</span>
        </div>
        {guardAudit.summary.errors > 0 && (
          <div className="flex items-center gap-1.5">
          <AlertTriangle size={ICON_SIZES.sm} className="text-red-500" />
          <span className="font-bold text-red-700">{t('moduleExplorer.errorsCount', { count: guardAudit.summary.errors })}</span>
          </div>
        )}
        {guardAudit.summary.warnings > 0 && (
          <div className="flex items-center gap-1.5">
          <AlertTriangle size={ICON_SIZES.sm} className="text-amber-500" />
          <span className="font-bold text-amber-700">{t('moduleExplorer.warningsCount', { count: guardAudit.summary.warnings })}</span>
          </div>
        )}
        </div>
      </div>
      )}
      
      {scanResults.map((res, i) => (
        <ScanResultCard
          key={i}
          res={res}
          index={i}
          editingCodeIndex={editingCodeIndex}
          setEditingCodeIndex={setEditingCodeIndex}
          expandedEditIndex={expandedEditIndex}
          setExpandedEditIndex={setExpandedEditIndex}
          similarityMap={similarityMap}
          handleUpdateScanResult={handleUpdateScanResult}
          handleSaveExtracted={handleSaveExtracted}
          handlePromoteToCandidate={handlePromoteToCandidate}
          openCompare={openCompare}
          isSavingRecipe={isSavingRecipe}
        />
      ))}
    </div>
    </div>

    {/* Compare drawer */}
    {compareDrawer && (
      <SPMCompareDrawer
        data={compareDrawer}
        onClose={() => setCompareDrawer(null)}
        onDataChange={setCompareDrawer}
        recipes={recipes}
        handleSaveExtracted={handleSaveExtracted}
        handleDeleteCandidate={handleDeleteCandidate}
        onEditRecipe={onEditRecipe}
        isSavingRecipe={isSavingRecipe}
      />
    )}

    {/* 上下文感知搜索面板 */}
    <ContextAwareSearchPanel
    isOpen={isContextSearchOpen}
    onClose={() => setIsContextSearchOpen(false)}
    targetName={selectedContextTarget}
    currentFile={selectedContextFile}
    language={filteredTargets.find(t => t.name === selectedTargetName)?.language || 'unknown'}
    onSelectRecipe={(recipeName) => {
      // Recipe selected for detail view
    }}
    />
  </div>
  );
};

export default ModuleExplorerView;
