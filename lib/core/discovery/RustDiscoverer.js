/**
 * @module RustDiscoverer
 * @description Rust 项目结构发现器
 *
 * 检测信号: Cargo.toml, Cargo.lock, *.rs
 * 支持: 单 crate 项目、Cargo workspace（多 crate）、标准目录布局 (src/ tests/ benches/ examples/)
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';
import { ProjectDiscoverer } from './ProjectDiscoverer.js';

const SOURCE_EXTENSIONS = new Set(['.rs']);

const EXCLUDE_DIRS = new Set([
  '.git',
  'target',
  'node_modules',
  '.cargo',
  '.idea',
  '.vscode',
  'dist',
  'build',
]);

export class RustDiscoverer extends ProjectDiscoverer {
  #projectRoot = null;
  #targets = [];
  #depGraph = { nodes: [], edges: [] };
  #crateName = null;

  get id() {
    return 'rust';
  }
  get displayName() {
    return 'Rust (Cargo)';
  }

  async detect(projectRoot) {
    let confidence = 0;
    const reasons = [];

    if (existsSync(join(projectRoot, 'Cargo.toml'))) {
      confidence = 0.92;
      reasons.push('Cargo.toml exists');
    }
    if (existsSync(join(projectRoot, 'Cargo.lock'))) {
      confidence = Math.max(confidence, 0.7);
      if (confidence < 0.92) {
        confidence += 0.1;
      }
      reasons.push('Cargo.lock exists');
    }
    if (
      existsSync(join(projectRoot, 'rust-toolchain.toml')) ||
      existsSync(join(projectRoot, 'rust-toolchain'))
    ) {
      confidence = Math.max(confidence, 0.85);
      reasons.push('rust-toolchain exists');
    }

    // 兜底: 根目录有 .rs 文件
    if (confidence === 0) {
      try {
        const entries = readdirSync(projectRoot);
        if (entries.some((e) => e.endsWith('.rs'))) {
          confidence = 0.5;
          reasons.push('*.rs files found at root');
        }
      } catch {
        /* skip */
      }
    }

    return {
      match: confidence > 0,
      confidence: Math.min(confidence, 1.0),
      reason: reasons.join(', ') || 'No Rust markers found',
    };
  }

  async load(projectRoot) {
    this.#projectRoot = projectRoot;
    this.#targets = [];
    this.#depGraph = { nodes: [], edges: [] };

    // 解析 Cargo.toml
    const cargoInfo = this.#parseCargoToml(projectRoot);
    this.#crateName = cargoInfo?.name || basename(projectRoot);

    const framework = this.#detectFramework(projectRoot);

    // 主 Target
    this.#targets.push({
      name: this.#crateName,
      path: projectRoot,
      type: cargoInfo?.isBin ? 'application' : 'library',
      language: 'rust',
      framework,
      metadata: {
        edition: cargoInfo?.edition || null,
        crateName: this.#crateName,
      },
    });
    this.#depGraph.nodes.push(this.#crateName);

    // Cargo workspace — 发现成员 crate
    const workspaceMembers = this.#discoverWorkspaceMembers(projectRoot);
    for (const member of workspaceMembers) {
      this.#targets.push(member);
      this.#depGraph.nodes.push(member.name);
    }

    // examples/ 下的二进制示例
    this.#discoverExamples(projectRoot, framework);

    // benches/ 下的 benchmark
    this.#discoverBenches(projectRoot);

    // tests/ 集成测试
    const testsDir = join(projectRoot, 'tests');
    if (existsSync(testsDir)) {
      this.#targets.push({
        name: 'tests',
        path: testsDir,
        type: 'test',
        language: 'rust',
      });
    }

    // 解析依赖
    this.#parseDependencies(projectRoot);

    // 发现内部模块
    this.#discoverInternalModules(projectRoot);
  }

  async listTargets() {
    return this.#targets;
  }

  async getTargetFiles(target) {
    const targetPath =
      typeof target === 'string'
        ? this.#targets.find((t) => t.name === target)?.path || this.#projectRoot
        : target.path;

    if (!targetPath || !existsSync(targetPath)) {
      return [];
    }

    const files = [];
    this.#collectRsFiles(targetPath, targetPath, files);
    return files;
  }

  async getDependencyGraph() {
    return this.#depGraph;
  }

  // ── 内部实现 ──

  /**
   * 简易解析 Cargo.toml（无 TOML 解析器，使用正则）
   */
  #parseCargoToml(projectRoot) {
    const cargoPath = join(projectRoot, 'Cargo.toml');
    if (!existsSync(cargoPath)) {
      return null;
    }

    try {
      const content = readFileSync(cargoPath, 'utf8');
      const name = content.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1];
      const edition = content.match(/^\s*edition\s*=\s*"([^"]+)"/m)?.[1];

      // 判断是 bin 还是 lib
      const hasMainRs = existsSync(join(projectRoot, 'src', 'main.rs'));
      const hasLibRs = existsSync(join(projectRoot, 'src', 'lib.rs'));
      const hasBinSection = /\[\[bin\]\]/.test(content);

      return {
        name,
        edition,
        isBin: hasMainRs || hasBinSection,
        isLib: hasLibRs,
      };
    } catch {
      return null;
    }
  }

  /**
   * 发现 Cargo workspace 成员
   */
  #discoverWorkspaceMembers(projectRoot) {
    const cargoPath = join(projectRoot, 'Cargo.toml');
    if (!existsSync(cargoPath)) {
      return [];
    }

    try {
      const content = readFileSync(cargoPath, 'utf8');

      // [workspace] members = ["crate_a", "crate_b", "crates/*"]
      const workspaceBlock = content.match(/\[workspace\]([\s\S]*?)(?:\n\[|\s*$)/);
      if (!workspaceBlock) {
        return [];
      }

      const membersLine = workspaceBlock[1].match(/members\s*=\s*\[([\s\S]*?)\]/);
      if (!membersLine) {
        return [];
      }

      const memberPatterns = membersLine[1]
        .split(',')
        .map((s) => s.replace(/["\s]/g, ''))
        .filter(Boolean);

      const members = [];
      for (const pattern of memberPatterns) {
        if (pattern.includes('*')) {
          // Glob — 展开
          const prefix = pattern.replace('/*', '');
          const parentDir = join(projectRoot, prefix);
          if (!existsSync(parentDir)) {
            continue;
          }
          try {
            const entries = readdirSync(parentDir, { withFileTypes: true });
            for (const entry of entries) {
              if (entry.isDirectory() && !entry.name.startsWith('.')) {
                const memberPath = join(parentDir, entry.name);
                if (existsSync(join(memberPath, 'Cargo.toml'))) {
                  const info = this.#parseCargoToml(memberPath);
                  members.push({
                    name: info?.name || entry.name,
                    path: memberPath,
                    type: info?.isBin ? 'application' : 'library',
                    language: 'rust',
                    metadata: {
                      edition: info?.edition,
                      isWorkspaceMember: true,
                    },
                  });
                }
              }
            }
          } catch {
            /* skip */
          }
        } else {
          const memberPath = join(projectRoot, pattern);
          if (existsSync(join(memberPath, 'Cargo.toml'))) {
            const info = this.#parseCargoToml(memberPath);
            members.push({
              name: info?.name || basename(pattern),
              path: memberPath,
              type: info?.isBin ? 'application' : 'library',
              language: 'rust',
              metadata: {
                edition: info?.edition,
                isWorkspaceMember: true,
              },
            });
          }
        }
      }

      return members;
    } catch {
      return [];
    }
  }

  /**
   * 发现 examples/ 目录
   */
  #discoverExamples(projectRoot, framework) {
    const examplesDir = join(projectRoot, 'examples');
    if (!existsSync(examplesDir)) {
      return;
    }

    try {
      const entries = readdirSync(examplesDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.rs')) {
          // 单文件示例不作为独立 target，只记录目录
        } else if (entry.isDirectory()) {
          const subDir = join(examplesDir, entry.name);
          if (existsSync(join(subDir, 'main.rs'))) {
            this.#targets.push({
              name: `examples/${entry.name}`,
              path: subDir,
              type: 'example',
              language: 'rust',
              framework,
            });
          }
        }
      }
      // 如果有任何 .rs 文件，添加整个 examples 目录
      if (entries.some((e) => e.isFile() && e.name.endsWith('.rs'))) {
        this.#targets.push({
          name: 'examples',
          path: examplesDir,
          type: 'example',
          language: 'rust',
        });
      }
    } catch {
      /* skip */
    }
  }

  /**
   * 发现 benches/ 目录
   */
  #discoverBenches(projectRoot) {
    const benchDir = join(projectRoot, 'benches');
    if (!existsSync(benchDir)) {
      return;
    }

    try {
      const entries = readdirSync(benchDir);
      if (entries.some((e) => e.endsWith('.rs'))) {
        this.#targets.push({
          name: 'benches',
          path: benchDir,
          type: 'benchmark',
          language: 'rust',
        });
      }
    } catch {
      /* skip */
    }
  }

  /**
   * 检测 Rust Web/网络框架
   */
  #detectFramework(projectRoot) {
    const cargoPath = join(projectRoot, 'Cargo.toml');
    if (!existsSync(cargoPath)) {
      return null;
    }

    try {
      const content = readFileSync(cargoPath, 'utf8');

      if (/\bactix-web\b/.test(content)) {
        return 'actix-web';
      }
      if (/\baxum\b/.test(content)) {
        return 'axum';
      }
      if (/\brocket\b/.test(content)) {
        return 'rocket';
      }
      if (/\bwarp\b/.test(content)) {
        return 'warp';
      }
      if (/\btokio\b/.test(content) && /\bhyper\b/.test(content)) {
        return 'hyper';
      }
      if (/\btokio\b/.test(content)) {
        return 'tokio';
      }
      if (/\basync-std\b/.test(content)) {
        return 'async-std';
      }
      if (/\btauri\b/.test(content)) {
        return 'tauri';
      }
      if (/\bbevy\b/.test(content)) {
        return 'bevy';
      }
      if (/\bclap\b/.test(content)) {
        return 'clap-cli';
      }
      if (/\bserde\b/.test(content)) {
        return 'serde';
      }
    } catch {
      /* skip */
    }

    return null;
  }

  /**
   * 解析 Cargo.toml 的 [dependencies] 到 depGraph
   */
  #parseDependencies(projectRoot) {
    const cargoPath = join(projectRoot, 'Cargo.toml');
    if (!existsSync(cargoPath)) {
      return;
    }

    const nodeSet = new Set(this.#depGraph.nodes.map((n) => (typeof n === 'string' ? n : n.id)));
    const rootNode =
      typeof this.#depGraph.nodes[0] === 'string'
        ? this.#depGraph.nodes[0]
        : this.#depGraph.nodes[0]?.id || 'root';

    try {
      const content = readFileSync(cargoPath, 'utf8');

      // 匹配 [dependencies] 和 [dev-dependencies] 块
      const depSections = content.matchAll(
        /\[((?:dev-|build-)?dependencies)\]([\s\S]*?)(?=\n\[|$)/g
      );

      for (const section of depSections) {
        const sectionType = section[1];
        const isDev = sectionType.startsWith('dev-');
        const isBuild = sectionType.startsWith('build-');
        const lines = section[2].split('\n');

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('[')) {
            continue;
          }

          // dep = "version" 或 dep = { version = "...", ... }
          const depMatch = trimmed.match(/^(\S+)\s*=/);
          if (depMatch) {
            const depName = depMatch[1].replace(/"/g, '');
            if (!nodeSet.has(depName)) {
              this.#depGraph.nodes.push({
                id: depName,
                label: depName,
                type: 'external',
                isDev,
                isBuild,
              });
              nodeSet.add(depName);
            }
            this.#depGraph.edges.push({
              from: rootNode,
              to: depName,
              type: isDev ? 'dev-dependency' : isBuild ? 'build-dependency' : 'dependency',
            });
          }
        }
      }
    } catch {
      /* skip */
    }
  }

  /**
   * 发现内部模块（src/ 子目录）
   */
  #discoverInternalModules(projectRoot) {
    const srcDir = join(projectRoot, 'src');
    if (!existsSync(srcDir)) {
      return;
    }

    const nodeSet = new Set(this.#depGraph.nodes.map((n) => (typeof n === 'string' ? n : n.id)));

    const walk = (dir, relPath, depth) => {
      if (depth > 6) {
        return;
      }
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name.startsWith('.') || EXCLUDE_DIRS.has(entry.name)) {
            continue;
          }
          const subDir = join(dir, entry.name);
          const subRel = relPath ? `${relPath}/${entry.name}` : entry.name;

          try {
            const subEntries = readdirSync(subDir);
            const hasRsFiles = subEntries.some((e) => e.endsWith('.rs'));
            if (hasRsFiles && !nodeSet.has(subRel)) {
              this.#depGraph.nodes.push({ id: subRel, label: subRel, type: 'internal' });
              nodeSet.add(subRel);
            }
          } catch {
            /* skip */
          }

          walk(subDir, subRel, depth + 1);
        }
      } catch {
        /* skip */
      }
    };

    walk(srcDir, '', 0);
  }

  /**
   * 递归收集 .rs 文件
   */
  #collectRsFiles(dir, rootDir, files, depth = 0) {
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
          this.#collectRsFiles(join(dir, entry.name), rootDir, files, depth + 1);
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
