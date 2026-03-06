/**
 * GuardCodeChecks - Guard 代码级别检查（跨行 / 配对检查）
 *
 * 从 GuardCheckEngine._runCodeLevelChecks 拆分
 * 按语言分发到各自的检查逻辑，不依赖正则规则
 */

/**
 * 代码级别检查 - 需要上下文理解的检查（跨行 / 配对检查）
 * 按语言分发到各自的检查逻辑
 * 支持 disabledRules 禁用特定检查、codeLevelThresholds 调整阈值
 *
 * @param {string} code 源代码
 * @param {string} language 语言标识
 * @param {string[]} lines 按行拆分的源代码
 * @param {object} options
 * @param {string[]} [options.disabledRules] 禁用的规则 ID 列表
 * @param {Record<string, number>} [options.codeLevelThresholds] 可配置阈值
 * @returns {Array<{ruleId, message, severity, line, snippet, dimension?, fixSuggestion?}>}
 */
export function runCodeLevelChecks(code, language, lines, options: any = {}) {
  const violations: any[] = [];
  const disabledSet = new Set(options.disabledRules || []);
  const thresholds = options.codeLevelThresholds || {};
  /** 判断 ruleId 是否被禁用 */
  const isDisabled = (ruleId) => disabledSet.has(ruleId);
  /** 获取可配置阈值，回退到默认值 */
  const threshold = (ruleId, defaultVal) => thresholds[ruleId] ?? defaultVal;

  // ── ObjC ──
  if (language === 'objc') {
    // KVO 观察者未移除检查
    if (
      !isDisabled('objc-kvo-missing-remove') &&
      code.includes('addObserver') &&
      !code.includes('removeObserver')
    ) {
      const lineIdx = lines.findIndex((l) => /addObserver/.test(l));
      violations.push({
        ruleId: 'objc-kvo-missing-remove',
        message: '存在 addObserver 未发现配对 removeObserver，请在 dealloc 或合适时机移除',
        severity: 'warning',
        line: lineIdx >= 0 ? lineIdx + 1 : 1,
        snippet: lineIdx >= 0 ? lines[lineIdx].trim().slice(0, 120) : '',
        dimension: 'file',
      });
    }

    // ObjC Category 重名检查 (同文件)
    if (!isDisabled('objc-duplicate-category')) {
      const categoryRegex = /@interface\s+(\w+)\s*\(\s*(\w+)\s*\)/g;
      const categories: Record<string, any> = {};
      for (let i = 0; i < lines.length; i++) {
        categoryRegex.lastIndex = 0;
        const m = categoryRegex.exec(lines[i]);
        if (!m) {
          continue;
        }
        const key = `${m[1]}(${m[2]})`;
        if (!categories[key]) {
          categories[key] = [];
        }
        categories[key].push({ line: i + 1, snippet: lines[i].trim().slice(0, 120) });
      }
      for (const [key, occs] of Object.entries(categories)) {
        if ((occs as any).length <= 1) {
          continue;
        }
        for (let j = 1; j < (occs as any).length; j++) {
          violations.push({
            ruleId: 'objc-duplicate-category',
            message: `同文件内 Category 重名：${key}，首次在第 ${occs[0].line} 行`,
            severity: 'warning',
            line: occs[j].line,
            snippet: occs[j].snippet,
            dimension: 'file',
          });
        }
      }
    } // end isDisabled('objc-duplicate-category')
  }

  // ── JavaScript / TypeScript ──
  if (language === 'javascript' || language === 'typescript') {
    // Promise 未处理 rejection 检查
    // 文件中存在 .then() 但没有对应的 .catch() 或 try-catch
    if (
      !isDisabled('js-unhandled-promise') &&
      code.includes('.then(') &&
      !code.includes('.catch(') &&
      !code.includes('try')
    ) {
      const thenLines: number[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (/\.then\s*\(/.test(lines[i])) {
          thenLines.push(i);
        }
      }
      if (thenLines.length > 0) {
        violations.push({
          ruleId: 'js-unhandled-promise',
          message: 'Promise 链缺少 .catch() 错误处理，未捕获的 rejection 可能导致静默失败',
          severity: 'warning',
          line: thenLines[0] + 1,
          snippet: lines[thenLines[0]].trim().slice(0, 120),
          dimension: 'file',
        });
      }
    }
  }

  // ── Go ──
  if (language === 'go') {
    // defer 在循环内检查 — defer 在函数结束时才执行，循环内 defer 可能资源泄露
    if (!isDisabled('go-defer-in-loop')) {
      let inLoop = false;
      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (/^for\s/.test(trimmed) || /^for\s*\{/.test(trimmed)) {
          inLoop = true;
        }
        if (inLoop && /^\s*defer\s/.test(lines[i])) {
          violations.push({
            ruleId: 'go-defer-in-loop',
            message: 'defer 在循环内会延迟到函数返回时才执行，可能导致资源泄露或大量堆积',
            severity: 'warning',
            line: i + 1,
            snippet: lines[i].trim().slice(0, 120),
            dimension: 'file',
            fixSuggestion: '将循环体提取到独立函数中，或手动调用 Close()',
          });
        }
        // 简化: 遇到 } 且缩进回到顶层，认为循环结束
        if (inLoop && trimmed === '}' && (lines[i].match(/^\t/) || lines[i].match(/^}/))) {
          inLoop = false;
        }
      }
    } // end isDisabled('go-defer-in-loop')
  }

  // ── Python ──
  if (language === 'python') {
    // 文件中同时存在 tab 和 space 缩进
    if (!isDisabled('py-mixed-indentation')) {
      let hasTab = false;
      let hasSpace = false;
      for (let i = 0; i < Math.min(lines.length, 200); i++) {
        if (/^\t/.test(lines[i])) {
          hasTab = true;
        }
        if (/^ {2,}/.test(lines[i]) && !/^\t/.test(lines[i])) {
          hasSpace = true;
        }
      }
      if (hasTab && hasSpace) {
        violations.push({
          ruleId: 'py-mixed-indentation',
          message: '文件混用 tab 和 space 缩进，Python 对此敏感，请统一使用 space',
          severity: 'warning',
          line: 1,
          snippet: '',
          dimension: 'file',
        });
      }
    } // end isDisabled('py-mixed-indentation')
  }

  // ── Swift ──
  if (language === 'swift') {
    // 强制解包滥用检查: 连续多行使用 ! 强制解包（单行已被正则规则覆盖，这里检查文件级滥用）
    if (!isDisabled('swift-excessive-force-unwrap')) {
      let forceUnwrapCount = 0;
      for (let i = 0; i < lines.length; i++) {
        // 排除 != 和 !== 运算符, 以及注释行
        const trimmed = lines[i].trimStart();
        if (trimmed.startsWith('//') || trimmed.startsWith('/*')) {
          continue;
        }
        // 匹配 variable! 或 expression!. 形式，但排除 !=
        if (/\w!(?!=)[.\s,)\]]/.test(lines[i]) || /\w!$/.test(lines[i].trim())) {
          forceUnwrapCount++;
        }
      }
      if (forceUnwrapCount > threshold('swift-excessive-force-unwrap', 5)) {
        violations.push({
          ruleId: 'swift-excessive-force-unwrap',
          message: `文件包含 ${forceUnwrapCount} 处强制解包 (!)，建议使用 guard let / if let 安全解包`,
          severity: 'warning',
          line: 1,
          snippet: `${forceUnwrapCount} force unwraps detected`,
          dimension: 'file',
          fixSuggestion: '使用 guard let value = optional else { return } 替代 optional!',
        });
      }
    } // end isDisabled('swift-excessive-force-unwrap')
  }

  // ── Java ──
  if (language === 'java') {
    // 资源泄露检查: new InputStream/Connection/Reader 未在 try-with-resources 或 finally 中关闭
    if (!isDisabled('java-resource-leak')) {
      const resourcePatterns =
        /new\s+(FileInputStream|FileOutputStream|BufferedReader|BufferedWriter|Connection|Socket|FileReader|FileWriter|Scanner)\s*\(/;
      const hasResourceAlloc = lines.some((l) => resourcePatterns.test(l));
      const hasTryWithResource = code.includes('try (') || code.includes('try(');
      const hasFinallyClose = code.includes('finally') && code.includes('.close()');
      if (hasResourceAlloc && !hasTryWithResource && !hasFinallyClose) {
        const lineIdx = lines.findIndex((l) => resourcePatterns.test(l));
        violations.push({
          ruleId: 'java-resource-leak',
          message: '资源分配后未使用 try-with-resources 或 finally/close()，可能造成资源泄露',
          severity: 'warning',
          line: lineIdx >= 0 ? lineIdx + 1 : 1,
          snippet: lineIdx >= 0 ? lines[lineIdx].trim().slice(0, 120) : '',
          dimension: 'file',
          fixSuggestion: '使用 try (var res = new Resource()) { ... } 自动关闭资源',
        });
      }
    } // end isDisabled('java-resource-leak')

    // synchronized 在非 final 字段上 — 可能导致锁对象被替换
    if (!isDisabled('java-sync-non-final')) {
      const syncRegex = /synchronized\s*\(\s*(\w+)\s*\)/;
      for (let i = 0; i < lines.length; i++) {
        const m = syncRegex.exec(lines[i]);
        if (m && m[1] !== 'this' && !m[1].endsWith('.class')) {
          // 检查该变量是否声明为 final
          const varName = m[1];
          const declaredFinal = lines.some((l) =>
            new RegExp(`final\\s+\\w+.*\\b${varName}\\b`).test(l)
          );
          if (!declaredFinal) {
            violations.push({
              ruleId: 'java-sync-non-final',
              message: `synchronized 使用了非 final 变量 "${varName}"，锁对象可能被重新赋值`,
              severity: 'warning',
              line: i + 1,
              snippet: lines[i].trim().slice(0, 120),
              dimension: 'file',
              fixSuggestion: `将 ${varName} 声明为 private final`,
            });
          }
        }
      }
    } // end isDisabled('java-sync-non-final')
  }

  // ── Kotlin ──
  if (language === 'kotlin') {
    // GlobalScope.launch — 生命周期泄露风险
    if (!isDisabled('kotlin-global-scope')) {
      for (let i = 0; i < lines.length; i++) {
        if (/GlobalScope\s*\.\s*(launch|async)/.test(lines[i])) {
          violations.push({
            ruleId: 'kotlin-global-scope',
            message: 'GlobalScope.launch/async 不绑定生命周期，可能导致协程泄露',
            severity: 'warning',
            line: i + 1,
            snippet: lines[i].trim().slice(0, 120),
            dimension: 'file',
            fixSuggestion: '使用 viewModelScope、lifecycleScope 或自定义 CoroutineScope 替代',
          });
        }
      }
    } // end isDisabled('kotlin-global-scope')

    // runBlocking 在 main/UI 线程 — 可能冻结 UI
    if (!isDisabled('kotlin-run-blocking') && code.includes('runBlocking')) {
      const lineIdx = lines.findIndex((l) => /runBlocking\s*[({]/.test(l));
      if (lineIdx >= 0) {
        violations.push({
          ruleId: 'kotlin-run-blocking',
          message: 'runBlocking 会阻塞当前线程，避免在 Main/UI 线程中使用',
          severity: 'warning',
          line: lineIdx + 1,
          snippet: lines[lineIdx].trim().slice(0, 120),
          dimension: 'file',
          fixSuggestion: '改用 suspend 函数 或 launch { } 非阻塞协程',
        });
      }
    }
  }

  // ── Rust ──
  if (language === 'rust') {
    // .unwrap() 滥用检查 — 生产代码应使用 ? 或 expect()
    if (!isDisabled('rust-excessive-unwrap')) {
      let unwrapCount = 0;
      const unwrapLines: number[] = [];
      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trimStart();
        // 跳过测试代码和注释
        if (trimmed.startsWith('//') || trimmed.startsWith('#[test]')) {
          continue;
        }
        if (/\.unwrap\(\)/.test(lines[i])) {
          unwrapCount++;
          if (unwrapLines.length < 3) {
            unwrapLines.push(i);
          }
        }
      }
      if (unwrapCount > threshold('rust-excessive-unwrap', 3)) {
        violations.push({
          ruleId: 'rust-excessive-unwrap',
          message: `文件包含 ${unwrapCount} 处 .unwrap()，生产代码建议使用 ? 操作符或 .expect("reason")`,
          severity: 'warning',
          line: unwrapLines[0] + 1,
          snippet: lines[unwrapLines[0]].trim().slice(0, 120),
          dimension: 'file',
          fixSuggestion: '使用 ? 操作符向上传播错误，或 .expect("具体原因") 提供崩溃上下文',
        });
      }
    } // end isDisabled('rust-excessive-unwrap')

    // unsafe 块数量检查
    if (!isDisabled('rust-excessive-unsafe')) {
      let unsafeCount = 0;
      for (let i = 0; i < lines.length; i++) {
        if (/\bunsafe\s*\{/.test(lines[i]) || /\bunsafe\s+fn\b/.test(lines[i])) {
          unsafeCount++;
        }
      }
      if (unsafeCount > threshold('rust-excessive-unsafe', 3)) {
        violations.push({
          ruleId: 'rust-excessive-unsafe',
          message: `文件包含 ${unsafeCount} 处 unsafe 块/函数，请审查是否都必要`,
          severity: 'warning',
          line: 1,
          snippet: `${unsafeCount} unsafe blocks detected`,
          dimension: 'file',
          fixSuggestion: '尽量使用 safe abstraction 封装 unsafe 代码，减少 unsafe 暴露面',
        });
      }
    } // end isDisabled('rust-excessive-unsafe')
  }

  // ── Dart ──
  if (language === 'dart') {
    // setState after dispose — Flutter 常见内存泄露
    if (
      !isDisabled('dart-setstate-after-dispose') &&
      code.includes('setState') &&
      code.includes('dispose')
    ) {
      // 检查 dispose 方法后是否还有 async 回调中的 setState
      const disposeIdx = lines.findIndex(
        (l) => /void\s+dispose\s*\(/.test(l) || /\bsuper\.dispose\(\)/.test(l)
      );
      if (disposeIdx >= 0) {
        // 检查是否有 mounted 检查保护
        const hasMountedCheck = code.includes('if (mounted)') || code.includes('if (!mounted)');
        if (!hasMountedCheck) {
          violations.push({
            ruleId: 'dart-setstate-after-dispose',
            message:
              '存在 setState 调用但未检查 mounted 状态，异步回调可能在 dispose 后触发 setState',
            severity: 'warning',
            line: disposeIdx + 1,
            snippet: lines[disposeIdx].trim().slice(0, 120),
            dimension: 'file',
            fixSuggestion: '在 setState 前添加 if (!mounted) return; 检查',
          });
        }
      }
    }

    // late 变量未初始化风险
    if (!isDisabled('dart-excessive-late')) {
      let lateCount = 0;
      for (let i = 0; i < lines.length; i++) {
        if (/\blate\s+(?!final\b)\w+/.test(lines[i]) && !lines[i].includes('=')) {
          lateCount++;
        }
      }
      if (lateCount > threshold('dart-excessive-late', 3)) {
        violations.push({
          ruleId: 'dart-excessive-late',
          message: `文件有 ${lateCount} 个 late 非 final 变量且无初始值，访问未初始化变量会抛出 LateInitializationError`,
          severity: 'warning',
          line: 1,
          snippet: `${lateCount} late variables without initializer`,
          dimension: 'file',
          fixSuggestion: '考虑使用可空类型 + null 检查，或 late final + 初始化赋值',
        });
      }
    } // end isDisabled('dart-excessive-late')
  }

  return violations;
}
