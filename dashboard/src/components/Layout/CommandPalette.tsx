import React, { useEffect, useState, useCallback } from 'react';
import { Plus, Settings, FileText, Bookmark, FolderOpen, Clock, Library, GitBranch, Share2, Shield, Layers, BookOpen, MessageSquare, HelpCircle, BrainCircuit } from 'lucide-react';
import { Dialog, DialogContent } from '../ui/Dialog';
import { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem, CommandSeparator, CommandShortcut } from '../ui/Command';
import { TabType } from '../../constants';
import { useI18n } from '../../i18n';
import api from '../../api';

/** Tab → i18n label key */
const TAB_ICON_MAP: Record<TabType, React.ElementType> = {
  recipes: Bookmark,
  spm: FolderOpen,
  candidates: Clock,
  knowledge: Library,
  depgraph: GitBranch,
  knowledgegraph: Share2,
  guard: Shield,
  panorama: Layers,
  skills: BookOpen,
  wiki: FileText,
  ai: MessageSquare,
  help: HelpCircle,
};

const TAB_LABEL_MAP: Record<TabType, string> = {
  recipes: 'sidebar.recipes',
  spm: 'sidebar.moduleExplorer',
  candidates: 'sidebar.candidates',
  knowledge: 'sidebar.batchManage',
  depgraph: 'sidebar.depGraph',
  knowledgegraph: 'sidebar.knowledgeGraph',
  guard: 'sidebar.guard',
  panorama: 'sidebar.panorama',
  skills: 'sidebar.skills',
  wiki: 'sidebar.repoWiki',
  ai: 'sidebar.aiAssistant',
  help: 'sidebar.help',
};

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  navigateToTab: (tab: TabType) => void;
  setShowCreateModal: (show: boolean) => void;
  onSemanticSearch?: (query: string) => void;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  onOpenLlmConfig?: () => void;
  candidateCount?: number;
}

const CommandPalette: React.FC<CommandPaletteProps> = ({
  open, onOpenChange,
  navigateToTab,
  setShowCreateModal,
  onSemanticSearch,
  searchQuery, setSearchQuery,
  onOpenLlmConfig,
  candidateCount = 0,
}) => {
  const { t } = useI18n();
  const [recentRecipes, setRecentRecipes] = useState<Array<{ name: string; title: string }>>([]);

  /* 打开时加载最近 recipes */
  useEffect(() => {
    if (open && recentRecipes.length === 0) {
      api.fetchData()
        .then((data: any) => {
          const items = data?.recipes || [];
          setRecentRecipes(
            items.slice(0, 5).map((r: any) => ({
              name: r.name || r.title,
              title: r.title || r.name,
            }))
          );
        })
        .catch(() => { /* intentionally ignored: recent recipes are a non-critical hint */ });
    }
  }, [open]);

  /* 全局 ⌘K 快捷键 */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onOpenChange]);

  const runAndClose = useCallback((fn: () => void) => {
    fn();
    onOpenChange(false);
  }, [onOpenChange]);

  const tabs = Object.keys(TAB_LABEL_MAP) as TabType[];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="md"
        hideClose
        className="!p-0 !top-[15vh] !translate-y-0 overflow-hidden"
        style={{ backgroundColor: 'var(--bg-root)' }}
      >
        <Command className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-[var(--fg-subtle)] [&_[cmdk-item]]:px-3 [&_[cmdk-item]]:py-2.5">
          <CommandInput
            placeholder={t('commandPalette.searchPlaceholder') || '搜索知识、命令、页面...'}
            value={searchQuery}
            onValueChange={setSearchQuery}
          />
          <CommandList className="max-h-[360px]">
            <CommandEmpty>{t('commandPalette.noResults') || '没有找到结果'}</CommandEmpty>

            {/* 最近访问 */}
            {recentRecipes.length > 0 && (
              <CommandGroup heading={t('commandPalette.recent') || '最近'}>
                {recentRecipes.map((r) => (
                  <CommandItem
                    key={r.name}
                    value={r.title}
                    onSelect={() => runAndClose(() => {
                      navigateToTab('recipes');
                      setSearchQuery(r.title);
                    })}
                  >
                    <FileText className="mr-2 h-4 w-4 text-[var(--fg-subtle)]" />
                    <span>{r.title}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            <CommandSeparator />

            {/* 页面导航 */}
            <CommandGroup heading={t('commandPalette.pages') || '页面'}>
              {tabs.map((tab) => {
                const Icon = TAB_ICON_MAP[tab];
                const labelParams = tab === 'candidates' ? { count: candidateCount } : undefined;
                return (
                  <CommandItem
                    key={tab}
                    value={t(TAB_LABEL_MAP[tab], labelParams)}
                    onSelect={() => runAndClose(() => navigateToTab(tab))}
                  >
                    <Icon className="mr-2 h-4 w-4 text-[var(--fg-subtle)]" />
                    <span>{t(TAB_LABEL_MAP[tab], labelParams)}</span>
                  </CommandItem>
                );
              })}
            </CommandGroup>

            <CommandSeparator />

            {/* 命令 */}
            <CommandGroup heading={t('commandPalette.commands') || '命令'}>
              <CommandItem
                value="new recipe"
                onSelect={() => runAndClose(() => setShowCreateModal(true))}
              >
                <Plus className="mr-2 h-4 w-4 text-[var(--fg-subtle)]" />
                <span>{t('header.newRecipe')}</span>
                <CommandShortcut>⌘N</CommandShortcut>
              </CommandItem>
              {onSemanticSearch && (
                <CommandItem
                  value="semantic search"
                  onSelect={() => runAndClose(() => onSemanticSearch(searchQuery))}
                >
                  <BrainCircuit className="mr-2 h-4 w-4 text-[var(--fg-subtle)]" />
                  <span>{t('header.semanticSearch')}</span>
                  <CommandShortcut>⌘⇧F</CommandShortcut>
                </CommandItem>
              )}
              {onOpenLlmConfig && (
                <CommandItem
                  value="llm config"
                  onSelect={() => runAndClose(() => onOpenLlmConfig())}
                >
                  <Settings className="mr-2 h-4 w-4 text-[var(--fg-subtle)]" />
                  <span>{t('header.configureLlm')}</span>
                </CommandItem>
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
};

export default CommandPalette;
