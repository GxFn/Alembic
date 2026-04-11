import React from 'react';
import { BadgeCheck, Boxes, Inbox, Shield, MessageSquare, HelpCircle, LogOut, User, Moon, Sun, Library, ScrollText, BookOpen, Languages, Layers, Radio } from 'lucide-react';
import { TabType } from '../../constants';
import { useI18n } from '../../i18n';
import { useTheme } from '../../theme';
import { cn } from '../../lib/utils';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '../ui/Tooltip';

interface SidebarProps {
  activeTab: TabType;
  navigateToTab: (tab: TabType, options?: { preserveSearch?: boolean }) => void;
  candidateCount: number;
  signalSuggestionCount?: number;
  currentUser?: string;
  currentRole?: string;
  permissionMode?: string;
  onLogout?: () => void;
  projectName?: string;
  /** @deprecated 永远为图标模式，保留参数兼容 */
  collapsed?: boolean;
  /** @deprecated 永远为图标模式 */
  onToggleCollapse?: () => void;
}

interface NavItem {
  tab: TabType;
  icon: React.ElementType;
  label: string;
  badge?: number | string;
}

/** 60px icon-only nav item with tooltip */
function NavButton({
  item, active, onClick,
}: {
  item: NavItem;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          className={cn(
            "relative flex items-center justify-center w-10 h-10 rounded-[var(--radius-md)] transition-all duration-200",
            active
              ? "bg-[var(--accent)] text-white shadow-[0_0_16px_var(--accent-glow)]"
              : "text-[var(--fg-subtle)] hover:bg-[var(--bg-muted)]/60 hover:text-[var(--fg-default)]"
          )}
        >
          <item.icon size={18} className="shrink-0" />
          {/* 小圆点 badge */}
          {item.badge != null && (
            <span className="absolute -top-0.5 -right-0.5 flex h-2.5 w-2.5 items-center justify-center">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[var(--warning)] opacity-40" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-[var(--warning)]" />
            </span>
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" className="flex items-center gap-1.5">
        <span>{item.label}</span>
      </TooltipContent>
    </Tooltip>
  );
}

const Sidebar: React.FC<SidebarProps> = ({
  activeTab, navigateToTab, candidateCount,
  signalSuggestionCount = 0,
  currentUser, onLogout,
}) => {
  const { t, lang, setLang } = useI18n();
  const { isDark, toggle: toggleTheme } = useTheme();

  const navItems: NavItem[] = [
    /* ── 知识核心：生命周期 ── */
    { tab: 'recipes', icon: BadgeCheck, label: t('sidebar.recipes') },
    { tab: 'candidates', icon: Inbox, label: t('sidebar.candidates', { count: candidateCount }) },
    { tab: 'knowledge', icon: Library, label: t('sidebar.batchManage') },
    /* ── 项目探索 ── */
    { tab: 'panorama', icon: Layers, label: t('sidebar.panorama') },
    { tab: 'spm', icon: Boxes, label: t('sidebar.moduleExplorer') },
    /* ── 质量治理 ── */
    { tab: 'guard', icon: Shield, label: t('sidebar.guard') },
    { tab: 'skills', icon: ScrollText, label: t('sidebar.skills'), badge: signalSuggestionCount > 0 ? signalSuggestionCount : undefined },
    /* ── 参考 & 监控 ── */
    { tab: 'wiki', icon: BookOpen, label: t('sidebar.repoWiki') },
    { tab: 'signals', icon: Radio, label: 'Signals' },
    /* ── 辅助 ── */
    { tab: 'ai', icon: MessageSquare, label: t('sidebar.aiAssistant') },
    { tab: 'help', icon: HelpCircle, label: t('sidebar.help') },
  ];

  /* 分组：主导航与辅助导航 (AI + Help) */
  const mainNav = navItems.slice(0, navItems.length - 2);
  const auxNav = navItems.slice(navItems.length - 2);

  return (
    <TooltipProvider>
      <aside
        className="w-[var(--sidebar-width)] flex flex-col shrink-0 glass-surface select-none z-10"
      >
        {/* ── Logo ── */}
        <div className="flex items-center justify-center h-[var(--topbar-height)] border-b border-[var(--border-muted)]">
          <div className="w-9 h-9 rounded-[var(--radius-md)] flex items-center justify-center text-white shadow-[0_0_20px_var(--accent-glow)]" style={{ background: 'var(--accent-gradient)' }}>
            <span className="text-[11px] font-black italic tracking-tighter leading-none">AS</span>
          </div>
        </div>

        {/* ── 主导航 ── */}
        <nav className="flex-1 flex flex-col items-center gap-1 py-3 overflow-y-auto scrollbar-hidden">
          {mainNav.map((item) => (
            <NavButton
              key={item.tab}
              item={item}
              active={activeTab === item.tab}
              onClick={() => navigateToTab(item.tab)}
            />
          ))}

          {/* 分割线 */}
          <div className="w-6 separator-gradient my-2" />

          {auxNav.map((item) => (
            <NavButton
              key={item.tab}
              item={item}
              active={activeTab === item.tab}
              onClick={() => navigateToTab(item.tab)}
            />
          ))}
        </nav>

        {/* ── 底部工具区 ── */}
        <div className="flex flex-col items-center gap-1 py-3 border-t border-[var(--border-muted)]">
          {/* 语言切换 */}
          <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
              <button
                onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')}
                className="flex items-center justify-center w-10 h-10 rounded-[var(--radius-md)] text-[var(--fg-subtle)] hover:bg-[var(--bg-muted)] hover:text-[var(--fg-default)] transition-colors"
              >
                <Languages size={18} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">{t('header.langSwitch')}</TooltipContent>
          </Tooltip>

          {/* 主题切换 */}
          <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
              <button
                onClick={toggleTheme}
                className="flex items-center justify-center w-10 h-10 rounded-[var(--radius-md)] text-[var(--fg-subtle)] hover:bg-[var(--bg-muted)] hover:text-[var(--fg-default)] transition-colors"
              >
                {isDark ? <Sun size={18} /> : <Moon size={18} />}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              {isDark ? t('header.lightMode') : t('header.darkMode')}
            </TooltipContent>
          </Tooltip>

          {/* 用户/登出 */}
          {currentUser && (
            <Tooltip delayDuration={300}>
              <TooltipTrigger asChild>
                <button
                  onClick={onLogout}
                  className="flex items-center justify-center w-10 h-10 rounded-[var(--radius-md)] text-[var(--fg-subtle)] hover:bg-[var(--bg-muted)] hover:text-[var(--danger)] transition-colors"
                >
                  <User size={18} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right" className="flex items-center gap-2">
                <span>{currentUser}</span>
                {onLogout && (
                  <>
                    <span className="text-[var(--fg-subtle)]">·</span>
                    <span className="flex items-center gap-1 text-[var(--danger)]">
                      <LogOut size={12} />{t('sidebar.logout')}
                    </span>
                  </>
                )}
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </aside>
    </TooltipProvider>
  );
};

export default Sidebar;
