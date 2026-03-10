/**
 * WikiUtils.js — Wiki 生成器工具函数
 *
 * 从 WikiGenerator.js 中提取的纯工具/辅助函数，无 class 依赖。
 *
 * @module WikiUtils
 */

import fs from 'node:fs';
import path from 'node:path';
import Logger from '../../infrastructure/logging/Logger.js';
import { LanguageService } from '../../shared/LanguageService.js';
import { DEFAULT_KNOWLEDGE_BASE_DIR } from '../../shared/ProjectMarkers.js';

const logger = Logger.getInstance();

// ─── 工具函数 ────────────────────────────────────────────────

/** 文本 slug 化 */
export function slug(name: string) {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
}

/** Mermaid 安全 ID */
export function mermaidId(name: string) {
  return name.replace(/[^a-zA-Z0-9]/g, '_');
}

/** 遍历目录（排除 build/Pods/DerivedData 等） */
export function walkDir(dir: string, callback: (filePath: string) => void, maxFiles = 500) {
  const excludeNames = new Set([
    'Pods',
    'Carthage',
    'node_modules',
    '.build',
    'build',
    'DerivedData',
    'vendor',
    '.git',
    '__tests__',
    'Tests',
    DEFAULT_KNOWLEDGE_BASE_DIR,
    '.cursor',
  ]);
  let count = 0;

  const walk = (d: string) => {
    if (count >= maxFiles) {
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (count >= maxFiles) {
        return;
      }
      if (excludeNames.has(entry.name)) {
        continue;
      }
      if (entry.name.startsWith('.')) {
        continue;
      }

      const fullPath = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        callback(fullPath);
        count++;
      }
    }
  };

  walk(dir);
}

/**
 * 从文件相对路径推断所属模块名
 * 支持多种项目结构约定:
 *   SPM:     Sources/{ModuleName}/...
 *   Node.js: packages/{name}/... | src/{name}/... | lib/{name}/...
 *   Go:      pkg/{name}/... | internal/{name}/... | cmd/{name}/...
 *   Rust:    crates/{name}/... | src/ (单 crate)
 *   Python:  src/{name}/... | {name}/ (顶层包)
 *   Java/Kt: src/main/java/{pkg}/... (取第一个包段)
 *   Dart:    lib/{name}/...
 *
 * 兜底: 取第一级目录名
 */
export function inferModuleFromPath(filePath: string) {
  const parts = filePath.split('/');

  // SPM: Sources/{Module}/...
  const sourcesIdx = parts.indexOf('Sources');
  if (sourcesIdx >= 0 && sourcesIdx + 1 < parts.length) {
    return parts[sourcesIdx + 1];
  }

  // Node.js monorepo: packages/{name}/... | apps/{name}/...
  for (const dir of ['packages', 'apps', 'modules']) {
    const idx = parts.indexOf(dir);
    if (idx >= 0 && idx + 1 < parts.length) {
      return parts[idx + 1];
    }
  }

  // Go: pkg/{name}/... | internal/{name}/... | cmd/{name}/...
  for (const dir of ['pkg', 'internal', 'cmd']) {
    const idx = parts.indexOf(dir);
    if (idx >= 0 && idx + 1 < parts.length) {
      return parts[idx + 1];
    }
  }

  // Rust: crates/{name}/...
  const cratesIdx = parts.indexOf('crates');
  if (cratesIdx >= 0 && cratesIdx + 1 < parts.length) {
    return parts[cratesIdx + 1];
  }

  // Java/Kotlin: src/main/java/{pkg}/... → 跳过域名前缀，取最后一个有意义的包目录
  //   例: src/main/java/org/springframework/samples/petclinic/vet/Vet.java → "vet"
  //   例: src/main/java/com/example/demo/DemoApp.java → "demo"
  for (const langDir of ['java', 'kotlin']) {
    const langIdx = parts.indexOf(langDir);
    if (langIdx >= 0 && langIdx + 1 < parts.length) {
      // 文件名所在目录（倒数第二个 part）才是 "模块"
      const pkgParts = parts.slice(langIdx + 1, parts.length - 1); // 包路径（不含文件名）
      if (pkgParts.length >= 2) {
        // 从尾部取: 最后一个包段即为功能模块
        return pkgParts[pkgParts.length - 1];
      }
      if (pkgParts.length === 1) {
        return pkgParts[0];
      }
      // 只有文件直接在 java/ 下
      return parts[langIdx + 1];
    }
  }

  // Generic: src/{name}/... | lib/{name}/... (至少 3 层深时)
  for (const dir of ['src', 'lib']) {
    const idx = parts.indexOf(dir);
    if (idx >= 0 && idx + 1 < parts.length && parts.length > idx + 2) {
      return parts[idx + 1];
    }
  }

  // 兜底: 取第一级目录名
  return parts.length > 1 ? parts[0] : null;
}

/**
 * 获取某个 Target 对应的源文件列表
 * 按优先级匹配: target.path → target.info.path → sourceFilesByModule[name]
 */
export function getModuleSourceFiles(
  target: { name: string; path?: string; info?: { path?: string } },
  projectInfo: { sourceFilesByModule?: Record<string, string[]>; sourceFiles?: string[] }
) {
  const sfm = projectInfo.sourceFilesByModule || {};
  const name = target.name;

  // 1. 按模块名直接匹配（最常见: Sources/{name}/ 解析出的 key）
  if (sfm[name]?.length > 0) {
    return sfm[name];
  }

  // 2. 通过 target.path 或 target.info.path 匹配
  const targetPath = target.path || target.info?.path;
  if (targetPath) {
    const matched = (projectInfo.sourceFiles || []).filter(
      (f: string) => f.startsWith(`${targetPath}/`) || f.startsWith(targetPath + path.sep)
    );
    if (matched.length > 0) {
      return matched;
    }
  }

  // 3. 大小写不敏感模糊匹配
  const lower = name.toLowerCase();
  for (const [key, files] of Object.entries(sfm)) {
    if (key.toLowerCase() === lower) {
      return files;
    }
  }

  return [];
}

/**
 * 基于模块名称和内容推断模块功能
 * 对常见命名模式做智能推断
 */
export function inferModulePurpose(
  name: string,
  classes: string[],
  protocols: string[],
  files: string[]
) {
  const lower = name.toLowerCase();
  const _fileNames = files.map((f: string) => path.basename(f).toLowerCase());

  // 常见模块功能推断规则
  const rules = [
    {
      match: /network|http|api|client|request|fetch/i,
      zh: '负责网络通信和 API 调用',
      en: 'handles network communication and API calls',
    },
    {
      match: /ui|view|component|widget|screen|page/i,
      zh: '提供用户界面组件',
      en: 'provides user interface components',
    },
    {
      match: /model|entity|domain|data/i,
      zh: '定义数据模型和领域实体',
      en: 'defines data models and domain entities',
    },
    {
      match: /storage|database|cache|persist|core\s*data|realm/i,
      zh: '负责数据持久化和存储',
      en: 'manages data persistence and storage',
    },
    {
      match: /auth|login|session|token|credential/i,
      zh: '处理认证授权和会话管理',
      en: 'handles authentication and session management',
    },
    {
      match: /util|helper|extension|common|shared|foundation/i,
      zh: '提供公共工具类和扩展方法',
      en: 'provides common utilities and extensions',
    },
    { match: /test|spec|mock/i, zh: '包含单元测试和 Mock', en: 'contains unit tests and mocks' },
    {
      match: /router|navigation|coordinator|flow/i,
      zh: '管理页面路由和导航流',
      en: 'manages page routing and navigation flow',
    },
    {
      match: /config|setting|preference|env/i,
      zh: '管理应用配置和环境设置',
      en: 'manages app configuration and environment settings',
    },
    {
      match: /log|analytics|track|monitor/i,
      zh: '提供日志记录和数据分析能力',
      en: 'provides logging and analytics capabilities',
    },
    {
      match: /media|image|video|audio|player/i,
      zh: '处理多媒体资源',
      en: 'handles multimedia resources',
    },
    {
      match: /service|manager|provider/i,
      zh: '提供核心业务服务',
      en: 'provides core business services',
    },
  ];

  // 先按模块名匹配
  for (const rule of rules) {
    if (rule.match.test(lower)) {
      return rule;
    }
  }

  // 再按类名匹配
  const classStr = classes.join(' ');
  for (const rule of rules) {
    if (rule.match.test(classStr)) {
      return rule;
    }
  }

  return null;
}

/**
 * 从 CodeEntityGraph 提取继承根节点
 * @returns >}
 */
export function getInheritanceRoots(
  codeEntityGraph: {
    queryEntities?: (filter: Record<string, unknown>) => Array<{ entityId: string; name: string }>;
    queryEdges?: (
      filter: Record<string, unknown>
    ) => Array<{ toId?: string; to_id?: string; fromId?: string }>;
  } | null
) {
  if (!codeEntityGraph) {
    return [];
  }
  try {
    // 尝试查询继承关系
    const entities = codeEntityGraph.queryEntities?.({ entityType: 'class', limit: 50 }) || [];
    const roots: { name: string; children: string[] }[] = [];
    for (const e of entities) {
      const _parents =
        codeEntityGraph.queryEdges?.({ toId: e.entityId, relation: 'inherits' }) || [];
      const children =
        codeEntityGraph.queryEdges?.({ fromId: e.entityId, relation: 'inherits' }) || [];
      if (children.length > 0) {
        roots.push({
          name: e.name,
          children: children.map((c: { toId?: string; to_id?: string }) => c.toId || c.to_id || ''),
        });
      }
    }
    return roots.sort((a, b) => (b.children?.length || 0) - (a.children?.length || 0));
  } catch {
    return [];
  }
}

/**
 * 两层去重
 *
 * Layer 1: Title slug 碰撞 — 同名文件不同目录 → hash 相同则删除副本
 * Layer 2: Content hash    — 跨文件内容完全相同 → 仅保留第一个
 *
 * @returns }
 */
export function dedup(
  files: { path: string; hash: string }[],
  wikiDir: string,
  emit: (phase: string, progress: number, message: string) => void
) {
  const removed: string[] = [];

  // Layer 1: slug 碰撞（同名文件跨目录）
  const slugMap = new Map(); // slug → first file
  for (const file of files) {
    const s = path.basename(file.path, path.extname(file.path)).toLowerCase();
    if (slugMap.has(s)) {
      const existing = slugMap.get(s);
      // 完全相同 hash → 移除后来的
      if (existing.hash === file.hash) {
        const fullPath = path.join(wikiDir, file.path);
        if (!fullPath.startsWith(path.resolve(wikiDir) + path.sep)) {
          logger.warn(`[WikiGenerator] Dedup: path escape blocked — ${file.path}`);
          continue;
        }
        try {
          fs.unlinkSync(fullPath);
        } catch {
          /* skip */
        }
        removed.push(file.path);
        logger.info(`[WikiGenerator] Dedup: removed ${file.path} (same hash as ${existing.path})`);
      }
      // hash 不同 → 保留两个（不同目录允许同名）
    } else {
      slugMap.set(s, file);
    }
  }

  // Layer 2: content hash 碰撞（不同文件名但内容相同）
  const hashMap = new Map(); // hash → first file path
  for (const file of files) {
    if (removed.includes(file.path)) {
      continue;
    }
    if (hashMap.has(file.hash)) {
      const firstPath = hashMap.get(file.hash);
      // 优先保留代码生成的（非 synced）
      const isFirstSynced = firstPath.startsWith('documents/') || firstPath.startsWith('skills/');
      const isCurrentSynced = file.path.startsWith('documents/') || file.path.startsWith('skills/');

      if (isCurrentSynced && !isFirstSynced) {
        // 当前是 synced，first 是 codegen → 删除 synced
        const fullPath = path.join(wikiDir, file.path);
        if (!fullPath.startsWith(path.resolve(wikiDir) + path.sep)) {
          logger.warn(`[WikiGenerator] Dedup: path escape blocked — ${file.path}`);
          continue;
        }
        try {
          fs.unlinkSync(fullPath);
        } catch {
          /* skip */
        }
        removed.push(file.path);
        logger.info(
          `[WikiGenerator] Dedup: removed synced ${file.path} (same content as ${firstPath})`
        );
      }
      // 其他情况保留两个
    } else {
      hashMap.set(file.hash, file.path);
    }
  }

  // 从 files 数组中移除已删除的
  for (let i = files.length - 1; i >= 0; i--) {
    if (removed.includes(files[i].path)) {
      files.splice(i, 1);
    }
  }

  if (removed.length > 0) {
    emit('dedup', 93, `去重: 移除 ${removed.length} 个重复文件`);
  } else {
    emit('dedup', 93, '无重复文件');
  }

  return { removed, kept: files.length };
}

// ─── 多语言支持 ──────────────────────────────────────────────

/**
 * 按主语言返回 AST 术语（中英文）
 *
 * 不同语言对"类"和"接口"有不同称谓，Wiki 文档应使用合适的措辞。
 *
 * @param langId LanguageService langId，如 'swift', 'python', 'go'
 * @returns , interfaceLabel: {zh: string, en: string}, moduleMetric: {zh: string, en: string} }}
 */
export function getLangTerms(langId: string) {
  const TERMS = {
    swift: {
      typeLabel: { zh: '类/结构体', en: 'Classes/Structs' },
      interfaceLabel: { zh: '协议', en: 'Protocols' },
      moduleMetric: { zh: 'SPM Targets', en: 'SPM Targets' },
    },
    objectivec: {
      typeLabel: { zh: '类', en: 'Classes' },
      interfaceLabel: { zh: '协议', en: 'Protocols' },
      moduleMetric: { zh: 'Targets', en: 'Targets' },
    },
    typescript: {
      typeLabel: { zh: '类', en: 'Classes' },
      interfaceLabel: { zh: '接口', en: 'Interfaces' },
      moduleMetric: { zh: 'Packages', en: 'Packages' },
    },
    javascript: {
      typeLabel: { zh: '类/模块', en: 'Classes/Modules' },
      interfaceLabel: { zh: '接口', en: 'Interfaces' },
      moduleMetric: { zh: 'Packages', en: 'Packages' },
    },
    python: {
      typeLabel: { zh: '类', en: 'Classes' },
      interfaceLabel: { zh: '抽象基类', en: 'Abstract Base' },
      moduleMetric: { zh: 'Packages', en: 'Packages' },
    },
    go: {
      typeLabel: { zh: '结构体', en: 'Structs' },
      interfaceLabel: { zh: '接口', en: 'Interfaces' },
      moduleMetric: { zh: 'Go Modules', en: 'Go Modules' },
    },
    rust: {
      typeLabel: { zh: '结构体/枚举', en: 'Structs/Enums' },
      interfaceLabel: { zh: 'Trait', en: 'Traits' },
      moduleMetric: { zh: 'Crates', en: 'Crates' },
    },
    java: {
      typeLabel: { zh: '类', en: 'Classes' },
      interfaceLabel: { zh: '接口', en: 'Interfaces' },
      moduleMetric: { zh: 'Modules', en: 'Modules' },
    },
    kotlin: {
      typeLabel: { zh: '类', en: 'Classes' },
      interfaceLabel: { zh: '接口', en: 'Interfaces' },
      moduleMetric: { zh: 'Modules', en: 'Modules' },
    },
    dart: {
      typeLabel: { zh: '类', en: 'Classes' },
      interfaceLabel: { zh: '抽象类', en: 'Abstract Classes' },
      moduleMetric: { zh: 'Packages', en: 'Packages' },
    },
    csharp: {
      typeLabel: { zh: '类', en: 'Classes' },
      interfaceLabel: { zh: '接口', en: 'Interfaces' },
      moduleMetric: { zh: 'Projects', en: 'Projects' },
    },
  };
  return (
    (
      TERMS as Record<
        string,
        {
          typeLabel: { zh: string; en: string };
          interfaceLabel: { zh: string; en: string };
          moduleMetric: { zh: string; en: string };
        }
      >
    )[langId] || {
      typeLabel: { zh: '类型', en: 'Types' },
      interfaceLabel: { zh: '接口', en: 'Interfaces' },
      moduleMetric: { zh: 'Modules', en: 'Modules' },
    }
  );
}

/**
 * 已知的构建系统标志文件 → 生态类型映射
 *
 * @deprecated 请使用 LanguageService.buildSystemMarkers。此处保留为只读引用以保持向后兼容。
 */
export const BUILD_SYSTEM_MARKERS = LanguageService.buildSystemMarkers;

/**
 * 检测项目根目录中存在的构建系统标志
 *
 * 两级检测:
 *   1. 先检查根目录的一级文件
 *   2. 如果根目录未找到，检查一级子目录（支持 monorepo 如 AppFlowy/frontend/...）
 *
 * @param rootEntryNames 项目根目录一级文件/目录名列表
 * @param [projectRoot] 可选的项目根路径，用于二级检测
 * @returns >} 匹配到的构建系统
 */
export function detectBuildSystems(rootEntryNames: string[], projectRoot?: string) {
  // 委托给 LanguageService 做一级匹配
  const results = LanguageService.matchBuildMarkers(rootEntryNames);
  const seenEco = new Set(results.map((r) => r.eco));

  // 二级检测: monorepo / 嵌套项目 — 检查一级子目录
  if (projectRoot && results.length === 0) {
    const skipDirs = LanguageService.scanSkipDirs;
    try {
      const entries = fs.readdirSync(projectRoot, { withFileTypes: true });
      for (const dir of entries) {
        if (!dir.isDirectory() || dir.name.startsWith('.') || skipDirs.has(dir.name)) {
          continue;
        }
        try {
          const subEntries = fs
            .readdirSync(path.join(projectRoot, dir.name))
            .filter((n) => !n.startsWith('.'));
          const subResults = LanguageService.matchBuildMarkers(subEntries);
          for (const r of subResults) {
            if (!seenEco.has(r.eco)) {
              results.push(r);
              seenEco.add(r.eco);
            }
          }
        } catch {
          /* skip unreadable subdirs */
        }
      }
    } catch {
      /* skip */
    }
  }

  return results;
}

// ─── Folder Profile 分析 (AST 不可用时的降级策略) ─────────

/** 入口文件名模式 */
const ENTRY_POINT_NAMES = new Set([
  'index.js',
  'index.ts',
  'index.tsx',
  'index.jsx',
  'index.mjs',
  'main.js',
  'main.ts',
  'main.go',
  'main.py',
  'main.rs',
  'main.dart',
  'main.c',
  'main.cpp',
  'mod.rs',
  'lib.rs',
  '__init__.py',
  'app.js',
  'app.ts',
  'app.py',
  'app.rb',
  'server.js',
  'server.ts',
  'server.py',
]);

/** 多语言 import/require 正则 (轻量级, 不依赖 AST) */
const IMPORT_PATTERNS = [
  // JS/TS: import ... from '...'  or  require('...')
  /(?:import\s+.*?\s+from\s+['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\))/,
  // Python: import xxx / from xxx import yyy
  /(?:^from\s+([.\w]+)\s+import|^import\s+([.\w]+))/,
  // Go: import "path/to/pkg"
  /import\s+(?:\w+\s+)?["']([^"']+)["']/,
  // Rust: use crate::xxx / use super::xxx / mod xxx
  /(?:use\s+(?:crate|super)::(\w+)|mod\s+(\w+)\s*;)/,
  // Java/Kotlin: import com.xxx.yyy
  /import\s+([\w.]+)/,
  // Ruby: require 'xxx' / require_relative 'xxx'
  /require(?:_relative)?\s+['"]([^'"]+)['"]/,
  // C/C++: #include "xxx"
  /#include\s+"([^"]+)"/,
  // Dart: import 'package:xxx/yyy.dart'
  /import\s+['"](?:package:)?([^'"]+)['"]/,
];

/**
 * 分析项目中重要文件夹，生成 FolderProfile 列表
 *
 * 适用场景: AST 无法提取 target（类/函数/协议）的语言，
 * 通过文件夹结构、文件命名、轻量 import 分析来产出有意义的 wiki 内容。
 *
 * @param projectInfo WikiGenerator._scanProject() 的输出
 * @param [options.minFiles=3] 文件夹最少文件数阈值
 * @param [options.maxFolders=20] 最多分析的文件夹数
 * @param [options.sampleLines=40] 每个文件采样行数 (用于 import 提取)
 */
export function profileFolders(
  projectInfo: { root: string; sourceFiles?: string[]; [key: string]: unknown },
  options: { minFiles?: number; maxFolders?: number; sampleLines?: number } = {}
) {
  const { minFiles = 3, maxFolders = 20, sampleLines = 40 } = options;

  const root = projectInfo.root;
  const sourceFiles = projectInfo.sourceFiles || [];

  // ── 1. 按文件夹分组源文件 ──
  /** relDir → [relFilePath, ...] */
  const folderFiles = new Map();
  for (const relFile of sourceFiles) {
    const dir = path.dirname(relFile);
    if (!folderFiles.has(dir)) {
      folderFiles.set(dir, []);
    }
    folderFiles.get(dir).push(relFile);
  }

  // ── 2. 聚合: 将子文件夹的文件计入父文件夹 (递归) ──
  /** relDir → 所有递归子文件 */
  const folderRecursive = new Map();
  for (const [dir, files] of folderFiles) {
    // 把文件计入 dir 本身及所有祖先
    const parts = dir.split('/');
    for (let depth = 1; depth <= parts.length; depth++) {
      const ancestor = parts.slice(0, depth).join('/');
      if (!folderRecursive.has(ancestor)) {
        folderRecursive.set(ancestor, []);
      }
      folderRecursive.get(ancestor).push(...files);
    }
  }

  // ── 3. 筛选重要文件夹 ──
  const candidates: { dir: string; files: string[]; depth: number }[] = [];
  for (const [dir, files] of folderRecursive) {
    if (files.length < minFiles) {
      continue;
    }
    // 排除根目录 '.'
    if (dir === '.') {
      continue;
    }
    // 排除太深的目录 (depth > 4), 这些通常是叶子目录, 信息量低
    const depth = dir.split('/').length;
    if (depth > 4) {
      continue;
    }

    candidates.push({ dir, files, depth });
  }

  // 按文件数降序, 优先保留文件多的大模块
  candidates.sort((a, b) => b.files.length - a.files.length);

  // 去除被父级包含且文件完全是父级子集的冗余候选
  // (保留层次分明的目录: 如果父子文件数差异不大, 去掉子)
  const selected = _pruneRedundantFolders(candidates.slice(0, maxFolders * 2), maxFolders);

  // ── 4. 为每个选中的文件夹生成 Profile ──
  const profiles: Record<string, unknown>[] = [];

  for (const { dir, files, depth } of selected) {
    const profile = _buildFolderProfile(dir, files, depth, root, sampleLines);
    if (profile) {
      profiles.push(profile);
    }
  }

  // 按 fileCount 降序 + depth 升序 排序
  profiles.sort((a, b) => {
    if ((b.fileCount as number) !== (a.fileCount as number)) {
      return (b.fileCount as number) - (a.fileCount as number);
    }
    return (a.depth as number) - (b.depth as number);
  });

  return profiles.slice(0, maxFolders);
}

/**
 * 修剪冗余文件夹: 如果子目录文件数与父目录接近 (>80%), 仅保留父目录
 */
function _pruneRedundantFolders(
  candidates: { dir: string; files: string[]; depth: number }[],
  maxFolders: number
) {
  const kept: { dir: string; files: string[]; depth: number }[] = [];
  const removedDirs = new Set();

  for (const c of candidates) {
    if (removedDirs.has(c.dir)) {
      continue;
    }

    // 检查是否有已 kept 的父目录, 且文件比率 > 80%
    let isRedundant = false;
    for (const k of kept) {
      if (c.dir.startsWith(`${k.dir}/`)) {
        // c 是 k 的子目录
        if (c.files.length / k.files.length > 0.8) {
          isRedundant = true;
          break;
        }
      } else if (k.dir.startsWith(`${c.dir}/`)) {
        // c 是 k 的父目录, k 覆盖了 c 大部分 → 保留 c (更高层), 移除 k
        if (k.files.length / c.files.length > 0.8) {
          removedDirs.add(k.dir);
        }
      }
    }

    if (!isRedundant) {
      kept.push(c);
    }

    if (kept.length >= maxFolders) {
      break;
    }
  }

  return kept.filter((c) => !removedDirs.has(c.dir));
}

/**
 * 为单个文件夹构建 FolderProfile
 */
function _buildFolderProfile(
  relDir: string,
  files: string[],
  depth: number,
  projectRoot: string,
  sampleLines: number
) {
  const fullDir = path.join(projectRoot, relDir);
  const folderName = path.basename(relDir);

  // ── 语言分布 ──
  const langBreakdown: Record<string, number> = {};
  let totalSize = 0;
  for (const f of files) {
    const ext = path.extname(f);
    const lang = LanguageService.displayNameFromExt(ext) || ext;
    langBreakdown[lang] = (langBreakdown[lang] || 0) + 1;
    try {
      const stat = fs.statSync(path.join(projectRoot, f));
      totalSize += stat.size;
    } catch {
      /* skip */
    }
  }

  // ── 文件名列表 ──
  const fileNames = files.map((f: string) => path.basename(f)).sort();

  // ── 入口点检测 ──
  const entryPoints = files.filter((f: string) =>
    ENTRY_POINT_NAMES.has(path.basename(f).toLowerCase())
  );

  // ── 重要文件 (大文件 top5 + 入口文件) ──
  const fileSizes: { file: string; size: number }[] = [];
  for (const f of files) {
    try {
      const stat = fs.statSync(path.join(projectRoot, f));
      fileSizes.push({ file: f, size: stat.size });
    } catch {
      /* skip */
    }
  }
  fileSizes.sort((a, b) => b.size - a.size);
  const keyFiles = [...new Set([...entryPoints, ...fileSizes.slice(0, 5).map((fs) => fs.file)])];

  // ── README 检测 ──
  let readme: string | null = null;
  const readmeNames = ['README.md', 'readme.md', 'README.txt', 'README', 'readme.markdown'];
  for (const rn of readmeNames) {
    const rPath = path.join(fullDir, rn);
    try {
      if (fs.existsSync(rPath)) {
        const content = fs.readFileSync(rPath, 'utf-8');
        readme = content.slice(0, 1000); // 只取前 1000 字符
        break;
      }
    } catch {
      /* skip */
    }
  }

  // ── 命名模式检测 ──
  const namingPatterns = _detectNamingPatterns(fileNames);

  // ── 轻量 Import 分析 ──
  const imports = _extractImports(keyFiles.slice(0, 10), projectRoot, sampleLines, relDir);

  // ── 头部注释提取 (从关键文件提取首段注释) ──
  const headerComments: string[] = [];
  for (const f of keyFiles.slice(0, 3)) {
    const comment = _extractHeaderComment(path.join(projectRoot, f));
    if (comment) {
      headerComments.push(`${path.basename(f)}: ${comment}`);
    }
  }

  // ── 功能推断 (复用已有 inferModulePurpose + 增强) ──
  const purpose = inferModulePurpose(folderName, [], [], files);

  return {
    name: folderName,
    relPath: relDir,
    fileCount: files.length,
    totalSize,
    depth,
    langBreakdown,
    keyFiles,
    fileNames,
    readme,
    purpose: purpose ? purpose : null,
    imports,
    entryPoints: [...new Set(entryPoints.map((f: string) => path.basename(f)))],
    namingPatterns,
    headerComments,
  };
}

/**
 * 从文件名列表检测命名约定
 * @param fileNames basename 列表
 */
function _detectNamingPatterns(fileNames: string[]) {
  const patterns: string[] = [];
  const lower = fileNames.map((n: string) => n.toLowerCase());

  // 测试文件
  const testFiles = lower.filter(
    (n: string) =>
      n.startsWith('test_') ||
      n.startsWith('test.') ||
      n.endsWith('_test.go') ||
      n.endsWith('.test.js') ||
      n.endsWith('.test.ts') ||
      n.endsWith('.spec.js') ||
      n.endsWith('.spec.ts') ||
      n.endsWith('_spec.rb') ||
      (n.startsWith('test') && n.includes('.'))
  );
  if (testFiles.length > 0) {
    patterns.push(`test files: ${testFiles.length}`);
  }

  // 常见后缀模式
  const suffixes: Record<string, number> = {};
  for (const name of fileNames) {
    const base = path.basename(name, path.extname(name));
    // 检测 CamelCase 后缀: UserController → Controller
    const camelMatch = base.match(/([A-Z][a-z]+)$/);
    if (camelMatch) {
      const suffix = camelMatch[1];
      suffixes[suffix] = (suffixes[suffix] || 0) + 1;
    }
    // 检测 snake_case 后缀: user_controller → controller
    const snakeMatch = base.match(/_([a-z]+)$/);
    if (snakeMatch) {
      const suffix = snakeMatch[1];
      suffixes[suffix] = (suffixes[suffix] || 0) + 1;
    }
  }

  // 出现 ≥2 次的后缀视为命名约定
  for (const [suffix, count] of Object.entries(suffixes).sort(
    (a, b) => (b[1] as number) - (a[1] as number)
  )) {
    if ((count as number) >= 2) {
      patterns.push(`*${suffix}: ${count}`);
    }
  }

  return patterns.slice(0, 8);
}

/**
 * 从文件顶部提取 import/require 语句，推断文件夹级依赖
 */
function _extractImports(
  keyFiles: string[],
  projectRoot: string,
  sampleLines: number,
  currentDir: string
) {
  const importTargets = new Set();

  // Node.js / 常见运行时内置模块 — 不应计入项目文件夹依赖
  const BUILTIN_MODULES = new Set([
    'fs',
    'path',
    'os',
    'http',
    'https',
    'url',
    'util',
    'crypto',
    'stream',
    'events',
    'child_process',
    'cluster',
    'net',
    'dns',
    'tls',
    'zlib',
    'readline',
    'assert',
    'buffer',
    'querystring',
    'string_decoder',
    'timers',
    'tty',
    'dgram',
    'vm',
    'worker_threads',
    'perf_hooks',
    'async_hooks',
    'v8',
    'inspector',
    'console',
    'process',
    'module',
    // node: prefix 会被 firstSeg 拆出 "node" — 直接排除
    'node',
    // 常见第三方包 (非项目目录)
    'react',
    'vue',
    'express',
    'lodash',
    'axios',
    'moment',
    'dayjs',
    'webpack',
    'vite',
    'jest',
    'mocha',
    'chai',
  ]);

  for (const relFile of keyFiles) {
    try {
      const fullPath = path.join(projectRoot, relFile);
      const content = fs.readFileSync(fullPath, 'utf-8');
      const lines = content.split('\n').slice(0, sampleLines);

      for (const line of lines) {
        for (const pattern of IMPORT_PATTERNS) {
          const match = line.match(pattern);
          if (match) {
            // 取第一个非 undefined 捕获组
            const target = match[1] || match[2];
            if (target) {
              // 跳过 node: 协议前缀 (Node.js 内置模块)
              if (target.startsWith('node:')) {
                continue;
              }

              // 解析相对路径 import → 文件夹名
              if (target.startsWith('.') || target.startsWith('/')) {
                const resolved = path.normalize(path.join(currentDir, target));
                const topDir = resolved.split('/')[0];
                if (
                  topDir &&
                  topDir !== '.' &&
                  topDir !== '..' &&
                  topDir !== currentDir.split('/')[0]
                ) {
                  importTargets.add(topDir);
                }
              } else {
                // 绝对 import → 取第一段作为模块名
                const firstSeg = target.split(/[/.]/)[0];
                if (firstSeg && firstSeg.length > 1 && !BUILTIN_MODULES.has(firstSeg)) {
                  importTargets.add(firstSeg);
                }
              }
            }
          }
        }
      }
    } catch {
      /* skip unreadable files */
    }
  }

  return [...importTargets].slice(0, 20);
}

/**
 * 提取文件头部注释 (第一个注释块)
 */
function _extractHeaderComment(fullPath: string) {
  try {
    const content = fs.readFileSync(fullPath, 'utf-8');
    const lines = content.split('\n').slice(0, 30);

    // 尝试匹配多行注释 /** ... */ 或 /* ... */
    const joined = lines.join('\n');
    const blockMatch = joined.match(/\/\*\*?([\s\S]*?)\*\//);
    if (blockMatch) {
      const comment = blockMatch[1]
        .split('\n')
        .map((l) => l.replace(/^\s*\*\s?/, '').trim())
        .filter((l) => l && !l.startsWith('@'))
        .join(' ')
        .slice(0, 200);
      if (comment.length > 10) {
        return comment;
      }
    }

    // 尝试匹配 # 或 // 开头的连续行注释
    const lineComments: string[] = [];
    for (const line of lines) {
      const stripped = line.trim();
      if (
        stripped.startsWith('#') &&
        !stripped.startsWith('#!') &&
        !stripped.startsWith('#include')
      ) {
        lineComments.push(stripped.replace(/^#+\s*/, ''));
      } else if (stripped.startsWith('//')) {
        lineComments.push(stripped.replace(/^\/\/\s*/, ''));
      } else if (stripped.startsWith('"""') || stripped.startsWith("'''")) {
        // Python docstring
        const docMatch = joined.match(/(?:"""|''')([\s\S]*?)(?:"""|''')/);
        if (docMatch) {
          return docMatch[1].trim().slice(0, 200);
        }
      } else if (lineComments.length > 0) {
        break; // 注释块结束
      }
    }
    if (lineComments.length > 0) {
      const comment = lineComments.join(' ').slice(0, 200);
      if (comment.length > 10) {
        return comment;
      }
    }

    return null;
  } catch {
    return null;
  }
}
