/**
 * @module CustomConfigDiscoverer
 * @description 自研配置文件发现器 — 识别使用非标准/自研构建系统的项目
 *
 * 两级检测策略：
 *  Level 1: 已知自研工具指纹匹配 (confidence 0.70-0.80)
 *  Level 2: 启发式目录结构探测 (confidence 0.50-0.65)
 *
 * 当前支持：
 *  - Baidu EasyBox (Boxfile + *.boxspec)
 *  - Tuist (Project.swift)
 *  - XcodeGen (project.yml)
 *
 * 设计文档: docs/copilot/custom-config-discoverer-design.md
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { getProjectSpecPath } from '#infra/config/Paths.js';
import { LanguageService } from '#shared/LanguageService.js';
import {
  type DependencyGraph,
  type DependencyGraphLayer,
  type DiscoveredFile,
  type DiscoveredTarget,
  ProjectDiscoverer,
} from './ProjectDiscoverer.js';
import {
  type ParsedLayer,
  type ParsedModuleSpec,
  type ParsedProjectConfig,
  parseBoxfile,
  parseModuleSpec,
} from './parsers/RubyDslParser.js';
import {
  extractXcodeGenDependencyEdges,
  parseXcodeGenProject,
  parseXcodeGenTarget,
} from './parsers/YamlConfigParser.js';

// ── 已知自研构建系统配置表 ────────────────────────────

interface CustomSystemProfile {
  id: string;
  displayName: string;
  markers: string[];
  moduleSpecPattern: string | null;
  language: readonly string[];
  confidence: number;
  parser: 'ruby-dsl' | 'yaml' | 'swift-dsl' | 'starlark';
}

const KNOWN_CUSTOM_SYSTEMS: readonly CustomSystemProfile[] = Object.freeze([
  {
    id: 'easybox',
    displayName: 'Baidu EasyBox',
    markers: ['Boxfile'],
    moduleSpecPattern: '*.boxspec',
    language: Object.freeze(['objectivec', 'swift']),
    confidence: 0.8,
    parser: 'ruby-dsl' as const,
  },
  {
    id: 'tuist',
    displayName: 'Tuist',
    markers: ['Tuist/Config.swift', 'Project.swift'],
    moduleSpecPattern: null,
    language: Object.freeze(['swift']),
    confidence: 0.8,
    parser: 'swift-dsl' as const,
  },
  {
    id: 'xcodegen',
    displayName: 'XcodeGen',
    markers: ['project.yml', 'project.yaml'],
    moduleSpecPattern: null,
    language: Object.freeze(['swift', 'objectivec']),
    confidence: 0.75,
    parser: 'yaml' as const,
  },
]);

// ── 启发式信号 ──────────────────────────────────────

interface HeuristicSignal {
  pattern: RegExp;
  type: 'module-dir' | 'custom-dsl' | 'spec-file' | 'xcode';
  boost: number;
}

const HEURISTIC_SIGNALS: readonly HeuristicSignal[] = Object.freeze([
  { pattern: /^(Local)?Modules?$/i, type: 'module-dir' as const, boost: 0.15 },
  { pattern: /^Packages$/i, type: 'module-dir' as const, boost: 0.1 },
  { pattern: /^[A-Z]\w+file$/, type: 'custom-dsl' as const, boost: 0.2 },
  { pattern: /\.\w+spec$/, type: 'spec-file' as const, boost: 0.2 },
  { pattern: /\.xcodeproj$/, type: 'xcode' as const, boost: 0.05 },
]);

// 排除已知的标准 Ruby DSL 文件
const KNOWN_STANDARD_FILES = new Set([
  'Gemfile',
  'Podfile',
  'Fastfile',
  'Rakefile',
  'Vagrantfile',
  'Guardfile',
  'Brewfile',
  'Berksfile',
  'Capfile',
]);

const EXCLUDE_DIRS = new Set([
  'node_modules',
  '.git',
  '.cursor',
  'dist',
  'build',
  'out',
  '.build',
  'Pods',
  'Carthage',
  'DerivedData',
  '__pycache__',
  '.venv',
  'venv',
  '.gradle',
  'coverage',
  '.cache',
  '.easybox',
]);

const SOURCE_EXTENSIONS = new Set(['.m', '.h', '.swift', '.mm', '.c', '.cpp', '.cc']);

// ── User Custom Systems (boxspec.json) ──────────────

/**
 * 从 boxspec.json 读取用户自定义配置系统
 *
 * boxspec.json 中可选字段：
 * ```json
 * {
 *   "customDiscoverer": {
 *     "id": "my-build-tool",
 *     "displayName": "MyBuildTool",
 *     "markers": ["MyBuildfile"],
 *     "moduleSpecPattern": "*.myspec",
 *     "language": ["swift"],
 *     "confidence": 0.85,
 *     "parser": "ruby-dsl"
 *   }
 * }
 * ```
 * 或数组形式支持多个自定义系统。
 */
function loadUserCustomSystems(projectRoot: string): CustomSystemProfile[] {
  try {
    const specPath = getProjectSpecPath(projectRoot);
    if (!existsSync(specPath)) {
      return [];
    }

    const raw = JSON.parse(readFileSync(specPath, 'utf-8'));
    const custom = raw?.customDiscoverer;
    if (!custom) {
      return [];
    }

    const items = Array.isArray(custom) ? custom : [custom];
    const results: CustomSystemProfile[] = [];

    for (const item of items) {
      if (!item?.id || !item?.markers || !Array.isArray(item.markers)) {
        continue;
      }

      results.push({
        id: String(item.id),
        displayName: String(item.displayName ?? item.id),
        markers: item.markers.map(String),
        moduleSpecPattern: item.moduleSpecPattern ? String(item.moduleSpecPattern) : null,
        language: Array.isArray(item.language) ? item.language.map(String) : ['swift'],
        confidence: typeof item.confidence === 'number' ? item.confidence : 0.75,
        parser: ['ruby-dsl', 'yaml', 'swift-dsl', 'starlark'].includes(item.parser)
          ? item.parser
          : 'ruby-dsl',
      });
    }

    return results;
  } catch {
    return [];
  }
}

/**
 * 获取合并后的系统配置表：用户自定义 + 内置
 * 用户自定义系统优先匹配
 */
function getEffectiveSystemProfiles(projectRoot: string): readonly CustomSystemProfile[] {
  const userSystems = loadUserCustomSystems(projectRoot);
  if (userSystems.length === 0) {
    return KNOWN_CUSTOM_SYSTEMS;
  }
  return [...userSystems, ...KNOWN_CUSTOM_SYSTEMS];
}

// ── CustomConfigDiscoverer ──────────────────────────

export class CustomConfigDiscoverer extends ProjectDiscoverer {
  #projectRoot: string | null = null;
  #matchedSystem: CustomSystemProfile | null = null;
  #parsedConfig: ParsedProjectConfig | null = null;
  #moduleSpecs = new Map<string, ParsedModuleSpec>();
  #targets: DiscoveredTarget[] = [];

  get id() {
    return 'customConfig';
  }

  get displayName() {
    if (this.#matchedSystem) {
      return `Custom Config (${this.#matchedSystem.displayName})`;
    }
    return 'Custom Config (Heuristic)';
  }

  // ── detect ────────────────────────────────────────

  async detect(projectRoot: string) {
    // Level 1: 已知自研工具指纹匹配（含用户自定义系统）
    const systems = getEffectiveSystemProfiles(projectRoot);
    for (const system of systems) {
      const markerFound = system.markers.some((marker) => {
        const fullPath = join(projectRoot, marker);
        return existsSync(fullPath);
      });

      if (markerFound) {
        return {
          match: true,
          confidence: system.confidence,
          reason: `${system.displayName} detected (${system.markers.join(', ')})`,
        };
      }
    }

    // Level 2: 启发式目录结构探测
    let heuristicScore = 0.35; // 基础分
    const signals: string[] = [];

    try {
      const entries = readdirSync(projectRoot, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.name.startsWith('.')) {
          continue;
        }

        for (const signal of HEURISTIC_SIGNALS) {
          if (signal.pattern.test(entry.name)) {
            // 排除已知的标准文件
            if (signal.type === 'custom-dsl' && KNOWN_STANDARD_FILES.has(entry.name)) {
              continue;
            }

            // 对 module-dir 类型，要求目录内有多个子目录
            if (signal.type === 'module-dir' && entry.isDirectory()) {
              const subCount = countSubdirsWithSpecs(join(projectRoot, entry.name));
              if (subCount < 2) {
                continue;
              }
            }

            heuristicScore += signal.boost;
            signals.push(`${entry.name} (${signal.type})`);
          }
        }
      }
    } catch {
      /* skip */
    }

    // 限制最高分
    heuristicScore = Math.min(heuristicScore, 0.65);

    if (heuristicScore >= 0.5 && signals.length >= 2) {
      return {
        match: true,
        confidence: heuristicScore,
        reason: `Heuristic signals: ${signals.join(', ')}`,
      };
    }

    return { match: false, confidence: 0, reason: 'No custom config detected' };
  }

  // ── load ──────────────────────────────────────────

  async load(projectRoot: string) {
    this.#projectRoot = projectRoot;
    this.#parsedConfig = null;
    this.#moduleSpecs.clear();
    this.#targets = [];

    // 确定匹配的系统（含用户自定义系统）
    this.#matchedSystem = null;
    const systems = getEffectiveSystemProfiles(projectRoot);
    for (const system of systems) {
      const markerFound = system.markers.some((marker) => existsSync(join(projectRoot, marker)));
      if (markerFound) {
        this.#matchedSystem = system;
        break;
      }
    }

    if (this.#matchedSystem?.parser === 'ruby-dsl') {
      this.#loadRubyDsl(projectRoot);
    } else if (this.#matchedSystem?.parser === 'yaml') {
      this.#loadYaml(projectRoot);
    } else {
      // 启发式 fallback: 扫描目录结构
      this.#loadHeuristic(projectRoot);
    }
  }

  // ── listTargets ───────────────────────────────────

  async listTargets(): Promise<DiscoveredTarget[]> {
    return this.#targets;
  }

  // ── getTargetFiles ────────────────────────────────

  async getTargetFiles(target: DiscoveredTarget): Promise<DiscoveredFile[]> {
    const targetPath =
      typeof target === 'string' ? this.#targets.find((t) => t.name === target)?.path : target.path;

    if (!targetPath || !existsSync(targetPath)) {
      return [];
    }

    // 如果有 spec 文件，优先使用 sources 字段定位
    const targetName = typeof target === 'string' ? target : target.name;
    const spec = this.#moduleSpecs.get(targetName);

    let sourceDir = targetPath;
    if (spec?.sources) {
      const specSourceDir = join(targetPath, spec.sources);
      if (existsSync(specSourceDir)) {
        sourceDir = specSourceDir;
      }
    }

    const files: DiscoveredFile[] = [];
    this.#collectSourceFiles(sourceDir, targetPath, files);
    return files;
  }

  // ── getDependencyGraph ────────────────────────────

  async getDependencyGraph(): Promise<DependencyGraph> {
    if (!this.#parsedConfig) {
      return { nodes: this.#targets.map((t) => t.name), edges: [] };
    }

    const config = this.#parsedConfig;
    const nodes: DependencyGraph['nodes'] = [];
    const edges: DependencyGraph['edges'] = [];
    const nodeIds = new Set<string>();

    // 宿主应用节点
    if (config.hostApp) {
      const hostId = config.hostApp.name;
      nodes.push({
        id: hostId,
        label: hostId,
        type: 'host',
        version: config.hostApp.version,
      });
      nodeIds.add(hostId);
    }

    // 遍历所有层级，添加模块节点
    for (const layer of config.layers) {
      for (const mod of layer.modules) {
        if (nodeIds.has(mod.name)) {
          continue;
        }
        nodeIds.add(mod.name);

        nodes.push({
          id: mod.name,
          label: mod.name,
          type: mod.isLocal ? 'local' : 'external',
          layer: layer.name,
          version: mod.version || undefined,
          group: mod.group || undefined,
          fullPath:
            mod.isLocal && mod.localPath && this.#projectRoot
              ? join(this.#projectRoot, mod.localPath)
              : undefined,
        });
      }
    }

    // 全局依赖
    for (const mod of config.globalDependencies) {
      if (nodeIds.has(mod.name)) {
        continue;
      }
      nodeIds.add(mod.name);

      nodes.push({
        id: mod.name,
        label: mod.name,
        type: mod.isLocal ? 'local' : 'external',
        version: mod.version || undefined,
        group: mod.group || undefined,
        fullPath:
          mod.isLocal && mod.localPath && this.#projectRoot
            ? join(this.#projectRoot, mod.localPath)
            : undefined,
      });
    }

    // 从 boxspec 依赖声明生成边
    for (const [moduleName, spec] of this.#moduleSpecs) {
      for (const depName of spec.dependencies) {
        // 确保依赖目标存在于节点列表中
        if (!nodeIds.has(depName)) {
          nodeIds.add(depName);
          nodes.push({
            id: depName,
            label: depName,
            type: 'external',
            indirect: true,
          });
        }

        edges.push({
          from: moduleName,
          to: depName,
          type: 'depends_on',
        });
      }
    }

    // 宿主应用 → 所有本地模块的 contains 关系
    if (config.hostApp) {
      for (const layer of config.layers) {
        for (const mod of layer.modules) {
          if (mod.isLocal) {
            edges.push({
              from: config.hostApp.name,
              to: mod.name,
              type: 'contains',
            });
          }
        }
      }
    }

    // 层级元数据
    const layers: DependencyGraphLayer[] = config.layers.map((l) => ({
      name: l.name,
      order: l.order,
      accessibleLayers: l.accessibleLayers,
    }));

    return { nodes, edges, layers };
  }

  // ── Private: Ruby DSL 加载 ─────────────────────────

  #loadRubyDsl(projectRoot: string) {
    // 读取 Boxfile
    const boxfilePath = join(projectRoot, 'Boxfile');
    if (!existsSync(boxfilePath)) {
      return;
    }

    let content: string;
    try {
      content = readFileSync(boxfilePath, 'utf8');
    } catch {
      return;
    }

    // 解析 Boxfile
    this.#parsedConfig = parseBoxfile(content);

    // 尝试合并 Boxfile.local 覆盖
    this.#mergeLocalOverrides(projectRoot);

    // 遍历本地模块，解析 spec 文件
    const allModules = [
      ...this.#parsedConfig.layers.flatMap((l) => l.modules),
      ...this.#parsedConfig.globalDependencies,
    ];

    for (const mod of allModules) {
      if (!mod.isLocal || !mod.localPath) {
        continue;
      }

      const modulePath = join(projectRoot, mod.localPath);
      if (!existsSync(modulePath)) {
        continue;
      }

      // 查找 spec 文件
      const specPath = this.#findSpecFile(modulePath, mod.name);
      if (specPath) {
        try {
          const specContent = readFileSync(specPath, 'utf8');
          const spec = parseModuleSpec(specContent);
          this.#moduleSpecs.set(mod.name, spec);
        } catch {
          /* skip unreadable spec */
        }
      }
    }

    // 构建 targets（仅 local 模块 + 宿主应用）
    this.#buildTargets(projectRoot);
  }

  /**
   * 合并 Boxfile.local 中的覆盖配置
   * Boxfile.local 中 :path 覆盖可以将远程依赖切换为本地源码
   */
  #mergeLocalOverrides(projectRoot: string) {
    const localPath = join(projectRoot, 'Boxfile.local');
    if (!existsSync(localPath)) {
      return;
    }

    try {
      const localContent = readFileSync(localPath, 'utf8');
      const localConfig = parseBoxfile(localContent);

      if (!this.#parsedConfig) {
        return;
      }

      // 合并本地覆盖：将 Boxfile.local 中的 local module 覆盖到主配置
      const allLocalModules = localConfig.layers.flatMap((l) => l.modules);
      for (const localMod of allLocalModules) {
        if (!localMod.isLocal) {
          continue;
        }

        // 查找主配置中的同名模块并覆盖
        const configLayers: ParsedLayer[] = this.#parsedConfig.layers;
        for (const layer of configLayers) {
          const existingIdx = layer.modules.findIndex(
            (m: { name: string }) => m.name === localMod.name
          );
          if (existingIdx >= 0) {
            layer.modules[existingIdx] = { ...layer.modules[existingIdx], ...localMod };
          }
        }
      }
    } catch {
      /* skip */
    }
  }

  /**
   * 在模块目录中查找 spec 文件
   * 查找顺序: ModuleName.boxspec → ModuleName.podspec → 任意 *.boxspec → 任意 *.podspec
   */
  #findSpecFile(modulePath: string, moduleName: string): string | null {
    // 精确匹配
    for (const ext of ['.boxspec', '.podspec']) {
      const exactPath = join(modulePath, `${moduleName}${ext}`);
      if (existsSync(exactPath)) {
        return exactPath;
      }
    }

    // 模糊匹配
    try {
      const entries = readdirSync(modulePath);
      for (const entry of entries) {
        if (entry.endsWith('.boxspec') || entry.endsWith('.podspec')) {
          return join(modulePath, entry);
        }
      }
    } catch {
      /* skip */
    }

    return null;
  }

  /**
   * 从解析结果构建 Target 列表
   * 仅包含本地模块和宿主应用（有源码可收集的目标）
   */
  #buildTargets(projectRoot: string) {
    if (!this.#parsedConfig) {
      return;
    }

    const config = this.#parsedConfig;
    const primaryLang = this.#matchedSystem?.language[0] || 'objectivec';

    // 宿主应用
    if (config.hostApp) {
      const hostDir = join(projectRoot, config.hostApp.name);
      if (existsSync(hostDir)) {
        this.#targets.push({
          name: config.hostApp.name,
          path: hostDir,
          type: 'application',
          language: primaryLang,
          metadata: {
            layer: 'Application',
            version: config.hostApp.version,
          },
        });
      }
    }

    // 所有层级中的本地模块
    for (const layer of config.layers) {
      for (const mod of layer.modules) {
        if (!mod.isLocal || !mod.localPath) {
          continue;
        }

        const modulePath = join(projectRoot, mod.localPath);
        if (!existsSync(modulePath)) {
          continue;
        }

        this.#targets.push({
          name: mod.name,
          path: modulePath,
          type: 'library',
          language: primaryLang,
          metadata: {
            layer: layer.name,
            version: mod.version,
            group: mod.group,
            specFile: this.#moduleSpecs.has(mod.name),
          },
        });
      }
    }

    // 全局本地模块
    for (const mod of config.globalDependencies) {
      if (!mod.isLocal || !mod.localPath) {
        continue;
      }

      const modulePath = join(projectRoot, mod.localPath);
      if (!existsSync(modulePath)) {
        continue;
      }

      // 避免重复
      if (this.#targets.some((t) => t.name === mod.name)) {
        continue;
      }

      this.#targets.push({
        name: mod.name,
        path: modulePath,
        type: 'library',
        language: primaryLang,
        metadata: {
          version: mod.version,
          group: mod.group,
          specFile: this.#moduleSpecs.has(mod.name),
        },
      });
    }
  }

  // ── Private: YAML 加载 (XcodeGen) ──────────────────

  #loadYaml(projectRoot: string) {
    const system = this.#matchedSystem!;

    // 查找可用的 YAML 配置文件
    let yamlContent: string | null = null;
    for (const marker of system.markers) {
      const markerPath = join(projectRoot, marker);
      if (existsSync(markerPath)) {
        try {
          yamlContent = readFileSync(markerPath, 'utf-8');
          break;
        } catch {
          /* 跳过不可读文件 */
        }
      }
    }

    if (!yamlContent) {
      this.#loadHeuristic(projectRoot);
      return;
    }

    // 解析 project.yml
    const config = parseXcodeGenProject(yamlContent);
    this.#parsedConfig = config;

    const primaryLang = system.language[0] as string;

    // 遍历 layers → targets
    for (const layer of config.layers) {
      for (const mod of layer.modules) {
        if (!mod.isLocal) {
          continue;
        }

        const modulePath = mod.localPath
          ? join(projectRoot, mod.localPath)
          : join(projectRoot, mod.name);

        this.#targets.push({
          name: mod.name,
          path: modulePath,
          type: layer.name === 'App' ? 'application' : 'library',
          language: primaryLang,
          metadata: {
            layer: layer.name,
            version: mod.version,
            group: mod.group,
          },
        });

        // 为每个 target 构建 ParsedModuleSpec
        const targetSpec = parseXcodeGenTarget(mod.name, yamlContent);
        if (targetSpec) {
          this.#moduleSpecs.set(mod.name, targetSpec);
        }
      }
    }

    // 全局 SPM 包依赖 → targets（标记为外部）
    for (const dep of config.globalDependencies) {
      if (this.#targets.some((t) => t.name === dep.name)) {
      }
      // 外部包不加入 targets，留给 getDependencyGraph 处理
    }
  }

  // ── Private: 启发式加载 ────────────────────────────

  #loadHeuristic(projectRoot: string) {
    // 扫描根目录中可能包含模块的目录
    try {
      const entries = readdirSync(projectRoot, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || EXCLUDE_DIRS.has(entry.name)) {
          continue;
        }

        // 检查是否是模块容器目录
        if (/^(Local)?Modules?$|^Packages$/i.test(entry.name)) {
          this.#scanModuleDirectory(join(projectRoot, entry.name));
        }
      }
    } catch {
      /* skip */
    }
  }

  /**
   * 扫描模块容器目录，每个有 spec 文件或源码的子目录视为一个模块
   */
  #scanModuleDirectory(containerDir: string) {
    try {
      const entries = readdirSync(containerDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) {
          continue;
        }

        const modulePath = join(containerDir, entry.name);

        // 查找 spec 文件
        const specPath = this.#findSpecFile(modulePath, entry.name);
        if (specPath) {
          try {
            const specContent = readFileSync(specPath, 'utf8');
            const spec = parseModuleSpec(specContent);
            this.#moduleSpecs.set(entry.name, spec);
          } catch {
            /* skip */
          }
        }

        // 检查目录是否包含源码文件
        if (specPath || this.#hasSourceFiles(modulePath)) {
          this.#targets.push({
            name: entry.name,
            path: modulePath,
            type: 'library',
            language: 'objectivec',
            metadata: { specFile: specPath !== null },
          });
        }
      }
    } catch {
      /* skip */
    }
  }

  // ── Private: 文件工具 ──────────────────────────────

  /**
   * 递归收集源码文件
   */
  #collectSourceFiles(dir: string, rootDir: string, files: DiscoveredFile[], depth = 0) {
    if (depth > 15 || files.length >= 500) {
      return;
    }

    try {
      const entries = readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.name.startsWith('.')) {
          continue;
        }
        if (EXCLUDE_DIRS.has(entry.name)) {
          continue;
        }

        const fullPath = join(dir, entry.name);

        if (entry.isDirectory()) {
          this.#collectSourceFiles(fullPath, rootDir, files, depth + 1);
        } else if (entry.isFile()) {
          const ext = extname(entry.name);
          if (SOURCE_EXTENSIONS.has(ext) || LanguageService.sourceExts.has(ext)) {
            const lang = LanguageService.inferLang(entry.name) || 'unknown';
            files.push({
              name: entry.name,
              path: fullPath,
              relativePath: relative(rootDir, fullPath),
              language: lang,
            });
          }
        }

        if (files.length >= 500) {
          return;
        }
      }
    } catch {
      /* skip */
    }
  }

  /**
   * 检查目录中是否存在源码文件（浅层检查）
   */
  #hasSourceFiles(dir: string, depth = 0): boolean {
    if (depth > 3) {
      return false;
    }

    try {
      const entries = readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.name.startsWith('.')) {
          continue;
        }

        if (entry.isFile()) {
          const ext = extname(entry.name);
          if (SOURCE_EXTENSIONS.has(ext)) {
            return true;
          }
        } else if (entry.isDirectory() && !EXCLUDE_DIRS.has(entry.name)) {
          if (this.#hasSourceFiles(join(dir, entry.name), depth + 1)) {
            return true;
          }
        }
      }
    } catch {
      /* skip */
    }

    return false;
  }
}

// ── Module-level helpers ────────────────────────────

/**
 * 计算目录下包含 spec 文件的子目录数量
 */
function countSubdirsWithSpecs(containerDir: string): number {
  let count = 0;
  try {
    const entries = readdirSync(containerDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) {
        continue;
      }
      try {
        const subEntries = readdirSync(join(containerDir, entry.name));
        const hasSpec = subEntries.some((e) => e.endsWith('.boxspec') || e.endsWith('.podspec'));
        if (hasSpec) {
          count++;
        }
      } catch {
        /* skip */
      }
    }
  } catch {
    /* skip */
  }
  return count;
}
