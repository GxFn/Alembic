/**
 * @module StarlarkParser
 * @description Starlark (Python 子集) 轻量解析器 — 从 BUILD / BUILD.bazel / BUCK 文件提取构建目标信息
 *
 * 支持解析：
 *  - load() 语句 → 推断语言
 *  - 目标声明 (swift_library, cc_binary, java_library 等)
 *  - name / deps / srcs / visibility 字段
 *
 * 设计策略: 正则 + 逐行状态机（不做宏展开）
 */

// ── 解析结果类型 ─────────────────────────────────────

export interface StarlarkTarget {
  rule: string;
  name: string;
  srcs: string[];
  deps: string[];
  visibility: string[];
  testonly?: boolean;
}

export interface LoadStatement {
  repository: string;
  path: string;
  symbols: string[];
}

export interface ParsedBuildFile {
  targets: StarlarkTarget[];
  loads: LoadStatement[];
}

// ── 规则名 → 语言映射 ────────────────────────────────

export const RULE_TO_LANGUAGE: Record<string, string> = {
  // Bazel
  swift_library: 'swift',
  swift_binary: 'swift',
  swift_test: 'swift',
  cc_library: 'cpp',
  cc_binary: 'cpp',
  cc_test: 'cpp',
  java_library: 'java',
  java_binary: 'java',
  java_test: 'java',
  kt_jvm_library: 'kotlin',
  kt_jvm_binary: 'kotlin',
  py_library: 'python',
  py_binary: 'python',
  py_test: 'python',
  go_library: 'go',
  go_binary: 'go',
  go_test: 'go',
  rust_library: 'rust',
  rust_binary: 'rust',
  rust_test: 'rust',
  ts_project: 'typescript',
  proto_library: 'protobuf',
  // Buck2
  cxx_library: 'cpp',
  cxx_binary: 'cpp',
  cxx_test: 'cpp',
  android_library: 'kotlin',
  android_binary: 'kotlin',
  apple_library: 'swift',
  apple_binary: 'swift',
  python_library: 'python',
  python_binary: 'python',
  // Pants
  python_source: 'python',
  python_sources: 'python',
  docker_image: 'docker',
};

// ── 正则模式 ────────────────────────────────────────

const LOAD_RE = /^load\(\s*"([^"]+)"\s*,\s*((?:"[^"]+"(?:\s*,\s*)?)+)\s*\)/;
const RULE_CALL_RE = /^(\w+)\(\s*$/;
const NAME_RE = /name\s*=\s*"([^"]+)"/;
const TESTONLY_RE = /testonly\s*=\s*(True|1)/;
const STRING_LIST_RE = (field: string) =>
  new RegExp(`${field}\\s*=\\s*(?:glob\\(\\s*)?\\[([^\\]]*)\\]`, 's');
const DEP_LABEL_RE = /"((?:\/\/[^"]*|:[^"]*))"/g;
const GLOB_RE = /glob\(\s*\[([^\]]*)\]\s*\)/;

// ── 公开 API ────────────────────────────────────────

/**
 * 解析单个 BUILD/BUILD.bazel/BUCK 文件内容
 */
export function parseStarlarkBuildFile(content: string): ParsedBuildFile {
  const result: ParsedBuildFile = { targets: [], loads: [] };
  const lines = content.split('\n');

  // Pass 1: 提取 load 语句
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) {
      continue;
    }

    const loadMatch = trimmed.match(LOAD_RE);
    if (loadMatch) {
      const fullLabel = loadMatch[1];
      const symbolsPart = loadMatch[2];

      // 解析 repository 和 path
      let repository = '';
      let path = fullLabel;
      if (fullLabel.startsWith('@')) {
        const slashIdx = fullLabel.indexOf('//');
        if (slashIdx !== -1) {
          repository = fullLabel.substring(0, slashIdx);
          path = fullLabel.substring(slashIdx);
        }
      }

      const symbols: string[] = [];
      const symRe = /"([^"]+)"/g;
      let symMatch: RegExpExecArray | null;
      while ((symMatch = symRe.exec(symbolsPart)) !== null) {
        symbols.push(symMatch[1]);
      }

      result.loads.push({ repository, path, symbols });
    }
  }

  // Pass 2: 提取目标声明（逐行状态机）
  let i = 0;
  while (i < lines.length) {
    const trimmed = lines[i].trim();

    // 跳过注释和空行
    if (trimmed.startsWith('#') || trimmed === '') {
      i++;
      continue;
    }

    // 检测规则调用开始: rule_name(
    const ruleMatch = trimmed.match(RULE_CALL_RE);
    if (ruleMatch) {
      const rule = ruleMatch[1];
      // 收集整个调用块直到匹配的 )
      const blockLines = [trimmed];
      let depth = 1;
      let j = i + 1;
      while (j < lines.length && depth > 0) {
        const bLine = lines[j];
        for (const ch of bLine) {
          if (ch === '(') {
            depth++;
          }
          if (ch === ')') {
            depth--;
          }
        }
        blockLines.push(bLine);
        j++;
      }

      const block = blockLines.join('\n');
      const target = parseTargetBlock(rule, block);
      if (target) {
        result.targets.push(target);
      }

      i = j;
      continue;
    }

    // 也检测单行调用: rule_name(name = "...")
    const inlineMatch = trimmed.match(/^(\w+)\(/);
    if (inlineMatch && RULE_TO_LANGUAGE[inlineMatch[1]]) {
      // 同样收集到闭合 )
      const rule = inlineMatch[1];
      const blockLines = [trimmed];
      let depth = 0;
      for (const ch of trimmed) {
        if (ch === '(') {
          depth++;
        }
        if (ch === ')') {
          depth--;
        }
      }
      let j = i + 1;
      while (j < lines.length && depth > 0) {
        const bLine = lines[j];
        for (const ch of bLine) {
          if (ch === '(') {
            depth++;
          }
          if (ch === ')') {
            depth--;
          }
        }
        blockLines.push(bLine);
        j++;
      }

      const block = blockLines.join('\n');
      const target = parseTargetBlock(rule, block);
      if (target) {
        result.targets.push(target);
      }

      i = j;
      continue;
    }

    i++;
  }

  return result;
}

// ── 内部解析函数 ────────────────────────────────────

function parseTargetBlock(rule: string, block: string): StarlarkTarget | null {
  const nameMatch = block.match(NAME_RE);
  if (!nameMatch) {
    return null;
  }

  return {
    rule,
    name: nameMatch[1],
    srcs: extractStringList(block, 'srcs'),
    deps: extractDepLabels(block),
    visibility: extractStringList(block, 'visibility'),
    testonly: TESTONLY_RE.test(block) ? true : undefined,
  };
}

function extractStringList(block: string, field: string): string[] {
  const listMatch = block.match(STRING_LIST_RE(field));
  if (!listMatch) {
    return [];
  }

  let inner = listMatch[1];

  // 处理 glob() 模式
  const globMatch = inner.match(GLOB_RE);
  if (globMatch) {
    inner = globMatch[1];
  }

  const items: string[] = [];
  const strRe = /"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = strRe.exec(inner)) !== null) {
    items.push(m[1]);
  }
  return items;
}

function extractDepLabels(block: string): string[] {
  const depsMatch = block.match(STRING_LIST_RE('deps'));
  if (!depsMatch) {
    return [];
  }

  const inner = depsMatch[1];
  const deps: string[] = [];
  const re = new RegExp(DEP_LABEL_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner)) !== null) {
    deps.push(m[1]);
  }

  // 也捕获非标签格式的字符串依赖
  const strRe = /"([^"]+)"/g;
  while ((m = strRe.exec(inner)) !== null) {
    if (!m[1].startsWith('//') && !m[1].startsWith(':') && !deps.includes(m[1])) {
      deps.push(m[1]);
    }
  }

  return deps;
}
