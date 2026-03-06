/**
 * @module NodeDiscoverer
 * @description TypeScript / JavaScript 项目结构发现器
 *
 * 检测信号: package.json, tsconfig.json, node_modules/
 * 支持: 单包、Monorepo (npm/pnpm/yarn workspaces, lerna)
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, extname, join, relative, resolve } from 'node:path';
import { inferLang } from '../../external/mcp/handlers/LanguageExtensions.js';
import { ProjectDiscoverer } from './ProjectDiscoverer.js';

const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.vue',
  '.svelte',
]);
const EXCLUDE_DIRS = new Set([
  'node_modules',
  '.git',
  '.cursor',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  'coverage',
  '.turbo',
  '.cache',
]);

export class NodeDiscoverer extends ProjectDiscoverer {
  #projectRoot = null;
  #packageJson = null;
  #targets = [];
  #depGraph = { nodes: [], edges: [] };

  // @ts-expect-error TS migration: TS2416
  get id() {
    return 'node';
  }
  // @ts-expect-error TS migration: TS2416
  get displayName() {
    return 'Node.js (npm/pnpm/yarn)';
  }

  // @ts-expect-error TS migration: TS2416
  async detect(projectRoot) {
    let confidence = 0;
    const reasons = [];

    if (existsSync(join(projectRoot, 'package.json'))) {
      confidence = 0.9;
      reasons.push('package.json exists');
    }
    if (existsSync(join(projectRoot, 'tsconfig.json'))) {
      confidence = Math.max(confidence, 0.9);
      confidence += 0.05;
      reasons.push('tsconfig.json exists');
    }
    if (existsSync(join(projectRoot, 'node_modules'))) {
      confidence += 0.05;
      reasons.push('node_modules/ exists');
    }

    // ── 降低 confidence：当检测到其他生态的强标记时 ──────────
    // 这些项目使用 package.json 仅作为前端/工具链辅助，主语言在别的生态
    if (confidence > 0) {
      // Ruby 生态：Gemfile/Rakefile 的存在几乎确定是 Rails/Sinatra 项目
      // 即使有 tsconfig.json 也只是说明前端构建链使用 TS（Ember/React），
      // 主语言仍然是 Ruby，因此始终重度降级
      const rubyMarkers = ['Gemfile', 'Rakefile'];
      const hasRubyMarker = rubyMarkers.some((f) => existsSync(join(projectRoot, f)));
      if (hasRubyMarker) {
        confidence *= 0.05;
        reasons.push('Ruby marker found (Gemfile/Rakefile) — confidence heavily reduced');
      } else {
        // 其他生态标记：tsconfig 存在则可能是全栈项目，保留较高 confidence
        const otherMarkers = [
          { files: ['Cargo.toml'], lang: 'Rust' },
          { files: ['go.mod'], lang: 'Go' },
        ];
        for (const marker of otherMarkers) {
          if (marker.files.some((f) => existsSync(join(projectRoot, f)))) {
            const hasTsConfig = existsSync(join(projectRoot, 'tsconfig.json'));
            if (hasTsConfig) {
              confidence *= 0.5;
              reasons.push(
                `${marker.lang} marker found (but tsconfig present) — confidence moderately reduced`
              );
            } else {
              confidence *= 0.05;
              reasons.push(`${marker.lang} marker found — confidence heavily reduced`);
            }
            break;
          }
        }
      }
    }

    return {
      match: confidence > 0,
      confidence: Math.min(confidence, 1.0),
      reason: reasons.join(', ') || 'No Node.js markers found',
    };
  }

  async load(projectRoot) {
    this.#projectRoot = projectRoot;
    this.#targets = [];
    this.#depGraph = { nodes: [], edges: [] };

    // 读取 package.json
    const pkgPath = join(projectRoot, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        this.#packageJson = JSON.parse(readFileSync(pkgPath, 'utf8'));
      } catch {
        this.#packageJson = {};
      }
    } else {
      this.#packageJson = {};
    }

    // 检测 monorepo workspaces
    const workspacePaths = this.#resolveWorkspaces(projectRoot);

    if (workspacePaths.length > 0) {
      // Monorepo 模式: 每个 workspace 是一个 Target
      for (const wsPath of workspacePaths) {
        const wsAbsPath = resolve(projectRoot, wsPath);
        if (!existsSync(wsAbsPath)) {
          continue;
        }
        const wsPkgPath = join(wsAbsPath, 'package.json');
        let wsPkg: any = {};
        if (existsSync(wsPkgPath)) {
          try {
            wsPkg = JSON.parse(readFileSync(wsPkgPath, 'utf8'));
          } catch {
            /* skip */
          }
        }

        const framework = this.#detectFramework(wsPkg);
        const name = wsPkg.name || basename(wsPath);
        const type = this.#inferTargetType(wsPkg);

        this.#targets.push({
          name,
          path: wsAbsPath,
          type,
          language: 'typescript',
          framework,
          metadata: { packageJson: wsPkg },
        });
        this.#depGraph.nodes.push(name);
      }

      // 构建 workspace 间依赖
      this.#buildWorkspaceDeps(workspacePaths);
    } else {
      // 单包模式
      const framework = this.#detectFramework(this.#packageJson);
      const name = this.#packageJson.name || basename(projectRoot);
      const type = this.#inferTargetType(this.#packageJson);

      this.#targets.push({
        name,
        path: projectRoot,
        type,
        language: 'typescript',
        framework,
        metadata: { packageJson: this.#packageJson },
      });
      this.#depGraph.nodes.push(name);
    }

    // 添加外部依赖到依赖图
    this.#addExternalDeps();
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
    this.#collectFiles(targetPath, targetPath, files);
    return files;
  }

  // @ts-expect-error TS migration: TS2416
  async getDependencyGraph() {
    return this.#depGraph;
  }

  // ── 内部实现 ──

  #resolveWorkspaces(projectRoot) {
    const paths = [];

    // npm/yarn workspaces (from package.json)
    const workspaces = this.#packageJson.workspaces;
    if (workspaces) {
      const patterns = Array.isArray(workspaces) ? workspaces : workspaces.packages || [];
      for (const pattern of patterns) {
        // 简单 glob 展开: "packages/*" → 列出子目录
        if (pattern.endsWith('/*') || pattern.endsWith('/**')) {
          const dir = pattern.replace(/\/\*\*?$/, '');
          const absDir = resolve(projectRoot, dir);
          if (existsSync(absDir)) {
            try {
              const entries = readdirSync(absDir, { withFileTypes: true });
              for (const entry of entries) {
                if (entry.isDirectory() && !entry.name.startsWith('.')) {
                  paths.push(join(dir, entry.name));
                }
              }
            } catch {
              /* skip */
            }
          }
        } else {
          paths.push(pattern);
        }
      }
    }

    // pnpm-workspace.yaml
    const pnpmWsPath = join(projectRoot, 'pnpm-workspace.yaml');
    if (paths.length === 0 && existsSync(pnpmWsPath)) {
      try {
        const content = readFileSync(pnpmWsPath, 'utf8');
        const pkgMatches = content.matchAll(/^\s*-\s*['"]?([^'"#\n]+)['"]?/gm);
        for (const m of pkgMatches) {
          const pattern = m[1].trim();
          if (pattern.endsWith('/*') || pattern.endsWith('/**')) {
            const dir = pattern.replace(/\/\*\*?$/, '');
            const absDir = resolve(projectRoot, dir);
            if (existsSync(absDir)) {
              try {
                const entries = readdirSync(absDir, { withFileTypes: true });
                for (const entry of entries) {
                  if (entry.isDirectory() && !entry.name.startsWith('.')) {
                    paths.push(join(dir, entry.name));
                  }
                }
              } catch {
                /* skip */
              }
            }
          } else {
            paths.push(pattern);
          }
        }
      } catch {
        /* skip */
      }
    }

    // lerna.json
    const lernaPath = join(projectRoot, 'lerna.json');
    if (paths.length === 0 && existsSync(lernaPath)) {
      try {
        const lerna = JSON.parse(readFileSync(lernaPath, 'utf8'));
        const patterns = lerna.packages || ['packages/*'];
        for (const pattern of patterns) {
          if (pattern.endsWith('/*') || pattern.endsWith('/**')) {
            const dir = pattern.replace(/\/\*\*?$/, '');
            const absDir = resolve(projectRoot, dir);
            if (existsSync(absDir)) {
              try {
                const entries = readdirSync(absDir, { withFileTypes: true });
                for (const entry of entries) {
                  if (entry.isDirectory() && !entry.name.startsWith('.')) {
                    paths.push(join(dir, entry.name));
                  }
                }
              } catch {
                /* skip */
              }
            }
          } else {
            paths.push(pattern);
          }
        }
      } catch {
        /* skip */
      }
    }

    return paths;
  }

  #detectFramework(pkg) {
    if (!pkg) {
      return null;
    }
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };

    if (deps.next) {
      return 'nextjs';
    }
    if (deps.nuxt || deps.nuxt3) {
      return 'nuxt';
    }
    if (deps['@angular/core']) {
      return 'angular';
    }
    if (deps.svelte) {
      return 'svelte';
    }
    if (deps['react-native']) {
      return 'react-native';
    }
    if (deps.react || deps['react-dom']) {
      return 'react';
    }
    if (deps.vue) {
      return 'vue';
    }
    if (deps['@nestjs/core']) {
      return 'nestjs';
    }
    if (deps.electron) {
      return 'electron';
    }
    if (deps.express) {
      return 'node-server';
    }
    if (deps.fastify) {
      return 'node-server';
    }
    if (deps.koa) {
      return 'node-server';
    }
    if (deps.hono) {
      return 'node-server';
    }
    return null;
  }

  #inferTargetType(pkg) {
    if (!pkg) {
      return 'library';
    }
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };

    if (pkg.bin) {
      return 'executable';
    }
    if (deps.jest || deps.mocha || deps.vitest) {
      // Has test runner but check if it's primary purpose
      if (pkg.name?.includes('test')) {
        return 'test';
      }
    }
    if (deps.react || deps.vue || deps['@angular/core'] || deps.svelte) {
      return 'app';
    }
    if (deps.express || deps.fastify || deps.koa || deps['@nestjs/core']) {
      return 'app';
    }
    if (deps.electron) {
      return 'app';
    }
    return 'library';
  }

  #collectFiles(dir, rootDir, files, depth = 0) {
    if (depth > 15) {
      return; // 防止过深递归
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
          this.#collectFiles(fullPath, rootDir, files, depth + 1);
        } else if (entry.isFile()) {
          const ext = extname(entry.name);
          if (SOURCE_EXTENSIONS.has(ext)) {
            const lang = inferLang(entry.name) || 'javascript';
            files.push({
              name: entry.name,
              path: fullPath,
              relativePath: relative(rootDir, fullPath),
              language: lang,
            });
          }
        }
      }
    } catch {
      /* skip unreadable dirs */
    }
  }

  #buildWorkspaceDeps(workspacePaths) {
    // 收集所有 workspace 包名
    const nameToPath = new Map();
    for (const t of this.#targets) {
      nameToPath.set(t.name, t.path);
    }

    for (const t of this.#targets) {
      const pkg = t.metadata?.packageJson;
      if (!pkg) {
        continue;
      }
      const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      for (const depName of Object.keys(allDeps)) {
        if (nameToPath.has(depName)) {
          this.#depGraph.edges.push({
            from: t.name,
            to: depName,
            type: pkg.devDependencies?.[depName] ? 'dev_depends_on' : 'depends_on',
          });
        }
      }
    }
  }

  #addExternalDeps() {
    if (!this.#packageJson) {
      return;
    }
    const deps = this.#packageJson.dependencies || {};
    const devDeps = this.#packageJson.devDependencies || {};
    const rootName = this.#targets[0]?.name;
    if (!rootName) {
      return;
    }

    for (const dep of Object.keys(deps)) {
      if (!this.#depGraph.nodes.includes(dep)) {
        this.#depGraph.edges.push({ from: rootName, to: dep, type: 'depends_on' });
      }
    }
    for (const dep of Object.keys(devDeps)) {
      if (!this.#depGraph.nodes.includes(dep)) {
        this.#depGraph.edges.push({ from: rootName, to: dep, type: 'dev_depends_on' });
      }
    }
  }
}
