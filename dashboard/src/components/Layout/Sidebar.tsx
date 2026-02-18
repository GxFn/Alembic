import React, { useEffect, useState, useCallback } from 'react';
import { Bookmark, FolderOpen, Clock, GitBranch, Share2, Shield, MessageSquare, HelpCircle, Code, Edit3, LogOut, User, ShieldCheck, Eye, Fingerprint, BookOpen, Sparkles, PanelLeftClose, PanelLeftOpen, Zap, Library, FileText } from 'lucide-react';
import { TabType } from '../../constants';
import { ICON_SIZES } from '../../constants/icons';
import api from '../../api';
import { getSocket } from '../../lib/socket';

/** 格式化 token 数字：1234 → "1.2k", 1234567 → "1.2M" */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

interface SidebarProps {
  activeTab: TabType;
  navigateToTab: (tab: TabType, options?: { preserveSearch?: boolean }) => void;
  candidateCount: number;
  signalSuggestionCount?: number;
  isDarkMode?: boolean;
  currentUser?: string;
  currentRole?: string;
  permissionMode?: string;
  onLogout?: () => void;
  /** 是否折叠为图标模式 */
  collapsed?: boolean;
  /** 切换折叠 */
  onToggleCollapse?: () => void;
}

const ROLE_LABELS: Record<string, { label: string, color: string, bg: string }> = {
  developer:       { label: '开发者', color: 'text-emerald-700', bg: 'bg-emerald-50 border-emerald-200' },
  external_agent:  { label: 'Agent', color: 'text-purple-700', bg: 'bg-purple-50 border-purple-200' },
  chat_agent:      { label: 'ChatAgent', color: 'text-blue-700', bg: 'bg-blue-50 border-blue-200' },
};

const MODE_ICONS: Record<string, typeof ShieldCheck> = {
  token: Fingerprint,
  probe: Eye,
};

interface NavItem {
  tab: TabType;
  icon: React.ElementType;
  label: string;
  badge?: number | string;
  badgeColor?: string;
}

const Sidebar: React.FC<SidebarProps> = ({
  activeTab, navigateToTab, candidateCount,
  signalSuggestionCount = 0, isDarkMode = false,
  currentUser, currentRole, permissionMode, onLogout,
  collapsed = false, onToggleCollapse,
}) => {
  const roleInfo = ROLE_LABELS[currentRole || ''] || ROLE_LABELS.developer;
  const ModeIcon = MODE_ICONS[permissionMode || 'probe'] || Eye;

  // ── Token 消耗指标（事件驱动刷新，不轮询） ──
  const [tokenSummary, setTokenSummary] = useState<{ total_tokens: number; call_count: number } | null>(null);
  const refreshTokens = useCallback(() => {
    api.getTokenUsage7Days()
      .then(d => setTokenSummary(d.summary))
      .catch(() => {});
  }, []);

  useEffect(() => {
    // 初始加载一次
    refreshTokens();

    // 监听 socket 事件：AI 调用产生新 token 时触发
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

  const navItems: NavItem[] = [
    { tab: 'recipes', icon: Bookmark, label: 'Recipes' },
    { tab: 'spm', icon: FolderOpen, label: 'SPM Explorer' },
    { tab: 'candidates', icon: Clock, label: `Candidates (${candidateCount})` },
    { tab: 'knowledge', icon: Library, label: '批量管理' },
    { tab: 'depgraph', icon: GitBranch, label: '依赖关系图' },
    { tab: 'knowledgegraph', icon: Share2, label: '知识图谱' },
    { tab: 'guard', icon: Shield, label: 'Guard' },
    { tab: 'skills', icon: BookOpen, label: 'Skills', badge: signalSuggestionCount > 0 ? signalSuggestionCount : undefined, badgeColor: 'bg-amber-100 text-amber-700' },
    { tab: 'wiki', icon: FileText, label: 'Repo Wiki' },
    { tab: 'ai', icon: MessageSquare, label: 'AI Assistant' },
    { tab: 'editor', icon: Edit3, label: '编辑器（测试）' },
    { tab: 'help', icon: HelpCircle, label: '使用说明' },
  ];

  const activeClass = isDarkMode ? 'bg-blue-900/30 text-blue-400 font-medium' : 'bg-blue-50 text-blue-700 font-medium';
  const inactiveClass = isDarkMode ? 'text-slate-300 hover:bg-slate-700/50' : 'text-slate-600 hover:bg-slate-50';

  return (
    <aside className={`${collapsed ? 'w-16' : 'w-64'} ${isDarkMode ? 'bg-[#252526] border-r border-[#3e3e42]' : 'bg-white border-r border-slate-200'} flex flex-col shrink-0 transition-all duration-200`}>

      {/* Logo + 折叠按钮 */}
      <div className={`${collapsed ? 'px-3 py-4' : 'p-6'} border-b ${isDarkMode ? 'border-[#3e3e42]' : 'border-slate-100'} flex items-center ${collapsed ? 'justify-center' : 'justify-between'}`}>
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center text-white shrink-0">
            <Code size={ICON_SIZES.lg} />
          </div>
          {!collapsed && <h1 className="font-bold text-lg truncate">AutoSnippet</h1>}
        </div>
        {onToggleCollapse && !collapsed && (
          <button onClick={onToggleCollapse} className={`p-1 rounded-md transition-colors ${isDarkMode ? 'text-slate-500 hover:text-slate-300 hover:bg-slate-700/50' : 'text-slate-400 hover:text-slate-600 hover:bg-slate-100'}`} title="折叠导航">
            <PanelLeftClose size={16} />
          </button>
        )}
      </div>

      {/* 折叠状态下的展开按钮 */}
      {collapsed && onToggleCollapse && (
        <div className="flex justify-center py-2">
          <button onClick={onToggleCollapse} className={`p-1.5 rounded-md transition-colors ${isDarkMode ? 'text-slate-500 hover:text-slate-300 hover:bg-slate-700/50' : 'text-slate-400 hover:text-slate-600 hover:bg-slate-100'}`} title="展开导航">
            <PanelLeftOpen size={16} />
          </button>
        </div>
      )}

      {/* 导航项 */}
      <nav className={`flex-1 ${collapsed ? 'px-2 py-2' : 'p-4'} space-y-1 overflow-y-auto scrollbar-light`}>
        {navItems.map(({ tab, icon: Icon, label, badge, badgeColor }) => (
          <button
            key={tab}
            type="button"
            onClick={() => navigateToTab(tab)}
            title={collapsed ? label : undefined}
            className={`w-full flex items-center ${collapsed ? 'justify-center px-2 py-2.5 relative' : 'gap-3 px-4 py-2'} rounded-lg transition-colors ${activeTab === tab ? activeClass : inactiveClass}`}
          >
            <Icon size={ICON_SIZES.lg} className="shrink-0" />
            {!collapsed && (
              <>
                <span className="flex-1 text-left truncate text-[13px]">{label}</span>
                {badge != null && (
                  <span className={`flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-bold ${badgeColor || 'bg-blue-100 text-blue-700'}`}>
                    <Sparkles size={10} />{badge}
                  </span>
                )}
              </>
            )}
            {collapsed && badge != null && (
              <span className="absolute top-0 right-0 w-2 h-2 rounded-full bg-amber-400" />
            )}
          </button>
        ))}
      </nav>

      {/* 底部：角色 / 用户 / 刷新 */}
      <div className={`${collapsed ? 'px-2 py-3' : 'p-4'} ${isDarkMode ? 'border-t border-[#3e3e42]' : 'border-t border-slate-100'}`}>
        {!collapsed && (
          <>
            <div className={`flex items-center gap-1.5 mb-3 px-2 py-1.5 rounded-lg border text-[10px] font-bold uppercase tracking-wider ${isDarkMode ? 'bg-slate-700/30 border-slate-600 text-slate-400' : roleInfo.bg + ' ' + roleInfo.color}`}>
              <ModeIcon size={ICON_SIZES.xs} />
              <span>{permissionMode === 'token' ? '登录' : '探针'}</span>
              <span className="mx-0.5">&middot;</span>
              <ShieldCheck size={ICON_SIZES.xs} />
              <span>{roleInfo.label}</span>
            </div>
            {currentUser && (
              <div className={`flex items-center justify-between mb-3 px-2 py-1.5 rounded-lg ${isDarkMode ? 'bg-slate-700/30' : 'bg-slate-50'}`}>
                <div className="flex items-center gap-2 min-w-0">
                  <User size={ICON_SIZES.sm} className={isDarkMode ? 'text-slate-400' : 'text-slate-500'} />
                  <span className={`text-xs font-medium truncate ${isDarkMode ? 'text-slate-300' : 'text-slate-600'}`}>{currentUser}</span>
                </div>
                {onLogout && (
                  <button onClick={onLogout} title="登出" className={`shrink-0 p-1 rounded transition-colors ${isDarkMode ? 'text-slate-500 hover:text-red-400 hover:bg-slate-700/50' : 'text-slate-400 hover:text-red-500 hover:bg-red-50'}`}>
                    <LogOut size={ICON_SIZES.sm} />
                  </button>
                )}
              </div>
            )}
          </>
        )}
        {/* Token 消耗指标 */}
        {tokenSummary && tokenSummary.total_tokens > 0 && (
          <button
            onClick={() => navigateToTab('help')}
            title={collapsed ? `7日 Token: ${fmtTokens(tokenSummary.total_tokens)} (${tokenSummary.call_count} 次 AI 调用)` : undefined}
            className={`w-full flex items-center ${collapsed ? 'justify-center py-2 mb-1' : 'gap-2 px-2 py-1.5 mb-2'} rounded-lg transition-colors ${isDarkMode ? 'bg-slate-700/30 hover:bg-slate-700/50 text-slate-400' : 'bg-amber-50 hover:bg-amber-100 text-amber-700'}`}
          >
            <Zap size={collapsed ? ICON_SIZES.lg : ICON_SIZES.sm} className={isDarkMode ? 'text-amber-400' : 'text-amber-500'} />
            {!collapsed && (
              <div className="flex flex-col items-start min-w-0">
                <span className="text-[10px] font-bold uppercase tracking-wider">7日 Token</span>
                <span className={`text-xs font-mono font-semibold ${isDarkMode ? 'text-amber-300' : 'text-amber-800'}`}>
                  {fmtTokens(tokenSummary.total_tokens)}
                  <span className={`ml-1 text-[10px] font-normal ${isDarkMode ? 'text-slate-500' : 'text-amber-600/70'}`}>({tokenSummary.call_count}次调用)</span>
                </span>
              </div>
            )}
          </button>
        )}


      </div>
    </aside>
  );
};

export default Sidebar;
