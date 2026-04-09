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
import { parseCMakeProject } from './parsers/CMakeParser.js';
import { inferConventionRole, parseGradleProject } from './parsers/GradleDslParser.js';
import {
  parseFlutterPluginsDeps,
  parseNxWorkspace,
  parseReactNativeProject,
} from './parsers/JsonConfigParser.js';
import {
  type ParsedLayer,
  type ParsedModuleSpec,
  type ParsedProjectConfig,
  parseBoxfile,
  parseModuleSpec,
} from './parsers/RubyDslParser.js';
import {
  type ParsedBuildFile,
  parseStarlarkBuildFile,
  RULE_TO_LANGUAGE,
} from './parsers/StarlarkParser.js';
import {
  parseMelosProject,
  parseXcodeGenProject,
  parseXcodeGenTarget,
} from './parsers/YamlConfigParser.js';

// ── 已知自研构建系统配置表 ────────────────────────────

interface CustomSystemProfile {
  id: string;
  displayName: string;
  markers: string[];
  markerStrategy?: 'all' | 'any' | 'ordered';
  antiMarkers?: string[];
  moduleSpecPattern: string | null;
  language: readonly string[];
  confidence: number;
  parser: 'ruby-dsl' | 'yaml' | 'swift-dsl' | 'starlark' | 'gradle-dsl' | 'cmake' | 'json-config';
}

const KNOWN_CUSTOM_SYSTEMS: readonly CustomSystemProfile[] = Object.freeze([
  // ── Tier 1: Bazel / Buck2 (Starlark) ──
  {
    id: 'bazel',
    displayName: 'Bazel',
    markers: ['MODULE.bazel', 'WORKSPACE', 'WORKSPACE.bazel'],
    markerStrategy: 'any' as const,
    moduleSpecPattern: 'BUILD.bazel',
    language: Object.freeze([]),
    confidence: 0.85,
    parser: 'starlark' as const,
  },
  {
    id: 'buck2',
    displayName: 'Buck2',
    markers: ['.buckconfig', '.buckroot'],
    markerStrategy: 'any' as const,
    moduleSpecPattern: 'BUCK',
    language: Object.freeze([]),
    confidence: 0.85,
    parser: 'starlark' as const,
  },
  // ── Tier 1: Android Gradle Convention Plugins ──
  {
    id: 'gradle-convention',
    displayName: 'Gradle Convention Plugins',
    markers: ['build-logic/convention/', 'buildSrc/src/main/kotlin/'],
    markerStrategy: 'any' as const,
    moduleSpecPattern: null,
    language: Object.freeze(['kotlin', 'java']),
    confidence: 0.8,
    parser: 'gradle-dsl' as const,
  },
  // ── Tier 1: Flutter Melos ──
  {
    id: 'melos',
    displayName: 'Melos (Flutter Monorepo)',
    markers: ['melos.yaml'],
    moduleSpecPattern: null,
    language: Object.freeze(['dart']),
    confidence: 0.82,
    parser: 'yaml' as const,
  },
  // ── Tier 1: iOS 生态 ──
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
    id: 'ks-component',
    displayName: 'KSComponent (快手)',
    markers: ['KSPodfile', 'Podfile.ks'],
    markerStrategy: 'any' as const,
    moduleSpecPattern: '*.podspec',
    language: Object.freeze(['swift', 'objectivec']),
    confidence: 0.8,
    parser: 'ruby-dsl' as const,
  },
  {
    id: 'mt-component',
    displayName: 'MTComponent (美团)',
    markers: ['MTModulefile', 'MTConfig.yml'],
    markerStrategy: 'any' as const,
    moduleSpecPattern: '*.podspec',
    language: Object.freeze(['swift', 'objectivec']),
    confidence: 0.78,
    parser: 'ruby-dsl' as const,
  },
  // ── Tier 1: 混合架构 ──
  {
    id: 'flutter-add-to-app',
    displayName: 'Flutter Add-to-App',
    markers: ['.flutter-plugins-dependencies', '.flutter-plugins'],
    markerStrategy: 'any' as const,
    moduleSpecPattern: 'pubspec.yaml',
    language: Object.freeze(['dart']),
    confidence: 0.78,
    parser: 'json-config' as const,
  },
  {
    id: 'react-native-hybrid',
    displayName: 'React Native Hybrid',
    markers: ['metro.config.js', 'metro.config.ts', 'react-native.config.js'],
    markerStrategy: 'any' as const,
    moduleSpecPattern: null,
    language: Object.freeze(['typescript', 'javascript']),
    confidence: 0.78,
    parser: 'json-config' as const,
  },
  {
    id: 'kotlin-multiplatform',
    displayName: 'Kotlin Multiplatform',
    markers: ['shared/build.gradle.kts'],
    moduleSpecPattern: null,
    language: Object.freeze(['kotlin']),
    confidence: 0.78,
    parser: 'gradle-dsl' as const,
  },
  // ── Tier 2: Nx / Pants / CMake ──
  {
    id: 'nx-monorepo',
    displayName: 'Nx Monorepo',
    markers: ['nx.json'],
    moduleSpecPattern: 'project.json',
    language: Object.freeze(['typescript', 'javascript']),
    confidence: 0.8,
    parser: 'json-config' as const,
  },
  {
    id: 'pants',
    displayName: 'Pants Build',
    markers: ['pants.toml'],
    moduleSpecPattern: 'BUILD',
    language: Object.freeze([]),
    confidence: 0.8,
    parser: 'starlark' as const,
  },
  {
    id: 'cmake-multiproject',
    displayName: 'CMake Multi-Project',
    markers: ['CMakeLists.txt'],
    antiMarkers: ['MODULE.bazel', 'WORKSPACE', 'meson.build'],
    moduleSpecPattern: 'CMakeLists.txt',
    language: Object.freeze(['cpp', 'c']),
    confidence: 0.75,
    parser: 'cmake' as const,
  },
  {
    id: 'xcodegen',
    displayName: 'XcodeGen',
    markers: ['project.yml', 'project.yaml'],
    markerStrategy: 'any' as const,
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
        parser: [
          'ruby-dsl',
          'yaml',
          'swift-dsl',
          'starlark',
          'gradle-dsl',
          'cmake',
          'json-config',
        ].includes(item.parser)
          ? item.parser
          : 'ruby-dsl',
        markerStrategy: ['all', 'any', 'ordered'].includes(item.markerStrategy)
          ? item.markerStrategy
          : undefined,
        antiMarkers: Array.isArray(item.antiMarkers) ? item.antiMarkers.map(String) : undefined,
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
      // antiMarkers 排除检查
      if (system.antiMarkers?.some((am) => existsSync(join(projectRoot, am)))) {
        continue;
      }

      const strategy = system.markerStrategy ?? 'all';
      let markerFound = false;

      if (strategy === 'any') {
        markerFound = system.markers.some((marker) => existsSync(join(projectRoot, marker)));
      } else {
        // 'all' 和 'ordered' 都要求所有 markers 存在（ordered 未来可扩展）
        markerFound = system.markers.every((marker) => existsSync(join(projectRoot, marker)));
      }

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
      if (system.antiMarkers?.some((am) => existsSync(join(projectRoot, am)))) {
        continue;
      }
      const strategy = system.markerStrategy ?? 'all';
      const markerFound =
        strategy === 'any'
          ? system.markers.some((marker) => existsSync(join(projectRoot, marker)))
          : system.markers.every((marker) => existsSync(join(projectRoot, marker)));
      if (markerFound) {
        this.#matchedSystem = system;
        break;
      }
    }

    if (!this.#matchedSystem) {
      this.#loadHeuristic(projectRoot);
      return;
    }

    switch (this.#matchedSystem.parser) {
      case 'ruby-dsl':
        this.#loadRubyDsl(projectRoot);
        break;
      case 'yaml':
        this.#loadYaml(projectRoot);
        break;
      case 'starlark':
        this.#loadStarlark(projectRoot);
        break;
      case 'gradle-dsl':
        this.#loadGradleDsl(projectRoot);
        break;
      case 'cmake':
        this.#loadCMake(projectRoot);
        break;
      case 'json-config':
        this.#loadJsonConfig(projectRoot);
        break;
      default:
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

    // Melos 项目走专用加载路径
    if (system.id === 'melos') {
      this.#loadMelos(projectRoot, yamlContent);
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

  // ── Private: Melos 加载 ──────────────────────────────

  #loadMelos(projectRoot: string, yamlContent: string) {
    const melos = parseMelosProject(yamlContent);

    // 使用 glob 模式扫描 pubspec.yaml 文件
    const pubspecFiles = this.#findBuildFiles(projectRoot, ['pubspec.yaml']);

    for (const pf of pubspecFiles) {
      // 排除根目录 pubspec
      if (pf === join(projectRoot, 'pubspec.yaml')) {
        continue;
      }

      try {
        const content = readFileSync(pf, 'utf-8');
        const nameMatch = content.match(/^name:\s*(\S+)/m);
        if (nameMatch) {
          const modDir = join(pf, '..');
          const relPath = relative(projectRoot, modDir);

          this.#targets.push({
            name: nameMatch[1],
            path: modDir,
            type: 'library',
            language: 'dart',
            metadata: {
              melosProject: melos.name,
              pubspecPath: relative(projectRoot, pf),
              packageDir: relPath,
            },
          });
        }
      } catch {
        /* skip */
      }
    }
  }

  // ── Private: Starlark 加载 (Bazel/Buck2/Pants) ──────

  #loadStarlark(projectRoot: string) {
    const system = this.#matchedSystem!;
    const specPattern = system.moduleSpecPattern ?? 'BUILD';
    const buildFileNames = specPattern === 'BUCK' ? ['BUCK'] : ['BUILD.bazel', 'BUILD'];

    // 扫描所有 BUILD 文件
    const buildFiles = this.#findBuildFiles(projectRoot, buildFileNames);
    const allTargets: ParsedBuildFile['targets'] = [];
    const detectedLanguages = new Set<string>();

    for (const buildFile of buildFiles) {
      try {
        const content = readFileSync(buildFile, 'utf-8');
        const parsed = parseStarlarkBuildFile(content);

        const dirRelative = relative(projectRoot, buildFile).replace(/\/[^/]+$/, '') || '.';

        for (const target of parsed.targets) {
          allTargets.push(target);

          // 语言推断
          const lang = RULE_TO_LANGUAGE[target.rule];
          if (lang) {
            detectedLanguages.add(lang);
          }

          const modulePath = join(projectRoot, dirRelative);
          this.#targets.push({
            name: target.name,
            path: modulePath,
            type:
              target.rule.includes('binary') || target.rule.includes('executable')
                ? 'application'
                : 'library',
            language: lang ?? 'unknown',
            metadata: {
              rule: target.rule,
              visibility: target.visibility,
              buildFile: relative(projectRoot, buildFile),
            },
          });
        }
      } catch {
        /* skip unreadable BUILD files */
      }
    }
  }

  #findBuildFiles(dir: string, names: string[], depth = 0): string[] {
    if (depth > 8) {
      return [];
    }
    const results: string[] = [];
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || EXCLUDE_DIRS.has(entry.name)) {
          continue;
        }
        const fullPath = join(dir, entry.name);
        if (entry.isFile() && names.includes(entry.name)) {
          results.push(fullPath);
        } else if (entry.isDirectory()) {
          results.push(...this.#findBuildFiles(fullPath, names, depth + 1));
        }
      }
    } catch {
      /* skip */
    }
    return results;
  }

  // ── Private: Gradle DSL 加载 ─────────────────────────

  #loadGradleDsl(projectRoot: string) {
    // 查找 settings.gradle.kts 或 settings.gradle
    let settingsContent: string | null = null;
    for (const name of ['settings.gradle.kts', 'settings.gradle']) {
      const settingsPath = join(projectRoot, name);
      if (existsSync(settingsPath)) {
        try {
          settingsContent = readFileSync(settingsPath, 'utf-8');
          break;
        } catch {
          /* skip */
        }
      }
    }

    if (!settingsContent) {
      this.#loadHeuristic(projectRoot);
      return;
    }

    const project = parseGradleProject(settingsContent);
    const primaryLang = (this.#matchedSystem?.language[0] as string) || 'kotlin';

    // 解析每个模块的 build.gradle.kts
    for (const mod of project.includedModules) {
      const modulePath = join(projectRoot, mod.directory);
      if (!existsSync(modulePath)) {
        continue;
      }

      // 读取 build.gradle.kts 获取 dependencies 和 plugins
      for (const buildName of ['build.gradle.kts', 'build.gradle']) {
        const buildPath = join(modulePath, buildName);
        if (existsSync(buildPath)) {
          try {
            const buildContent = readFileSync(buildPath, 'utf-8');
            const updatedMod = parseGradleProject(buildContent, mod);
            // 更新 module 的 convention plugin 和 dependencies
            mod.conventionPlugin =
              updatedMod.includedModules[0]?.conventionPlugin ?? mod.conventionPlugin;
            mod.dependencies = updatedMod.includedModules[0]?.dependencies ?? mod.dependencies;
          } catch {
            /* skip */
          }
          break;
        }
      }

      const inferredRole = mod.conventionPlugin
        ? inferConventionRole(mod.conventionPlugin)
        : undefined;

      this.#targets.push({
        name: mod.path,
        path: modulePath,
        type: mod.path === ':app' ? 'application' : 'library',
        language: primaryLang,
        metadata: {
          gradlePath: mod.path,
          conventionPlugin: mod.conventionPlugin,
          conventionRole: inferredRole,
        },
      });
    }
  }

  // ── Private: CMake 加载 ──────────────────────────────

  #loadCMake(projectRoot: string) {
    const cmakePath = join(projectRoot, 'CMakeLists.txt');
    if (!existsSync(cmakePath)) {
      this.#loadHeuristic(projectRoot);
      return;
    }

    let content: string;
    try {
      content = readFileSync(cmakePath, 'utf-8');
    } catch {
      return;
    }

    const project = parseCMakeProject(content);
    const primaryLang = (this.#matchedSystem?.language[0] as string) || 'cpp';

    // 主目标
    for (const target of project.targets) {
      this.#targets.push({
        name: target.name,
        path: projectRoot,
        type: target.type === 'executable' ? 'application' : 'library',
        language: primaryLang,
        metadata: {
          cmakeType: target.type,
        },
      });
    }

    // 递归解析子目录的 CMakeLists.txt
    for (const subdir of project.subdirectories) {
      const subdirPath = join(projectRoot, subdir);
      const subdirCmakePath = join(subdirPath, 'CMakeLists.txt');
      if (!existsSync(subdirCmakePath)) {
        continue;
      }

      try {
        const subcontent = readFileSync(subdirCmakePath, 'utf-8');
        const subproject = parseCMakeProject(subcontent);

        for (const target of subproject.targets) {
          this.#targets.push({
            name: target.name,
            path: subdirPath,
            type: target.type === 'executable' ? 'application' : 'library',
            language: primaryLang,
            metadata: {
              cmakeType: target.type,
              subdirectory: subdir,
            },
          });
        }
      } catch {
        /* skip */
      }
    }
  }

  // ── Private: JSON Config 加载 (Nx/Flutter/RN) ────────

  #loadJsonConfig(projectRoot: string) {
    const system = this.#matchedSystem!;

    switch (system.id) {
      case 'nx-monorepo':
        this.#loadNx(projectRoot);
        break;
      case 'flutter-add-to-app':
        this.#loadFlutterAddToApp(projectRoot);
        break;
      case 'react-native-hybrid':
        this.#loadReactNative(projectRoot);
        break;
      default:
        this.#loadHeuristic(projectRoot);
    }
  }

  #loadNx(projectRoot: string) {
    const nxJsonPath = join(projectRoot, 'nx.json');
    if (!existsSync(nxJsonPath)) {
      return;
    }

    // 扫描所有 project.json 文件
    const projectJsonFiles = this.#findBuildFiles(projectRoot, ['project.json']);
    const projects: Array<{ name: string; root: string; projectType: string; tags: string[] }> = [];

    for (const pjFile of projectJsonFiles) {
      try {
        const content = readFileSync(pjFile, 'utf-8');
        const parsed = parseNxWorkspace(content);
        for (const proj of parsed.projects) {
          projects.push(proj);
          const modulePath = join(projectRoot, proj.root);

          this.#targets.push({
            name: proj.name,
            path: modulePath,
            type: proj.projectType === 'application' ? 'application' : 'library',
            language: 'typescript',
            metadata: {
              tags: proj.tags,
              nxProjectType: proj.projectType,
            },
          });
        }
      } catch {
        /* skip */
      }
    }
  }

  #loadFlutterAddToApp(projectRoot: string) {
    // 解析 .flutter-plugins-dependencies
    const depsPath = join(projectRoot, '.flutter-plugins-dependencies');
    if (existsSync(depsPath)) {
      try {
        const content = readFileSync(depsPath, 'utf-8');
        const parsed = parseFlutterPluginsDeps(content);

        for (const plugin of parsed.plugins) {
          this.#targets.push({
            name: plugin.name,
            path: plugin.path,
            type: 'library',
            language: 'dart',
            metadata: {
              platform: plugin.platform,
              bridgeType: 'flutter-engine',
            },
          });
        }
      } catch {
        /* skip */
      }
    }

    // 查找嵌入的 pubspec.yaml
    const pubspecFiles = this.#findBuildFiles(projectRoot, ['pubspec.yaml']);
    for (const pf of pubspecFiles) {
      // 排除根目录的 pubspec（交给 DartDiscoverer 处理）
      if (pf === join(projectRoot, 'pubspec.yaml')) {
        continue;
      }

      try {
        const content = readFileSync(pf, 'utf-8');
        const nameMatch = content.match(/^name:\s*(\S+)/m);
        if (nameMatch) {
          const modDir = join(pf, '..');
          this.#targets.push({
            name: nameMatch[1],
            path: modDir,
            type: 'library',
            language: 'dart',
            metadata: {
              pubspecPath: relative(projectRoot, pf),
            },
          });
        }
      } catch {
        /* skip */
      }
    }
  }

  #loadReactNative(projectRoot: string) {
    const pkgJsonPath = join(projectRoot, 'package.json');
    if (!existsSync(pkgJsonPath)) {
      return;
    }

    try {
      const content = readFileSync(pkgJsonPath, 'utf-8');
      const parsed = parseReactNativeProject(content);

      if (parsed.isReactNative) {
        this.#targets.push({
          name: parsed.name,
          path: projectRoot,
          type: 'application',
          language: 'typescript',
          metadata: {
            rnVersion: parsed.rnVersion,
            bridgeType: 'native-module',
          },
        });
      }
    } catch {
      /* skip */
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
