import React, { useState, useEffect, useCallback } from 'react';
import { Plus, Cpu, ChevronDown, ChevronRight, MessageSquare, Settings, Search, Zap, Radio, FlaskConical, FlaskRound, TerminalSquare, ShieldCheck, ShieldAlert, Eye } from 'lucide-react';
import api from '../../api';
import { getSocket } from '../../lib/socket';
import { useGlobalChat } from '../Shared/GlobalChatDrawer';
import { useI18n } from '../../i18n';
import { cn } from '../../lib/utils';
import { Button } from '../ui/Button';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '../ui/Tooltip';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuLabel,
} from '../ui/DropdownMenu';
import { TabType } from '../../constants';

/** 格式化 token 数字：1234 → "1.2k", 1234567 → "1.2M" */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

/** 中间省略：保留前后字符，中间用 … 替代 */
function midEllipsis(s: string, max: number): string {
  if (s.length <= max) return s;
  const keep = Math.floor((max - 1) / 2);
  return s.slice(0, keep) + '…' + s.slice(s.length - keep);
}

interface AiProvider {
  id: string;
  label: string;
  defaultModel: string;
  hasKey?: boolean;
}

/** Tab → 显示名称映射 (i18n 兼容) */
const TAB_LABELS: Record<TabType, string> = {
  recipes: 'sidebar.recipes',
  spm: 'sidebar.moduleExplorer',
  candidates: 'sidebar.candidates',
  knowledge: 'sidebar.batchManage',
  guard: 'sidebar.guard',
  panorama: 'sidebar.panorama',
  skills: 'sidebar.skills',
  wiki: 'sidebar.repoWiki',
  signals: 'sidebar.signals',
  ai: 'sidebar.aiAssistant',
  help: 'sidebar.help',
};

interface HeaderProps {
  setShowCreateModal: (show: boolean) => void;
  aiConfig?: { provider: string; model: string };
  llmReady?: boolean;
  onOpenLlmConfig?: () => void;
  onBeforeAiSwitch?: () => void;
  onAiConfigChange?: () => void;
  /** 当前激活的 Tab (用于面包屑) */
  activeTab?: TabType;
  /** 打开 ⌘K Command Palette */
  onOpenCommandPalette?: () => void;
  /** 项目名称 */
  projectName?: string;
  /** 候选总数（用于面包屑插值） */
  candidateCount?: number;
  /** Signal Monitor 开关 */
  showSignalMonitor?: boolean;
  onToggleSignalMonitor?: () => void;
}

const Header: React.FC<HeaderProps> = ({
  setShowCreateModal,
  aiConfig, llmReady = true, onOpenLlmConfig,
  onBeforeAiSwitch, onAiConfigChange,
  activeTab,
  onOpenCommandPalette,
  projectName,
  candidateCount = 0,
  showSignalMonitor = false,
  onToggleSignalMonitor,
}) => {
  const { toggle: toggleChat, isOpen: chatOpen } = useGlobalChat();
  const { t } = useI18n();
  const [aiProviders, setAiProviders] = useState<AiProvider[]>([]);
  const [aiSwitching, setAiSwitching] = useState(false);

  /* ── 测试模式标识（全局持久展示） ── */
  const [testMode, setTestMode] = useState<{
    enabled: boolean;
    bootstrapDims: string[];
    rescanDims: string[];
    terminal: { enabled: boolean; toolset: string };
    sandbox: { mode: string; available: boolean };
  } | null>(null);
  useEffect(() => {
    api.getTestModeConfig().then(cfg => {
      if (cfg.enabled || cfg.terminal.enabled || cfg.sandbox.mode !== 'disabled') {
        setTestMode(cfg);
      }
    }).catch(() => { /* best-effort */ });
  }, []);

  /* ── Token 消耗指标（事件驱动刷新） ── */
  const [tokenSummary, setTokenSummary] = useState<{ total_tokens: number; call_count: number } | null>(null);
  const refreshTokens = useCallback(() => {
    api.getTokenUsage7Days()
      .then(d => setTokenSummary(d.summary))
      .catch(() => { /* intentionally ignored: token usage is a non-critical metric */ });
  }, []);

  useEffect(() => {
    refreshTokens();
    const socket = getSocket();
    const onTokenChange = () => refreshTokens();
    socket.on('candidate-created', onTokenChange);
    socket.on('bootstrap:all-completed', onTokenChange);
    socket.on('token-usage-updated', onTokenChange);
    return () => {
      socket.off('candidate-created', onTokenChange);
      socket.off('bootstrap:all-completed', onTokenChange);
      socket.off('token-usage-updated', onTokenChange);
    };
  }, [refreshTokens]);

  /* ── AI 提供商切换 ── */
  const handleSelectAi = async (provider: AiProvider) => {
    const isSwitchingFromMock = aiConfig?.provider === 'mock' && provider.id !== 'mock';
    const isSwitchingToMock = aiConfig?.provider !== 'mock' && provider.id === 'mock';

    // 切换到 Mock 模式时，提醒用户
    if (isSwitchingToMock) {
      if (!window.confirm(t('header.mockSwitchToConfirm'))) {
        return;
      }
    }

    // 从 Mock 切出时，询问是否清理伪造数据
    if (isSwitchingFromMock) {
      const shouldClean = window.confirm(t('header.mockSwitchFromConfirm'));
      if (shouldClean) {
        try {
          const result = await api.cleanupMockData();
          console.log(`Mock cleanup: ${result.deleted} entries deleted`);
        } catch (e) {
          console.error('Mock cleanup failed', e);
        }
      }
    }

    setAiSwitching(true);
    try {
      onBeforeAiSwitch?.();
      await api.saveLlmEnvConfig({
        provider: provider.id,
        model: provider.defaultModel,
      });
      if (onAiConfigChange) {
        onAiConfigChange();
      }
    } catch (e) {
      console.error('AI config update failed', e);
    } finally {
      setAiSwitching(false);
    }
  };

  const loadProviders = useCallback(() => {
    if (aiProviders.length === 0) {
      api.getAiProviders().then(setAiProviders).catch(() => { /* intentionally ignored: provider list load is best-effort */ });
    }
  }, [aiProviders.length]);

  // Eagerly load providers so we know hasKey for the status dot
  useEffect(() => { loadProviders(); }, [loadProviders]);

  // Derive current provider's key availability
  const currentProviderHasKey = aiConfig
    ? aiProviders.find(p => p.id === aiConfig.provider)?.hasKey
    : undefined;

  const tabLabel = activeTab ? t(TAB_LABELS[activeTab], { count: candidateCount }) : '';

  return (
    <TooltipProvider>
      <header
        className="h-[var(--topbar-height)] flex items-center justify-between px-5 border-b border-[var(--border-muted)] glass shrink-0 gap-3 select-none z-10"
      >
        {/* ── 左侧：面包屑 + 测试模式标识 ── */}
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm text-[var(--fg-subtle)] font-medium truncate max-w-[160px]" title={projectName || 'Alembic'}>{projectName || 'Alembic'}</span>
          {tabLabel && (
            <>
              <ChevronRight size={14} className="text-[var(--fg-subtle)]/50 shrink-0" />
              <span className="text-sm text-[var(--fg-default)] font-semibold truncate">{tabLabel}</span>
            </>
          )}
          {testMode && (
            <div className="flex items-center gap-1.5 ml-2 shrink-0">
              {testMode.enabled && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-600 border border-amber-300/40 cursor-default">
                      <FlaskRound size={10} />
                      {t('bootstrap.testMode')}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-xs text-xs">
                    <p className="font-medium mb-1">{t('bootstrap.testMode')}</p>
                    <p>Bootstrap: {testMode.bootstrapDims.length > 0 ? testMode.bootstrapDims.join(', ') : t('bootstrap.testModeAll')}</p>
                    <p>Rescan: {testMode.rescanDims.length > 0 ? testMode.rescanDims.join(', ') : t('bootstrap.testModeAll')}</p>
                  </TooltipContent>
                </Tooltip>
              )}
              {testMode.terminal.enabled && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-sky-500/10 text-sky-600 border border-sky-300/40 cursor-default">
                      <TerminalSquare size={10} />
                      {t('bootstrap.terminalTest')}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="text-xs">
                    Toolset: {testMode.terminal.toolset}
                  </TooltipContent>
                </Tooltip>
              )}
              {testMode.sandbox && !testMode.sandbox.available && testMode.sandbox.mode !== 'disabled' && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-gray-500/10 text-gray-500 border border-gray-300/40 cursor-default">
                      <ShieldAlert size={10} />
                      {t('sandbox.unavailable')}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="text-xs">
                    {t('sandbox.unavailableHint')}
                  </TooltipContent>
                </Tooltip>
              )}
              {testMode.sandbox && testMode.sandbox.available && testMode.sandbox.mode === 'enforce' && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 border border-emerald-300/40 cursor-default">
                      <ShieldCheck size={10} />
                      {t('sandbox.enforce')}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="text-xs">
                    {t('sandbox.enforceHint')}
                  </TooltipContent>
                </Tooltip>
              )}
              {testMode.sandbox && testMode.sandbox.available && testMode.sandbox.mode === 'audit' && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-blue-500/10 text-blue-600 border border-blue-300/40 cursor-default">
                      <Eye size={10} />
                      {t('sandbox.audit')}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="text-xs">
                    {t('sandbox.auditHint')}
                  </TooltipContent>
                </Tooltip>
              )}
              {testMode.sandbox && testMode.sandbox.mode === 'disabled' && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-red-500/10 text-red-600 border border-red-300/40 cursor-default">
                      <ShieldAlert size={10} />
                      {t('sandbox.disabled')}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="text-xs">
                    {t('sandbox.disabledHint')}
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
          )}
        </div>

        {/* ── 中间：⌘K 搜索触发 ── */}
        <button
          onClick={onOpenCommandPalette}
          className={cn(
            "flex items-center gap-2 h-8 px-3 rounded-[var(--radius-full)] border border-[var(--border-default)] bg-[var(--bg-subtle)]/60",
            "text-sm text-[var(--fg-subtle)] hover:border-[var(--accent)]/40 hover:text-[var(--fg-muted)] hover:shadow-[0_0_12px_var(--accent-glow)] transition-all",
            "w-64 justify-between backdrop-blur-sm"
          )}
        >
          <div className="flex items-center gap-2">
            <Search size={14} />
            <span>{t('header.searchPlaceholder')}</span>
          </div>
          <kbd className="hidden sm:inline-flex items-center gap-0.5 rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-root)]/60 px-1.5 py-0.5 text-[10px] font-mono text-[var(--fg-subtle)]">
            ⌘K
          </kbd>
        </button>

        {/* ── 右侧：操作按钮 ── */}
        <div className="flex items-center gap-1 shrink-0">
          {/* LLM 配置警告 */}
          {!llmReady && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onOpenLlmConfig}
              className="text-[var(--warning)] animate-pulse"
            >
              <Settings size={14} />
              <span className="text-xs">{t('header.configureLlm')}</span>
            </Button>
          )}

          {/* AI Provider 选择器 */}
          {llmReady && aiConfig && (
            <DropdownMenu onOpenChange={(open) => open && loadProviders()}>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="gap-1.5 focus-visible:ring-0 focus-visible:ring-offset-0">
                  <span className="relative shrink-0">
                    {aiConfig.provider === 'mock' ? (
                      <FlaskConical size={14} className="text-amber-500" />
                    ) : (
                      <Cpu size={14} />
                    )}
                    <span
                      className={cn(
                        "absolute -top-0.5 -right-0.5 w-[6px] h-[6px] rounded-full ring-1 ring-[var(--bg-root)]",
                        aiConfig.provider === 'mock'
                          ? "bg-amber-500"
                          : currentProviderHasKey === false
                            ? "bg-red-400"
                            : "bg-emerald-500"
                      )}
                    />
                  </span>
                  <span className="text-xs" title={`${aiConfig.provider}/${aiConfig.model}`}>{midEllipsis(aiConfig.model, 28)}</span>
                  {aiConfig.provider === 'mock' && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-500 font-medium shrink-0">
                      Mock
                    </span>
                  )}
                  {tokenSummary && tokenSummary.total_tokens > 0 && (
                    <span className="flex items-center gap-0.5 ml-0.5 text-[10px] text-[var(--fg-subtle)] tabular-nums shrink-0">
                      <Zap size={9} className="text-amber-500/70" />{fmtTokens(tokenSummary.total_tokens)}
                    </span>
                  )}
                  <ChevronDown size={12} className="shrink-0" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel>{t('header.switchAi')}</DropdownMenuLabel>
                {aiConfig.provider === 'mock' && (
                  <div className="px-2 py-1.5 text-[11px] text-amber-500/80 bg-amber-500/5 rounded mx-1 mb-1">
                    🧪 {t('header.mockModeHint')}
                  </div>
                )}
                <DropdownMenuSeparator />
                {aiProviders.length === 0 ? (
                  <DropdownMenuItem disabled>{t('common.loading')}</DropdownMenuItem>
                ) : (
                  aiProviders.map((p) => (
                    <DropdownMenuItem
                      key={p.id}
                      onClick={() => handleSelectAi(p)}
                      disabled={aiSwitching}
                      className={cn(
                        aiConfig.provider === p.id && "bg-[var(--accent-subtle)] text-[var(--accent)] font-medium",
                        p.hasKey === false && "opacity-50"
                      )}
                    >
                      <span className="flex items-center gap-2 flex-1 min-w-0">
                        <span
                          className={cn(
                            "inline-block w-1.5 h-1.5 rounded-full shrink-0",
                            p.hasKey !== false ? "bg-emerald-500" : "bg-[var(--fg-subtle)]"
                          )}
                        />
                        <span className="flex flex-col min-w-0">
                          <span className="truncate">{p.label}</span>
                          <span className="text-[10px] text-[var(--fg-subtle)] truncate">{p.defaultModel}</span>
                        </span>
                      </span>
                      {aiConfig.provider === p.id && <span className="text-xs shrink-0">✓</span>}
                    </DropdownMenuItem>
                  ))
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={onOpenLlmConfig}>
                  <Settings size={14} />
                  <span>{t('header.editEnvConfig')}</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {/* 新建 */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setShowCreateModal(true)}
              >
                <Plus size={16} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('header.newRecipe')}</TooltipContent>
          </Tooltip>

          {/* Signal Monitor Toggle */}
          {onToggleSignalMonitor && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={showSignalMonitor ? "accent" : "ghost"}
                  size="icon-sm"
                  onClick={onToggleSignalMonitor}
                >
                  <Radio size={16} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{showSignalMonitor ? t('signals.closeMonitor') : t('signals.openMonitor')}</TooltipContent>
            </Tooltip>
          )}

          {/* AI Chat Toggle（贴最右） */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={chatOpen ? "accent" : "ghost"}
                size="icon-sm"
                onClick={toggleChat}
              >
                <MessageSquare size={16} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{chatOpen ? t('header.closeAiChat') : t('header.openAiChat')}</TooltipContent>
          </Tooltip>        </div>
      </header>
    </TooltipProvider>
  );
};

export default Header;
