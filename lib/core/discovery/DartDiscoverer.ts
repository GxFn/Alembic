/**
 * @module DartDiscoverer
 * @description Dart / Flutter 项目结构发现器
 *
 * 检测信号: pubspec.yaml, pubspec.lock, .dart_tool/, *.dart
 * 支持: 单 Package 项目、Flutter 应用、Melos 多包工作区
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';
import { ProjectDiscoverer } from './ProjectDiscoverer.js';

const SOURCE_EXTENSIONS = new Set(['.dart']);

const EXCLUDE_DIRS = new Set([
  '.git',
  '.dart_tool',
  '.fvm',
  'build',
  'node_modules',
  '.idea',
  '.vscode',
  'ios',
  'android',
  'macos',
  'windows',
  'linux',
  'web',
  '.pub-cache',
  '.pub',
  '.cursor',
]);

export class DartDiscoverer extends ProjectDiscoverer {
  #projectRoot = null;
  #targets = [];
  #depGraph = { nodes: [], edges: [] };
  #packageName = null;

  // @ts-expect-error TS migration: TS2416
  get id() {
    return 'dart';
  }
  // @ts-expect-error TS migration: TS2416
  get displayName() {
    return 'Dart / Flutter';
  }

  // @ts-expect-error TS migration: TS2416
  async detect(projectRoot) {
    let confidence = 0;
    const reasons = [];

    if (existsSync(join(projectRoot, 'pubspec.yaml'))) {
      confidence = 0.92;
      reasons.push('pubspec.yaml exists');
    }
    if (existsSync(join(projectRoot, 'pubspec.lock'))) {
      confidence = Math.max(confidence, 0.7);
      if (confidence < 0.92) {
        confidence += 0.1;
      }
      reasons.push('pubspec.lock exists');
    }
    if (existsSync(join(projectRoot, '.dart_tool'))) {
      confidence = Math.max(confidence, 0.6);
      reasons.push('.dart_tool exists');
    }
    // Melos workspace
    if (existsSync(join(projectRoot, 'melos.yaml'))) {
      confidence = Math.max(confidence, 0.95);
      reasons.push('melos.yaml exists (workspace)');
    }

    // 兜底: 根目录有 .dart 文件
    if (confidence === 0) {
      try {
        const entries = readdirSync(projectRoot);
        if (entries.some((e) => e.endsWith('.dart'))) {
          confidence = 0.5;
          reasons.push('*.dart files found at root');
        }
      } catch {
        /* skip */
      }
    }

    return {
      match: confidence > 0,
      confidence: Math.min(confidence, 1.0),
      reason: reasons.join(', ') || 'No Dart markers found',
    };
  }

  async load(projectRoot) {
    this.#projectRoot = projectRoot;
    this.#targets = [];
    this.#depGraph = { nodes: [], edges: [] };

    // 解析 pubspec.yaml
    const pubspec = this.#parsePubspec(projectRoot);
    // @ts-expect-error TS migration: TS2339
    this.#packageName = pubspec?.name || basename(projectRoot);

    const framework = this.#detectFramework(pubspec);
    // @ts-expect-error TS migration: TS2339
    const isFlutter = framework === 'flutter' || !!pubspec?.dependencies?.flutter;

    // 主 Target — lib/
    this.#targets.push({
      name: this.#packageName,
      path: join(projectRoot, 'lib'),
      type: 'library',
      language: 'dart',
      framework,
      metadata: {
        packageName: this.#packageName,
        isFlutter,
        // @ts-expect-error TS migration: TS2339
        sdkVersion: pubspec?.environment?.sdk || null,
        // @ts-expect-error TS migration: TS2339
        flutterVersion: pubspec?.environment?.flutter || null,
      },
    });
    this.#depGraph.nodes.push(this.#packageName);

    // bin/ — CLI 应用入口
    const binDir = join(projectRoot, 'bin');
    if (existsSync(binDir)) {
      this.#targets.push({
        name: 'bin',
        path: binDir,
        type: 'application',
        language: 'dart',
        framework,
      });
    }

    // test/ — 测试目录
    for (const testDir of ['test', 'test_driver', 'integration_test']) {
      const testPath = join(projectRoot, testDir);
      if (existsSync(testPath)) {
        this.#targets.push({
          name: testDir,
          path: testPath,
          type: 'test',
          language: 'dart',
        });
      }
    }

    // example/ — 示例项目
    const exampleDir = join(projectRoot, 'example');
    if (existsSync(exampleDir) && existsSync(join(exampleDir, 'pubspec.yaml'))) {
      this.#targets.push({
        name: 'example',
        path: exampleDir,
        type: 'example',
        language: 'dart',
        framework,
      });
    }

    // Melos 多包工作区
    this.#discoverMelosPackages(projectRoot);

    // 解析依赖图
    this.#parseDependencies(pubspec);

    // 解析内部 import 关系
    this.#parseInternalImports(projectRoot);
  }

  // @ts-expect-error TS migration: TS2416
  async listTargets() {
    return this.#targets;
  }

  // @ts-expect-error TS migration: TS2416
  async getTargetFiles(target) {
    const targetPath =
      typeof target === 'string'
        ? this.#targets.find((t) => t.name === target)?.path || this.#projectRoot
        : target.path;

    if (!targetPath || !existsSync(targetPath)) {
      return [];
    }

    const files = [];
    this.#collectDartFiles(targetPath, targetPath, files);
    return files;
  }

  // @ts-expect-error TS migration: TS2416
  async getDependencyGraph() {
    return this.#depGraph;
  }

  // ── 内部实现 ──

  /**
   * 解析 pubspec.yaml（简易 YAML 解析，不引入三方依赖）
   */
  #parsePubspec(projectRoot) {
    const pubspecPath = join(projectRoot, 'pubspec.yaml');
    if (!existsSync(pubspecPath)) {
      return null;
    }
    try {
      const content = readFileSync(pubspecPath, 'utf8');
      return this.#parseSimpleYaml(content);
    } catch {
      return null;
    }
  }

  /**
   * 极简 YAML 解析器 — 仅支持顶层和一层嵌套的 key: value
   * 用于解析 pubspec.yaml 中的 name, dependencies, environment 等
   */
  #parseSimpleYaml(content) {
    const result = {};
    let currentSection = null;

    for (const line of content.split('\n')) {
      // 跳过注释和空行
      if (/^\s*#/.test(line) || /^\s*$/.test(line)) {
        continue;
      }

      // 顶层 key（无缩进）
      const topMatch = line.match(/^(\w[\w-]*):\s*(.*)/);
      if (topMatch) {
        const key = topMatch[1];
        const value = topMatch[2].trim();
        if (value) {
          result[key] = value;
          currentSection = null;
        } else {
          result[key] = {};
          currentSection = key;
        }
        continue;
      }

      // 嵌套 key（有缩进）
      if (currentSection) {
        const nestedMatch = line.match(/^\s+(\w[\w-]*):\s*(.*)/);
        if (nestedMatch) {
          const key = nestedMatch[1];
          const value = nestedMatch[2].trim();
          if (typeof result[currentSection] === 'object') {
            result[currentSection][key] = value || true;
          }
        }
      }
    }

    return result;
  }

  /**
   * 检测 Flutter/Dart 框架
   */
  #detectFramework(pubspec) {
    if (!pubspec) {
      return null;
    }

    const deps = {
      ...(typeof pubspec.dependencies === 'object' ? pubspec.dependencies : {}),
      ...(typeof pubspec.dev_dependencies === 'object' ? pubspec.dev_dependencies : {}),
    };

    // Flutter SDK
    if (deps.flutter || deps.flutter_test) {
      // Sub-framework detection
      if (deps.flutter_riverpod || deps.hooks_riverpod || deps.riverpod) {
        return 'flutter-riverpod';
      }
      if (deps.flutter_bloc || deps.bloc) {
        return 'flutter-bloc';
      }
      if (deps.get || deps.getx) {
        return 'flutter-getx';
      }
      if (deps.provider) {
        return 'flutter-provider';
      }
      return 'flutter';
    }

    // Pure Dart server/CLI
    if (deps.shelf || deps.shelf_router) {
      return 'shelf';
    }
    if (deps.dart_frog) {
      return 'dart-frog';
    }
    if (deps.serverpod) {
      return 'serverpod';
    }
    if (deps.args || deps.cli_util) {
      return 'dart-cli';
    }

    return null;
  }

  /**
   * 发现 Melos 多包工作区中的子包
   */
  #discoverMelosPackages(projectRoot) {
    const melosPath = join(projectRoot, 'melos.yaml');
    if (!existsSync(melosPath)) {
      return;
    }

    try {
      const content = readFileSync(melosPath, 'utf8');
      const _melos = this.#parseSimpleYaml(content);

      // Melos packages 字段（简化处理: 扫描 packages/ 目录）
      const packagesDir = join(projectRoot, 'packages');
      if (existsSync(packagesDir)) {
        const entries = readdirSync(packagesDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name.startsWith('.')) {
            continue;
          }
          const pkgDir = join(packagesDir, entry.name);
          if (existsSync(join(pkgDir, 'pubspec.yaml'))) {
            const subPubspec = this.#parsePubspec(pkgDir);
            // @ts-expect-error TS migration: TS2339
            const pkgName = subPubspec?.name || entry.name;
            this.#targets.push({
              name: `packages/${pkgName}`,
              path: join(pkgDir, 'lib'),
              type: 'library',
              language: 'dart',
              metadata: { isMelosPackage: true, packageName: pkgName },
            });
            this.#depGraph.nodes.push({ id: pkgName, label: pkgName, type: 'internal' });
          }
        }
      }

      // 也检查 apps/ 目录（部分 Melos 工作区的约定）
      const appsDir = join(projectRoot, 'apps');
      if (existsSync(appsDir)) {
        const entries = readdirSync(appsDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name.startsWith('.')) {
            continue;
          }
          const appDir = join(appsDir, entry.name);
          if (existsSync(join(appDir, 'pubspec.yaml'))) {
            const subPubspec = this.#parsePubspec(appDir);
            // @ts-expect-error TS migration: TS2339
            const appName = subPubspec?.name || entry.name;
            this.#targets.push({
              name: `apps/${appName}`,
              path: join(appDir, 'lib'),
              type: 'application',
              language: 'dart',
              metadata: { isMelosPackage: true, packageName: appName },
            });
            this.#depGraph.nodes.push({ id: appName, label: appName, type: 'internal' });
          }
        }
      }
    } catch {
      /* skip */
    }
  }

  /**
   * 解析 pubspec.yaml 依赖到 depGraph
   */
  #parseDependencies(pubspec) {
    if (!pubspec) {
      return;
    }

    const nodeSet = new Set(this.#depGraph.nodes.map((n) => (typeof n === 'string' ? n : n.id)));
    const rootNode = this.#packageName;

    const addDep = (name, isDev) => {
      if (!nodeSet.has(name)) {
        this.#depGraph.nodes.push({
          id: name,
          label: name,
          type: 'external',
          isDev,
        });
        nodeSet.add(name);
      }
      this.#depGraph.edges.push({
        from: rootNode,
        to: name,
        type: isDev ? 'dev-dependency' : 'dependency',
      });
    };

    if (typeof pubspec.dependencies === 'object') {
      for (const dep of Object.keys(pubspec.dependencies)) {
        if (dep === 'flutter' || dep === 'flutter_localizations') {
          continue; // SDK 依赖，不记为外部包
        }
        addDep(dep, false);
      }
    }

    if (typeof pubspec.dev_dependencies === 'object') {
      for (const dep of Object.keys(pubspec.dev_dependencies)) {
        if (dep === 'flutter_test' || dep === 'flutter_lints' || dep === 'flutter_driver') {
          continue;
        }
        addDep(dep, true);
      }
    }
  }

  /**
   * 解析内部 Dart import 语句，构建包内模块依赖关系
   */
  #parseInternalImports(projectRoot) {
    const libDir = join(projectRoot, 'lib');
    if (!existsSync(libDir)) {
      return;
    }

    const nodeSet = new Set(this.#depGraph.nodes.map((n) => (typeof n === 'string' ? n : n.id)));
    const edgeSet = new Set();

    // 收集 lib/ 下的子目录作为内部模块
    try {
      const entries = readdirSync(libDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && !entry.name.startsWith('_')) {
          const moduleId = `lib/${entry.name}`;
          if (!nodeSet.has(moduleId)) {
            this.#depGraph.nodes.push({ id: moduleId, label: entry.name, type: 'internal' });
            nodeSet.add(moduleId);
          }
        }
      }
    } catch {
      /* skip */
    }

    // 扫描 import 语句
    const scanDir = (dir) => {
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            if (!entry.name.startsWith('.') && !EXCLUDE_DIRS.has(entry.name)) {
              scanDir(join(dir, entry.name));
            }
          } else if (entry.isFile() && entry.name.endsWith('.dart')) {
            try {
              const content = readFileSync(join(dir, entry.name), 'utf8');
              const relDir = relative(libDir, dir);
              const fromModule = relDir ? `lib/${relDir.split('/')[0]}` : this.#packageName;

              // 匹配 import 'package:xxx/yyy.dart'
              const imports = content.matchAll(/import\s+['"]package:(\w+)\/([^'"]+)['"]/g);
              for (const m of imports) {
                const pkg = m[1];
                const filePath = m[2];
                if (pkg === this.#packageName) {
                  // 内部 import
                  const targetModule = `lib/${filePath.split('/')[0]}`;
                  if (targetModule !== fromModule && nodeSet.has(targetModule)) {
                    const edgeKey = `${fromModule}->${targetModule}`;
                    if (!edgeSet.has(edgeKey)) {
                      edgeSet.add(edgeKey);
                      this.#depGraph.edges.push({
                        from: fromModule,
                        to: targetModule,
                        type: 'internal',
                      });
                    }
                  }
                }
              }
            } catch {
              /* skip */
            }
          }
        }
      } catch {
        /* skip */
      }
    };

    scanDir(libDir);
  }

  /**
   * 递归收集 .dart 文件
   */
  #collectDartFiles(dir, rootDir, files, depth = 0) {
    if (depth > 15) {
      return;
    }

    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.')) {
          continue;
        }

        if (entry.isDirectory()) {
          if (EXCLUDE_DIRS.has(entry.name)) {
            continue;
          }
          this.#collectDartFiles(join(dir, entry.name), rootDir, files, depth + 1);
        } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
          const fullPath = join(dir, entry.name);
          try {
            const content = readFileSync(fullPath, 'utf8');
            files.push({
              name: entry.name,
              path: fullPath,
              relativePath: relative(rootDir, fullPath),
              content,
            });
          } catch {
            /* unreadable */
          }
        }
      }
    } catch {
      /* permission error */
    }
  }
}
