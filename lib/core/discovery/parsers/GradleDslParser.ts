/**
 * @module GradleDslParser
 * @description Gradle DSL 轻量解析器 — 从 settings.gradle.kts / build.gradle.kts 提取项目拓扑
 *
 * 支持解析：
 *  - settings.gradle.kts: rootProject.name + include() 模块声明
 *  - build.gradle.kts: plugins {} + dependencies {} (project-to-project)
 *  - settings.gradle (Groovy 语法)
 *
 * 同时支持 Kotlin DSL 和 Groovy DSL 的正则模式。
 */

// ── 解析结果类型 ─────────────────────────────────────

export interface ParsedGradleProject {
  rootProjectName: string;
  includedModules: GradleModule[];
  versionCatalog?: string;
}

export interface GradleModule {
  path: string;
  directory: string;
  conventionPlugin?: string;
  dependencies: GradleDep[];
}

export interface GradleDep {
  configuration: string;
  target: string;
  isProject: boolean;
}

// ── settings.gradle 解析模式 ─────────────────────────

const SETTINGS_ROOT_NAME_KT = /rootProject\.name\s*=\s*"([^"]+)"/;
const SETTINGS_ROOT_NAME_GR = /rootProject\.name\s*=\s*'([^']+)'/;

// Kotlin DSL: include(":core:network") 或 include(":app", ":core")
const INCLUDE_KT = /include\(\s*((?:"[^"]+"(?:\s*,\s*)?)+)\s*\)/g;
// Groovy DSL: include ':core:network' 或 include ':app', ':core'
const INCLUDE_GR = /include\s+((?:'[^']+'(?:\s*,\s*)?)+)/g;

// ── build.gradle 解析模式 ────────────────────────────

// Kotlin DSL: id("myapp.android.feature")
const PLUGIN_KT = /id\(\s*"([^"]+)"\s*\)/g;
// Groovy DSL: id 'myapp.android.feature'
const PLUGIN_GR = /id\s+'([^']+)'/g;

// Kotlin DSL: implementation(project(":core:network"))
const PROJECT_DEP_KT =
  /(implementation|api|compileOnly|testImplementation|runtimeOnly|kapt|ksp)\s*\(\s*project\(\s*"([^"]+)"\s*\)\s*\)/g;
// Groovy DSL: implementation project(':core:network')
const PROJECT_DEP_GR =
  /(implementation|api|compileOnly|testImplementation|runtimeOnly|kapt|ksp)\s+project\(\s*['"]([^'"]+)['"]\s*\)/g;

// kotlin("multiplatform") plugin detection
const KMP_PLUGIN_RE = /kotlin\(\s*"multiplatform"\s*\)/;

// ── 公开 API ────────────────────────────────────────

/**
 * 解析 settings.gradle.kts / settings.gradle 内容
 * 提取 rootProject 名和所有 include 模块
 *
 * 当传入 build 文件内容时（附带 module 参数），解析 plugins 和 dependencies 到该模块上
 */
export function parseGradleProject(
  content: string,
  existingModule?: GradleModule
): ParsedGradleProject {
  const result: ParsedGradleProject = {
    rootProjectName: '',
    includedModules: [],
  };

  // 如果传入了 existingModule，解析 build 文件内容
  if (existingModule) {
    const updatedMod = parseBuildFileForModule(content, existingModule);
    result.includedModules = [updatedMod];
    return result;
  }

  // 解析 rootProject.name
  const rootNameKt = content.match(SETTINGS_ROOT_NAME_KT);
  const rootNameGr = content.match(SETTINGS_ROOT_NAME_GR);
  result.rootProjectName = rootNameKt?.[1] ?? rootNameGr?.[1] ?? '';

  // 解析 include 声明
  const modules = new Map<string, GradleModule>();

  // Kotlin DSL includes
  const ktContent = content;
  let m: RegExpExecArray | null;
  const ktIncludeRe = new RegExp(INCLUDE_KT.source, 'g');
  while ((m = ktIncludeRe.exec(ktContent)) !== null) {
    const innerStr = m[1];
    const pathRe = /"([^"]+)"/g;
    let pathMatch: RegExpExecArray | null;
    while ((pathMatch = pathRe.exec(innerStr)) !== null) {
      const modPath = pathMatch[1];
      if (!modules.has(modPath)) {
        modules.set(modPath, {
          path: modPath,
          directory: modPath.replace(/^:/, '').replace(/:/g, '/'),
          dependencies: [],
        });
      }
    }
  }

  // Groovy DSL includes
  const grIncludeRe = new RegExp(INCLUDE_GR.source, 'g');
  while ((m = grIncludeRe.exec(content)) !== null) {
    const innerStr = m[1];
    const pathRe = /'([^']+)'/g;
    let pathMatch: RegExpExecArray | null;
    while ((pathMatch = pathRe.exec(innerStr)) !== null) {
      const modPath = pathMatch[1];
      if (!modules.has(modPath)) {
        modules.set(modPath, {
          path: modPath,
          directory: modPath.replace(/^:/, '').replace(/:/g, '/'),
          dependencies: [],
        });
      }
    }
  }

  // 检测 version catalog
  if (content.includes('libs.versions.toml') || content.includes('versionCatalogs')) {
    result.versionCatalog = 'gradle/libs.versions.toml';
  }

  result.includedModules = [...modules.values()];
  return result;
}

/**
 * 检测 build 文件中是否使用了 Kotlin Multiplatform 插件
 */
export function isKmpBuildFile(content: string): boolean {
  return KMP_PLUGIN_RE.test(content);
}

// ── 内部函数 ────────────────────────────────────────

function parseBuildFileForModule(content: string, module: GradleModule): GradleModule {
  const result: GradleModule = { ...module, dependencies: [] };

  // 提取 convention plugin
  const pluginKtRe = new RegExp(PLUGIN_KT.source, 'g');
  const pluginGrRe = new RegExp(PLUGIN_GR.source, 'g');
  let m: RegExpExecArray | null;

  while ((m = pluginKtRe.exec(content)) !== null) {
    const pluginId = m[1];
    // Convention plugins 通常是项目自定义的（包含项目名前缀）
    if (
      pluginId.includes('.') &&
      !pluginId.startsWith('com.android') &&
      !pluginId.startsWith('org.jetbrains')
    ) {
      result.conventionPlugin = pluginId;
      break;
    }
  }
  if (!result.conventionPlugin) {
    while ((m = pluginGrRe.exec(content)) !== null) {
      const pluginId = m[1];
      if (
        pluginId.includes('.') &&
        !pluginId.startsWith('com.android') &&
        !pluginId.startsWith('org.jetbrains')
      ) {
        result.conventionPlugin = pluginId;
        break;
      }
    }
  }

  // 提取 project dependencies
  const depKtRe = new RegExp(PROJECT_DEP_KT.source, 'g');
  const depGrRe = new RegExp(PROJECT_DEP_GR.source, 'g');

  while ((m = depKtRe.exec(content)) !== null) {
    result.dependencies.push({
      configuration: m[1],
      target: m[2],
      isProject: true,
    });
  }

  while ((m = depGrRe.exec(content)) !== null) {
    result.dependencies.push({
      configuration: m[1],
      target: m[2],
      isProject: true,
    });
  }

  return result;
}

/**
 * 从 convention plugin id 推断模块角色
 * 例: "myapp.android.feature" → "feature"
 */
export function inferConventionRole(pluginId: string): string | undefined {
  const parts = pluginId.split('.');
  const last = parts[parts.length - 1];

  const ROLE_KEYWORDS: Record<string, string> = {
    feature: 'feature',
    library: 'library',
    app: 'application',
    application: 'application',
    core: 'core',
    data: 'data',
    domain: 'domain',
    ui: 'ui',
    test: 'test',
    compose: 'compose',
    hilt: 'di',
  };

  return ROLE_KEYWORDS[last] ?? undefined;
}
