/**
 * GuardCheckEngine - Guard 规则检查引擎
 * 
 * 从 V1 guard/ios 迁移，适配 V2 架构
 * 支持: 正则模式匹配 + code-level 检查 + 多维度审计
 */

import Logger from '../../infrastructure/logging/Logger.js';

/**
 * 内置默认规则集（iOS: ObjC + Swift）
 * 用于在数据库为空时提供基础检查能力
 */
const BUILT_IN_RULES = {
  'no-main-thread-sync': {
    message: '禁止在主线程上使用 dispatch_sync(main)，易死锁',
    severity: 'error',
    pattern: 'dispatch_sync\\s*\\([^)]*main',
    languages: ['objc', 'swift'],
    dimension: 'file',
  },
  'main-thread-sync-swift': {
    message: '禁止在主线程上使用 DispatchQueue.main.sync，易死锁',
    severity: 'error',
    pattern: 'DispatchQueue\\.main\\.sync',
    languages: ['swift'],
    dimension: 'file',
  },
  'objc-dealloc-async': {
    message: 'dealloc 内禁止使用 dispatch_async/dispatch_after/postNotification 等',
    severity: 'error',
    pattern: '(dealloc.*(dispatch_async|dispatch_after|postNotification|performSelector.*afterDelay))',
    languages: ['objc'],
    dimension: 'file',
  },
  'objc-block-retain-cycle': {
    message: 'block 内直接使用 self 可能循环引用，建议 weakSelf',
    severity: 'warning',
    pattern: '\\^\\s*[({][^}]*\\bself\\b',
    languages: ['objc'],
    dimension: 'file',
  },
  'objc-assign-object': {
    message: 'assign 用于对象类型会产生悬垂指针，建议改为 weak 或 strong',
    severity: 'warning',
    pattern: '@property\\s*\\([^)]*\\bassign\\b[^)]*\\)[^;]*(\\*|id\\s*<|\\bid\\s+)',
    languages: ['objc'],
    dimension: 'file',
  },
  'swift-force-cast': {
    message: '强制类型转换 as! 在失败时崩溃，建议 as? 或 guard let',
    severity: 'warning',
    pattern: 'as\\s*!',
    languages: ['swift'],
    dimension: 'file',
  },
  'swift-force-try': {
    message: 'try! 在异常时崩溃，建议 do-catch 或 try?',
    severity: 'warning',
    pattern: 'try\\s*!',
    languages: ['swift'],
    dimension: 'file',
  },
  'objc-timer-retain-cycle': {
    message: 'NSTimer 以 self 为 target 会强引用 self，需在 dealloc 前 invalidate 或使用 block 形式',
    severity: 'warning',
    pattern: '(scheduledTimerWithTimeInterval|timerWithTimeInterval)[^;]*target\\s*:\\s*self',
    languages: ['objc'],
    dimension: 'file',
  },
  'objc-possible-main-thread-blocking': {
    message: 'sleep/usleep 可能造成主线程阻塞',
    severity: 'warning',
    pattern: '\\b(sleep|usleep)\\s*\\(',
    languages: ['objc'],
    dimension: 'file',
  },

  // ── 通用 JavaScript / TypeScript 规则 ──────────────────

  'js-no-eval': {
    message: 'eval() 存在安全风险和性能问题，应避免使用',
    severity: 'error',
    pattern: '\\beval\\s*\\(',
    languages: ['javascript', 'typescript'],
    dimension: 'file',
  },
  'js-no-var': {
    message: '使用 let/const 替代 var，避免变量提升问题',
    severity: 'warning',
    pattern: '\\bvar\\s+\\w+',
    languages: ['javascript', 'typescript'],
    dimension: 'file',
  },
  'js-no-console-log': {
    message: '生产代码应移除 console.log，使用专用日志库',
    severity: 'info',
    pattern: 'console\\.log\\s*\\(',
    languages: ['javascript', 'typescript'],
    dimension: 'file',
  },
  'js-no-debugger': {
    message: '生产代码中不应包含 debugger 语句',
    severity: 'error',
    pattern: '\\bdebugger\\b',
    languages: ['javascript', 'typescript'],
    dimension: 'file',
  },
  'ts-no-any': {
    message: '避免使用 any 类型，使用 unknown 或具体类型',
    severity: 'warning',
    pattern: ':\\s*any\\b',
    languages: ['typescript'],
    dimension: 'file',
  },
  'ts-no-non-null-assertion': {
    message: '非空断言 ! 可能掩盖 null/undefined 错误',
    severity: 'warning',
    pattern: '\\w+!\\.',
    languages: ['typescript'],
    dimension: 'file',
  },

  // ── Python 规则 ──────────────────────────────────────

  'py-no-bare-except': {
    message: '裸 except: 会捕获所有异常（含 SystemExit），应指定异常类型',
    severity: 'warning',
    pattern: 'except\\s*:',
    languages: ['python'],
    dimension: 'file',
  },
  'py-no-exec': {
    message: 'exec() 存在安全风险，应避免使用',
    severity: 'error',
    pattern: '\\bexec\\s*\\(',
    languages: ['python'],
    dimension: 'file',
  },
  'py-no-mutable-default': {
    message: '函数默认参数使用可变对象（list/dict/set）会导致共享状态 bug',
    severity: 'warning',
    pattern: 'def\\s+\\w+\\s*\\([^)]*=\\s*\\[\\]',
    languages: ['python'],
    dimension: 'file',
  },

  // ── Java / Kotlin 规则 ──────────────────────────────

  'java-no-system-exit': {
    message: 'System.exit() 直接终止 JVM，应抛异常或返回状态码',
    severity: 'error',
    pattern: 'System\\.exit\\s*\\(',
    languages: ['java', 'kotlin'],
    dimension: 'file',
  },
  'java-no-raw-type': {
    message: '使用泛型集合替代原始类型 (如 List<String> 替代 List)',
    severity: 'warning',
    pattern: '(List|Map|Set|Collection|Iterable)\\s+\\w+\\s*[=;]',
    languages: ['java'],
    dimension: 'file',
  },

  // ── Go 规则 ──────────────────────────────────────────

  'go-no-panic': {
    message: 'panic 应仅用于不可恢复错误，库代码应返回 error',
    severity: 'warning',
    pattern: '\\bpanic\\s*\\(',
    languages: ['go'],
    dimension: 'file',
  },
  'go-no-err-ignored': {
    message: '错误值不应用 _ 忽略，应处理或明确标注',
    severity: 'warning',
    pattern: '\\b_\\s*,\\s*err\\s*:?=|_\\s*=\\s*\\w+\\(',
    languages: ['go'],
    dimension: 'file',
  },

  // ── Rust 规则 ────────────────────────────────────────

  'rust-no-unwrap': {
    message: 'unwrap() 在 None/Err 时 panic，应使用 ? 或模式匹配',
    severity: 'warning',
    pattern: '\\.unwrap\\s*\\(',
    languages: ['rust'],
    dimension: 'file',
  },
  'rust-no-unsafe': {
    message: 'unsafe 代码需严格审查，确认必要性并添加安全注释',
    severity: 'info',
    pattern: '\\bunsafe\\s*\\{',
    languages: ['rust'],
    dimension: 'file',
  },
};

/**
 * 从文件扩展名推断语言
 */
export function detectLanguage(filePath) {
  if (!filePath) return 'unknown';
  const ext = filePath.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'swift': return 'swift';
    case 'm': case 'mm': case 'h': return 'objc';
    case 'js': case 'mjs': case 'cjs': return 'javascript';
    case 'ts': case 'tsx': return 'typescript';
    case 'py': return 'python';
    case 'java': return 'java';
    case 'kt': case 'kts': return 'kotlin';
    case 'rb': return 'ruby';
    case 'go': return 'go';
    case 'rs': return 'rust';
    default: return 'unknown';
  }
}

/**
 * GuardCheckEngine - 核心检查引擎
 */
export class GuardCheckEngine {
  constructor(db, options = {}) {
    this.db = typeof db?.getDb === 'function' ? db.getDb() : db;
    this.logger = Logger.getInstance();
    this._builtInRules = BUILT_IN_RULES;
    this._customRulesCache = null;
    this._cacheTime = 0;
    this._cacheTTL = options.cacheTTL || 60_000; // 1min
  }

  /**
   * 获取所有启用的规则 (数据库 + 内置)
   */
  getRules(language = null) {
    let rules = [];

    // 从数据库加载自定义规则
    // 优先从 knowledge_entries 表查询（V3），回退到 recipes 表（V2）
    try {
      const now = Date.now();
      if (!this._customRulesCache || now - this._cacheTime > this._cacheTTL) {
        let rows = [];
        try {
          // V3: knowledge_entries 表
          rows = this.db.prepare(
            `SELECT id, title, description, language, scope, constraints
             FROM knowledge_entries
             WHERE (kind = 'rule' OR knowledge_type = 'boundary-constraint')
               AND lifecycle = 'active'`
          ).all();
        } catch {
          // V3 表不存在，回退到 V2 recipes 表
          try {
            rows = this.db.prepare(
              `SELECT id, title, description, language, scope, constraints_json AS constraints
               FROM recipes WHERE (kind = 'rule' OR knowledge_type = 'boundary-constraint') AND status = 'active'`
            ).all();
          } catch { /* neither table exists */ }
        }
        this._customRulesCache = rows.map(r => {
          let guards = [];
          try {
            const constraints = JSON.parse(r.constraints || '{}');
            guards = constraints.guards || [];
          } catch { /* ignore */ }
          // Each guard entry becomes a rule
          return guards.map(g => ({
            id: g.id || r.id,
            name: g.name || r.title,
            message: g.message || r.description || r.title,
            pattern: g.pattern || '',
            languages: r.language ? [r.language] : [],
            severity: g.severity || 'warning',
            dimension: r.scope || 'file',
            source: 'database',
          }));
        }).flat().filter(r => r.pattern);
        this._cacheTime = now;
      }
      rules.push(...this._customRulesCache);
    } catch {
      // table or column may not exist
    }

    // 合并内置规则（不覆盖同名数据库规则）
    const existingIds = new Set(rules.map(r => r.id || r.name));
    for (const [ruleId, rule] of Object.entries(this._builtInRules)) {
      if (!existingIds.has(ruleId)) {
        rules.push({
          id: ruleId,
          name: ruleId,
          message: rule.message,
          pattern: rule.pattern,
          languages: rule.languages,
          severity: rule.severity,
          dimension: rule.dimension || 'file',
          source: 'built-in',
        });
      }
    }

    // 按语言过滤
    if (language) {
      rules = rules.filter(r => !r.languages?.length || r.languages.includes(language));
    }

    return rules;
  }

  /**
   * 对代码运行静态检查
   * @param {string} code - 源代码
   * @param {string} language - 'objc'|'swift'|'javascript' 等
   * @param {object} options - {scope, filePath}
   * @returns {Array<{ruleId, message, severity, line, snippet, dimension?}>}
   */
  checkCode(code, language, options = {}) {
    const { scope = null } = options;
    const violations = [];

    // 获取匹配语言的规则
    let rules = this.getRules(language);

    // 如果有 scope，按层级过滤：project ⊇ target ⊇ file
    // project 范围包含所有维度的规则；target 包含 file+target；file 仅匹配 file
    if (scope) {
      const SCOPE_HIERARCHY = { project: ['file', 'target', 'project'], target: ['file', 'target'], file: ['file'] };
      const allowedDimensions = SCOPE_HIERARCHY[scope] || [scope];
      rules = rules.filter(r => !r.dimension || allowedDimensions.includes(r.dimension));
    }

    const lines = (code || '').split(/\r?\n/);

    for (const rule of rules) {
      // 跳过空模式或特殊标记 (?!) — 由 code-level 检查接管
      if (!rule.pattern || rule.pattern === '(?!)') continue;

      let re;
      try {
        re = new RegExp(rule.pattern);
      } catch {
        this.logger.debug(`Invalid regex in rule ${rule.id}: ${rule.pattern}`);
        continue;
      }

      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          violations.push({
            ruleId: rule.id || rule.name,
            message: rule.message,
            severity: rule.severity || 'warning',
            line: i + 1,
            snippet: lines[i].trim().slice(0, 120),
            ...(rule.dimension ? { dimension: rule.dimension } : {}),
          });
        }
      }
    }

    // Code-level 检查（不依赖正则）
    violations.push(...this._runCodeLevelChecks(code, language, lines));

    // 跟踪 Guard 命中次数（回写 Recipe 统计）
    this.trackGuardHits(violations);

    // ── Reasoning Enrichment: 推理信息跟随数据流动 ──
    return violations.map(v => ({
      ...v,
      reasoning: {
        whatViolated: v.ruleId,
        whyItMatters: v.message,
        suggestedFix: v.suggestedFix || null,
      },
    }));
  }

  /**
   * 将 Guard 命中计数回写到对应 Recipe 的 guard_hit_count
   * @param {Array<{ruleId: string}>} violations
   */
  trackGuardHits(violations) {
    if (!violations?.length || !this.db) return;

    try {
      // 收集来自数据库规则的 ruleId → 命中次数
      const hitMap = new Map();
      for (const v of violations) {
        const count = hitMap.get(v.ruleId) || 0;
        hitMap.set(v.ruleId, count + 1);
      }

      // V3: guard_hit_count 已合并到 stats JSON，使用 json_set 更新
      let updateStmt;
      try {
        updateStmt = this.db.prepare(
          `UPDATE knowledge_entries
           SET stats = json_set(COALESCE(stats, '{}'), '$.guard_hits',
                 COALESCE(json_extract(stats, '$.guard_hits'), 0) + ?),
               updated_at = ?
           WHERE id = ?`
        );
      } catch {
        // V3 表不存在，回退到 V2
        updateStmt = this.db.prepare(
          `UPDATE recipes SET guard_hit_count = guard_hit_count + ?, updated_at = ? WHERE id = ?`
        );
      }
      const now = Math.floor(Date.now() / 1000);

      for (const [ruleId, count] of hitMap) {
        try {
          updateStmt.run(count, now, ruleId);
        } catch { /* 非 Recipe 规则（内置规则）忽略 */ }
      }
    } catch (err) {
      this.logger.debug('trackGuardHits failed', { error: err.message });
    }
  }

  /**
   * 代码级别检查 - 需要上下文理解的检查
   */
  _runCodeLevelChecks(code, language, lines) {
    const violations = [];

    if (language === 'objc') {
      // KVO 观察者未移除检查
      if (code.includes('addObserver') && !code.includes('removeObserver')) {
        const lineIdx = lines.findIndex(l => /addObserver/.test(l));
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
      const categoryRegex = /@interface\s+(\w+)\s*\(\s*(\w+)\s*\)/g;
      const categories = {};
      for (let i = 0; i < lines.length; i++) {
        categoryRegex.lastIndex = 0;
        const m = categoryRegex.exec(lines[i]);
        if (!m) continue;
        const key = `${m[1]}(${m[2]})`;
        if (!categories[key]) categories[key] = [];
        categories[key].push({ line: i + 1, snippet: lines[i].trim().slice(0, 120) });
      }
      for (const [key, occs] of Object.entries(categories)) {
        if (occs.length <= 1) continue;
        for (let j = 1; j < occs.length; j++) {
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
    }

    return violations;
  }

  /**
   * 文件审计 - 读取文件并检查
   * @param {string} filePath - 绝对路径
   * @param {string} code - 文件内容
   * @param {object} options - {scope}
   */
  auditFile(filePath, code, options = {}) {
    const language = detectLanguage(filePath);
    const violations = this.checkCode(code, language, { ...options, filePath });
    return {
      filePath,
      language,
      violations,
      summary: {
        total: violations.length,
        errors: violations.filter(v => v.severity === 'error').length,
        warnings: violations.filter(v => v.severity === 'warning').length,
      },
    };
  }

  /**
   * 批量文件审计
   * @param {Array<{path: string, content: string}>} files
   * @param {object} options - {scope: 'file'|'target'|'project'}
   * @returns {{files, summary, crossFileViolations}}
   */
  auditFiles(files, options = {}) {
    const results = [];
    let totalViolations = 0;
    let totalErrors = 0;

    for (const { path: filePath, content } of files) {
      const result = this.auditFile(filePath, content, options);
      results.push(result);
      totalViolations += result.summary.total;
      totalErrors += result.summary.errors;
    }

    // ── 跨文件检查 ──
    const crossFileViolations = this._runCrossFileChecks(files);
    totalViolations += crossFileViolations.length;
    totalErrors += crossFileViolations.filter(v => v.severity === 'error').length;

    return {
      files: results,
      crossFileViolations,
      summary: {
        filesChecked: results.length,
        totalViolations,
        totalErrors,
        filesWithViolations: results.filter(r => r.summary.total > 0).length,
      },
    };
  }

  /**
   * 跨文件检查 — 需要多文件上下文才能发现的问题
   * @param {Array<{path: string, content: string}>} files
   * @returns {Array<{ruleId, message, severity, locations}>}
   */
  _runCrossFileChecks(files) {
    const violations = [];

    // ── ObjC Category 跨文件重名检查 ──
    // 收集所有文件中的 @interface ClassName(CategoryName) 声明
    const categoryMap = new Map(); // key: "ClassName(CategoryName)" → [{filePath, line, snippet}]
    const categoryRegex = /@interface\s+(\w+)\s*\(\s*(\w+)\s*\)/g;

    for (const { path: filePath, content } of files) {
      const ext = filePath.split('.').pop()?.toLowerCase();
      if (ext !== 'm' && ext !== 'mm' && ext !== 'h') continue;

      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        categoryRegex.lastIndex = 0;
        let m;
        while ((m = categoryRegex.exec(lines[i])) !== null) {
          const key = `${m[1]}(${m[2]})`;
          if (!categoryMap.has(key)) categoryMap.set(key, []);
          categoryMap.get(key).push({
            filePath,
            line: i + 1,
            snippet: lines[i].trim().slice(0, 120),
          });
        }
      }
    }

    // .h 和 .m 成对出现是正常的（声明 + 实现），只有同类型文件重名才是问题
    // 或者超过 2 处声明就一定有问题
    for (const [key, locations] of categoryMap) {
      if (locations.length <= 1) continue;

      // 按文件扩展名分组: .h 和 .m/.mm 各一个是合法的
      const hFiles = locations.filter(l => l.filePath.endsWith('.h'));
      const mFiles = locations.filter(l => !l.filePath.endsWith('.h'));

      // 同类型文件中有多个声明 → 重名冲突
      const hasDuplicateH = hFiles.length > 1;
      const hasDuplicateM = mFiles.length > 1;
      // 超过 2 处总声明（如 3 个文件都声明了同一个 Category）→ 一定有问题
      const tooMany = locations.length > 2;

      if (hasDuplicateH || hasDuplicateM || tooMany) {
        // 收集冲突的那些位置
        const conflictLocations = tooMany ? locations
          : hasDuplicateH && hasDuplicateM ? locations
          : hasDuplicateH ? hFiles
          : mFiles;

        violations.push({
          ruleId: 'objc-cross-file-duplicate-category',
          message: `Category ${key} 在 ${conflictLocations.length} 个文件中重复声明，可能导致方法覆盖或未定义行为`,
          severity: 'warning',
          locations: conflictLocations,
        });
      }
    }

    return violations;
  }

  /**
   * 清除规则缓存
   */
  clearCache() {
    this._customRulesCache = null;
    this._cacheTime = 0;
  }

  /**
   * 获取内置规则列表
   */
  getBuiltInRules() {
    return { ...this._builtInRules };
  }
}

export default GuardCheckEngine;
