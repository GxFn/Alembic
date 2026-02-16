import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { Toaster } from 'react-hot-toast';
import { notify } from './utils/notification';
import { Recipe, ProjectData, SPMTarget, ExtractedRecipe, ScanResultItem, GuardAuditResult } from './types';
import { TabType, validTabs } from './constants';
import { isShellTarget, isSilentTarget, isPendingTarget, getWritePermissionErrorMsg, getSaveErrorMsg } from './utils';
import api from './api';
import { useAuth } from './hooks/useAuth';
import { usePermission } from './hooks/usePermission';
import { useBootstrapSocket } from './hooks/useBootstrapSocket';
import LoginView from './components/Views/LoginView';

// Components
import Sidebar from './components/Layout/Sidebar';
import Header from './components/Layout/Header';
import CategoryBar from './components/Shared/CategoryBar';
import RecipesView from './components/Views/RecipesView';
import HelpView from './components/Views/HelpView';
import CandidatesView from './components/Views/CandidatesView';
import SPMExplorerView from './components/Views/SPMExplorerView';
import DepGraphView from './components/Views/DepGraphView';
import GuardView from './components/Views/GuardView';
import { GlobalChatProvider, GlobalChatPanel, useGlobalChat } from './components/Shared/GlobalChatDrawer';
import AiChatView from './components/Views/AiChatView';
import KnowledgeGraphView from './components/Views/KnowledgeGraphView';
import SkillsView from './components/Views/SkillsView';
import BootstrapProgressView from './components/Views/BootstrapProgressView';
import XcodeSimulator from './pages/XcodeSimulator';
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
          <h2 style={{ color: '#ef4444', marginBottom: 12 }}>页面出现异常</h2>
          <pre style={{ fontSize: 12, color: '#64748b', whiteSpace: 'pre-wrap', maxWidth: 600, margin: '0 auto' }}>
            {this.state.error?.message}
          </pre>
          <button
            onClick={() => { this.setState({ hasError: false, error: null }); window.location.reload(); }}
            style={{ marginTop: 16, padding: '8px 20px', background: '#3b82f6', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}
          >
            刷新页面
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

/** 将 usageGuide 字段安全转为字符串（AI 可能返回 object） */
function stringifyGuide(val: unknown): string {
  if (!val) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'object') {
    // AI 常返回 { "When to use": "...", "Key points": "..." }
    const obj = val as Record<string, unknown>;
    return Object.entries(obj)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join('; ') : v}`)
      .join('\n');
  }
  return String(val);
}

const App: React.FC = () => {
  const auth = useAuth();
  const permission = usePermission(auth.user?.role);
  const bootstrap = useBootstrapSocket();

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
  // chatAbortControllerRef 已迁移到 GlobalChatDrawer

  // 搜索/分类变化时 Recipes 列表重置到第一页；刷新数据（fetchData）不重置页码
  useEffect(() => {
  setRecipePage(1);
  }, [searchQuery, selectedCategory]);

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

  return () => {
    window.removeEventListener('popstate', handlePopState);
  };
  }, []);

  // API Calls
  const fetchData = async () => {
  setLoading(true);
  try {
    const projectData = await api.fetchData();
    // 清理候选池中重复的语言版本
    if (projectData.candidates) {
    const cleanedCandidates: typeof projectData.candidates = {};
    Object.entries(projectData.candidates).forEach(([targetName, targetData]) => {
      const cleanedItems = targetData.items.map(item => {
      const summary_cn = item.summary_cn || item.summary || '';
      const summary_en = item.summary_en && item.summary_en !== summary_cn ? item.summary_en : undefined;
      const usageGuide_cn = stringifyGuide(item.usageGuide_cn || item.usageGuide || '');
      const usageGuide_en = item.usageGuide_en && stringifyGuide(item.usageGuide_en) !== usageGuide_cn ? stringifyGuide(item.usageGuide_en) : undefined;
      
      return {
        ...item,
        summary_cn,
        summary_en,
        usageGuide_cn,
        usageGuide_en
      };
      });
      cleanedCandidates[targetName] = { ...targetData, items: cleanedItems };
    });
    projectData.candidates = cleanedCandidates;
    }
    setData(projectData);
  } catch (err: any) {
    notify(err?.message || '无法加载项目数据', { title: '加载失败', type: 'error' });
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

  const handleSyncToXcode = async () => {
  try {
    await api.syncToXcode();
    notify('Recipes 已同步到 Xcode CodeSnippets 目录', { title: 'Xcode 同步成功' });
  } catch (err) {
    notify('请检查 Xcode 是否已安装并重试', { title: '同步失败', type: 'error' });
  }
  };

  const handleRefreshProject = async () => {
  try {
    await api.refreshProject();
    fetchTargets();
    notify('Target 列表与文件树已更新', { title: '项目结构已刷新' });
  } catch (err) {
    notify('请确认项目路径有效后重试', { title: '刷新失败', type: 'error' });
  }
  };

  const handleCreateFromPathWithSpecifiedPath = async (specifiedPath: string) => {
  setIsExtracting(true);
  try {
    const extractResult = await api.extractFromPath(specifiedPath);
    setScanResults(extractResult.result.map(item => {
    const summary_cn = item.summary_cn || item.summary || '';
    const summary_en = item.summary_en && item.summary_en !== summary_cn ? item.summary_en : undefined;
    const usageGuide_cn = stringifyGuide(item.usageGuide_cn || item.usageGuide || '');
    const usageGuide_en = item.usageGuide_en && stringifyGuide(item.usageGuide_en) !== usageGuide_cn ? stringifyGuide(item.usageGuide_en) : undefined;
    
    return {
      ...item,
      summary_cn,
      summary_en,
      usageGuide_cn,
      usageGuide_en,
      tags: Array.isArray(item.tags) ? item.tags : [],
      mode: 'full',
      lang: 'cn',
      includeHeaders: true,
      category: item.category || 'Utility',
      summary: summary_cn,
      usageGuide: usageGuide_cn
    };
    }));
    navigateToTab('spm', { preserveSearch: true });
    setShowCreateModal(false);
    fetchData();
    if (extractResult.result?.length > 0) {
    notify('提取结果已进入候选池，请在 Candidates 页审核', { title: '提取完成' });
    }
  } catch (err) {
    notify('Extraction failed', { type: 'error' });
  } finally {
    setIsExtracting(false);
  }
  };

  const handleCreateFromPath = async () => {
  if (!createPath) return;
  setIsExtracting(true);
  try {
    const extractResult = await api.extractFromPath(createPath);
    setScanResults(extractResult.result.map(item => {
    const summary_cn = item.summary_cn || item.summary || '';
    const summary_en = item.summary_en && item.summary_en !== summary_cn ? item.summary_en : undefined;
    const usageGuide_cn = stringifyGuide(item.usageGuide_cn || item.usageGuide || '');
    const usageGuide_en = item.usageGuide_en && stringifyGuide(item.usageGuide_en) !== usageGuide_cn ? stringifyGuide(item.usageGuide_en) : undefined;
    
    return {
      ...item,
      summary_cn,
      summary_en,
      usageGuide_cn,
      usageGuide_en,
      tags: Array.isArray(item.tags) ? item.tags : [],
      mode: 'full',
      lang: 'cn',
      includeHeaders: true,
      category: item.category || 'Utility',
      summary: summary_cn,
      usageGuide: usageGuide_cn
    };
    }));
    navigateToTab('spm');
    setShowCreateModal(false);
    fetchData();
    if (extractResult.result?.length > 0) {
    notify(extractResult.isMarked ? '精准锁定标记代码，已加入候选池' : '提取结果已加入候选池', { title: '提取完成' });
    } else if (!extractResult.isMarked) {
    notify('未找到 ASD 标记，AI 将分析完整文件', { title: '提取中', type: 'info' });
    }
  } catch (err) {
    notify('Extraction failed', { type: 'error' });
  } finally {
    setIsExtracting(false);
  }
  };

  const handleCreateFromClipboard = async (contextPath?: string) => {
  try {
    const text = await navigator.clipboard.readText();
    if (!text) return notify('请先复制代码到剪贴板', { title: '剪贴板为空', type: 'info' });
    
    // 立即提示收到代码
    notify('已收到代码，AI 正在识别可复用模式...', { title: '剪贴板分析中', type: 'info' });
    
    setIsExtracting(true);
    const relativePath = contextPath || createPath;
    
    try {
    const item = await api.extractFromText(text, relativePath || undefined);
    
    // 清理重复的语言版本
    const summary_cn = item.summary_cn || item.summary || '';
    const summary_en = item.summary_en && item.summary_en !== summary_cn ? item.summary_en : undefined;
    const usageGuide_cn = stringifyGuide(item.usageGuide_cn || item.usageGuide || '');
    const usageGuide_en = item.usageGuide_en && stringifyGuide(item.usageGuide_en) !== usageGuide_cn ? stringifyGuide(item.usageGuide_en) : undefined;
    
    const multipleCount = (item as ExtractedRecipe & { _multipleCount?: number })._multipleCount;
    setScanResults([{ 
      ...item,
      summary_cn,
      summary_en,
      usageGuide_cn,
      usageGuide_en,
      tags: Array.isArray(item.tags) ? item.tags : [],
      mode: 'full', 
      lang: 'cn',
      includeHeaders: true,
      category: item.category || 'Utility',
      summary: summary_cn,
      usageGuide: usageGuide_cn
    }]);
    navigateToTab('spm', { preserveSearch: true });
    setShowCreateModal(false);
    fetchData();
    notify(multipleCount ? `已识别 ${multipleCount} 条 Recipe，请在候选池审核` : '提取结果已加入候选池', { title: 'AI 识别完成' });
    } catch (err: any) {
    // 区分 AI 错误和其他错误
    const isAiError = err.response?.data?.aiError === true;
    const errorMsg = err.response?.data?.error || err.message;
    
    if (isAiError) {
      notify(errorMsg, { title: 'AI 识别失败', type: 'error' });
    } else {
      notify(errorMsg, { title: '操作失败', type: 'error' });
    }
    }
  } catch (err) {
    notify('浏览器可能未授权剪贴板访问', { title: '剪贴板读取失败', type: 'error' });
  } finally {
    setIsExtracting(false);
  }
  };

  const SCAN_PHASES = [
  { status: '正在读取 Target 源文件...', percent: 15 },
  { status: '正在发送到 AI 分析...', percent: 35 },
  { status: '正在识别可复用代码片段...', percent: 55 },
  { status: '正在生成摘要与使用指南...', percent: 75 },
  { status: '即将完成...', percent: 92 }
  ];

  const handleScanTarget = async (target: SPMTarget) => {
  if (isScanning) return;
  if (abortControllerRef.current) abortControllerRef.current.abort();
  const controller = new AbortController();
  abortControllerRef.current = controller;

  setSelectedTargetName(target.name);
  setIsScanning(true);
  setScanResults([]);
  setGuardAudit(null);
  setScanFileList([]);
  setScanProgress({ current: 0, total: 100, status: '正在获取待扫描文件列表...' });

  const phaseInterval = 4000;
  let phaseIndex = 0;
  const progressTimer = setInterval(() => {
    phaseIndex = Math.min(phaseIndex + 1, SCAN_PHASES.length);
    const phase = SCAN_PHASES[phaseIndex - 1];
    if (phase) {
    setScanProgress(prev => ({ ...prev, current: phase.percent, status: phase.status }));
    }
  }, phaseInterval);

  try {
    const filesResult = await api.getTargetFiles(target, controller.signal);
    const fileList = filesResult.files || [];
    const fileCount = filesResult.count ?? fileList.length;
    setScanFileList(fileList);
    setScanProgress(prev => ({ ...prev, current: 10, status: `正在分析 ${fileCount} 个文件...` }));

    const scanResult = await api.scanTarget(target, controller.signal);
    clearInterval(progressTimer);
    setScanProgress({ current: 100, total: 100, status: '扫描完成' });

    const recipes = scanResult.recipes || [];
    const scannedFiles = scanResult.scannedFiles?.length ? scanResult.scannedFiles : fileList;

    if (recipes.length > 0 || scannedFiles.length > 0) {
    const scanTargetName = typeof target === 'string' ? target : target?.name || 'unknown';
    const enrichedResults = recipes.map((item: ExtractedRecipe) => ({
      ...item,
      mode: 'full' as const,
      lang: 'cn' as const,
      includeHeaders: item.includeHeaders !== false,
      category: item.category || 'Utility',
      summary: stringifyGuide(item.summary_cn || item.summary || ''),
      usageGuide: stringifyGuide(item.usageGuide_cn || item.usageGuide || ''),
      tags: Array.isArray(item.tags) ? item.tags : [],
      candidateTargetName: scanTargetName,
      scanMode: 'target' as const,
    }));
    setScanResults(enrichedResults);
    setScanFileList(scannedFiles);

    fetchData();
    if (recipes.length > 0) {
      notify(`发现 ${recipes.length} 条可复用代码模式，请在右侧审核`, { title: 'Target 扫描完成' });
    } else if (scanResult.message) {
      notify(scanResult.message, { title: 'AI 扫描未返回结果', type: 'error' });
    } else {
      notify('该 Target 中未找到可复用的代码片段', { title: '扫描完成', type: 'info' });
    }
    } else {
    notify('请确认 Target 包含有效的源代码文件', { title: '扫描失败', type: 'error' });
    }
  } catch (err: any) {
    clearInterval(progressTimer);
    if (axios.isCancel(err)) return;
    const isTimeout = err.code === 'ECONNABORTED' || err.message?.includes('timeout');
    const msg = isTimeout
      ? '扫描超时，请尝试减少 Target 文件数量'
      : (err.response?.data?.error || err.message);
    notify(msg, { title: isTimeout ? '扫描超时' : '扫描出错', type: 'error' });
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
  setScanProgress({ current: 0, total: 100, status: '正在收集项目结构...' });
  bootstrap.resetSession();

  try {
    const result = await api.bootstrap(controller.signal);
    setScanProgress({ current: 100, total: 100, status: '骨架已创建，正在后台填充...' });

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
    const guardMsg = guardInfo ? `, Guard: ${guardInfo.totalViolations} 项违规` : '';

    notify(
      `冷启动骨架已创建: ${targetCount} 个 Target, ${fileCount} 个文件, ` +
      `${graphEdges} 条依赖${guardMsg}，正在后台逐维度填充...`
    );
  } catch (err: any) {
    if (axios.isCancel(err)) return;
    const isTimeout = err.code === 'ECONNABORTED' || err.message?.includes('timeout');
    const msg = isTimeout
      ? '冷启动超时，请检查项目文件数量'
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
  setScanProgress({ current: 0, total: 100, status: '正在收集所有 Target 文件...' });

  const phases = [
    { status: '正在收集源文件...', percent: 5 },
    { status: '正在 AI 分析代码模式...', percent: 15 },
    { status: 'AI 提取中（大项目可能需要数分钟）...', percent: 25 },
    { status: 'AI 提取中...', percent: 35 },
    { status: 'AI 深度分析中...', percent: 45 },
    { status: '持续处理中...', percent: 55 },
    { status: '正在运行 Guard 审计...', percent: 65 },
    { status: '正在汇总结果...', percent: 75 },
    { status: '即将完成...', percent: 85 },
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
    setScanProgress({ current: 100, total: 100, status: result.partial ? '扫描部分完成（超时）' : '全项目扫描完成' });

    const recipes = result.recipes || [];
    const scannedFiles = result.scannedFiles || [];

    if (recipes.length > 0 || scannedFiles.length > 0) {
    const enrichedResults = recipes.map((item: ExtractedRecipe) => ({
      ...item,
      mode: 'full' as const,
      lang: 'cn' as const,
      includeHeaders: item.includeHeaders !== false,
      category: item.category || 'Utility',
      summary: item.summary_cn || item.summary || '',
      usageGuide: item.usageGuide_cn || item.usageGuide || '',
      candidateTargetName: '__project__',
      scanMode: 'project' as const,
    }));
    setScanResults(enrichedResults);
    setScanFileList(scannedFiles);
    setGuardAudit(result.guardAudit || null);
    fetchData();

    const guardInfo = result.guardAudit?.summary;
    const violationMsg = guardInfo ? `, Guard: ${guardInfo.totalViolations} 处违反` : '';
    const partialMsg = result.partial ? '（部分结果，AI 超时）' : '';
    notify(`全项目扫描完成: ${recipes.length} 条候选${violationMsg}${partialMsg}`);
    } else {
    notify('全项目扫描完成，未发现可提取内容');
    }
  } catch (err: any) {
    clearInterval(progressTimer);
    if (axios.isCancel(err)) return;
    const isTimeout = err.code === 'ECONNABORTED' || err.message?.includes('timeout');
    const msg = isTimeout
      ? '扫描超时，请尝试减少项目文件数量或分 Target 扫描'
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
  
  // 初始化语言字段：确保 summary_cn 有值（作为中文版本的基础）
  // 但要避免覆盖已存在的 summary_en
  if (!current.summary_cn && current.summary && !current.summary_en) {
    // 只有在既没有 summary_cn 也没有 summary_en 时，才初始化 summary_cn
    current.summary_cn = current.summary;
  }
  if (!current.usageGuide_cn && current.usageGuide && !current.usageGuide_en) {
    // 只有在既没有 usageGuide_cn 也没有 usageGuide_en 时，才初始化 usageGuide_cn
    current.usageGuide_cn = current.usageGuide;
  }
  
  // 当直接设置 summary/usageGuide（用于翻译后直接显示）时，跳过语言判断
  // 只有在没有直接提供这些字段时，才根据 lang 来决定使用哪个版本
  if (updates.lang !== undefined && updates.summary === undefined) {
    current.summary = updates.lang === 'cn' ? (current.summary_cn || current.summary) : (current.summary_en || current.summary);
  }
  if (updates.lang !== undefined && updates.usageGuide === undefined) {
    current.usageGuide = updates.lang === 'cn' ? (current.usageGuide_cn || current.usageGuide) : (current.usageGuide_en || current.usageGuide);
  }
  
  // 编辑 summary 或 usageGuide 时，保存到对应的语言版本
  if (updates.summary !== undefined && updates.lang === undefined) {
    if (current.lang === 'cn') current.summary_cn = updates.summary;
    else current.summary_en = updates.summary;
  }
  if (updates.usageGuide !== undefined && updates.lang === undefined) {
    if (current.lang === 'cn') current.usageGuide_cn = updates.usageGuide;
    else current.usageGuide_en = updates.usageGuide;
  }

  newResults[index] = current;
  setScanResults(newResults);
  };

  const handleSaveExtracted = async (extracted: ScanResultItem) => {
  if (isSavingRecipe) return;
  setIsSavingRecipe(true);
  try {
    const triggers = (extracted.trigger || '').split(/[,，\s]+/).map(t => t.trim()).filter(Boolean);
    if (triggers.length === 0) {
    notify('请输入 Trigger', { type: 'error' });
    setIsSavingRecipe(false);
    return;
    }
    const primarySnippetId = crypto.randomUUID().toUpperCase();

  const recipeName = `${(extracted.title || 'Untitled').replace(/\s+/g, '-')}.md`;
  
  // 准备中英文版本
  const summary_cn = extracted.summary_cn || extracted.summary || '';
  const summary_en = extracted.summary_en || extracted.summary || '';
  const usageGuide_cn = extracted.usageGuide_cn || extracted.usageGuide || '';
  const usageGuide_en = extracted.usageGuide_en || extracted.usageGuide || '';
  
  // 构建 Frontmatter
  let frontmatter = `---
id: ${extracted.mode === 'full' ? primarySnippetId : 'preview-only'}
title: ${extracted.title || 'Untitled Recipe'}
language: ${extracted.language || 'swift'}
trigger: ${triggers.join(', ')}
category: ${extracted.category || 'Utility'}
summary: ${summary_cn}
summary_cn: ${summary_cn}`;

  if (summary_en && summary_en !== summary_cn) {
    frontmatter += `\nsummary_en: ${summary_en}`;
  }
  
  frontmatter += `
headers: ${JSON.stringify(extracted.headers || [])}`;
  
  if (extracted.difficulty) {
    frontmatter += `\ndifficulty: ${extracted.difficulty}`;
  }
  if (extracted.authority) {
    frontmatter += `\nauthority: ${extracted.authority}`;
  }
  if (extracted.knowledgeType) {
    frontmatter += `\nknowledge_type: ${extracted.knowledgeType}`;
  }
  if (extracted.complexity) {
    frontmatter += `\ncomplexity: ${extracted.complexity}`;
  }
  if (extracted.scope) {
    frontmatter += `\nscope: ${extracted.scope}`;
  }
  if (extracted.tags && extracted.tags.length > 0) {
    frontmatter += `\ntags: ${JSON.stringify(extracted.tags)}`;
  }
  
  frontmatter += `
version: "1.0.0"
updatedAt: ${Date.now()}
---`;

  // 构建正文
  let body = `
## Snippet / Code Reference

\`\`\`${extracted.language || 'swift'}
${extracted.code || ''}
\`\`\`

## AI Context / Usage Guide

${usageGuide_cn}`;

  if (usageGuide_en && usageGuide_en !== usageGuide_cn) {
    body += `

## AI Context / Usage Guide (EN)

${usageGuide_en}`;
  }

  // Rationale (from AI)
  if (extracted.rationale) {
    body += `

## Architecture Usage

${extracted.rationale}`;
  }

  // Steps (from AI)
  if (extracted.steps && extracted.steps.length > 0) {
    body += `

## Best Practices

${extracted.steps.map((s: string, i: number) => `${i + 1}. ${s}`).join('\n')}`;
  }

  // Preconditions (from AI)
  if (extracted.preconditions && extracted.preconditions.length > 0) {
    body += `

## Standards

**Preconditions:**\n${extracted.preconditions.map((p: string) => `- ${p}`).join('\n')}`;
  }
  
  const recipeContent = frontmatter + body;
    await api.saveRecipe(recipeName, recipeContent);
    
    notify(extracted.mode === 'full' ? '已保存为 Recipe（Snippet 将自动生成）' : '已保存到 KB');
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
    notify(msg ?? '保存失败', { type: 'error' });
  } finally {
    setIsSavingRecipe(false);
  }
  };

  const handleSaveRecipe = async () => {
  if (!editingRecipe || isSavingRecipe) return;
  setIsSavingRecipe(true);
  try {
    // 清理重复的英文版本：保留只有一份 "## AI Context / Usage Guide (EN)"
    let cleanedContent = editingRecipe.content;
    
    // 用简单的方式：找到第一份英文版本，删除之后的所有重复英文版本
    const enGuidePattern = '\n## AI Context / Usage Guide (EN)';
    const firstIndex = cleanedContent.indexOf(enGuidePattern);
    
    if (firstIndex !== -1) {
    // 找第一份英文版本后面是否还有其他 "## AI Context / Usage Guide (EN)"
    const afterFirst = cleanedContent.substring(firstIndex + enGuidePattern.length);
    const secondIndex = afterFirst.indexOf(enGuidePattern);
    
    if (secondIndex !== -1) {
      // 有重复，找出第一份的完整范围（到下一个标题或末尾）
      const nextHeaderMatch = afterFirst.match(/\n## /);
      let endOfFirst = afterFirst.length;
      
      if (nextHeaderMatch && nextHeaderMatch.index !== undefined && nextHeaderMatch.index < secondIndex) {
      // 第一份英文版本后有其他标题
      endOfFirst = nextHeaderMatch.index;
      cleanedContent = cleanedContent.substring(0, firstIndex + enGuidePattern.length) + 
            afterFirst.substring(0, endOfFirst);
      } else {
      // 第一份英文版本就到文件末尾（或只到第二份之前）
      cleanedContent = cleanedContent.substring(0, firstIndex + enGuidePattern.length) + 
            afterFirst.substring(0, secondIndex);
      }
    }
    }
    
    await api.saveRecipe(editingRecipe.name, cleanedContent);
    closeRecipeEdit();
    fetchData();
  } catch (err) {
    const msg = getSaveErrorMsg(err) ?? getWritePermissionErrorMsg(err);
    notify(msg ?? '保存 Recipe 失败', { type: 'error' });
  } finally {
    setIsSavingRecipe(false);
  }
  };

  const handleDeleteRecipe = async (name: string) => {
  if (!window.confirm(`Are you sure?`)) return;
  try {
    await api.deleteRecipe(name);
    fetchData();
  } catch (err) {
    const msg = getWritePermissionErrorMsg(err);
    notify(msg ?? '删除失败', { type: 'error' });
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
    notify('操作失败', { type: 'error' });
  }
  };

  const handleDeleteAllInTarget = async (targetName: string) => {
  if (!window.confirm(`确定移除「${targetName}」下的全部候选？`)) return;
  try {
    await api.deleteAllCandidatesInTarget(targetName);
    fetchData();
    notify(`已移除 ${targetName} 下的全部候选`);
  } catch (err) {
    notify('操作失败', { type: 'error' });
  }
  };

  const handlePromoteToCandidate = async (res: any, index: number) => {
  try {
    await api.promoteToCandidate(res, res.candidateTargetName || selectedTargetName || '_review');
    notify('已加入 Candidate 待审核队列');
    setScanResults(prev => prev.filter((_, i) => i !== index));
    fetchData();
  } catch (err: any) {
    notify(err.response?.data?.error || '创建 Candidate 失败', { type: 'error' });
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
  const content = s.content || '';
  const matchesSearch = name.toLowerCase().includes(searchQuery.toLowerCase()) || content.toLowerCase().includes(searchQuery.toLowerCase());
  if (selectedCategory === 'All') return matchesSearch;
  const categoryMatch = content ? content.match(/category:\s*(.*)/) : null;
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

  const filteredTargets = targets
  .filter(t => t.name.toLowerCase().includes(searchQuery.toLowerCase()))
  .sort((a, b) => {
    const aShell = isShellTarget(a.name);
    const bShell = isShellTarget(b.name);
    if (aShell && !bShell) return 1;
    if (!aShell && bShell) return -1;
    return a.name.localeCompare(b.name);
  });

  const candidateCount = Object.values(data?.candidates || {}).reduce((acc, curr) => acc + curr.items.length, 0);

  const isDarkMode = activeTab === 'editor';

  // ── 登录门控 ──────────────────────────────────
  if (requireLogin) {
    return <LoginView onLogin={auth.login} isLoading={auth.isLoading} />;
  }

  return (
  <ErrorBoundary>
  <GlobalChatProvider>
  <div className={`flex h-screen ${isDarkMode ? 'bg-[#1e1e1e] text-slate-200' : 'bg-slate-50 text-slate-900'} overflow-hidden font-sans`}>
    <Toaster position="top-center" toastOptions={{ duration: 5000 }} containerStyle={{ top: 24 }} />
    <Sidebar 
    activeTab={activeTab} 
    navigateToTab={navigateToTab} 
    candidateCount={candidateCount}
    signalSuggestionCount={signalSuggestionCount}
    isDarkMode={isDarkMode}
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
      handleSyncToXcode={handleSyncToXcode} 
      aiConfig={data?.aiConfig}
      llmReady={llmReady}
      onOpenLlmConfig={() => setShowLlmConfig(true)}
      onBeforeAiSwitch={stopCurrentAiTasks}
      onAiConfigChange={fetchData}
      isDarkMode={isDarkMode}
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

    <div className={`flex-1 overflow-y-auto ${activeTab === 'editor' ? '' : 'p-8'}`}>
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
        setScanResults([{ 
          ...cand, 
          mode: 'full',
          lang: 'cn',
          includeHeaders: true,
          summary: cand.summary_cn || cand.summary || '',
          usageGuide: cand.usageGuide_cn || cand.usageGuide || '',
          candidateId: cand.id,
          candidateTargetName: targetName
        }]);
        navigateToTab('spm');
        }}
        onAuditAllInTarget={(items, targetName) => {
        setScanResults(items.map(cand => ({
          ...cand,
          mode: 'full' as const,
          lang: 'cn' as const,
          includeHeaders: true,
          summary: cand.summary_cn || cand.summary || '',
          usageGuide: cand.usageGuide_cn || cand.usageGuide || '',
          candidateId: cand.id,
          candidateTargetName: targetName
        })));
        navigateToTab('spm');
        }}
        handleDeleteAllInTarget={handleDeleteAllInTarget} 
      />
      </>
      ) : activeTab === 'depgraph' ? (
      <DepGraphView />
      ) : activeTab === 'knowledgegraph' ? (
      <KnowledgeGraphView />
      ) : activeTab === 'spm' ? (
      <SPMExplorerView 
        targets={targets}
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
      />
      ) : activeTab === 'editor' ? (
      <XcodeSimulator />
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
