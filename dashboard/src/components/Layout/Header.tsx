import React, { useState, useEffect, useRef } from 'react';
import { Search, Plus, RefreshCw, BrainCircuit, Loader2, Cpu, ChevronDown, MessageSquare, Settings, Languages, Sun, Moon } from 'lucide-react';
import api from '../../api';
import { ICON_SIZES } from '../../constants/icons';
import { useGlobalChat } from '../Shared/GlobalChatDrawer';
import { useI18n } from '../../i18n';
import { useTheme } from '../../theme';

interface AiProvider {
  id: string;
  label: string;
  defaultModel: string;
}

interface HeaderProps {
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  setShowCreateModal: (show: boolean) => void;
  handleSyncSnippets: () => void;
  aiConfig?: { provider: string; model: string };
  llmReady?: boolean;
  onOpenLlmConfig?: () => void;
  onSemanticSearchResults?: (results: any[]) => void;
  onBeforeAiSwitch?: () => void;
  onAiConfigChange?: () => void;
}

const Header: React.FC<HeaderProps> = ({ searchQuery, setSearchQuery, setShowCreateModal, handleSyncSnippets, aiConfig, llmReady = true, onOpenLlmConfig, onSemanticSearchResults, onBeforeAiSwitch, onAiConfigChange }) => {
  const { toggle: toggleChat, isOpen: chatOpen } = useGlobalChat();
  const { t, lang, setLang } = useI18n();
  const { isDark: isDarkMode, toggle: toggleTheme } = useTheme();
  const [isSemanticSearching, setIsSemanticSearching] = useState(false);
  const [aiDropdownOpen, setAiDropdownOpen] = useState(false);
  const [aiProviders, setAiProviders] = useState<AiProvider[]>([]);
  const [aiSwitching, setAiSwitching] = useState(false);
  const aiDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
  if (aiDropdownOpen && aiProviders.length === 0) {
    api.getAiProviders().then((providers) => setAiProviders(providers)).catch(() => {});
  }
  }, [aiDropdownOpen, aiProviders.length]);

  useEffect(() => {
  const close = (e: MouseEvent) => {
    if (aiDropdownRef.current && !aiDropdownRef.current.contains(e.target as Node)) setAiDropdownOpen(false);
  };
  document.addEventListener('click', close);
  return () => document.removeEventListener('click', close);
  }, []);

  const handleSemanticSearch = async () => {
  if (!searchQuery) return;
  setIsSemanticSearching(true);
  try {
    const data = await api.search(searchQuery, { mode: 'semantic' });
    const results = (data.items || []).map((r: any) => ({
      name: (r.title || r.name || '') + '.md',
      content: r.content?.pattern || r.content?.markdown || r.content?.code || '',
      similarity: r.score || 0,
      metadata: { type: 'recipe', name: (r.title || r.name || '') + '.md' },
    }));
    if (onSemanticSearchResults) onSemanticSearchResults(results);
  } catch (e) {
    console.error('Semantic search failed', e);
    alert(t('header.semanticSearchFailed'));
  } finally {
    setIsSemanticSearching(false);
  }
  };

  const handleSelectAi = async (provider: AiProvider) => {
  setAiSwitching(true);
  try {
    onBeforeAiSwitch?.();
    await api.setAiConfig(provider.id, provider.defaultModel);
    setAiDropdownOpen(false);
    if (onAiConfigChange) onAiConfigChange();
  } catch (e) {
    console.error('AI config update failed', e);
    alert(t('header.aiSwitchFailed'));
  } finally {
    setAiSwitching(false);
  }
  };

  return (
  <header className={`h-16 ${isDarkMode ? 'bg-[#252526] border-b border-[#3e3e42]' : 'bg-white border-b border-slate-200'} flex items-center justify-between px-4 xl:px-6 2xl:px-8 shrink-0 gap-3`}>
    <div className="flex items-center gap-2 xl:gap-3 2xl:gap-4 min-w-0 flex-1">
    <div className="relative w-40 xl:w-60 2xl:w-80 min-w-[10rem] shrink">
      <Search className={`absolute left-3 top-1/2 -translate-y-1/2 ${isDarkMode ? 'text-slate-500' : 'text-slate-400'}`} size={ICON_SIZES.md} />
      <input 
      type="text" 
      placeholder={t('header.searchPlaceholder')} 
      className={`w-full pl-10 pr-4 py-2 ${isDarkMode ? 'bg-[#1e1e1e] text-slate-300 placeholder-slate-500' : 'bg-slate-100 text-slate-900'} border-transparent rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-500/20 transition-all`} 
      value={searchQuery} 
      onChange={(e) => setSearchQuery(e.target.value)}
      onKeyDown={(e) => e.key === 'Enter' && handleSemanticSearch()}
      />
    </div>
    <button 
      onClick={handleSemanticSearch}
      disabled={!searchQuery || isSemanticSearching}
      className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-bold transition-all ${isSemanticSearching ? (isDarkMode ? 'bg-blue-900/30 text-blue-300' : 'bg-blue-50 text-blue-400') : (isDarkMode ? 'bg-blue-900/30 text-blue-400 hover:bg-blue-900/50' : 'bg-blue-50 text-blue-600 hover:bg-blue-100')}`}
      title={t('header.semanticSearchTitle')}
    >
      {isSemanticSearching ? <Loader2 size={ICON_SIZES.sm} className="animate-spin" /> : <BrainCircuit size={ICON_SIZES.sm} />}
      {t('header.semanticSearch')}
    </button>
    </div>
    <div className="flex items-center gap-1.5 xl:gap-2 2xl:gap-3 shrink-0">
    {!llmReady ? (
      <button
        type="button"
        onClick={onOpenLlmConfig}
        className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors animate-pulse ${isDarkMode ? 'bg-amber-900/30 text-amber-300 border-amber-700 hover:bg-amber-900/50' : 'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100'}`}
        title={t('header.aiNotConfigured')}
      >
        <Settings size={ICON_SIZES.sm} />
        {t('header.configureLlm')}
      </button>
    ) : aiConfig ? (
      <div className="relative" ref={aiDropdownRef}>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setAiDropdownOpen((v) => !v); }}
        className={`flex items-center gap-1.5 px-2 xl:px-3 py-1.5 rounded-lg text-xs font-medium border transition-all duration-150 max-w-[180px] 2xl:max-w-none ${isDarkMode ? 'bg-[#2a2d35] border-[#3e3e42] text-slate-300 hover:border-slate-500 hover:bg-[#333842]' : 'bg-white border-slate-200 text-slate-600 hover:border-slate-300 hover:bg-slate-50'}`}
        title={t('header.clickSwitchAi')}
      >
        <Cpu size={ICON_SIZES.sm} className="shrink-0" />
        <span className="truncate">{aiConfig.provider} / {aiConfig.model}</span>
        <ChevronDown size={ICON_SIZES.xs} className={`shrink-0 ${aiDropdownOpen ? 'rotate-180' : ''}`} />
      </button>
      {aiDropdownOpen && (
        <div className={`absolute top-full right-0 mt-1 py-1 rounded-lg border shadow-lg z-20 min-w-[200px] ${isDarkMode ? 'bg-[#252526] border-[#3e3e42]' : 'bg-white border-slate-200'}`}>
        <div className={`px-3 py-2 text-xs border-b ${isDarkMode ? 'text-slate-400 border-[#3e3e42]' : 'text-slate-500 border-slate-100'}`}>{t('header.switchAi')}</div>
        <div className={`px-3 py-1.5 text-[11px] border-b ${isDarkMode ? 'text-slate-500 border-[#3e3e42]' : 'text-slate-400 border-slate-100'}`}>
          <button type="button" onClick={() => { setAiDropdownOpen(false); onOpenLlmConfig?.(); }} className="text-blue-500 hover:underline">{t('header.editEnvConfig')}</button>
        </div>
        {aiProviders.length === 0 ? (
          <div className={`px-3 py-2 text-xs ${isDarkMode ? 'text-slate-500' : 'text-slate-400'}`}>{t('common.loading')}</div>
        ) : (
          aiProviders.map((p) => (
          <button
            key={p.id}
            type="button"
            disabled={aiSwitching}
            onClick={() => handleSelectAi(p)}
            className={`w-full text-left px-3 py-2 text-sm flex items-center justify-between ${aiConfig.provider === p.id ? (isDarkMode ? 'bg-blue-900/30 text-blue-400 font-medium' : 'bg-blue-50 text-blue-700 font-medium') : (isDarkMode ? 'text-slate-300 hover:bg-slate-700/50' : 'text-slate-700 hover:bg-slate-50')}`}
          >
            <span>{p.label}</span>
            {aiConfig.provider === p.id && <span className="text-xs">✓</span>}
          </button>
          ))
        )}
        </div>
      )}
      </div>
    ) : null}
    <button
      onClick={toggleChat}
      className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium border transition-all duration-150 ${
        chatOpen
          ? isDarkMode
            ? 'bg-blue-500/20 border-blue-500/40 text-blue-300 ring-1 ring-blue-500/30 hover:border-blue-400/60 hover:bg-blue-500/30'
            : 'bg-blue-50 border-blue-300 text-blue-700 ring-1 ring-blue-200 hover:border-blue-400 hover:bg-blue-100'
          : isDarkMode
            ? 'bg-[#2a2d35] border-[#3e3e42] text-slate-300 hover:border-slate-500 hover:bg-[#333842]'
            : 'bg-white border-slate-200 text-slate-600 hover:border-slate-300 hover:bg-slate-50'
      }`}
      title={chatOpen ? t('header.closeAiChat') : t('header.openAiChat')}
    >
      <MessageSquare size={ICON_SIZES.sm} />
      {!chatOpen && <span className="text-xs">{t('header.aiChat')}</span>}
    </button>
    <button onClick={() => setShowCreateModal(true)} className={`flex items-center gap-1.5 px-2.5 xl:px-3 2xl:px-4 py-2 rounded-lg text-xs xl:text-sm font-medium transition-all duration-150 border whitespace-nowrap ${isDarkMode ? 'bg-[#2a2d35] border-[#3e3e42] text-slate-300 hover:border-slate-500 hover:bg-[#333842]' : 'bg-white border-slate-200 text-slate-600 hover:border-slate-300 hover:bg-slate-50'}`} title={t('header.newRecipe')}>
      <Plus size={ICON_SIZES.md} /> <span className="hidden xl:inline">{t('header.newRecipe')}</span>
    </button>
    <button onClick={handleSyncSnippets} className={`flex items-center gap-1.5 px-2.5 xl:px-3 2xl:px-4 py-2 rounded-lg text-xs xl:text-sm font-medium transition-all duration-150 border whitespace-nowrap ${isDarkMode ? 'bg-blue-500/20 border-blue-500/40 text-blue-300 hover:border-blue-400/60 hover:bg-blue-500/30' : 'bg-blue-50 border-blue-300 text-blue-600 hover:border-blue-400 hover:bg-blue-100'}`} title={t('header.syncSnippets')}>
      <RefreshCw size={ICON_SIZES.md} /> <span className="hidden xl:inline">{t('header.syncSnippets')}</span>
    </button>
    <button
      onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')}
      className={`flex items-center gap-1 px-2 xl:px-3 py-2 rounded-lg text-xs font-medium border transition-all duration-150 ${isDarkMode ? 'bg-[#2a2d35] border-[#3e3e42] text-slate-300 hover:border-slate-500 hover:bg-[#333842]' : 'bg-white border-slate-200 text-slate-600 hover:border-slate-300 hover:bg-slate-50'}`}
      title={lang === 'zh' ? 'Switch to English' : t('shared.switchToChinese')}
    >
      <Languages size={ICON_SIZES.sm} />
      <span className="hidden 2xl:inline">{t('header.langSwitch')}</span>
    </button>
    <button
      onClick={toggleTheme}
      className={`flex items-center p-2 rounded-lg border transition-all duration-150 ${isDarkMode ? 'bg-[#2a2d35] border-[#3e3e42] text-amber-300 hover:border-slate-500 hover:bg-[#333842]' : 'bg-white border-slate-200 text-slate-600 hover:border-slate-300 hover:bg-slate-50'}`}
      title={isDarkMode ? 'Light mode' : 'Dark mode'}
    >
      {isDarkMode ? <Sun size={ICON_SIZES.sm} /> : <Moon size={ICON_SIZES.sm} />}
    </button>
    </div>
  </header>
  );
};

export default Header;
