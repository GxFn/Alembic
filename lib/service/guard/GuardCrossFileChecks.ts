/**
 * GuardCrossFileChecks - Guard 跨文件检查
 *
 * 从 GuardCheckEngine._runCrossFileChecks 拆分
 * 包含: 跨文件规则检查 + 路径归一化工具
 */

/**
 * 解析相对 import 路径为归一化路径（去掉扩展名）
 * @param {string} fromDir 当前文件目录
 * @param {string} importPath 相对路径如 './foo' 或 '../bar/baz'
 * @returns {string|null}
 */
export function resolveImportPath(fromDir: string, importPath: string) {
  try {
    const parts = `${fromDir}/${importPath}`.split('/');
    const resolved: string[] = [];
    for (const p of parts) {
      if (p === '.' || p === '') {
        continue;
      }
      if (p === '..') {
        resolved.pop();
        continue;
      }
      resolved.push(p);
    }
    // 去掉扩展名归一化
    let result = resolved.join('/');
    result = result.replace(/\.(js|ts|jsx|tsx|mjs|mts)$/, '');
    // 移除 /index 后缀（index barrel 导入）
    result = result.replace(/\/index$/, '');
    return result;
  } catch {
    return null;
  }
}

/**
 * 归一化文件路径（去扩展名，用于 import 比较）
 * @param {string} filePath
 * @returns {string}
 */
export function normalizeFilePath(filePath: string) {
  return filePath.replace(/\.(js|ts|jsx|tsx|mjs|mts)$/, '').replace(/\/index$/, '');
}

/**
 * 跨文件检查 — 需要多文件上下文才能发现的问题
 * @param {Array<{path: string, content: string}>} files
 * @param {object} options
 * @param {string[]} [options.disabledRules] 禁用的规则 ID 列表
 * @returns {Array<{ruleId, message, severity, locations}>}
 */
export interface CrossFileViolation {
  ruleId: string;
  message: string;
  severity: string;
  locations: { filePath: string; line: number; snippet: string }[];
}

export function runCrossFileChecks(
  files: { path: string; content: string }[],
  options: { disabledRules?: string[] } = {}
) {
  const violations: CrossFileViolation[] = [];
  const disabledSet = new Set(options.disabledRules || []);
  const isDisabled = (ruleId: string) => disabledSet.has(ruleId);

  // ── ObjC Category 跨文件重名检查 ──
  if (!isDisabled('objc-cross-file-duplicate-category')) {
    const categoryMap = new Map();
    const categoryRegex = /@interface\s+(\w+)\s*\(\s*(\w+)\s*\)/g;

    for (const { path: filePath, content } of files) {
      const ext = filePath.split('.').pop()?.toLowerCase();
      if (ext !== 'm' && ext !== 'mm' && ext !== 'h') {
        continue;
      }

      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        categoryRegex.lastIndex = 0;
        let m;
        while ((m = categoryRegex.exec(lines[i])) !== null) {
          const key = `${m[1]}(${m[2]})`;
          if (!categoryMap.has(key)) {
            categoryMap.set(key, []);
          }
          categoryMap.get(key).push({
            filePath,
            line: i + 1,
            snippet: lines[i].trim().slice(0, 120),
          });
        }
      }
    }

    for (const [key, locations] of categoryMap) {
      if (locations.length <= 1) {
        continue;
      }

      const hFiles = locations.filter((l: { filePath: string }) => l.filePath.endsWith('.h'));
      const mFiles = locations.filter((l: { filePath: string }) => !l.filePath.endsWith('.h'));
      const hasDuplicateH = hFiles.length > 1;
      const hasDuplicateM = mFiles.length > 1;
      const tooMany = locations.length > 2;

      if (hasDuplicateH || hasDuplicateM || tooMany) {
        const conflictLocations = tooMany
          ? locations
          : hasDuplicateH && hasDuplicateM
            ? locations
            : hasDuplicateH
              ? hFiles
              : mFiles;

        violations.push({
          ruleId: 'objc-cross-file-duplicate-category',
          message: `Category ${key} 在 ${conflictLocations.length} 个文件中重复声明，可能导致方法覆盖或未定义行为`,
          severity: 'warning',
          locations: conflictLocations,
        });
      }
    }
  } // end isDisabled('objc-cross-file-duplicate-category')

  // ── JS/TS 循环依赖检查 ──
  // 检测 A imports B 且 B imports A 的直接循环
  if (!isDisabled('js-circular-import')) {
    const jsImportMap = new Map(); // filePath → Set<importedPath>
    const jsExts = new Set(['js', 'ts', 'jsx', 'tsx', 'mjs', 'mts']);
    const importRegex =
      /(?:import\s+.+?\s+from\s+['"](.+?)['"]|require\s*\(\s*['"](.+?)['"]\s*\))/g;

    for (const { path: filePath, content } of files) {
      const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
      if (!jsExts.has(ext)) {
        continue;
      }

      const imports = new Set();
      const lines = content.split(/\r?\n/);
      for (const line of lines) {
        importRegex.lastIndex = 0;
        let m;
        while ((m = importRegex.exec(line)) !== null) {
          const importPath = m[1] || m[2];
          if (importPath.startsWith('.')) {
            // 解析相对路径为归一化 key
            const dir = filePath.substring(0, filePath.lastIndexOf('/'));
            const resolved = resolveImportPath(dir, importPath);
            if (resolved) {
              imports.add(resolved);
            }
          }
        }
      }
      if (imports.size > 0) {
        jsImportMap.set(normalizeFilePath(filePath), imports);
      }
    }

    // 检测直接双向循环: A→B 且 B→A
    const reportedCycles = new Set();
    for (const [fileA, importsA] of jsImportMap) {
      for (const depB of importsA) {
        const importsB = jsImportMap.get(depB);
        if (importsB?.has(fileA)) {
          const cycleKey = [fileA, depB].sort().join(' <-> ');
          if (!reportedCycles.has(cycleKey)) {
            reportedCycles.add(cycleKey);
            violations.push({
              ruleId: 'js-circular-import',
              message: `检测到循环依赖，两个模块互相导入可能导致运行时 undefined`,
              severity: 'warning',
              locations: [
                { filePath: fileA, line: 1, snippet: `imports ${depB.split('/').pop()}` },
                { filePath: depB, line: 1, snippet: `imports ${fileA.split('/').pop()}` },
              ],
            });
          }
        }
      }
    }
  } // end isDisabled('js-circular-import')

  // ── Java/Kotlin 同名类跨文件检查 ──
  if (!isDisabled('java-duplicate-class-name')) {
    const classMap = new Map(); // className → [{filePath, line, snippet}]
    const javaClassRegex = /(?:public\s+)?(?:abstract\s+)?(?:final\s+)?class\s+(\w+)/;
    const jkExts = new Set(['java', 'kt']);

    for (const { path: filePath, content } of files) {
      const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
      if (!jkExts.has(ext)) {
        continue;
      }

      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const m = javaClassRegex.exec(lines[i]);
        if (m) {
          const className = m[1];
          if (!classMap.has(className)) {
            classMap.set(className, []);
          }
          classMap.get(className).push({
            filePath,
            line: i + 1,
            snippet: lines[i].trim().slice(0, 120),
          });
        }
      }
    }

    for (const [className, locations] of classMap) {
      if (locations.length > 1) {
        violations.push({
          ruleId: 'java-duplicate-class-name',
          message: `类名 "${className}" 在 ${locations.length} 个文件中定义，可能导致导入歧义`,
          severity: 'info',
          locations,
        });
      }
    }
  } // end isDisabled('java-duplicate-class-name')

  // ── Go 多文件 init() 函数检查 ──
  // 同一 package 下多个文件都有 init()，执行顺序依赖文件名排序，容易出错
  if (!isDisabled('go-multiple-init')) {
    const goInitMap = new Map(); // dirPath → [{filePath, line}]

    for (const { path: filePath, content } of files) {
      if (!filePath.endsWith('.go')) {
        continue;
      }

      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (/^func\s+init\s*\(\s*\)/.test(lines[i].trim())) {
          const dir = filePath.substring(0, filePath.lastIndexOf('/'));
          if (!goInitMap.has(dir)) {
            goInitMap.set(dir, []);
          }
          goInitMap.get(dir).push({
            filePath,
            line: i + 1,
            snippet: lines[i].trim().slice(0, 120),
          });
          break; // 每个文件只记录一次
        }
      }
    }

    for (const [dir, locations] of goInitMap) {
      if (locations.length > 2) {
        violations.push({
          ruleId: 'go-multiple-init',
          message: `同一 package (${dir.split('/').pop()}) 中 ${locations.length} 个文件都定义了 init()，执行顺序依赖文件名排序`,
          severity: 'info',
          locations,
        });
      }
    }
  } // end isDisabled('go-multiple-init')

  // ── Swift Extension 方法跨文件冲突检查 ──
  if (!isDisabled('swift-cross-file-extension-conflict')) {
    const swiftExtMethodMap = new Map(); // "TypeName.methodName" → [{filePath, line}]
    const swiftExtRegex = /extension\s+(\w+)/;
    const swiftFuncRegex = /func\s+(\w+)\s*\(/;

    for (const { path: filePath, content } of files) {
      if (!filePath.endsWith('.swift')) {
        continue;
      }

      const lines = content.split(/\r?\n/);
      let currentExt: string | null = null;
      let braceDepth = 0;

      for (let i = 0; i < lines.length; i++) {
        const extMatch = swiftExtRegex.exec(lines[i]);
        if (extMatch && !currentExt) {
          currentExt = extMatch[1];
          braceDepth = 0;
        }

        if (currentExt) {
          for (const ch of lines[i]) {
            if (ch === '{') {
              braceDepth++;
            } else if (ch === '}') {
              braceDepth--;
            }
          }

          const funcMatch = swiftFuncRegex.exec(lines[i]);
          if (funcMatch && braceDepth >= 1) {
            const key = `${currentExt}.${funcMatch[1]}`;
            if (!swiftExtMethodMap.has(key)) {
              swiftExtMethodMap.set(key, []);
            }
            swiftExtMethodMap.get(key).push({
              filePath,
              line: i + 1,
              snippet: lines[i].trim().slice(0, 120),
            });
          }

          if (braceDepth <= 0) {
            currentExt = null;
          }
        }
      }
    }

    for (const [key, locations] of swiftExtMethodMap) {
      if (locations.length > 1) {
        const uniqueFiles = new Set(locations.map((l: { filePath: string }) => l.filePath));
        if (uniqueFiles.size > 1) {
          violations.push({
            ruleId: 'swift-cross-file-extension-conflict',
            message: `Extension 方法 ${key} 在 ${uniqueFiles.size} 个文件中定义，可能导致方法冲突`,
            severity: 'warning',
            locations,
          });
        }
      }
    }
  } // end isDisabled('swift-cross-file-extension-conflict')

  return violations;
}
