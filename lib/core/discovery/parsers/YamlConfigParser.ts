/**
 * @module YamlConfigParser
 * @description YAML 配置解析器 — 从 XcodeGen project.yml 中提取项目结构信息
 *
 * 支持解析：
 *  - targets（构建目标）及其依赖关系
 *  - settings（项目级/目标级构建设置）
 *  - schemes（构建方案）
 *  - sources（源文件路径）
 *
 * 使用 js-yaml 进行安全解析（禁用危险的 YAML 特性）。
 */

import yaml from 'js-yaml';

import type { ParsedModule, ParsedModuleSpec, ParsedProjectConfig } from './RubyDslParser.js';

// ── XcodeGen YAML 类型 ───────────────────────────────

interface XcodeGenProject {
  name?: string;
  options?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  settingGroups?: Record<string, Record<string, unknown>>;
  targets?: Record<string, XcodeGenTarget>;
  schemes?: Record<string, unknown>;
  packages?: Record<string, XcodeGenPackage>;
  fileGroups?: string[];
  configFiles?: Record<string, string>;
  include?: Array<{ path: string }>;
}

interface XcodeGenTarget {
  type?: string;
  platform?: string | string[];
  deploymentTarget?: string | Record<string, string>;
  sources?: Array<string | XcodeGenSource>;
  dependencies?: Array<XcodeGenDependency>;
  settings?: Record<string, unknown>;
  scheme?: Record<string, unknown>;
  info?: Record<string, unknown>;
  configFiles?: Record<string, string>;
  preBuildScripts?: unknown[];
  postBuildScripts?: unknown[];
}

interface XcodeGenSource {
  path: string;
  name?: string;
  group?: string;
  excludes?: string[];
  includes?: string[];
}

interface XcodeGenDependency {
  target?: string;
  framework?: string;
  package?: string;
  sdk?: string;
  carthage?: string;
  embed?: boolean;
  link?: boolean;
  implicit?: boolean;
}

interface XcodeGenPackage {
  url?: string;
  from?: string;
  version?: string;
  branch?: string;
  revision?: string;
  path?: string;
}

// ── 目标类型 → 层级推断 ────────────────────────────────

const TARGET_TYPE_LAYER: Record<string, string> = {
  application: 'App',
  'app-extension': 'Extension',
  framework: 'Framework',
  'static-library': 'Library',
  'dynamic-library': 'Library',
  bundle: 'Resource',
  'unit-test': 'Test',
  'ui-test': 'Test',
  tool: 'Tool',
};

// ── 公开 API ────────────────────────────────────────

/**
 * 解析 XcodeGen project.yml 内容
 * 返回与 RubyDslParser 兼容的 ParsedProjectConfig
 */
export function parseXcodeGenProject(content: string): ParsedProjectConfig {
  let doc: XcodeGenProject | null;
  try {
    doc = yaml.load(content, { schema: yaml.CORE_SCHEMA }) as XcodeGenProject | null;
  } catch {
    return { layers: [], globalDependencies: [] };
  }

  if (!doc || typeof doc !== 'object') {
    return { layers: [], globalDependencies: [] };
  }

  const result: ParsedProjectConfig = {
    layers: [],
    globalDependencies: [],
  };

  // 提取宿主应用
  if (doc.name) {
    result.hostApp = { name: doc.name, version: '0.0.0' };
  }

  if (!doc.targets) {
    return result;
  }

  // 将 targets 按类型分层
  const layerMap = new Map<string, ParsedModule[]>();

  for (const [targetName, target] of Object.entries(doc.targets)) {
    const targetType = target.type ?? 'framework';
    const layerName = TARGET_TYPE_LAYER[targetType] ?? 'Other';
    const isLocal = !isExternalTarget(targetName, doc);

    const mod: ParsedModule = {
      name: targetName,
      version: '0.0.0',
      isLocal,
      localPath: extractSourcePath(target),
      group: layerName,
    };

    if (!layerMap.has(layerName)) {
      layerMap.set(layerName, []);
    }
    layerMap.get(layerName)?.push(mod);
  }

  // 转为 ParsedLayer[]
  let order = 0;
  for (const [name, modules] of layerMap.entries()) {
    result.layers.push({
      name,
      order: order++,
      accessibleLayers: [],
      modules,
    });
  }

  // 提取 SPM packages → globalDependencies
  if (doc.packages) {
    for (const [pkgName, pkg] of Object.entries(doc.packages)) {
      result.globalDependencies.push({
        name: pkgName,
        version: pkg.from ?? pkg.version ?? pkg.branch ?? '0.0.0',
        isLocal: !!pkg.path,
        localPath: pkg.path,
      });
    }
  }

  return result;
}

/**
 * 解析单个 target 为 ParsedModuleSpec 格式
 */
export function parseXcodeGenTarget(targetName: string, content: string): ParsedModuleSpec | null {
  let doc: XcodeGenProject | null;
  try {
    doc = yaml.load(content, { schema: yaml.CORE_SCHEMA }) as XcodeGenProject | null;
  } catch {
    return null;
  }

  if (!doc?.targets?.[targetName]) {
    return null;
  }

  const target = doc.targets[targetName];

  return {
    name: targetName,
    version: '0.0.0',
    sources: extractSourcePath(target) ?? targetName,
    dependencies: extractTargetDependencies(target),
    publicHeaders: [],
    deploymentTarget: extractDeploymentTarget(target),
  };
}

/**
 * 提取所有 target 的依赖图
 * 返回 [from, to][] 形式的有向边列表
 */
export function extractXcodeGenDependencyEdges(content: string): Array<[string, string]> {
  let doc: XcodeGenProject | null;
  try {
    doc = yaml.load(content, { schema: yaml.CORE_SCHEMA }) as XcodeGenProject | null;
  } catch {
    return [];
  }

  if (!doc?.targets) {
    return [];
  }

  const edges: Array<[string, string]> = [];

  for (const [targetName, target] of Object.entries(doc.targets)) {
    if (!target.dependencies) {
      continue;
    }
    for (const dep of target.dependencies) {
      const depName = dep.target ?? dep.framework ?? dep.package ?? dep.carthage;
      if (depName) {
        edges.push([targetName, depName]);
      }
    }
  }

  return edges;
}

// ── 内部帮助函数 ────────────────────────────────────

function extractSourcePath(target: XcodeGenTarget): string | undefined {
  if (!target.sources || target.sources.length === 0) {
    return undefined;
  }

  const first = target.sources[0];
  if (typeof first === 'string') {
    return first;
  }
  return first.path;
}

function extractTargetDependencies(target: XcodeGenTarget): string[] {
  if (!target.dependencies) {
    return [];
  }

  return target.dependencies
    .map((dep) => dep.target ?? dep.framework ?? dep.package ?? dep.carthage)
    .filter((name): name is string => !!name);
}

function extractDeploymentTarget(target: XcodeGenTarget): string | undefined {
  if (!target.deploymentTarget) {
    return undefined;
  }
  if (typeof target.deploymentTarget === 'string') {
    return target.deploymentTarget;
  }
  // Object form: { iOS: "15.0", macOS: "12.0" }
  const values = Object.values(target.deploymentTarget);
  return values[0] as string | undefined;
}

function isExternalTarget(targetName: string, doc: XcodeGenProject): boolean {
  // SPM packages referenced as targets are external
  if (doc.packages?.[targetName]) {
    return true;
  }
  // Targets defined in the project are local
  return false;
}

// ── Melos YAML 解析 ─────────────────────────────────

interface MelosConfig {
  name?: string;
  packages?: string[];
  scripts?: Record<string, unknown>;
  command?: Record<string, unknown>;
  ide?: Record<string, unknown>;
}

export interface ParsedMelosProject {
  name: string;
  packageGlobs: string[];
  scripts: string[];
}

/**
 * 解析 melos.yaml 内容
 * 提取项目名、包路径 glob 模式、scripts 列表
 */
export function parseMelosProject(content: string): ParsedMelosProject {
  const result: ParsedMelosProject = {
    name: '',
    packageGlobs: [],
    scripts: [],
  };

  try {
    const doc = yaml.load(content, { schema: yaml.CORE_SCHEMA }) as MelosConfig | null;
    if (!doc) {
      return result;
    }

    result.name = doc.name ?? '';

    if (Array.isArray(doc.packages)) {
      result.packageGlobs = doc.packages.filter((p): p is string => typeof p === 'string');
    }

    if (doc.scripts && typeof doc.scripts === 'object') {
      result.scripts = Object.keys(doc.scripts);
    }
  } catch {
    // YAML 解析失败时返回空结果
  }

  return result;
}
