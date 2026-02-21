import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import axios from 'axios';
import { Toaster } from 'react-hot-toast';
import { notify } from './utils/notification';
import { Recipe, ProjectData, SPMTarget, ExtractedRecipe, ScanResultItem, GuardAuditResult, KnowledgeContent, KnowledgeReasoning, KnowledgeQuality, KnowledgeStats, KnowledgeConstraints } from './types';
import { TabType, validTabs } from './constants';
import { isShellTarget, isSilentTarget, isPendingTarget, getWritePermissionErrorMsg, getSaveErrorMsg } from './utils';
import api from './api';
import { useAuth } from './hooks/useAuth';
import { usePermission } from './hooks/usePermission';
import { useBootstrapSocket } from './hooks/useBootstrapSocket';
import { useI18n } from './i18n';
import { zh } from './i18n/locales/zh';
import { useTheme } from './theme';
import LoginView from './components/Views/LoginView';

// Components
import Sidebar from './components/Layout/Sidebar';
import Header from './components/Layout/Header';
import CategoryBar from './components/Shared/CategoryBar';
import RecipesView from './components/Views/RecipesView';
import HelpView from './components/Views/HelpView';
import CandidatesView from './components/Views/CandidatesView';
import ModuleExplorerView from './components/Views/ModuleExplorerView';
import DepGraphView from './components/Views/DepGraphView';
import GuardView from './components/Views/GuardView';
import { GlobalChatProvider, GlobalChatPanel, useGlobalChat } from './components/Shared/GlobalChatDrawer';
import AiChatView from './components/Views/AiChatView';
import KnowledgeGraphView from './components/Views/KnowledgeGraphView';
import KnowledgeView from './components/Views/KnowledgeView';
import SkillsView from './components/Views/SkillsView';
import BootstrapProgressView from './components/Views/BootstrapProgressView';
import WikiView from './components/Views/WikiView';
import RecipeEditor from './components/Modals/RecipeEditor';
import CreateModal from './components/Modals/CreateModal';
import SearchModal from './components/Modals/SearchModal';
import LlmConfigModal from './components/Modals/LlmConfigModal';

/* ── ErrorBoundary — 防止白屏 ────────────── */
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 40, textAlign: 'center' }}>
          <h2 style={{ color: '#ef4444', marginBottom: 12 }}>{zh.app.errorBoundary.title}</h2>
          <pre style={{ fontSize: 12, color: '#64748b', whiteSpace: 'pre-wrap', maxWidth: 600, margin: '0 auto' }}>
            {this.state.error?.message}
          </pre>
          <button
            onClick={() => { this.setState({ hasError: false, error: null }); window.location.reload(); }}
            style={{ marginTop: 16, padding: '8px 20px', background: '#3b82f6', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}
          >
            {zh.app.errorBoundary.refreshBtn}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * 将后端 V3 结构直透为前端 ScanResultItem。
 * 后端 AI 已输出完整 V3 字段，此处不做任何回退填充，缺失字段留空。
 *
 * @param source - 数据来源标识：'ai-scan' | 'extract' | 'clipboard'
 */
function mapExtractedToV3(item: any, source: string = 'ai-scan'): Partial<ScanResultItem> {
  return {
    // ── 基础字段 ──
    title: item.title || '',
    description: item.description || '',
    trigger: item.trigger || '',
    language: item.language || '',
    category: item.category || '',
    tags: item.tags || [],

    // ── 分类字段 ──
    kind: item.kind || '',
    knowledgeType: item.knowledgeType || '',
    scope: item.scope || '',
    complexity: item.complexity || '',
    difficulty: item.difficulty || '',
    authority: item.authority,

    // ── 生命周期 ──
    lifecycle: (item.lifecycle || 'pending') as 'pending',
    source: item.source || source,

    // ── Delivery fields ──
    doClause: item.doClause || '',
    dontClause: item.dontClause || '',
    whenClause: item.whenClause || '',
    topicHint: item.topicHint || '',
    coreCode: item.coreCode || '',

    // ── 结构化子对象（直透） ──
    content: item.content || {},
    constraints: item.constraints || {},
    reasoning: item.reasoning || {},
    quality: item.quality || {},
    stats: item.stats || {},
    relations: item.relations || {},

    // ── 头文件相关 ──
    headers: item.headers || [],
    headerPaths: item.headerPaths,
    moduleName: item.moduleName,
    includeHeaders: item.includeHeaders,

    // ── 时间戳 ──
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

const App: React.FC = () => {
  const auth = useAuth();
  const permission = usePermission(auth.user?.role);
  const bootstrap = useBootstrapSocket();
  const { t, lang } = useI18n();

  const getTabFromPath = (): TabType => {
  const path = window.location.pathname.replace(/^\//, '').split('/')[0] || '';
  return (validTabs.includes(path as any) ? path : 'help') as any;
  };

  // ── 登录门控标记 ──────────────────────────────────
  const requireLogin = auth.authEnabled && !auth.isAuthenticated;

  // State
  const [data, setData] = useState<ProjectData | null>(null);
  const [activeTab, setActiveTab] = useState<TabType>(getTabFromPath());
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [editingRecipe, setEditingRecipe] = useState<Recipe | null>(null);
  const [targets, setTargets] = useState<SPMTarget[]>([]);
  const [customFolderTargets, setCustomFolderTargets] = useState<SPMTarget[]>([]);
  const [selectedTargetName, setSelectedTargetName] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState<{ current: number, total: number, status: string }>({ current: 0, total: 0, status: '' });
  const [scanFileList, setScanFileList] = useState<{ name: string; path: string }[]>([]);
  const [scanResults, setScanResults] = useState<ScanResultItem[]>([]);
  const [guardAudit, setGuardAudit] = useState<GuardAuditResult | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<string>('All');
  const [recipePage, setRecipePage] = useState(1);
  const [recipePageSize, setRecipePageSize] = useState(12);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createPath, setCreatePath] = useState('');
  const [isExtracting, setIsExtracting] = useState(false);
  // chatHistory / userInput / isAiThinking 已迁移到 GlobalChatDrawer
  const [semanticResults, setSemanticResults] = useState<any[] | null>(null);
  const [searchAction, setSearchAction] = useState<{ q: string; path: string } | null>(null);
  const [isSavingRecipe, setIsSavingRecipe] = useState(false);

  // LLM 配置状态
  const [llmReady, setLlmReady] = useState(true); // 默认 true，加载后更新
  const [showLlmConfig, setShowLlmConfig] = useState(false);

  // SignalCollector 后台推荐计数
  const [signalSuggestionCount, setSignalSuggestionCount] = useState(0);

  const abortControllerRef = useRef<AbortController | null>(null);
  const trickleTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // chatAbortControllerRef 已迁移到 GlobalChatDrawer

  // 搜索/分类变化时 Recipes 列表重置到第一页；刷新数据（fetchData）不重置页码
  useEffect(() => {
  setRecipePage(1);
  }, [searchQuery, selectedCategory]);

  // 项目切换时从 localStorage 加载该项目的自定义目录
  useEffect(() => {
    if (!data?.projectRoot) return;
    try {
      const key = `asd:custom-folder-targets:${data.projectRoot}`;
      const saved = localStorage.getItem(key);
      setCustomFolderTargets(saved ? JSON.parse(saved) : []);
    } catch { setCustomFolderTargets([]); }
  }, [data?.projectRoot]);

  /** 切换 AI 前停止当前 AI 任务（扫描等）；不置空 ref，由各任务 finally 清理并更新 UI */
  const stopCurrentAiTasks = () => {
  if (abortControllerRef.current) abortControllerRef.current.abort();
  };

  // SignalCollector 轮询：每 5 分钟检查是否有新建议
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const status = await api.getSignalStatus();
        if (!cancelled) {
          // 优先使用 pendingSuggestions 实际数量，降级到 snapshot 历史计数
          const pending = status?.suggestions?.length || 0;
          const fromSnapshot = status?.snapshot?.lastResult?.newSuggestions || 0;
          setSignalSuggestionCount(pending || fromSnapshot);
        }
      } catch { /* silent */ }
    };
    poll();
    const timer = setInterval(poll, 5 * 60 * 1000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  // Bootstrap 异步填充完成时刷新数据    
  useEffect(() => {
    if (bootstrap.isAllDone) {
      fetchData();
    }
  }, [bootstrap.isAllDone]);

  // Bootstrap 维度任务创建候选后，增量刷新内容区域（节流 2s，防止短时间多维度完成时频繁请求）
  useEffect(() => {
    if (bootstrap.candidateCreatedTick > 0) {
      const timer = setTimeout(() => fetchData(), 2000);
      return () => clearTimeout(timer);
    }
  }, [bootstrap.candidateCreatedTick]);

  // Navigation
  const navigateToTab = (tab: TabType, options?: { preserveSearch?: boolean }) => {
  setActiveTab(tab);
  const search = options?.preserveSearch && window.location.search ? window.location.search : '';
  window.history.pushState({}, document.title, `/${tab}${search}`);
  };

  // Handlers
  const openRecipeEdit = (recipe: Recipe) => {
  setEditingRecipe(recipe);
  setActiveTab('recipes');
  const q = new URLSearchParams(window.location.search);
  q.set('edit', encodeURIComponent(recipe.name));
  window.history.pushState({}, document.title, `/recipes?${q.toString()}`);
  };

  const closeRecipeEdit = () => {
  setEditingRecipe(null);
  window.history.replaceState({}, document.title, '/recipes');
  };

  useEffect(() => {
  if (searchQuery === '') {
    setSemanticResults(null);
  }
  }, [searchQuery]);

  // Effects
  useEffect(() => {
  setActiveTab(getTabFromPath());
  }, []);

  useEffect(() => {
  if (!data) return;
  const pathname = window.location.pathname.replace(/^\//, '').split('/')[0];
  const params = new URLSearchParams(window.location.search);
  const editId = params.get('edit');
  if (pathname === 'recipes' && editId && data.recipes) {
    try {
    const name = decodeURIComponent(editId);
    const recipe = data.recipes.find((s: Recipe) => s.name === name);
    if (recipe && !editingRecipe) {
      setActiveTab('recipes');
      openRecipeEdit(recipe);
    }
    } catch (_) {}
  }
  }, [data]);

  useEffect(() => {
  fetchData();
  fetchTargets();
  fetchLlmStatus();

  const handlePopState = () => {
    setActiveTab(getTabFromPath());
  };
  window.addEventListener('popstate', handlePopState);

  const params = new URLSearchParams(window.location.search);
  const action = params.get('action');
  const path = params.get('path');
  const q = params.get('q') || '';

  if (action === 'search' && path) {
    setSearchAction({ q, path });
  } else if (action === 'create' && path) {
    setCreatePath(path);
    setShowCreateModal(true);
    const autoScan = params.get('autoScan') === '1';
    if (autoScan) {
    // as:create -f：先显示 New Recipe 窗口，再在该窗口内自动执行 Scan File（AI 分析），完成后跳转
    setTimeout(() => handleCreateFromPathWithSpecifiedPath(path), 500);
    }
  }

  // 清除 action/path 参数，确保下次 // as:c 触发时 URL 不同，浏览器会重新加载
  if (action) {
    window.history.replaceState({}, document.title, window.location.pathname);
  }

  return () => {
    window.removeEventListener('popstate', handlePopState);
  };
  }, []);

  // API Calls
  const fetchData = async () => {
  setLoading(true);
  try {
    const projectData = await api.fetchData();
    // V3 KnowledgeEntry 字段已全部 camelCase
    setData(projectData);
  } catch (err: any) {
    notify(err?.message || t('app.load.failed'), { title: t('app.load.failedTitle'), type: 'error' });
  } finally {
    setLoading(false);
  }
  };

  const fetchTargets = async () => {
  try {
    const result = await api.fetchTargets();
    setTargets(result);
  } catch (err: any) {
    console.warn('删除候选残留失败:', err?.message);
  }
  };

  const fetchLlmStatus = async () => {
  try {
    const data = await api.getLlmEnvConfig();
    setLlmReady(data.llmReady);
  } catch {
    // 加载失败时保持默认值（true），不影响正常使用
  }
  };

  const handleSyncSnippets = async () => {
  try {
    const result = await api.syncSnippets('all');
    notify(t('app.sync.success'), { title: t('app.sync.successTitle') });
  } catch (err) {
    notify(t('app.sync.failedHint'), { title: t('app.sync.failed'), type: 'error' });
  }
  };

  const handleRefreshProject = async () => {
  try {
    await api.refreshProject();
    fetchTargets();
    notify(t('app.projectRefresh.success'), { title: t('app.projectRefresh.successTitle') });
  } catch (err) {
    notify(t('app.load.failedHint'), { title: t('app.projectRefresh.failed'), type: 'error' });
  }
  };

  const handleCreateFromPathWithSpecifiedPath = async (specifiedPath: string) => {
  setIsExtracting(true);
  try {
    const extractResult = await api.extractFromPath(specifiedPath);
    setScanResults(extractResult.result.map(item => ({
      ...mapExtractedToV3(item, 'extract'),
      mode: 'full' as const,
      lang: 'cn' as const,
    })));
    navigateToTab('spm');
    setShowCreateModal(false);
    fetchData();
    if (extractResult.result?.length > 0) {
    notify(t('app.extract.success'), { title: t('app.extract.successTitle') });
    }
  } catch (err) {
    notify(t('app.extract.failed'), { type: 'error' });
  } finally {
    setIsExtracting(false);
  }
  };

  const handleCreateFromPath = async () => {
  if (!createPath) return;
  setIsExtracting(true);
  try {
    const extractResult = await api.extractFromPath(createPath);
    setScanResults(extractResult.result.map(item => ({
      ...mapExtractedToV3(item, 'extract'),
      mode: 'full' as const,
      lang: 'cn' as const,
    })));
    navigateToTab('spm');
    setShowCreateModal(false);
    fetchData();
    if (extractResult.result?.length > 0) {
    notify(extractResult.isMarked ? t('app.extract.markerSuccess') : t('app.extract.normalSuccess'), { title: t('app.extract.successTitle') });
    } else if (!extractResult.isMarked) {
    notify(t('app.extract.noMarker'), { title: t('app.extract.extracting'), type: 'info' });
    }
  } catch (err) {
    notify(t('app.extract.failed'), { type: 'error' });
  } finally {
    setIsExtracting(false);
  }
  };

  const handleCreateFromClipboard = async (contextPath?: string) => {
  try {
    const text = await navigator.clipboard.readText();
    if (!text) return notify(t('app.clipboard.empty'), { title: t('app.clipboard.emptyTitle'), type: 'info' });
    
    // 立即提示收到代码
    notify(t('app.clipboard.analyzing'), { title: t('app.clipboard.analyzingTitle'), type: 'info' });
    
    setIsExtracting(true);
    const relativePath = contextPath || createPath;
    
    try {
    const item = await api.extractFromText(text, relativePath || undefined);
    
    const multipleCount = (item as ExtractedRecipe & { _multipleCount?: number })._multipleCount;
    setScanResults([{
      ...mapExtractedToV3(item, 'clipboard'),
      mode: 'full' as const,
      lang: 'cn' as const,
    }]);
    navigateToTab('spm');
    setShowCreateModal(false);
    fetchData();
    notify(multipleCount ? t('app.clipboard.resultMulti', { count: multipleCount }) : t('app.extract.normalSuccess'), { title: t('app.clipboard.resultTitle') });
    } catch (err: any) {
    // 区分 AI 错误和其他错误
    const isAiError = err.response?.data?.aiError === true;
    const errorMsg = err.response?.data?.error || err.message;
    
    if (isAiError) {
      notify(errorMsg, { title: t('app.clipboard.aiFailed'), type: 'error' });
    } else {
      notify(errorMsg, { title: t('common.operationFailed'), type: 'error' });
    }
    }
  } catch (err) {
    notify(t('app.clipboard.permissionError'), { title: t('app.clipboard.permissionTitle'), type: 'error' });
  } finally {
    setIsExtracting(false);
  }
  };

  /** SSE 事件类型 → 进度百分比 & 状态文案映射 */
  const SCAN_EVENT_PROGRESS: Record<string, { percent: number; status: string | ((e: any) => string) }> = {
  'scan:started':       { percent: 5,  status: t('app.scan.events.initializing') },
  'scan:files-loaded':  { percent: 15, status: (e: any) => t('app.scan.events.filesLoaded', { count: e.count || 0 }) },
  'scan:reading':       { percent: 25, status: (e: any) => t('app.scan.events.readingFiles', { count: e.count || 0 }) },
  'scan:ai-extracting': { percent: 40, status: t('app.scan.events.aiAnalyzing') },
  'scan:enriching':     { percent: 85, status: (e: any) => t('app.scan.events.enriching', { count: e.recipeCount || 0 }) },
  'scan:completed':     { percent: 95, status: t('app.scan.events.completing') },
  };

  const handleScanTarget = async (target: SPMTarget) => {
  if (isScanning) return;
  if (abortControllerRef.current) abortControllerRef.current.abort();
  if (trickleTimerRef.current) { clearInterval(trickleTimerRef.current); trickleTimerRef.current = null; }
  const controller = new AbortController();
  abortControllerRef.current = controller;

  setSelectedTargetName(target.name);
  setIsScanning(true);
  setScanResults([]);
  setGuardAudit(null);
  setScanFileList([]);
  setScanProgress({ current: 0, total: 100, status: t('app.scan.streamInit') });

  try {
    const scanResult = await api.scanTargetStream(target, (evt: any) => {
    // 实时处理 SSE 事件更新进度
    const mapping = SCAN_EVENT_PROGRESS[evt.type];
    if (mapping) {
      const statusText = typeof mapping.status === 'function' ? mapping.status(evt) : mapping.status;
      setScanProgress({ current: mapping.percent, total: 100, status: statusText });
    }

    // 文件列表就绪时立即展示
    if (evt.type === 'scan:files-loaded' && evt.files) {
      setScanFileList(evt.files);
    }

    // AI 提取阶段：启动缓动进度（40% → 80%，每 3 秒 +1%）
    if (evt.type === 'scan:ai-extracting') {
      if (trickleTimerRef.current) clearInterval(trickleTimerRef.current);
      trickleTimerRef.current = setInterval(() => {
      setScanProgress(prev => ({
        ...prev,
        current: Math.min(prev.current + 1, 80),
      }));
      }, 3000);
    }

    // AI 阶段结束，停止缓动
    if (evt.type === 'scan:enriching' || evt.type === 'scan:completed') {
      if (trickleTimerRef.current) { clearInterval(trickleTimerRef.current); trickleTimerRef.current = null; }
    }
    }, controller.signal);

    if (trickleTimerRef.current) { clearInterval(trickleTimerRef.current); trickleTimerRef.current = null; }
    setScanProgress({ current: 100, total: 100, status: t('app.scan.completed') });

    const recipes = scanResult.recipes || [];
    const scannedFiles = scanResult.scannedFiles || [];

    if (recipes.length > 0 || scannedFiles.length > 0) {
    const scanTargetName = typeof target === 'string' ? target : target?.name || 'unknown';
    const enrichedResults = recipes.map((item: ExtractedRecipe) => ({
      ...mapExtractedToV3(item, 'ai-scan'),
      mode: 'full' as const,
      lang: 'cn' as const,
      candidateTargetName: scanTargetName,
      scanMode: 'target' as const,
    }));
    setScanResults(enrichedResults);
    if (scannedFiles.length > 0) setScanFileList(scannedFiles);

    fetchData();
    if (recipes.length > 0) {
      notify(t('app.scan.targetSuccess', { count: recipes.length }), { title: t('app.scan.targetSuccessTitle') });
    } else if (scanResult.message) {
      const isNoAi = scanResult.noAi;
      notify(scanResult.message, {
        title: isNoAi ? t('app.scan.aiNotConfigured') : t('app.scan.noResults'),
        type: isNoAi ? 'info' : 'error',
      });
    } else {
      notify(t('app.scan.noSnippets'), { title: t('app.scan.scanComplete'), type: 'info' });
    }
    } else {
    notify(t('app.scan.scanFailedHint'), { title: t('app.scan.scanFailed'), type: 'error' });
    }
  } catch (err: any) {
    if (trickleTimerRef.current) { clearInterval(trickleTimerRef.current); trickleTimerRef.current = null; }
    if (err.name === 'AbortError') return;
    const isTimeout = err.message?.includes('timeout');
    const msg = isTimeout
      ? t('app.scan.timeout')
      : (err.message || t('app.scan.scanError'));
    notify(msg, { title: isTimeout ? t('app.scan.timeoutTitle') : t('app.scan.scanError'), type: 'error' });
  } finally {
    if (abortControllerRef.current === controller) {
    setIsScanning(false);
    setScanProgress({ current: 0, total: 0, status: '' });
    abortControllerRef.current = null;
    }
  }
  };

  /** 冷启动：快速骨架 + 异步逐维度填充（v5 async fill） */
  const handleColdStart = async () => {
  if (isScanning) return;
  if (abortControllerRef.current) abortControllerRef.current.abort();
  const controller = new AbortController();
  abortControllerRef.current = controller;

  // 自动跳转到 Candidates 页面展示结果
  navigateToTab('candidates');
  setIsScanning(true);
  setScanResults([]);
  setGuardAudit(null);
  setScanFileList([]);
  setScanProgress({ current: 0, total: 100, status: t('app.coldStart.collecting') });
  bootstrap.resetSession();

  try {
    const result = await api.bootstrap(controller.signal);
    setScanProgress({ current: 100, total: 100, status: t('app.coldStart.skeletonCreated') });

    // 如果返回了 bootstrapSession，初始化到 socket hook
    if (result.bootstrapSession) {
      bootstrap.initFromApiResponse(result.bootstrapSession);
    }

    // 刷新候选列表
    fetchData();

    const report = result.report || {};
    const targetCount = result.targets?.length || 0;
    const fileCount = report.totals?.files || 0;
    const graphEdges = report.totals?.graphEdges || 0;
    const guardInfo = result.guardSummary;
    const guardMsg = guardInfo ? `, ${t('app.coldStart.guardSuffix', { count: guardInfo.totalViolations })}` : '';

    notify(
      t('app.coldStart.skeletonDetail', { targets: targetCount, files: fileCount, deps: graphEdges }) + guardMsg
    );
  } catch (err: any) {
    if (axios.isCancel(err)) return;
    const isTimeout = err.code === 'ECONNABORTED' || err.message?.includes('timeout');
    const msg = isTimeout
      ? t('app.coldStart.timeout')
      : (err.response?.data?.error || err.message);
    notify(msg, { type: 'error' });
  } finally {
    if (abortControllerRef.current === controller) {
    setIsScanning(false);
    setScanProgress({ current: 0, total: 0, status: '' });
    abortControllerRef.current = null;
    }
  }
  };

  /** 全项目扫描：AI 提取候选 + Guard 审计（SPM 页面专用） */
  const handleScanProject = async () => {
  if (isScanning) return;
  if (abortControllerRef.current) abortControllerRef.current.abort();
  const controller = new AbortController();
  abortControllerRef.current = controller;

  navigateToTab('spm');
  setSelectedTargetName('__project__');
  setIsScanning(true);
  setScanResults([]);
  setGuardAudit(null);
  setScanFileList([]);
  setScanProgress({ current: 0, total: 100, status: t('app.fullScan.collecting') });

  const phases = [
    { status: t('app.fullScan.phase5'), percent: 5 },
    { status: t('app.fullScan.phase15'), percent: 15 },
    { status: t('app.fullScan.phase25'), percent: 25 },
    { status: t('app.fullScan.phase35'), percent: 35 },
    { status: t('app.fullScan.phase45'), percent: 45 },
    { status: t('app.fullScan.phase55'), percent: 55 },
    { status: t('app.fullScan.phase65'), percent: 65 },
    { status: t('app.fullScan.phase75'), percent: 75 },
    { status: t('app.fullScan.phase85'), percent: 85 },
  ];
  let phaseIndex = 0;
  const progressTimer = setInterval(() => {
    phaseIndex = Math.min(phaseIndex + 1, phases.length);
    const phase = phases[phaseIndex - 1];
    if (phase) setScanProgress(prev => ({ ...prev, current: phase.percent, status: phase.status }));
  }, 15000);

  try {
    const result = await api.scanProject(controller.signal);
    clearInterval(progressTimer);
    setScanProgress({ current: 100, total: 100, status: result.partial ? t('app.fullScan.partialComplete') : t('app.fullScan.completed') });

    const recipes = result.recipes || [];
    const scannedFiles = result.scannedFiles || [];

    if (recipes.length > 0 || scannedFiles.length > 0) {
    const enrichedResults = recipes.map((item: ExtractedRecipe) => ({
      ...mapExtractedToV3(item, 'ai-scan'),
      mode: 'full' as const,
      lang: 'cn' as const,
      candidateTargetName: '__project__',
      scanMode: 'project' as const,
    }));
    setScanResults(enrichedResults);
    setScanFileList(scannedFiles);
    setGuardAudit(result.guardAudit || null);
    fetchData();

    const guardInfo = result.guardAudit?.summary;
    const violationMsg = guardInfo ? `, ${t('app.fullScan.guardSuffix', { count: guardInfo.totalViolations })}` : '';
    const partialMsg = result.partial ? t('app.fullScan.timeoutSuffix') : '';
    notify(t('app.fullScan.resultDetail', { count: recipes.length }) + violationMsg + partialMsg);
    } else {
    notify(t('app.fullScan.noContent'));
    }
  } catch (err: any) {
    clearInterval(progressTimer);
    if (axios.isCancel(err)) return;
    const isTimeout = err.code === 'ECONNABORTED' || err.message?.includes('timeout');
    const msg = isTimeout
      ? t('app.fullScan.timeout')
      : (err.response?.data?.error || err.message);
    notify(msg, { type: 'error' });
  } finally {
    if (abortControllerRef.current === controller) {
    setIsScanning(false);
    setScanProgress({ current: 0, total: 0, status: '' });
    abortControllerRef.current = null;
    }
  }
  };

  const handleUpdateScanResult = (index: number, updates: Partial<ScanResultItem>) => {
  const newResults = [...scanResults];
  const current = { ...newResults[index], ...updates };

  newResults[index] = current;
  setScanResults(newResults);
  };

  const handleSaveExtracted = async (extracted: ScanResultItem) => {
  if (isSavingRecipe) return;
  setIsSavingRecipe(true);
  try {
    // V3: 统一数据模型直接取值
    const codeRaw = (extracted.content?.pattern || '').trim();
    const snippetAble = (() => {
      if (!codeRaw) return false;
      const lines = codeRaw.split('\n').filter((l: string) => l.trim());
      const mdLines = lines.filter((l: string) => /^\s*(#{1,6}\s|[-*>]\s|\d+\.\s)/.test(l));
      return mdLines.length <= lines.length * 0.3;
    })();

    const triggers = (extracted.trigger || '').split(/[,，\s]+/).map(t => t.trim()).filter(Boolean);
    if (snippetAble && triggers.length === 0) {
    notify(t('app.recipe.triggerRequired'), { type: 'error' });
    setIsSavingRecipe(false);
    return;
    }

    // ── V3 直透：结构化数据直接写入 Knowledge API，不经 markdown 序列化 ──
    const v3Data: Record<string, any> = {
      title:         extracted.title || 'Untitled',
      description:   extracted.description || '',
      trigger:       triggers.join(', ') || '',
      language:      extracted.language || '',
      category:      extracted.category || 'Utility',
      kind:          extracted.kind || 'pattern',
      knowledgeType: extracted.knowledgeType || 'code-pattern',
      complexity:    extracted.complexity || 'intermediate',
      scope:         extracted.scope || null,
      difficulty:    extracted.difficulty || '',
      tags:          extracted.tags || [],
      source:        extracted.source || 'ai-scan',
      sourceFile:    extracted.sourceFile || '',
      moduleName:    extracted.moduleName || '',

      // Delivery fields
      doClause:      extracted.doClause || '',
      dontClause:    extracted.dontClause || '',
      whenClause:    extracted.whenClause || '',
      topicHint:     extracted.topicHint || '',
      coreCode:      extracted.coreCode || '',

      // V3 结构化子对象
      content:       extracted.content || {},
      reasoning:     extracted.reasoning || {},
      quality:       extracted.quality || {},
      constraints:   extracted.constraints || {},
      relations:     extracted.relations || {},
      stats:         extracted.stats || {},

      // 头文件
      headers:       extracted.headers || [],
      headerPaths:   extracted.headerPaths || [],
      includeHeaders: extracted.includeHeaders || false,
    };

    const created = await api.knowledgeCreate(v3Data);

    // 审核卡片保存后直接发布为 active Recipe（跳过 pending 候选阶段）
    if (created?.id) {
      try {
        await api.knowledgeLifecycle(created.id, 'publish');
      } catch (pubErr) {
        console.warn('auto-publish after save failed:', pubErr);
      }
    }

    notify(snippetAble ? t('app.recipe.savedAsRecipe') : t('app.recipe.savedToKb'));
    setScanResults(prev => prev.filter(item => item.title !== extracted.title));
    // 若来自候选池，保存后从候选池移除
    const candTarget = extracted.candidateTargetName;
    const candId = extracted.candidateId;
    if (candTarget && candId) {
    try {
      await api.deleteCandidate(candId);
    } catch (_) {}
    }
    fetchData();
  } catch (err) {
    const msg = getSaveErrorMsg(err) ?? getWritePermissionErrorMsg(err);
    notify(msg ?? t('app.recipe.saveFailed'), { type: 'error' });
  } finally {
    setIsSavingRecipe(false);
  }
  };

  const handleSaveRecipe = async () => {
  if (!editingRecipe || isSavingRecipe) return;
  setIsSavingRecipe(true);
  try {
    // V3: 直接通过 Knowledge API 更新结构化数据
    const recipeId = editingRecipe.id || editingRecipe.name?.replace(/\.md$/, '');
    const contentObj = typeof editingRecipe.content === 'string'
      ? { pattern: editingRecipe.content, markdown: '', rationale: '', steps: [], codeChanges: [], verification: null }
      : (editingRecipe.content || {});

    await api.knowledgeUpdate(recipeId, {
      title: editingRecipe.name?.replace(/\.md$/, '') || '',
      description: editingRecipe.description || '',
      content: contentObj,
      tags: editingRecipe.tags || [],
      kind: editingRecipe.kind,
      language: editingRecipe.language,
      category: editingRecipe.category,
    } as any);
    closeRecipeEdit();
    fetchData();
  } catch (err) {
    const msg = getSaveErrorMsg(err) ?? getWritePermissionErrorMsg(err);
    notify(msg ?? t('app.recipe.saveRecipeFailed'), { type: 'error' });
  } finally {
    setIsSavingRecipe(false);
  }
  };

  const handleDeleteRecipe = async (name: string) => {
  if (!window.confirm(t('common.areYouSure'))) return;
  try {
    await api.deleteRecipe(name);
    fetchData();
  } catch (err) {
    const msg = getWritePermissionErrorMsg(err);
    notify(msg ?? t('common.deleteFailed'), { type: 'error' });
  }
  };

  const handleDeleteCandidate = async (targetName: string, candidateId: string): Promise<void> => {
  try {
    await api.deleteCandidate(candidateId);
    setScanResults(prev => prev.filter(r => !(r.candidateId === candidateId && r.candidateTargetName === targetName)));
    // 同步更新 data.candidates 状态，移除已删候选；若分类为空则移除整个分类
    setData(prev => {
      if (!prev?.candidates) return prev;
      const updated = { ...prev.candidates };
      if (updated[targetName]) {
        const filtered = updated[targetName].items.filter(c => c.id !== candidateId);
        if (filtered.length === 0) {
          delete updated[targetName];
        } else {
          updated[targetName] = { ...updated[targetName], items: filtered };
        }
      }
      return { ...prev, candidates: updated };
    });
  } catch (err) {
    notify(t('common.operationFailed'), { type: 'error' });
  }
  };

  const handleDeleteAllInTarget = async (targetName: string) => {
  if (!window.confirm(t('app.candidate.clearConfirm', { name: targetName }))) return;
  try {
    await api.deleteAllCandidatesInTarget(targetName);
    fetchData();
    notify(t('app.candidate.clearDone', { name: targetName }));
  } catch (err) {
    notify(t('common.operationFailed'), { type: 'error' });
  }
  };

  const handlePromoteToCandidate = async (res: any, index: number) => {
  try {
    await api.promoteToCandidate(res, res.candidateTargetName || selectedTargetName || '_review');
    notify(t('app.candidate.pushSuccess'));
    setScanResults(prev => prev.filter((_, i) => i !== index));
    fetchData();
  } catch (err: any) {
    const raw = err.response?.data?.error;
    const msg = typeof raw === 'string' ? raw : raw?.message || t('app.candidate.pushFailed');
    notify(msg, { type: 'error' });
  }
  };

  // handleChat 已迁移到 GlobalChatDrawer

  // Filters
  const filteredRecipes = (data?.recipes || []).filter(s => {
  // 语义搜索结果优先
  if (semanticResults) {
    return semanticResults.some(res => res.metadata.type === 'recipe' && res.metadata.name === s.name);
  }
  const name = s.name || '';
  const contentStr = typeof s.content === 'string' ? s.content : [s.content?.pattern, s.content?.markdown].filter(Boolean).join(' ');
  const matchesSearch = name.toLowerCase().includes(searchQuery.toLowerCase()) || contentStr.toLowerCase().includes(searchQuery.toLowerCase()) || (s.description || '').toLowerCase().includes(searchQuery.toLowerCase());
  if (selectedCategory === 'All') return matchesSearch;
  const categoryMatch = contentStr ? contentStr.match(/category:\s*(.*)/) : null;
  const category = categoryMatch ? categoryMatch[1].trim() : 'Utility';
  return matchesSearch && category === selectedCategory;
  }).sort((a, b) => {
  // 如果有语义搜索，按照相似度排序
  if (semanticResults) {
    const scoreA = semanticResults.find(r => r.metadata.name === a.name)?.similarity || 0;
    const scoreB = semanticResults.find(r => r.metadata.name === b.name)?.similarity || 0;
    return scoreB - scoreA;
  }
  // 默认按综合分（authorityScore）降序
  const sa = a.stats?.authorityScore ?? 0;
  const sb = b.stats?.authorityScore ?? 0;
  return sb - sa;
  });

  // 合并 API 发现的 targets 与用户手动添加的自定义目录
  const mergedTargets = React.useMemo(() => {
    const apiKeys = new Set(targets.map(t => `${t.discovererId || ''}::${t.name}`));
    const extras = customFolderTargets.filter(ct => !apiKeys.has(`${ct.discovererId || ''}::${ct.name}`));
    return [...targets, ...extras];
  }, [targets, customFolderTargets]);

  const filteredTargets = mergedTargets
  .filter(t => t.name.toLowerCase().includes(searchQuery.toLowerCase()))
  .sort((a, b) => {
    const aShell = isShellTarget(a.name);
    const bShell = isShellTarget(b.name);
    if (aShell && !bShell) return 1;
    if (!aShell && bShell) return -1;
    // 自定义目录排在已发现模块之后
    const aVirtual = a.isVirtual ? 1 : 0;
    const bVirtual = b.isVirtual ? 1 : 0;
    if (aVirtual !== bVirtual) return aVirtual - bVirtual;
    return a.name.localeCompare(b.name);
  });

  /** 添加自定义目录到常驻列表 */
  const handleAddCustomFolder = useCallback((folder: SPMTarget) => {
    setCustomFolderTargets(prev => {
      // 按 path 去重
      if (prev.some(t => t.path === folder.path)) return prev;
      const next = [...prev, folder];
      if (data?.projectRoot) {
        localStorage.setItem(`asd:custom-folder-targets:${data.projectRoot}`, JSON.stringify(next));
      }
      return next;
    });
  }, [data?.projectRoot]);

  /** 移除自定义目录 */
  const handleRemoveCustomFolder = useCallback((folderPath: string) => {
    setCustomFolderTargets(prev => {
      const next = prev.filter(t => t.path !== folderPath);
      if (data?.projectRoot) {
        localStorage.setItem(`asd:custom-folder-targets:${data.projectRoot}`, JSON.stringify(next));
      }
      return next;
    });
  }, [data?.projectRoot]);

  const candidateCount = Object.values(data?.candidates || {}).reduce((acc, curr) => acc + curr.items.length, 0);

  const { isDark: isDarkMode } = useTheme();

  // ── 登录门控 ──────────────────────────────────
  if (requireLogin) {
    return <LoginView onLogin={auth.login} isLoading={auth.isLoading} />;
  }

  return (
  <ErrorBoundary>
  <GlobalChatProvider>
  <div className={`flex h-screen ${isDarkMode ? 'bg-[#1e1e1e] text-slate-200' : 'bg-slate-50 text-slate-900'} overflow-hidden font-sans`}>
    <Toaster position="top-center" toastOptions={{ duration: 5000, style: { background: 'none', padding: 0, boxShadow: 'none', border: 'none' } }} containerStyle={{ top: 24 }} />
    <Sidebar 
    activeTab={activeTab} 
    navigateToTab={navigateToTab} 
    candidateCount={candidateCount}
    signalSuggestionCount={signalSuggestionCount}
    currentUser={auth.authEnabled ? auth.user?.username : (permission.user !== 'anonymous' ? permission.user : undefined)}
    currentRole={permission.role}
    permissionMode={permission.mode}
    onLogout={auth.authEnabled ? auth.logout : undefined}
    collapsed={sidebarCollapsed}
    onToggleCollapse={() => setSidebarCollapsed(prev => !prev)}
    />

    <main className="flex-1 flex flex-col overflow-hidden relative">
    <Header 
      searchQuery={searchQuery} 
      setSearchQuery={setSearchQuery} 
      setShowCreateModal={setShowCreateModal} 
      handleSyncSnippets={handleSyncSnippets} 
      aiConfig={data?.aiConfig}
      llmReady={llmReady}
      onOpenLlmConfig={() => setShowLlmConfig(true)}
      onBeforeAiSwitch={stopCurrentAiTasks}
      onAiConfigChange={fetchData}
      onSemanticSearchResults={(results) => {
      setSemanticResults(results);
      if (activeTab !== 'recipes') {
        navigateToTab('recipes');
      }
      }}
    />

    {activeTab === 'recipes' && (
      <CategoryBar 
      selectedCategory={selectedCategory} 
      setSelectedCategory={setSelectedCategory} 
      />
    )}

    <div className={`flex-1 ${activeTab === 'wiki' ? 'overflow-hidden' : 'overflow-y-auto p-8'}`}>
      {loading ? (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
      ) : activeTab === 'recipes' ? (
      <RecipesView 
        recipes={filteredRecipes} 
        openRecipeEdit={openRecipeEdit} 
        handleDeleteRecipe={handleDeleteRecipe}
        onRefresh={fetchData}
        idTitleMap={data?.idTitleMap}
        currentPage={recipePage}
        onPageChange={setRecipePage}
        pageSize={recipePageSize}
        onPageSizeChange={(size) => { setRecipePageSize(size); setRecipePage(1); }}
      />
      ) : activeTab === 'guard' ? (
      <GuardView onRefresh={fetchData} />
      ) : activeTab === 'skills' ? (
      <SkillsView onRefresh={fetchData} signalSuggestionCount={signalSuggestionCount} onSuggestionCountChange={setSignalSuggestionCount} />
      ) : activeTab === 'candidates' ? (
      <>
        {/* Bootstrap 异步填充进度面板 */}
        {bootstrap.session && (
          <div className="mb-4">
            <BootstrapProgressView
              session={bootstrap.session}
              isAllDone={bootstrap.isAllDone}
              reviewState={bootstrap.reviewState}
              onDismiss={() => bootstrap.resetSession()}
            />
          </div>
        )}
        <CandidatesView 
        data={data} 
        isShellTarget={isShellTarget}
        isSilentTarget={isSilentTarget}
        isPendingTarget={isPendingTarget}
        handleDeleteCandidate={handleDeleteCandidate} 
        onEditRecipe={openRecipeEdit}
        onColdStart={handleColdStart}
        isScanning={isScanning}
        isBootstrapping={bootstrap.session?.status === 'running'}
        onRefresh={fetchData}
        onAuditCandidate={(cand, targetName) => {
        const candCode = (cand.content?.pattern || '').trim();
        const isSnippetAble = !!candCode && (() => {
          const lines = candCode.split('\n').filter(l => l.trim());
          const mdLines = lines.filter(l => /^\s*(#{1,6}\s|[-*>]\s|\d+\.\s)/.test(l));
          return mdLines.length <= lines.length * 0.3;
        })();
        setScanResults([{ 
          ...cand, 
          mode: isSnippetAble ? 'full' : 'preview',
          lang: 'cn',
          includeHeaders: true,
          difficulty: cand.difficulty || cand.complexity || 'intermediate',
          authority: cand.stats?.authority || 3,
          candidateId: cand.id,
          candidateTargetName: targetName
        } as ScanResultItem]);
        navigateToTab('spm');
        }}
        onAuditAllInTarget={(items, targetName) => {
        setScanResults(items.map(cand => {
          const candCode = (cand.content?.pattern || '').trim();
          const isSnippetAble = !!candCode && (() => {
            const lines = candCode.split('\n').filter(l => l.trim());
            const mdLines = lines.filter(l => /^\s*(#{1,6}\s|[-*>]\s|\d+\.\s)/.test(l));
            return mdLines.length <= lines.length * 0.3;
          })();
          return {
          ...cand,
          mode: (isSnippetAble ? 'full' : 'preview') as 'full' | 'preview',
          lang: 'cn' as const,
          includeHeaders: true,
          difficulty: cand.difficulty || cand.complexity || 'intermediate',
          authority: cand.stats?.authority || 3,
          candidateId: cand.id,
          candidateTargetName: targetName
        } as ScanResultItem;
        }));
        navigateToTab('spm');
        }}
        handleDeleteAllInTarget={handleDeleteAllInTarget} 
      />
      </>
      ) : activeTab === 'knowledge' ? (
      <KnowledgeView onRefresh={handleRefreshProject} idTitleMap={data?.idTitleMap} />
      ) : activeTab === 'depgraph' ? (
      <DepGraphView />
      ) : activeTab === 'knowledgegraph' ? (
      <KnowledgeGraphView />
      ) : activeTab === 'spm' ? (
      <ModuleExplorerView 
        targets={mergedTargets}
        filteredTargets={filteredTargets}
        selectedTargetName={selectedTargetName}
        isScanning={isScanning}
        scanProgress={scanProgress}
        scanFileList={scanFileList}
        scanResults={scanResults}
        guardAudit={guardAudit}
        handleScanTarget={handleScanTarget}
        handleScanProject={handleScanProject}
        handleUpdateScanResult={handleUpdateScanResult}
        handleSaveExtracted={handleSaveExtracted}
        handlePromoteToCandidate={handlePromoteToCandidate}
        handleDeleteCandidate={handleDeleteCandidate}
        onEditRecipe={openRecipeEdit}
        isShellTarget={isShellTarget}
        recipes={data?.recipes ?? []}
        isSavingRecipe={isSavingRecipe}
        handleRefreshProject={handleRefreshProject}
        onAddCustomFolder={handleAddCustomFolder}
        onRemoveCustomFolder={handleRemoveCustomFolder}
      />
      ) : activeTab === 'wiki' ? (
      <WikiView />
      ) : activeTab === 'help' ? (
      <HelpView />
      ) : (
      <AiChatView />
      )}
    </div>

    {editingRecipe && (
      <RecipeEditor 
      editingRecipe={editingRecipe} 
      setEditingRecipe={setEditingRecipe} 
      handleSaveRecipe={handleSaveRecipe} 
      closeRecipeEdit={closeRecipeEdit}
      isSavingRecipe={isSavingRecipe}
      />
    )}

    {showCreateModal && (
      <CreateModal 
      setShowCreateModal={setShowCreateModal} 
      createPath={createPath} 
      setCreatePath={setCreatePath} 
      handleCreateFromPath={handleCreateFromPath} 
      handleCreateFromClipboard={handleCreateFromClipboard} 
      isExtracting={isExtracting} 
      />
    )}

    {searchAction && (
      <SearchModal
      searchQ={searchAction.q}
      insertPath={searchAction.path}
      onClose={() => {
        setSearchAction(null);
        window.history.replaceState({}, document.title, window.location.pathname);
      }}
      />
    )}

    {showLlmConfig && (
      <LlmConfigModal
        onClose={() => setShowLlmConfig(false)}
        onSaved={() => {
          fetchLlmStatus();
          fetchData();
        }}
      />
    )}

  </main>

  {/* AI Chat 内联面板 — flex 同层，挤压 main 空间 */}
  <ChatPanelSlot />
  </div>
  </GlobalChatProvider>
  </ErrorBoundary>
  );
};

/** Chat 面板插槽 — 按 isOpen 渲染 */
const ChatPanelSlot: React.FC = () => {
  const { isOpen } = useGlobalChat();
  if (!isOpen) return null;
  return <GlobalChatPanel />;
};

export default App;
