/**
 * @module GoDiscoverer
 * @description Go 项目结构发现器
 *
 * 检测信号: go.mod, go.sum, *.go
 * 支持: 单 Module 项目、Go Workspace (go.work)、标准目录布局 (cmd/ internal/ pkg/)
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';
import { ProjectDiscoverer } from './ProjectDiscoverer.js';

const SOURCE_EXTENSIONS = new Set(['.go']);

const EXCLUDE_DIRS = new Set([
  '.git',
  '.cursor',
  'vendor',
  'node_modules',
  'testdata',
  '.cache',
  'dist',
  'build',
  '_output',
]);

export class GoDiscoverer extends ProjectDiscoverer {
  #projectRoot = null;
  #targets = [];
  #depGraph = { nodes: [], edges: [] };
  #modulePath = null;

  get id() {
    return 'go';
  }
  get displayName() {
    return 'Go (modules)';
  }

  async detect(projectRoot) {
    let confidence = 0;
    const reasons = [];

    if (existsSync(join(projectRoot, 'go.mod'))) {
      confidence = 0.92;
      reasons.push('go.mod exists');
    }
    if (existsSync(join(projectRoot, 'go.sum'))) {
      confidence = Math.max(confidence, 0.7);
      if (confidence < 0.92) {
        confidence += 0.1;
      }
      reasons.push('go.sum exists');
    }
    if (existsSync(join(projectRoot, 'go.work'))) {
      confidence = Math.max(confidence, 0.95);
      reasons.push('go.work exists (workspace)');
    }

    // 兜底: 根目录有 .go 文件
    if (confidence === 0) {
      try {
        const entries = readdirSync(projectRoot);
        if (entries.some((e) => e.endsWith('.go'))) {
          confidence = 0.5;
          reasons.push('*.go files found at root');
        }
      } catch {
        /* skip */
      }
    }

    return {
      match: confidence > 0,
      confidence: Math.min(confidence, 1.0),
      reason: reasons.join(', ') || 'No Go markers found',
    };
  }

  async load(projectRoot) {
    this.#projectRoot = projectRoot;
    this.#targets = [];
    this.#depGraph = { nodes: [], edges: [] };

    // 解析 go.mod
    this.#modulePath = this.#parseGoMod(projectRoot);
    const projectName = this.#modulePath
      ? this.#modulePath.split('/').pop()
      : basename(projectRoot);

    // 主 Target — 始终覆盖整个 module（Go 项目根目录递归收集所有 .go 文件）
    const framework = this.#detectFramework(projectRoot);
    this.#targets.push({
      name: projectName,
      path: projectRoot,
      type: 'library',
      language: 'go',
      framework,
      metadata: { modulePath: this.#modulePath },
    });
    this.#depGraph.nodes.push(projectName);

    // cmd/ 下的子命令作为独立 Target
    const cmdTargets = this.#discoverCmdTargets(projectRoot);
    for (const t of cmdTargets) {
      this.#targets.push(t);
      this.#depGraph.nodes.push(t.name);
    }

    // 检测 test 目录（如果存在独立的 tests/ 或 test/）
    for (const testDir of ['test', 'tests', 'e2e']) {
      const testPath = join(projectRoot, testDir);
      if (existsSync(testPath) && !this.#targets.some((t) => t.name === testDir)) {
        this.#targets.push({
          name: testDir,
          path: testPath,
          type: 'test',
          language: 'go',
        });
      }
    }

    // 发现内部子包（binding/, render/, internal/ 等）
    this.#discoverInternalPackages(projectRoot);

    // 解析 go.mod 外部依赖（同时添加为 node）
    this.#parseDependencies(projectRoot);

    // 解析内部 import 关系
    this.#parseInternalImports(projectRoot);
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
    this.#collectGoFiles(targetPath, targetPath, files);
    return files;
  }

  async getDependencyGraph() {
    return this.#depGraph;
  }

  // ── 内部实现 ──

  /**
   * 解析 go.mod 提取 module path
   */
  #parseGoMod(projectRoot) {
    const goModPath = join(projectRoot, 'go.mod');
    if (!existsSync(goModPath)) {
      return null;
    }
    try {
      const content = readFileSync(goModPath, 'utf8');
      const match = content.match(/^module\s+(\S+)/m);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  /**
   * 发现 Go 标准约定目录: pkg/, internal/, api/
   */
  #discoverConventionDirs(projectRoot) {
    const dirs = [];
    const conventionNames = [
      { name: 'pkg', type: 'library' },
      { name: 'internal', type: 'library' },
      { name: 'api', type: 'library' },
      { name: 'server', type: 'application' },
      { name: 'service', type: 'application' },
    ];

    const framework = this.#detectFramework(projectRoot);

    for (const conv of conventionNames) {
      const dirPath = join(projectRoot, conv.name);
      if (existsSync(dirPath)) {
        try {
          const entries = readdirSync(dirPath, { withFileTypes: true });
          const hasGoFiles = entries.some((e) => e.isFile() && e.name.endsWith('.go'));
          const hasGoSubDirs = entries.some(
            (e) => e.isDirectory() && !e.name.startsWith('.') && !EXCLUDE_DIRS.has(e.name)
          );
          if (hasGoFiles || hasGoSubDirs) {
            dirs.push({
              name: conv.name,
              path: dirPath,
              type: conv.type,
              language: 'go',
              framework,
              metadata: { modulePath: this.#modulePath },
            });
          }
        } catch {
          /* skip */
        }
      }
    }

    return dirs;
  }

  /**
   * 发现 cmd/ 下的子命令—每个含 main.go 的子目录为一个 binary Target
   */
  #discoverCmdTargets(projectRoot) {
    const cmdDir = join(projectRoot, 'cmd');
    if (!existsSync(cmdDir)) {
      return [];
    }

    const targets = [];
    const framework = this.#detectFramework(projectRoot);

    try {
      const entries = readdirSync(cmdDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          const subDir = join(cmdDir, entry.name);
          targets.push({
            name: `cmd/${entry.name}`,
            path: subDir,
            type: 'application',
            language: 'go',
            framework,
            metadata: { modulePath: this.#modulePath, isCmdBinary: true },
          });
        }
      }
    } catch {
      /* skip */
    }

    // cmd/ 根目录本身有 main.go
    if (targets.length === 0) {
      try {
        const entries = readdirSync(cmdDir);
        if (entries.some((e) => e.endsWith('.go'))) {
          targets.push({
            name: 'cmd',
            path: cmdDir,
            type: 'application',
            language: 'go',
            framework,
            metadata: { modulePath: this.#modulePath },
          });
        }
      } catch {
        /* skip */
      }
    }

    return targets;
  }

  /**
   * 检测 Go Web 框架
   */
  #detectFramework(projectRoot) {
    const goModPath = join(projectRoot, 'go.mod');
    if (!existsSync(goModPath)) {
      return null;
    }

    try {
      const content = readFileSync(goModPath, 'utf8');

      if (/github\.com\/gin-gonic\/gin\b/.test(content)) {
        return 'gin';
      }
      if (/github\.com\/labstack\/echo\b/.test(content)) {
        return 'echo';
      }
      if (/github\.com\/gofiber\/fiber\b/.test(content)) {
        return 'fiber';
      }
      if (/github\.com\/gorilla\/mux\b/.test(content)) {
        return 'gorilla';
      }
      if (/github\.com\/beego\b|github\.com\/astaxie\/beego\b/.test(content)) {
        return 'beego';
      }
      if (/google\.golang\.org\/grpc\b/.test(content)) {
        return 'grpc';
      }
      if (/github\.com\/go-chi\/chi\b/.test(content)) {
        return 'chi';
      }
    } catch {
      /* skip */
    }

    return null;
  }

  /**
   * 发现内部子包——目录中包含 .go 文件即为一个 Go package
   */
  #discoverInternalPackages(projectRoot) {
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

          // 检查目录中是否包含 .go 文件
          try {
            const subEntries = readdirSync(subDir);
            const hasGoFiles = subEntries.some((e) => e.endsWith('.go'));
            if (hasGoFiles && !nodeSet.has(subRel)) {
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

    walk(projectRoot, '', 0);
  }

  /**
   * 解析 go.mod 依赖到 depGraph（同时将直接依赖添加为 node）
   */
  #parseDependencies(projectRoot) {
    const goModPath = join(projectRoot, 'go.mod');
    if (!existsSync(goModPath)) {
      return;
    }

    const nodeSet = new Set(this.#depGraph.nodes.map((n) => (typeof n === 'string' ? n : n.id)));
    const rootNode =
      typeof this.#depGraph.nodes[0] === 'string'
        ? this.#depGraph.nodes[0]
        : this.#depGraph.nodes[0]?.id || 'root';

    const addExtDep = (fullPath, indirect) => {
      const shortName = fullPath.split('/').pop();
      // 添加为 node（如果不存在）
      if (!nodeSet.has(shortName)) {
        this.#depGraph.nodes.push({
          id: shortName,
          label: shortName,
          type: 'external',
          fullPath,
          indirect,
        });
        nodeSet.add(shortName);
      }
      // 添加 edge
      this.#depGraph.edges.push({
        from: rootNode,
        to: shortName,
        type: indirect ? 'indirect' : 'dependency',
      });
    };

    try {
      const content = readFileSync(goModPath, 'utf8');

      // 块 require
      const requireBlocks = content.matchAll(/require\s*\(([\s\S]*?)\)/g);
      for (const block of requireBlocks) {
        const lines = block[1].split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith('//')) {
            const parts = trimmed.split(/\s+/);
            if (parts.length >= 2) {
              const indirect = trimmed.includes('// indirect');
              addExtDep(parts[0], indirect);
            }
          }
        }
      }

      // 单行 require（排除 block 语法 `require (`）
      const singleRequires = content.matchAll(/^require\s+([^\s(]\S*)\s+\S+/gm);
      for (const m of singleRequires) {
        const indirect = m[0].includes('// indirect');
        addExtDep(m[1], indirect);
      }
    } catch {
      /* skip */
    }
  }

  /**
   * 解析内部 Go import 语句，构建子包间依赖关系
   */
  #parseInternalImports(projectRoot) {
    if (!this.#modulePath) {
      return;
    }

    const internalNodes = new Set(
      this.#depGraph.nodes
        .filter((n) => typeof n === 'object' && n.type === 'internal')
        .map((n) => n.id)
    );

    // 也包含根包
    const rootNodeId =
      typeof this.#depGraph.nodes[0] === 'string'
        ? this.#depGraph.nodes[0]
        : this.#depGraph.nodes[0]?.id;

    const edgeSet = new Set();

    const scanPkgImports = (dir, pkgId) => {
      try {
        const entries = readdirSync(dir);
        for (const entry of entries) {
          if (!entry.endsWith('.go')) {
            continue;
          }
          try {
            const content = readFileSync(join(dir, entry), 'utf8');
            // 匹配 import 块和单行 import
            const importBlocks = content.matchAll(/import\s*\(([\s\S]*?)\)/g);
            for (const block of importBlocks) {
              const lines = block[1].split('\n');
              for (const line of lines) {
                this.#matchInternalImport(line, pkgId, rootNodeId, internalNodes, edgeSet);
              }
            }
            const singleImports = content.matchAll(/^import\s+(?:\w+\s+)?"([^"]+)"/gm);
            for (const m of singleImports) {
              this.#matchInternalImport(`"${m[1]}"`, pkgId, rootNodeId, internalNodes, edgeSet);
            }
          } catch {
            /* skip */
          }
        }
      } catch {
        /* skip */
      }
    };

    // 扫描根包
    scanPkgImports(projectRoot, rootNodeId);

    // 扫描各内部子包
    for (const pkgId of internalNodes) {
      scanPkgImports(join(projectRoot, pkgId), pkgId);
    }
  }

  /**
   * 从 import 行中匹配内部包引用
   */
  #matchInternalImport(line, fromPkgId, rootNodeId, internalNodes, edgeSet) {
    const match = line.match(/"([^"]+)"/);
    if (!match) {
      return;
    }

    const importPath = match[1];
    if (!importPath.startsWith(`${this.#modulePath}/`)) {
      return;
    }

    // 去掉 module path 前缀得到相对路径
    const relImport = importPath.slice(this.#modulePath.length + 1);

    // 确定目标节点
    let targetId = null;
    if (internalNodes.has(relImport)) {
      targetId = relImport;
    } else {
      // 可能是子路径，匹配最近的已知包
      for (const nodeId of internalNodes) {
        if (relImport.startsWith(`${nodeId}/`) || relImport === nodeId) {
          targetId = nodeId;
          break;
        }
      }
    }

    if (targetId && targetId !== fromPkgId) {
      const edgeKey = `${fromPkgId}->${targetId}`;
      if (!edgeSet.has(edgeKey)) {
        edgeSet.add(edgeKey);
        this.#depGraph.edges.push({
          from: fromPkgId,
          to: targetId,
          type: 'internal',
        });
      }
    }
  }

  /**
   * 递归收集 .go 文件
   */
  #collectGoFiles(dir, rootDir, files, depth = 0) {
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
          this.#collectGoFiles(join(dir, entry.name), rootDir, files, depth + 1);
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
