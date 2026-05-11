/**
 * @module CMakeParser
 * @description CMake 轻量解析器 — 从 CMakeLists.txt 提取项目拓扑
 *
 * 支持解析：
 *  - project() — 项目名和版本
 *  - add_subdirectory() — 子目录发现
 *  - add_library() / add_executable() — 目标声明
 *  - target_link_libraries() — 依赖关系
 *
 * 设计策略: 仅解析顶层调用，不跟踪控制流 (if/else/macro)
 */

// ── 解析结果类型 ─────────────────────────────────────

export interface ParsedCMakeProject {
  projectName: string;
  version?: string;
  subdirectories: string[];
  targets: CMakeTarget[];
}

export interface CMakeTarget {
  name: string;
  type: 'executable' | 'static-library' | 'shared-library' | 'interface-library';
  sources: string[];
  linkDependencies: CMakeLinkDep[];
}

export interface CMakeLinkDep {
  target: string;
  scope: 'PUBLIC' | 'PRIVATE' | 'INTERFACE';
}

// ── 正则模式 ────────────────────────────────────────

const PROJECT_RE = /project\(\s*(\w+)(?:\s+VERSION\s+([\d.]+))?/;
const ADD_SUBDIRECTORY_RE = /add_subdirectory\(\s*(\S+)\s*\)/g;

// add_library(name STATIC src1.cpp src2.cpp) — 允许多行
const ADD_LIBRARY_RE =
  /add_library\(\s*(\w+)\s+(STATIC|SHARED|INTERFACE|MODULE|OBJECT)?\s*([\s\S]*?)\)/g;
const ADD_EXECUTABLE_RE = /add_executable\(\s*(\w+)\s*([\s\S]*?)\)/g;

// target_link_libraries(target PUBLIC|PRIVATE|INTERFACE dep1 dep2)
const TARGET_LINK_RE = /target_link_libraries\(\s*(\w+)\s+([\s\S]*?)\)/g;

// ── 公开 API ────────────────────────────────────────

/**
 * 解析 CMakeLists.txt 内容
 */
export function parseCMakeProject(content: string): ParsedCMakeProject {
  const result: ParsedCMakeProject = {
    projectName: '',
    subdirectories: [],
    targets: [],
  };

  // 移除注释
  const cleaned = removeComments(content);

  // 解析 project()
  const projMatch = cleaned.match(PROJECT_RE);
  if (projMatch) {
    result.projectName = projMatch[1];
    result.version = projMatch[2];
  }

  // 解析 add_subdirectory()
  const subdirRe = new RegExp(ADD_SUBDIRECTORY_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = subdirRe.exec(cleaned)) !== null) {
    result.subdirectories.push(m[1]);
  }

  // 解析 add_library()
  const targetMap = new Map<string, CMakeTarget>();

  const libRe = new RegExp(ADD_LIBRARY_RE.source, 'gs');
  while ((m = libRe.exec(cleaned)) !== null) {
    const name = m[1];
    const typeStr = (m[2] ?? 'STATIC').toUpperCase();
    const sourcesStr = m[3] ?? '';

    const typeMap: Record<string, CMakeTarget['type']> = {
      STATIC: 'static-library',
      SHARED: 'shared-library',
      INTERFACE: 'interface-library',
      MODULE: 'shared-library',
      OBJECT: 'static-library',
    };

    const target: CMakeTarget = {
      name,
      type: typeMap[typeStr] ?? 'static-library',
      sources: extractSourceFiles(sourcesStr),
      linkDependencies: [],
    };
    targetMap.set(name, target);
  }

  // 解析 add_executable()
  const exeRe = new RegExp(ADD_EXECUTABLE_RE.source, 'gs');
  while ((m = exeRe.exec(cleaned)) !== null) {
    const name = m[1];
    const sourcesStr = m[2] ?? '';

    const target: CMakeTarget = {
      name,
      type: 'executable',
      sources: extractSourceFiles(sourcesStr),
      linkDependencies: [],
    };
    targetMap.set(name, target);
  }

  // 解析 target_link_libraries()
  const linkRe = new RegExp(TARGET_LINK_RE.source, 'gs');
  while ((m = linkRe.exec(cleaned)) !== null) {
    const targetName = m[1];
    const depsStr = m[2];

    const target = targetMap.get(targetName);
    if (!target) {
      continue;
    }

    target.linkDependencies = parseLinkDependencies(depsStr);
  }

  result.targets = [...targetMap.values()];
  return result;
}

// ── 内部函数 ────────────────────────────────────────

function removeComments(content: string): string {
  return content
    .split('\n')
    .map((line) => {
      const commentIdx = line.indexOf('#');
      if (commentIdx === -1) {
        return line;
      }
      // 简单处理：不检查字符串内的 #
      return line.substring(0, commentIdx);
    })
    .join('\n');
}

function extractSourceFiles(str: string): string[] {
  const sources: string[] = [];
  // 提取非关键字的 token
  const tokens = str.trim().split(/\s+/);
  for (const token of tokens) {
    const clean = token.trim();
    if (
      clean === '' ||
      clean === 'STATIC' ||
      clean === 'SHARED' ||
      clean === 'INTERFACE' ||
      clean === 'MODULE' ||
      clean === 'OBJECT' ||
      clean === 'PUBLIC' ||
      clean === 'PRIVATE' ||
      clean === 'IMPORTED' ||
      clean === 'ALIAS' ||
      clean === 'EXCLUDE_FROM_ALL' ||
      clean.startsWith('$')
    ) {
      continue;
    }
    sources.push(clean);
  }
  return sources;
}

function parseLinkDependencies(str: string): CMakeLinkDep[] {
  const deps: CMakeLinkDep[] = [];
  const tokens = str.trim().split(/\s+/);
  let currentScope: CMakeLinkDep['scope'] = 'PUBLIC';

  for (const token of tokens) {
    const clean = token.trim();
    if (clean === 'PUBLIC' || clean === 'PRIVATE' || clean === 'INTERFACE') {
      currentScope = clean as CMakeLinkDep['scope'];
      continue;
    }
    if (clean === '' || clean.startsWith('$') || clean.startsWith('#')) {
      continue;
    }
    deps.push({ target: clean, scope: currentScope });
  }

  return deps;
}
