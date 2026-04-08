import { Globe, Layout, Cpu, Zap, Database, Wifi, HardDrive, Box, Layers, Hash, GitBranch, Shield, BookOpen, Workflow, Cog, Brain, ScanSearch, Lock, Gauge, Eye, TestTube, Activity, Server, Puzzle, FileCode, Binary, Gem, Palette, Leaf, Flame } from 'lucide-react';

/** Bootstrap 维度分类 tab 显示名（合并后的展示分组） */
export const BOOTSTRAP_DIM_LABELS: Record<string, string> = {
  'architecture': '架构与设计',
  'best-practice': '规范与实践',
  'data-event-flow': '数据与并发',
  'deep-scan': '语言深度扫描',
  'bootstrap': 'Bootstrap',
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
  // ── 新统一维度 Layer 1 ──
  'architecture': { icon: Workflow, color: 'text-sky-600', bg: 'bg-sky-50', border: 'border-sky-100' },
  'coding-standards': { icon: BookOpen, color: 'text-violet-600', bg: 'bg-violet-50', border: 'border-violet-100' },
  'design-patterns': { icon: GitBranch, color: 'text-fuchsia-600', bg: 'bg-fuchsia-50', border: 'border-fuchsia-100' },
  'error-resilience': { icon: Shield, color: 'text-emerald-600', bg: 'bg-emerald-50', border: 'border-emerald-100' },
  'concurrency-async': { icon: Activity, color: 'text-rose-600', bg: 'bg-rose-50', border: 'border-rose-100' },
  'data-event-flow': { icon: Cog, color: 'text-amber-600', bg: 'bg-amber-50', border: 'border-amber-100' },
  'networking-api': { icon: Wifi, color: 'text-blue-600', bg: 'bg-blue-50', border: 'border-blue-100' },
  'ui-interaction': { icon: Layout, color: 'text-pink-600', bg: 'bg-pink-50', border: 'border-pink-100' },
  'testing-quality': { icon: TestTube, color: 'text-lime-600', bg: 'bg-lime-50', border: 'border-lime-100' },
  'security-auth': { icon: Lock, color: 'text-red-600', bg: 'bg-red-50', border: 'border-red-100' },
  'performance-optimization': { icon: Gauge, color: 'text-orange-600', bg: 'bg-orange-50', border: 'border-orange-100' },
  'observability-logging': { icon: Eye, color: 'text-teal-600', bg: 'bg-teal-50', border: 'border-teal-100' },
  'agent-guidelines': { icon: Brain, color: 'text-rose-600', bg: 'bg-rose-50', border: 'border-rose-100' },
  // ── 新统一维度 Layer 2 ──
  'swift-objc-idiom': { icon: ScanSearch, color: 'text-indigo-600', bg: 'bg-indigo-50', border: 'border-indigo-100' },
  'ts-js-module': { icon: FileCode, color: 'text-yellow-600', bg: 'bg-yellow-50', border: 'border-yellow-100' },
  'python-structure': { icon: Server, color: 'text-green-600', bg: 'bg-green-50', border: 'border-green-100' },
  'jvm-annotation': { icon: Hash, color: 'text-orange-600', bg: 'bg-orange-50', border: 'border-orange-100' },
  'go-module': { icon: Binary, color: 'text-cyan-600', bg: 'bg-cyan-50', border: 'border-cyan-100' },
  'rust-ownership': { icon: Gem, color: 'text-amber-600', bg: 'bg-amber-50', border: 'border-amber-100' },
  'csharp-dotnet': { icon: Puzzle, color: 'text-purple-600', bg: 'bg-purple-50', border: 'border-purple-100' },
  // ── 新统一维度 Layer 3 ──
  'react-patterns': { icon: Palette, color: 'text-sky-600', bg: 'bg-sky-50', border: 'border-sky-100' },
  'vue-patterns': { icon: Leaf, color: 'text-emerald-600', bg: 'bg-emerald-50', border: 'border-emerald-100' },
  'spring-patterns': { icon: Flame, color: 'text-lime-600', bg: 'bg-lime-50', border: 'border-lime-100' },
  'swiftui-patterns': { icon: Layout, color: 'text-blue-600', bg: 'bg-blue-50', border: 'border-blue-100' },
  'django-fastapi': { icon: Server, color: 'text-green-600', bg: 'bg-green-50', border: 'border-green-100' },
  'bootstrap': { icon: Zap, color: 'text-violet-600', bg: 'bg-violet-50', border: 'border-violet-100' },
};

export const categories = ['All', 'View', 'Service', 'Tool', 'Model', 'Network', 'Storage', 'UI', 'Utility'];

export const validTabs = ['recipes', 'ai', 'spm', 'candidates', 'knowledge', 'guard', 'panorama', 'skills', 'wiki', 'signals', 'help'] as const;
export type TabType = typeof validTabs[number];

/** ═══ 多语言支持 ═══ */

/** 语言选项（UI 下拉 / 切换器用） */
export interface LanguageOption {
  id: string;        // 规范化 ID（与后端 LanguageService 一致）
  label: string;     // 显示名
  aliases?: string[]; // 归一化别名
}

export const LANGUAGE_OPTIONS: LanguageOption[] = [
  { id: 'swift',       label: 'Swift' },
  { id: 'objectivec',  label: 'ObjC',       aliases: ['objc', 'objective-c', 'obj-c'] },
  { id: 'go',          label: 'Go' },
  { id: 'javascript',  label: 'JavaScript',  aliases: ['js'] },
  { id: 'typescript',  label: 'TypeScript',  aliases: ['ts'] },
  { id: 'python',      label: 'Python',      aliases: ['py'] },
  { id: 'java',        label: 'Java' },
  { id: 'kotlin',      label: 'Kotlin',      aliases: ['kt'] },
  { id: 'rust',        label: 'Rust',        aliases: ['rs'] },
  { id: 'dart',        label: 'Dart' },
  { id: 'c',           label: 'C' },
  { id: 'cpp',         label: 'C++',         aliases: ['c++'] },
  { id: 'csharp',      label: 'C#',          aliases: ['cs'] },
  { id: 'ruby',        label: 'Ruby',        aliases: ['rb'] },
];

/**
 * 归一化语言 ID：将别名映射为规范 ID
 * e.g. 'objc' → 'objectivec', 'ts' → 'typescript'
 */
export function normalizeLanguageId(raw?: string): string {
  if (!raw) return '';
  const lower = raw.toLowerCase().trim();
  for (const opt of LANGUAGE_OPTIONS) {
    if (opt.id === lower) return opt.id;
    if (opt.aliases?.includes(lower)) return opt.id;
  }
  return lower; // 未知语言原样返回
}

/** 获取语言显示名 */
export function languageDisplayName(langId?: string): string {
  if (!langId) return '';
  const norm = normalizeLanguageId(langId);
  const opt = LANGUAGE_OPTIONS.find(o => o.id === norm);
  return opt?.label ?? langId;
}

/** 获取用于代码高亮的 Prism 语言名 */
export function codeHighlightLanguage(langId?: string): string {
  const norm = normalizeLanguageId(langId);
  // Prism 对 ObjC 使用 'objectivec'
  if (norm === 'objectivec') return 'objectivec';
  if (norm === 'cpp') return 'cpp';
  if (norm === 'csharp') return 'csharp';
  return norm || 'text';
}

/** 获取语言对应的 import/header 占位符模板 */
export function importPlaceholder(langId?: string): string {
  const norm = normalizeLanguageId(langId);
  switch (norm) {
    case 'objectivec': return '#import <Module/Header.h>';
    case 'swift':      return 'import ModuleName';
    case 'go':         return 'import "package/path"';
    case 'python':     return 'import module_name';
    case 'java':
    case 'kotlin':     return 'import com.example.ClassName';
    case 'javascript':
    case 'typescript': return "import { name } from 'module'";
    case 'rust':       return 'use crate::module::name;';
    case 'dart':       return "import 'package:name/name.dart';";
    case 'csharp':     return 'using Namespace.Name;';
    case 'ruby':       return "require 'module_name'";
    case 'c':
    case 'cpp':        return '#include <header.h>';
    default:           return 'import module';
  }
}

/** GitHub 提交问题入口（Guard 误报、规则建议等） */
export const GITHUB_ISSUES_URL = 'https://github.com/GxFn/AutoSnippet/issues';
export const GITHUB_ISSUES_NEW_GUARD_URL = 'https://github.com/GxFn/AutoSnippet/issues/new?title=Guard%20误报%2F建议%3A%20&body=请描述误报的规则ID、代码片段或改进建议。';
