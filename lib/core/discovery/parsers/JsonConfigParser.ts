/**
 * @module JsonConfigParser
 * @description JSON 配置文件解析器 — 支持 Nx project.json、Flutter 插件依赖、React Native 检测
 *
 * 每个解析函数接受文件内容字符串，返回类型化结果。
 */

// ── Nx 类型 ─────────────────────────────────────────

export interface ParsedNxWorkspace {
  projects: NxProject[];
}

export interface NxProject {
  name: string;
  root: string;
  projectType: string;
  tags: string[];
}

// ── Flutter 类型 ────────────────────────────────────

export interface ParsedFlutterPluginsDeps {
  plugins: FlutterPlugin[];
  flutterSdkVersion?: string;
}

export interface FlutterPlugin {
  name: string;
  path: string;
  platform: string;
}

// ── React Native 类型 ──────────────────────────────

export interface ParsedReactNativeProject {
  isReactNative: boolean;
  name: string;
  rnVersion?: string;
  hasFabric?: boolean;
  hasTurboModules?: boolean;
}

// ── Nx 解析 ─────────────────────────────────────────

/**
 * 解析 Nx project.json 内容
 * 每个 project.json 描述一个项目
 */
export function parseNxWorkspace(content: string): ParsedNxWorkspace {
  const result: ParsedNxWorkspace = { projects: [] };

  try {
    const json = JSON.parse(content) as Record<string, unknown>;

    const name = (json.name as string) ?? '';
    const root = (json.root as string) ?? (json.sourceRoot as string) ?? '.';
    const projectType = (json.projectType as string) ?? 'library';
    const tags = Array.isArray(json.tags) ? (json.tags as string[]) : [];

    if (name) {
      result.projects.push({ name, root, projectType, tags });
    }
  } catch {
    // JSON 解析失败时返回空结果
  }

  return result;
}

// ── Flutter 解析 ────────────────────────────────────

/**
 * 解析 .flutter-plugins-dependencies 文件内容
 * 该文件由 Flutter 工具链自动生成
 */
export function parseFlutterPluginsDeps(content: string): ParsedFlutterPluginsDeps {
  const result: ParsedFlutterPluginsDeps = { plugins: [] };

  try {
    const json = JSON.parse(content) as Record<string, unknown>;

    // dependencyGraph 数组包含 Flutter embedding 信息
    const depGraph = json.dependencyGraph;
    if (Array.isArray(depGraph)) {
      for (const entry of depGraph) {
        if (typeof entry === 'object' && entry !== null) {
          const rec = entry as Record<string, unknown>;
          const name = (rec.name as string) ?? '';
          if (name && name !== 'flutter') {
            result.plugins.push({
              name,
              path: (rec.path as string) ?? '',
              platform: 'flutter',
            });
          }
        }
      }
    }

    // 也解析 plugins.ios / plugins.android 中的平台插件
    const plugins = json.plugins;
    if (typeof plugins === 'object' && plugins !== null) {
      const platformPlugins = plugins as Record<string, unknown>;
      for (const [platform, list] of Object.entries(platformPlugins)) {
        if (Array.isArray(list)) {
          for (const p of list) {
            if (typeof p === 'object' && p !== null) {
              const rec = p as Record<string, unknown>;
              const name = (rec.name as string) ?? '';
              // 避免重复
              if (
                name &&
                !result.plugins.some(
                  (existing) => existing.name === name && existing.platform === platform
                )
              ) {
                result.plugins.push({
                  name,
                  path: (rec.path as string) ?? '',
                  platform,
                });
              }
            }
          }
        }
      }
    }

    // Flutter SDK 版本
    if (typeof json.flutterVersion === 'string') {
      result.flutterSdkVersion = json.flutterVersion;
    }
  } catch {
    // JSON 解析失败时返回空结果
  }

  return result;
}

// ── React Native 解析 ──────────────────────────────

/**
 * 解析 package.json 内容，判断是否是 React Native 项目
 */
export function parseReactNativeProject(content: string): ParsedReactNativeProject {
  const result: ParsedReactNativeProject = {
    isReactNative: false,
    name: '',
  };

  try {
    const json = JSON.parse(content) as Record<string, unknown>;
    result.name = (json.name as string) ?? '';

    const deps = (json.dependencies ?? {}) as Record<string, string>;
    const devDeps = (json.devDependencies ?? {}) as Record<string, string>;

    if (deps['react-native'] || devDeps['react-native']) {
      result.isReactNative = true;
      result.rnVersion = deps['react-native'] ?? devDeps['react-native'];
    }

    // Fabric (new architecture) 检测
    if (result.isReactNative) {
      const scripts = (json.scripts ?? {}) as Record<string, string>;
      result.hasFabric =
        deps['react-native-codegen'] !== undefined ||
        Object.values(scripts).some((s) => s.includes('codegen'));

      // TurboModules 检测
      result.hasTurboModules =
        typeof json.codegenConfig === 'object' || deps['react-native-turbo-modules'] !== undefined;
    }
  } catch {
    // JSON 解析失败时返回空结果
  }

  return result;
}
