import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Box, Zap, Edit3, Cpu, Loader2, Layers, Shield, AlertTriangle, RefreshCw, FolderPlus, FolderOpen, X, ChevronRight, Trash2 } from 'lucide-react';
import { SPMTarget, ExtractedRecipe, ScanResultItem, Recipe, GuardAuditResult, ProjectDirectory } from '../../types';
import api from '../../api';
import { notify } from '../../utils/notification';
import { ICON_SIZES } from '../../constants/icons';
import { useI18n } from '../../i18n';
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
  const [similarityLoading, setSimilarityLoading] = useState<string | null>(null);
  const [compareDrawer, setCompareDrawer] = useState<CompareDrawerData | null>(null);
  const [isContextSearchOpen, setIsContextSearchOpen] = useState(false);
  const [selectedContextFile, setSelectedContextFile] = useState<string | undefined>();
  const [selectedContextTarget, setSelectedContextTarget] = useState<string | undefined>();
  const fetchedSimilarRef = useRef<Set<string>>(new Set());
  const prevSimilarKeysRef = useRef<string[]>([]);

  // ── 目录选择器状态 ──
  const [showFolderPicker, setShowFolderPicker] = useState(false);
  const [projectDirs, setProjectDirs] = useState<ProjectDirectory[]>([]);
  const [loadingDirs, setLoadingDirs] = useState(false);

  /** 打开目录选择器 — 加载项目目录列表 */
  const openFolderPicker = useCallback(async () => {
    setShowFolderPicker(true);
    setLoadingDirs(true);
    try {
      const dirs = await api.browseDirectories('', 3);
      setProjectDirs(dirs);
    } catch (err: any) {
      notify(err.message || t('moduleExplorer.browseFailedDefault'), { title: t('moduleExplorer.browseFailedTitle'), type: 'error' });
    } finally {
      setLoadingDirs(false);
    }
  }, []);

  /** 选择目录并触发扫描 — 构建虚拟 Target，持久化到侧边栏 */
  const handleSelectFolder = useCallback((dir: ProjectDirectory) => {
    setShowFolderPicker(false);
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
    // 持久化到前端存储
    onAddCustomFolder?.(virtualTarget);
    handleScanTarget(virtualTarget);
  }, [handleScanTarget, onAddCustomFolder]);


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
    } catch (err: any) {
    const status = err.response?.status;
    const message = err.response?.data?.message || err.message;
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
  <div className="flex gap-8 h-full">
    <div className="w-80 bg-white rounded-xl border border-slate-200 flex flex-col overflow-hidden shrink-0">
    <div className="p-4 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
      <span className="font-bold text-sm">{t('moduleExplorer.projectModules', { count: targets.length })}</span>
      <div className="flex items-center gap-1.5">
        <button
          onClick={openFolderPicker}
          disabled={isScanning}
          title={t('moduleExplorer.addFolderScan')}
          className="p-1.5 rounded-md hover:bg-emerald-50 text-slate-500 hover:text-emerald-600 border border-transparent hover:border-emerald-200 transition-all disabled:opacity-40"
        >
          <FolderPlus size={ICON_SIZES.md} />
        </button>
        {handleRefreshProject && (
        <button
          onClick={handleRefreshProject}
          title={t('moduleExplorer.refreshProject')}
          className="p-1.5 rounded-md hover:bg-blue-50 text-slate-500 hover:text-blue-600 border border-transparent hover:border-blue-200 transition-all"
        >
          <RefreshCw size={ICON_SIZES.md} />
        </button>
        )}
      </div>
    </div>
    <div className="flex-1 overflow-y-auto p-2 space-y-1">
      {filteredTargets.map(tgt => {
      const isShell = isShellTarget(tgt.name);
      const isSelected = selectedTargetName === tgt.name;
      const isVirtual = tgt.isVirtual || tgt.discovererId === 'folder-scan';
      const lang = tgt.language || '';
      const langBadgeClass = LANG_COLORS[lang] || 'bg-slate-100 text-slate-500 border-slate-200';
      const subtitle = tgt.packageName && tgt.packageName !== tgt.name ? tgt.packageName : (tgt.discovererName || '');
      return (
        <button 
        key={`${tgt.discovererId || 'default'}::${tgt.name}`} 
        onClick={() => handleScanTarget(tgt)} 
        disabled={isScanning}
        className={`w-full text-left p-3 rounded-lg flex items-center justify-between group transition-all border ${
          isScanning ? 'opacity-50 cursor-not-allowed' : 'hover:bg-slate-50'
        } ${isSelected ? 'bg-blue-50 border-blue-200 ring-1 ring-blue-200' : 'bg-white border-transparent'} ${isShell ? 'opacity-90' : ''}`}
        >
        <div className={`flex flex-col max-w-[85%] ${isShell ? 'opacity-60' : ''}`}>
          <div className="flex items-center gap-2">
          {!isShell && <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${isVirtual ? 'bg-emerald-500' : isSelected ? 'bg-blue-600' : 'bg-blue-600'}`} />}
          <span className={`text-sm truncate ${!isShell ? 'font-bold' : 'font-medium'} ${isSelected ? 'text-blue-700' : ''}`}>{tgt.name}</span>
          {lang && !isShell && (
            <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border shrink-0 ${langBadgeClass}`}>
            {lang.toUpperCase()}
            </span>
          )}
          {isVirtual && (
            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded border shrink-0 bg-emerald-50 text-emerald-600 border-emerald-200">
            FOLDER
            </span>
          )}
          </div>
          {subtitle && <span className="text-[10px] text-slate-400 truncate pl-3">{subtitle}</span>}
        </div>
        {isShell ? (
          <span className="text-[9px] font-bold text-slate-300 border border-slate-100 px-1 rounded">SHELL</span>
        ) : isVirtual && onRemoveCustomFolder ? (
          <div className="flex items-center gap-0.5 shrink-0">
          <Zap size={ICON_SIZES.sm} className={`${isSelected ? 'text-blue-500 opacity-100' : 'text-blue-500 opacity-0 group-hover:opacity-100'} transition-opacity`} />
          <button
            onClick={(e) => { e.stopPropagation(); onRemoveCustomFolder(tgt.path || ''); }}
            title={t('moduleExplorer.removeFolder')}
            className="p-0.5 rounded text-slate-300 hover:text-red-500 hover:bg-red-50 opacity-0 group-hover:opacity-100 transition-all"
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
    </div>
    </div>
    <div className="flex-1 bg-white rounded-xl border border-slate-200 flex flex-col overflow-hidden relative">
    <div className="p-4 bg-slate-50 border-b border-slate-200 font-bold text-sm flex justify-between items-center">
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
        <Edit3 size={ICON_SIZES.md} className="text-slate-400" />
        <span>{t('moduleExplorer.reviewResults')}</span>
        </>
      )}
      {scanResults.length > 0 && <span className="text-slate-400 font-normal text-xs ml-1">({t('moduleExplorer.resultsCount', { count: scanResults.length })}{scanResults[0]?.trigger ? t('moduleExplorer.candidateSuffix') : ''})</span>}
      </div>
    </div>
    
    <div className="flex-1 overflow-y-auto p-6 space-y-8 relative">
      {isScanning && (
      <div className="absolute inset-0 bg-white/90 backdrop-blur-[2px] z-10 flex flex-col items-center justify-center text-blue-600 px-8 overflow-y-auto">
        <div className="relative mb-6">
        <div className="w-16 h-16 border-4 border-blue-100 border-t-blue-600 rounded-full animate-spin"></div>
        <Cpu size={ICON_SIZES.xxl} className="absolute inset-0 m-auto text-blue-600 animate-pulse" />
        </div>
        <p className="font-bold text-lg animate-pulse mb-1">
        {selectedTargetName === '__project__' ? t('moduleExplorer.fullProjectScanning') : t('moduleExplorer.moduleScanLabel', { name: selectedTargetName || '...' })}
        </p>
        <p className="text-sm text-slate-500 mb-4">{scanProgress.status}</p>
        {scanFileList.length > 0 && (
        <div className="w-full max-w-lg mb-4 text-left">
          <p className="text-[10px] font-bold text-slate-400 uppercase mb-2">{t('moduleExplorer.filesInScan', { count: scanFileList.length })}</p>
          <div className="max-h-32 overflow-y-auto space-y-1 rounded-lg bg-slate-50 border border-slate-200 p-2">
          {scanFileList.map((f, i) => (
            <div key={i} className="text-xs font-mono text-slate-600 truncate" title={f.path}>{f.name}</div>
          ))}
          </div>
        </div>
        )}
        <div className="w-full max-w-md bg-slate-100 rounded-full h-2.5 overflow-hidden">
        <div
          className="h-full bg-blue-600 rounded-full transition-all duration-500 ease-out"
          style={{ width: `${Math.min(scanProgress.total ? (scanProgress.current / scanProgress.total) * 100 : 0, 98)}%` }}
        />
        </div>
        <p className="text-xs text-slate-400 mt-3">
        {scanProgress.total ? `${Math.round((scanProgress.current / scanProgress.total) * 100)}%` : '0%'}
        </p>
      </div>
      )}

      {!isScanning && scanResults.length === 0 && (
      <div className="h-full flex flex-col items-center justify-center text-slate-400 text-center">
        <Box size={ICON_SIZES.xxxl} className="mb-4 opacity-20" />
        <p className="font-medium text-slate-600">{t('moduleExplorer.knowledgeExtract')}</p>
        <p className="text-xs mt-2 max-w-sm leading-relaxed">
        {t('moduleExplorer.knowledgeExtractHint')}
        </p>
      </div>
      )}

      {!isScanning && scanFileList.length > 0 && (
      <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
        <p className="text-[10px] font-bold text-slate-400 uppercase mb-2">{t('moduleExplorer.filesInScan', { count: scanFileList.length })}</p>
        <div className="flex flex-wrap gap-2">
        {scanFileList.map((f, i) => (
          <span key={i} className="text-xs font-mono bg-white border border-slate-200 text-slate-600 px-2 py-1 rounded" title={f.path}>{f.name}</span>
        ))}
        </div>
      </div>
      )}

      {/* Guard 审计摘要 — 仅全项目扫描模式显示 */}
      {!isScanning && selectedTargetName === '__project__' && guardAudit?.summary && (
      <div className={`rounded-xl border p-4 ${guardAudit.summary.totalViolations > 0 ? 'border-amber-200 bg-amber-50' : 'border-emerald-200 bg-emerald-50'}`}>
        <div className="flex items-center gap-2 mb-2">
        <Shield size={ICON_SIZES.md} className={guardAudit.summary.totalViolations > 0 ? 'text-amber-600' : 'text-emerald-600'} />
        <span className="text-sm font-bold text-slate-700">{t('moduleExplorer.guardAuditSummary')}</span>
        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 border border-indigo-200">PROJECT SCAN</span>
        </div>
        <div className="flex gap-6 text-sm">
        <div className="flex items-center gap-1.5">
          <span className="text-slate-500">{t('moduleExplorer.auditedFiles')}</span>
          <span className="font-bold text-slate-700">{guardAudit.summary.totalFiles}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-slate-500">{t('moduleExplorer.totalViolationsLabel')}</span>
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

    {/* 目录选择器浮层 */}
    {showFolderPicker && (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-[1px]" onClick={() => setShowFolderPicker(false)}>
      <div className="bg-white rounded-xl shadow-2xl border border-slate-200 w-[480px] max-h-[70vh] flex flex-col" onClick={e => e.stopPropagation()}>
      <div className="p-4 border-b border-slate-200 flex items-center justify-between">
        <div className="flex items-center gap-2">
        <FolderOpen size={ICON_SIZES.md} className="text-emerald-500" />
        <span className="font-bold text-sm">{t('moduleExplorer.selectFolderTitle')}</span>
        </div>
        <button onClick={() => setShowFolderPicker(false)} className="p-1 rounded hover:bg-slate-100 text-slate-400">
        <X size={ICON_SIZES.sm} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-3 scrollbar-light">
        {loadingDirs ? (
        <div className="flex items-center justify-center py-12 text-slate-400">
          <Loader2 size={ICON_SIZES.lg} className="animate-spin mr-2" />
          <span className="text-sm">{t('moduleExplorer.scanningDirs')}</span>
        </div>
        ) : projectDirs.length === 0 ? (
        <div className="text-center py-12 text-slate-400 text-sm">
          {t('moduleExplorer.noDirs')}
        </div>
        ) : (
        <div className="space-y-0.5">
          {projectDirs.map(dir => {
          const dirLangClass = LANG_COLORS[dir.language] || 'bg-slate-100 text-slate-500 border-slate-200';
          return (
            <button
            key={dir.path}
            onClick={() => handleSelectFolder(dir)}
            disabled={!dir.hasSourceFiles}
            className={`w-full text-left p-2.5 rounded-lg flex items-center gap-3 transition-all border border-transparent
              ${dir.hasSourceFiles ? 'hover:bg-emerald-50 hover:border-emerald-200 cursor-pointer' : 'opacity-40 cursor-not-allowed'}
            `}
            style={{ paddingLeft: `${dir.depth * 16 + 10}px` }}
            >
            <FolderOpen size={ICON_SIZES.sm} className={dir.hasSourceFiles ? 'text-emerald-500' : 'text-slate-300'} />
            <span className="text-sm font-medium flex-1 truncate">{dir.name}</span>
            {dir.hasSourceFiles && dir.language !== 'unknown' && (
              <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border shrink-0 ${dirLangClass}`}>
              {dir.language.toUpperCase()}
              </span>
            )}
            {dir.hasSourceFiles && (
              <span className="text-[10px] text-slate-400 shrink-0">{t('moduleExplorer.sourceFileCount', { count: dir.sourceFileCount })}</span>
            )}
            <ChevronRight size={12} className="text-slate-300 shrink-0" />
            </button>
          );
          })}
        </div>
        )}
      </div>
      <div className="p-3 border-t border-slate-100 text-[10px] text-slate-400 text-center">
        {t('moduleExplorer.selectFolderHint')}
      </div>
      </div>
    </div>
    )}
  </div>
  );
};

export default ModuleExplorerView;
