/**
 * @module tools/v2/compressor/parsers/TreeParser
 * 解析 ls -R / find / tree 命令输出为紧凑缩进目录树格式。
 */

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  '__pycache__',
  '.DS_Store',
  '.next',
  '.nuxt',
  'dist',
  'coverage',
  '.cache',
  '.turbo',
  'bower_components',
  '.idea',
  '.vscode',
]);

interface TreeNode {
  name: string;
  children: Map<string, TreeNode>;
}

function shouldIgnore(name: string): boolean {
  return IGNORED_DIRS.has(name);
}

function insertPath(root: TreeNode, parts: string[]): void {
  let node = root;
  for (const part of parts) {
    if (!part || shouldIgnore(part)) {
      return;
    }
    if (!node.children.has(part)) {
      node.children.set(part, { name: part, children: new Map() });
    }
    const child = node.children.get(part);
    if (!child) {
      return;
    }
    node = child;
  }
}

function renderTree(node: TreeNode, indent: number): string[] {
  const lines: string[] = [];
  const sortedChildren = [...node.children.entries()].sort(([a], [b]) => a.localeCompare(b));

  for (const [, child] of sortedChildren) {
    const prefix = '  '.repeat(indent);
    const isDir = child.children.size > 0;
    lines.push(`${prefix}${child.name}${isDir ? '/' : ''}`);
    if (isDir) {
      lines.push(...renderTree(child, indent + 1));
    }
  }

  return lines;
}

function tryTreeCommand(raw: string): TreeNode | null {
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    return null;
  }

  const treeLineRe = /^([│├└─\s|`\\+-]*)\s*(.+?)$/;
  let matched = 0;
  const root: TreeNode = { name: '.', children: new Map() };
  const pathStack: string[] = [];

  for (const line of lines) {
    const m = treeLineRe.exec(line);
    if (!m) {
      continue;
    }

    const prefixLen = m[1].replace(/[^\s│|]/g, ' ').length;
    const name = m[2].trim();
    if (!name || name === '.' || name.match(/^\d+\s+directories/)) {
      continue;
    }

    const depth = Math.floor(prefixLen / 4) || 0;
    matched++;

    pathStack.length = depth;
    pathStack.push(name.replace(/\/$/, ''));
    insertPath(root, pathStack);
  }

  return matched > 2 ? root : null;
}

function tryFindOutput(raw: string): TreeNode | null {
  const root: TreeNode = { name: '.', children: new Map() };
  let matched = 0;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const cleaned = trimmed.replace(/^\.\//, '');
    if (!cleaned) {
      continue;
    }

    const parts = cleaned.split('/').filter(Boolean);
    if (parts.length === 0) {
      continue;
    }

    if (parts.some((p) => shouldIgnore(p))) {
      continue;
    }

    matched++;
    insertPath(root, parts);
  }

  return matched > 0 ? root : null;
}

function tryLsR(raw: string): TreeNode | null {
  const root: TreeNode = { name: '.', children: new Map() };
  let currentDir = '';
  let matched = 0;

  const dirHeaderRe = /^(.+):$/;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const dirMatch = dirHeaderRe.exec(trimmed);
    if (dirMatch) {
      currentDir = dirMatch[1].replace(/^\.\//, '');
      matched++;
      continue;
    }

    if (trimmed.startsWith('total ')) {
      continue;
    }

    const parts = currentDir ? [...currentDir.split('/'), trimmed] : [trimmed];

    if (parts.some((p) => shouldIgnore(p))) {
      continue;
    }
    matched++;
    insertPath(root, parts.filter(Boolean));
  }

  return matched > 2 ? root : null;
}

/** 尝试解析 raw 输出，失败返回 null */
export function parse(raw: string): string | null {
  try {
    if (!raw || raw.trim().length === 0) {
      return null;
    }

    const root = tryTreeCommand(raw) ?? tryLsR(raw) ?? tryFindOutput(raw);

    if (!root || root.children.size === 0) {
      return null;
    }

    const lines = renderTree(root, 0);
    if (lines.length === 0) {
      return null;
    }

    return lines.join('\n');
  } catch {
    return null;
  }
}
