import { Globe, Layout, Cpu, Zap, Database, Wifi, HardDrive, Box, Layers, Hash, GitBranch, Shield, BookOpen, Workflow, Cog, Brain, ScanSearch, Library } from 'lucide-react';

/** Bootstrap 维度分类 tab 显示名（合并后的展示分组） */
export const BOOTSTRAP_DIM_LABELS: Record<string, string> = {
  'architecture': '架构与设计',
  'best-practice': '规范与实践',
  'event-and-data-flow': '事件与数据流',
  'objc-deep-scan': '深度扫描',
  'agent-guidelines': 'Agent 注意事项',
  'bootstrap': 'Bootstrap',
  // 旧维度 ID 回退（兼容已有数据）
  'code-standard': '代码规范',
  'code-pattern': '设计模式',
  'project-profile': '项目特征',
  'category-scan': 'Category 分类方法',
};

export const categoryConfigs: Record<string, { icon: any, color: string, bg: string, border: string }> = {
  All: { icon: Globe, color: 'text-slate-600', bg: 'bg-slate-100', border: 'border-slate-200' },
  View: { icon: Layout, color: 'text-pink-600', bg: 'bg-pink-50', border: 'border-pink-100' },
  Service: { icon: Cpu, color: 'text-indigo-600', bg: 'bg-indigo-50', border: 'border-indigo-100' },
  Tool: { icon: Zap, color: 'text-amber-600', bg: 'bg-amber-50', border: 'border-amber-100' },
  Model: { icon: Database, color: 'text-emerald-600', bg: 'bg-emerald-50', border: 'border-emerald-100' },
  Network: { icon: Wifi, color: 'text-blue-600', bg: 'bg-blue-50', border: 'border-blue-100' },
  Storage: { icon: HardDrive, color: 'text-purple-600', bg: 'bg-purple-50', border: 'border-purple-100' },
  UI: { icon: Box, color: 'text-cyan-600', bg: 'bg-cyan-50', border: 'border-cyan-100' },
  Utility: { icon: Layers, color: 'text-orange-600', bg: 'bg-orange-50', border: 'border-orange-100' },
  // Bootstrap 维度分类
  'code-standard': { icon: BookOpen, color: 'text-violet-600', bg: 'bg-violet-50', border: 'border-violet-100' },
  'code-pattern': { icon: GitBranch, color: 'text-fuchsia-600', bg: 'bg-fuchsia-50', border: 'border-fuchsia-100' },
  'architecture': { icon: Workflow, color: 'text-sky-600', bg: 'bg-sky-50', border: 'border-sky-100' },
  'best-practice': { icon: Shield, color: 'text-emerald-600', bg: 'bg-emerald-50', border: 'border-emerald-100' },
  'event-and-data-flow': { icon: Cog, color: 'text-amber-600', bg: 'bg-amber-50', border: 'border-amber-100' },
  'project-profile': { icon: Hash, color: 'text-teal-600', bg: 'bg-teal-50', border: 'border-teal-100' },
  'agent-guidelines': { icon: Brain, color: 'text-rose-600', bg: 'bg-rose-50', border: 'border-rose-100' },
  'objc-deep-scan': { icon: ScanSearch, color: 'text-indigo-600', bg: 'bg-indigo-50', border: 'border-indigo-100' },
  'category-scan': { icon: Library, color: 'text-cyan-600', bg: 'bg-cyan-50', border: 'border-cyan-100' },
  'bootstrap': { icon: Zap, color: 'text-violet-600', bg: 'bg-violet-50', border: 'border-violet-100' },
};

export const categories = ['All', 'View', 'Service', 'Tool', 'Model', 'Network', 'Storage', 'UI', 'Utility'];

export const validTabs = ['recipes', 'ai', 'spm', 'candidates', 'knowledge', 'depgraph', 'knowledgegraph', 'guard', 'skills', 'wiki', 'editor', 'help'] as const;
export type TabType = typeof validTabs[number];

/** GitHub 提交问题入口（Guard 误报、规则建议等） */
export const GITHUB_ISSUES_URL = 'https://github.com/GxFn/AutoSnippet/issues';
export const GITHUB_ISSUES_NEW_GUARD_URL = 'https://github.com/GxFn/AutoSnippet/issues/new?title=Guard%20误报%2F建议%3A%20&body=请描述误报的规则ID、代码片段或改进建议。';
