import React, { useState, useEffect, useCallback } from 'react';
import { Plus, Cpu, ChevronDown, ChevronRight, MessageSquare, Settings, Search, Zap } from 'lucide-react';
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
  depgraph: 'sidebar.depGraph',
  knowledgegraph: 'sidebar.knowledgeGraph',
  guard: 'sidebar.guard',
  skills: 'sidebar.skills',
  wiki: 'sidebar.repoWiki',
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
}

const Header: React.FC<HeaderProps> = ({
  setShowCreateModal,
  aiConfig, llmReady = true, onOpenLlmConfig,
  onBeforeAiSwitch, onAiConfigChange,
  activeTab,
  onOpenCommandPalette,
  projectName,
  candidateCount = 0,
}) => {
  const { toggle: toggleChat, isOpen: chatOpen } = useGlobalChat();
  const { t } = useI18n();
  const [aiProviders, setAiProviders] = useState<AiProvider[]>([]);
  const [aiSwitching, setAiSwitching] = useState(false);

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
    setAiSwitching(true);
    try {
      onBeforeAiSwitch?.();
      await api.setAiConfig(provider.id, provider.defaultModel);
      if (onAiConfigChange) onAiConfigChange();
    } catch (e) {
      console.error('AI config update failed', e);
    } finally {
      setAiSwitching(false);
    }
  };

  const loadProviders = () => {
    if (aiProviders.length === 0) {
      api.getAiProviders().then(setAiProviders).catch(() => { /* intentionally ignored: provider list load is best-effort */ });
    }
  };

  const tabLabel = activeTab ? t(TAB_LABELS[activeTab], { count: candidateCount }) : '';

  return (
    <TooltipProvider>
      <header
        className="h-[var(--topbar-height)] flex items-center justify-between px-5 border-b border-[var(--border-muted)] glass shrink-0 gap-3 select-none z-10"
      >
        {/* ── 左侧：面包屑 ── */}
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm text-[var(--fg-subtle)] font-medium truncate max-w-[160px]" title={projectName || 'AutoSnippet'}>{projectName || 'AutoSnippet'}</span>
          {tabLabel && (
            <>
              <ChevronRight size={14} className="text-[var(--fg-subtle)]/50 shrink-0" />
              <span className="text-sm text-[var(--fg-default)] font-semibold truncate">{tabLabel}</span>
            </>
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
                  <Cpu size={14} className="shrink-0" />
                  <span className="text-xs" title={`${aiConfig.provider}/${aiConfig.model}`}>{midEllipsis(aiConfig.model, 28)}</span>
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
                      <span className="flex items-center gap-2 flex-1">
                        <span
                          className={cn(
                            "inline-block w-1.5 h-1.5 rounded-full shrink-0",
                            p.hasKey !== false ? "bg-emerald-500" : "bg-[var(--fg-subtle)]"
                          )}
                        />
                        {p.label}
                      </span>
                      {aiConfig.provider === p.id && <span className="text-xs">✓</span>}
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
