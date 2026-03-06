/**
 * FileWatcher - V2 文件监听主服务（精简版）
 *
 * 监控项目文件变更，检测 // as:c、// as:s、// as:a 等指令并自动处理。
 * 具体指令逻辑已拆分至 handlers/ 和 XcodeIntegration.js。
 *
 * 用法：
 *   const watcher = new FileWatcher(specPath, projectRoot, { quiet: false });
 *   watcher.start();
 */

import { accessSync, readFileSync, statSync } from 'node:fs';
import { basename, join, normalize } from 'node:path';
import { watch as chokidarWatch } from 'chokidar';
import { saveEventFilter } from '../../platform/ios/xcode/SaveEventFilter.js';
import { FILE_WATCHER } from '../../shared/constants.js';
import { detectTriggers, REGEX } from './DirectiveDetector.js';
import { handleAlink } from './handlers/AlinkHandler.js';
/* ── Handler imports ── */
import { handleCreate } from './handlers/CreateHandler.js';
import { handleGuard } from './handlers/GuardHandler.js';
import { handleHeader } from './handlers/HeaderHandler.js';
import { handleSearch } from './handlers/SearchHandler.js';

/* ────────── 配置 ────────── */

const DEFAULT_FILE_PATTERN = [
  // ObjC/Swift
  '**/*.m',
  '**/*.h',
  '**/*.mm',
  '**/*.swift',
  // JS/TS
  '**/*.js',
  '**/*.ts',
  '**/*.jsx',
  '**/*.tsx',
  '**/*.vue',
  '**/*.svelte',
  // Python
  '**/*.py',
  // JVM
  '**/*.java',
  '**/*.kt',
  '**/*.kts',
  // Other languages
  '**/*.go',
  '**/*.rs',
  '**/*.rb',
  // C/C++
  '**/*.c',
  '**/*.cpp',
  '**/*.cc',
  '**/*.hpp',
];
const IGNORED = [
  '**/node_modules/**',
  '**/.git/**',
  '**/.mgit/**',
  '**/.easybox/**',
  '**/xcuserdata/**',
  '**/.build/**',
  '**/*.swp',
  '**/*.tmp',
  '**/*~.m',
  '**/*~.h',
  '**/DerivedData/**',
  '**/Pods/**',
  '**/Carthage/**',
  '**/__pycache__/**',
  '**/.venv/**',
  '**/venv/**',
  '**/build/**',
  '**/target/**',
  '**/.gradle/**',
  '**/dist/**',
  '**/.next/**',
  '**/.nuxt/**',
];
const DEBOUNCE_DELAY = FILE_WATCHER.DEBOUNCE_DELAY_MS;

/* ────────── FileWatcher ────────── */

export class FileWatcher {
  _debounceTimers: any;
  _timeoutHead: any;
  _timeoutLink: any;
  _watcher: any;
  exts: any;
  onEvent: any;
  pathPrefix: any;
  projectRoot: any;
  quiet: any;
  specPath: any;
  /**
   * @param {string} specPath  boxspec.json 绝对路径
   * @param {string} projectRoot 项目根目录
   * @param {object} [opts]
   * @param {boolean} [opts.quiet=false]
   * @param {string[]} [opts.exts] 可选扩展名列表
   * @param {string} [opts.pathPrefix] 可选路径前缀过滤
   * @param {Function} [opts.onEvent] 可选事件回调
   */
  constructor(specPath, projectRoot, opts: any = {}) {
    this.specPath = specPath;
    this.projectRoot = projectRoot;
    this.quiet = !!opts.quiet;
    this.pathPrefix = opts.pathPrefix || null;
    this.onEvent = opts.onEvent || null;
    this.exts = opts.exts || null;
    this._debounceTimers = new Map();
    this._watcher = null;
    this._timeoutLink = null;
    this._timeoutHead = null;
  }

  /**
   * 启动文件监听
   */
  start() {
    const watchRoot = this.projectRoot;
    const filePattern = this.exts
      ? this.exts.map((e) => `**/*${e.startsWith('.') ? e : `.${e}`}`)
      : DEFAULT_FILE_PATTERN;

    if (!this.quiet) {
    }

    this._watcher = chokidarWatch(filePattern, {
      cwd: watchRoot,
      ignored: IGNORED,
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: {
        stabilityThreshold: FILE_WATCHER.STABILITY_THRESHOLD_MS,
        pollInterval: FILE_WATCHER.POLL_INTERVAL_MS,
      },
      usePolling: process.env.ASD_WATCH_POLLING === 'true',
      interval: FILE_WATCHER.POLL_INTERVAL_MS,
      binaryInterval: FILE_WATCHER.BINARY_INTERVAL_MS,
    });

    const handleEvent = (relativePath) => {
      const fullPath = join(watchRoot, relativePath);

      if (process.env.ASD_DEBUG === '1') {
      }

      if (this.pathPrefix && !normalize(relativePath).startsWith(normalize(this.pathPrefix))) {
        return;
      }

      this._debounce(fullPath, () => {
        this._processFile(fullPath, relativePath);
      });
    };

    this._watcher.on('change', handleEvent);
    this._watcher.on('add', handleEvent);
    this._watcher.on('error', (err) => console.error('文件监听错误:', err.message));
    this._watcher.on('ready', () => {
      if (!this.quiet) {
      }
      if (process.env.ASD_DEBUG === '1') {
      }
    });

    return this._watcher;
  }

  /**
   * 停止监听，释放所有资源
   */
  async stop() {
    if (this._watcher) {
      // 移除所有事件监听器，避免泄漏
      this._watcher.removeAllListeners();
      await this._watcher.close();
      this._watcher = null;
    }
    // 清理所有防抖定时器
    for (const timer of this._debounceTimers.values()) {
      clearTimeout(timer);
    }
    this._debounceTimers.clear();
    // 清理 handler 级别的延时定时器
    if (this._timeoutLink) {
      clearTimeout(this._timeoutLink);
      this._timeoutLink = null;
    }
    if (this._timeoutHead) {
      clearTimeout(this._timeoutHead);
      this._timeoutHead = null;
    }
  }

  /* ────────── 内部：文件处理（分派到 handlers） ────────── */

  async _processFile(fullPath, relativePath) {
    try {
      accessSync(fullPath);
      const stat = statSync(fullPath);
      if (stat.isDirectory() || stat.size > FILE_WATCHER.MAX_FILE_SIZE_BYTES) {
        return;
      }
    } catch {
      return;
    }

    let data;
    try {
      data = readFileSync(fullPath, 'utf8');
    } catch (err: any) {
      console.error(`❌ 读取文件失败: ${fullPath}`, err.message);
      return;
    }

    // ── 保存事件过滤：self-write / 内容未变 / Xcode 非前台 ──
    const verdict = saveEventFilter.shouldProcess(fullPath, data);
    if (!verdict.process) {
      if (process.env.ASD_DEBUG === '1') {
      }
      return;
    }

    if (process.env.ASD_DEBUG === '1') {
    }

    const filename = basename(fullPath);

    // 检测指令
    const triggers = detectTriggers(data, filename);

    if (process.env.ASD_DEBUG === '1') {
    }

    // // as:c — 创建候选
    if (triggers.createLine) {
      await handleCreate(this, fullPath, relativePath, triggers.createOption);
    }

    // // as:a — Guard 检查
    if (triggers.guardLine) {
      await handleGuard(this, fullPath, data, triggers.guardLine);
    }

    // // as:s — 搜索
    if (triggers.searchLine) {
      await handleSearch(this, fullPath, relativePath, triggers.searchLine);
    }

    // alink
    if (triggers.alinkLine) {
      clearTimeout(this._timeoutLink);
      this._timeoutLink = setTimeout(() => {
        handleAlink(triggers.alinkLine).catch((err) => {
          console.warn(`[Watcher] alink handler failed: ${err.message}`);
        });
      }, DEBOUNCE_DELAY);
    }

    // ── 更新内容哈希（处理完毕后记录状态，供下次变更比对） ──
    saveEventFilter.updateHash(fullPath, data);

    // header 指令
    if (triggers.headerLine) {
      const isMatch = triggers.isSwift
        ? REGEX.HEADER_SWIFT.test(triggers.headerLine)
        : REGEX.HEADER_OBJC.test(triggers.headerLine);
      if (isMatch) {
        clearTimeout(this._timeoutHead);
        this._timeoutHead = setTimeout(() => {
          handleHeader(
            this,
            fullPath,
            triggers.headerLine,
            triggers.importArray,
            triggers.isSwift
          ).catch((err) => {
            console.warn(`[Watcher] header handler failed: ${err.message}`);
          });
        }, DEBOUNCE_DELAY);
      }
    }
  }

  /* ────────── 工具方法（供 handlers 通过 watcher 引用调用） ────────── */

  /**
   * 追加候选项（通过 ServiceContainer 或 HTTP API）
   */
  async _appendCandidates(items, source) {
    // 过滤空 title / 空 code 的无效条目
    const validItems = items.filter((item) => {
      const title = (item.title || '').trim();
      const code = (item.code || '').trim();
      if (!title || !code) {
        console.warn(
          `[Watcher] 跳过无效候选: title=${JSON.stringify(title)}, code length=${code.length}`
        );
        return false;
      }
      return true;
    });
    if (validItems.length === 0) {
      throw new Error('所有候选条目缺少 title 或 code，无法提交');
    }

    // 优先 ServiceContainer
    let serviceError: any = null;
    try {
      const { ServiceContainer } = await import('../../injection/ServiceContainer.js');
      const container = ServiceContainer.getInstance();
      const knowledgeService = container.get('knowledgeService');
      const context = { userId: 'filewatcher' };
      for (const item of validItems) {
        await knowledgeService.create(
          {
            content: {
              pattern: item.code || '',
            },
            language: item.language || 'objc',
            category: item.category || 'Utility',
            source: source || 'watch',
            title: item.title,
            description: item.summary || item.description || '',
            moduleName: item.moduleName || 'watch-create',
            trigger: item.trigger || '',
            headers: item.headers || [],
            tags: item.tags || [],
          },
          context
        );
      }
      return;
    } catch (err: any) {
      serviceError = err;
      console.warn('[Watcher] KnowledgeService 创建失败，尝试 HTTP 回退:', err.message);
    }

    // 回退：HTTP API（使用 knowledge 端点而非 candidates）
    const dashboardUrl = process.env.ASD_DASHBOARD_URL || 'http://localhost:3000';
    try {
      for (const item of validItems) {
        const resp = await fetch(`${dashboardUrl}/api/v1/knowledge`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: item.title,
            content: { pattern: item.code || '' },
            language: item.language || 'objc',
            category: item.category || 'Utility',
            source: source || 'watch',
            description: item.summary || item.description || '',
            moduleName: item.moduleName || 'watch-create',
            trigger: item.trigger || '',
            headers: item.headers || [],
          }),
        });
        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status}`);
        }
      }
      return;
    } catch (err: any) {
      console.warn(`[Watcher] HTTP 候选提交也失败: ${err.message}`);
    }

    // 两条路径都失败 → 抛出原始错误
    throw serviceError || new Error('候选提交失败：ServiceContainer 和 HTTP 均不可用');
  }

  /**
   * 为候选解析头文件
   */
  async _resolveHeadersIfNeeded(item, relativePath, text) {
    if (relativePath && (!item.headers || item.headers.length === 0)) {
      try {
        const HeaderResolver = await import('../../infrastructure/paths/HeaderResolver.js');
        const resolved = await HeaderResolver.resolveHeadersForText(
          this.projectRoot,
          relativePath,
          text
        );
        if (resolved?.headers && resolved.headers.length > 0) {
          item.headers = resolved.headers;
          item.headerPaths = resolved.headerPaths;
          item.moduleName = resolved.moduleName;
        }
      } catch {
        // 头文件解析失败不阻塞
      }
    }
  }

  /**
   * 打开 Dashboard 页面
   */
  _openDashboard(path) {
    const base = process.env.ASD_DASHBOARD_URL || 'http://localhost:3000';
    const url = `${base}${path}`;
    import('../../infrastructure/external/OpenBrowser.js')
      .then(({ openBrowserReuseTab }) => openBrowserReuseTab(url, base))
      .catch(() => {});
  }

  /**
   * macOS 通知
   */
  _notify(msg) {
    import('../../infrastructure/external/NativeUi.js')
      .then((NU) => NU.notify(msg))
      .catch(() => {});
  }

  /**
   * 防抖
   */
  _debounce(key, fn) {
    if (this._debounceTimers.has(key)) {
      clearTimeout(this._debounceTimers.get(key));
    }
    this._debounceTimers.set(
      key,
      setTimeout(() => {
        this._debounceTimers.delete(key);
        Promise.resolve()
          .then(() => fn())
          .catch((err) => {
            console.error('[Watch] 处理文件失败:', err.message);
            if (process.env.ASD_DEBUG === '1') {
              console.error(err.stack);
            }
          });
      }, DEBOUNCE_DELAY)
    );
  }
}

export default FileWatcher;
