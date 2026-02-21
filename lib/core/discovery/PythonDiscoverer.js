/**
 * @module PythonDiscoverer
 * @description Python 项目结构发现器
 *
 * 检测信号: pyproject.toml, setup.py, setup.cfg, requirements.txt, *.py
 * 支持: pyproject.toml (PEP 621), setup.py, src 布局, 平铺布局
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { ProjectDiscoverer } from './ProjectDiscoverer.js';

const EXCLUDE_DIRS = new Set([
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  '.git',
  '.mypy_cache',
  '.pytest_cache',
  '.eggs',
  'dist',
  'build',
  'node_modules',
  '.nox',
  '.ruff_cache',
]);

export class PythonDiscoverer extends ProjectDiscoverer {
  #projectRoot = null;
  #targets = [];
  #depGraph = { nodes: [], edges: [] };
  #projectName = null;

  get id() {
    return 'python';
  }
  get displayName() {
    return 'Python (pip/poetry/pdm)';
  }

  async detect(projectRoot) {
    let confidence = 0;
    const reasons = [];

    if (existsSync(join(projectRoot, 'pyproject.toml'))) {
      confidence = 0.9;
      reasons.push('pyproject.toml exists');
    }
    if (existsSync(join(projectRoot, 'setup.py'))) {
      confidence = Math.max(confidence, 0.8);
      reasons.push('setup.py exists');
    }
    if (existsSync(join(projectRoot, 'setup.cfg'))) {
      confidence = Math.max(confidence, 0.8);
      reasons.push('setup.cfg exists');
    }
    if (existsSync(join(projectRoot, 'requirements.txt'))) {
      confidence = Math.max(confidence, 0.6);
      reasons.push('requirements.txt exists');
    }

    // 检查是否有 .py 文件
    if (confidence === 0) {
      try {
        const entries = readdirSync(projectRoot);
        if (entries.some((e) => e.endsWith('.py'))) {
          confidence = 0.4;
          reasons.push('*.py files found at root');
        }
      } catch {
        /* skip */
      }
    }

    return {
      match: confidence > 0,
      confidence: Math.min(confidence, 1.0),
      reason: reasons.join(', ') || 'No Python markers found',
    };
  }

  async load(projectRoot) {
    this.#projectRoot = projectRoot;
    this.#targets = [];
    this.#depGraph = { nodes: [], edges: [] };

    // 解析 pyproject.toml（简易 TOML 解析）
    const pyprojectPath = join(projectRoot, 'pyproject.toml');
    let pyproject = null;
    if (existsSync(pyprojectPath)) {
      pyproject = this.#parsePyprojectToml(readFileSync(pyprojectPath, 'utf8'));
    }

    this.#projectName = pyproject?.project?.name || basename(projectRoot);

    // 发现包目录
    const packages = this.#discoverPackages(projectRoot, pyproject);

    for (const pkg of packages) {
      const framework = this.#detectFramework(projectRoot, pyproject);
      this.#targets.push({
        name: pkg.name,
        path: pkg.path,
        type: pkg.isTest ? 'test' : 'library',
        language: 'python',
        framework,
        metadata: { pyproject },
      });
      this.#depGraph.nodes.push(pkg.name);
    }

    // 如果没有发现任何包, 以项目根为兜底
    if (this.#targets.length === 0) {
      this.#targets.push({
        name: this.#projectName,
        path: projectRoot,
        type: 'library',
        language: 'python',
        framework: this.#detectFramework(projectRoot, pyproject),
        metadata: { pyproject },
      });
      this.#depGraph.nodes.push(this.#projectName);
    }

    // 解析依赖
    this.#parseDependencies(projectRoot, pyproject);
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
    this.#collectPyFiles(targetPath, targetPath, files);
    return files;
  }

  async getDependencyGraph() {
    return this.#depGraph;
  }

  // ── 内部实现 ──

  #discoverPackages(projectRoot, pyproject) {
    const packages = [];

    // src/ 布局优先
    const srcDir = join(projectRoot, 'src');
    if (existsSync(srcDir)) {
      try {
        const entries = readdirSync(srcDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && !entry.name.startsWith('.') && !entry.name.startsWith('_')) {
            const pkgDir = join(srcDir, entry.name);
            if (existsSync(join(pkgDir, '__init__.py'))) {
              packages.push({ name: entry.name, path: pkgDir, isTest: false });
            }
          }
        }
      } catch {
        /* skip */
      }
    }

    // 平铺布局: 含 __init__.py 的顶层目录
    if (packages.length === 0) {
      try {
        const entries = readdirSync(projectRoot, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && !entry.name.startsWith('.') && !EXCLUDE_DIRS.has(entry.name)) {
            const pkgDir = join(projectRoot, entry.name);
            if (existsSync(join(pkgDir, '__init__.py'))) {
              const isTest = /^tests?$/.test(entry.name);
              packages.push({ name: entry.name, path: pkgDir, isTest });
            }
          }
        }
      } catch {
        /* skip */
      }
    }

    // 检测 tests/ 目录
    for (const testDir of ['tests', 'test']) {
      const testPath = join(projectRoot, testDir);
      if (existsSync(testPath) && !packages.some((p) => p.name === testDir)) {
        packages.push({ name: testDir, path: testPath, isTest: true });
      }
    }

    return packages;
  }

  #detectFramework(projectRoot, pyproject) {
    const deps = this.#extractDependencyNames(projectRoot, pyproject);

    if (deps.has('django')) {
      return 'django';
    }
    if (deps.has('flask')) {
      return 'flask';
    }
    if (deps.has('fastapi')) {
      return 'fastapi';
    }
    if (deps.has('torch') || deps.has('tensorflow')) {
      return 'ml';
    }
    if (deps.has('scrapy')) {
      return 'scrapy';
    }
    if (deps.has('celery')) {
      return 'celery';
    }
    return null;
  }

  #extractDependencyNames(projectRoot, pyproject) {
    const names = new Set();

    // From pyproject.toml
    if (pyproject?.project?.dependencies) {
      for (const dep of pyproject.project.dependencies) {
        const name = dep
          .replace(/[>=<![\]~;@\s].*/g, '')
          .trim()
          .toLowerCase();
        if (name) {
          names.add(name);
        }
      }
    }

    // From requirements.txt
    const reqPath = join(projectRoot, 'requirements.txt');
    if (existsSync(reqPath)) {
      try {
        const content = readFileSync(reqPath, 'utf8');
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('-')) {
            const name = trimmed
              .replace(/[>=<![\]~;@\s].*/g, '')
              .trim()
              .toLowerCase();
            if (name) {
              names.add(name);
            }
          }
        }
      } catch {
        /* skip */
      }
    }

    return names;
  }

  #parseDependencies(projectRoot, pyproject) {
    const names = this.#extractDependencyNames(projectRoot, pyproject);
    const rootTarget = this.#targets[0]?.name;
    if (!rootTarget) {
      return;
    }

    for (const dep of names) {
      this.#depGraph.edges.push({ from: rootTarget, to: dep, type: 'depends_on' });
    }
  }

  #collectPyFiles(dir, rootDir, files, depth = 0) {
    if (depth > 15) {
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
          this.#collectPyFiles(fullPath, rootDir, files, depth + 1);
        } else if (entry.isFile() && entry.name.endsWith('.py')) {
          files.push({
            name: entry.name,
            path: fullPath,
            relativePath: relative(rootDir, fullPath),
            language: 'python',
          });
        }
      }
    } catch {
      /* skip */
    }
  }

  /**
   * 简易 TOML 解析器 — 仅提取本项目需要的字段
   * 不做完整 TOML 解析, 只用正则提取关键信息
   */
  #parsePyprojectToml(content) {
    const result = { project: {} };

    // [project] name
    const nameMatch = content.match(/\[project\][\s\S]*?name\s*=\s*["']([^"']+)["']/);
    if (nameMatch) {
      result.project.name = nameMatch[1];
    }

    // [project] dependencies — 简化提取数组
    const depsMatch = content.match(/\[project\][\s\S]*?dependencies\s*=\s*\[([\s\S]*?)\]/);
    if (depsMatch) {
      result.project.dependencies = [];
      const items = depsMatch[1].matchAll(/["']([^"']+)["']/g);
      for (const m of items) {
        result.project.dependencies.push(m[1]);
      }
    }

    return result;
  }
}
