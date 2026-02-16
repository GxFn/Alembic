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

import { watch as chokidarWatch } from 'chokidar';
import { readFileSync, accessSync, statSync } from 'node:fs';
import { basename, join, normalize } from 'node:path';
import { detectTriggers, REGEX } from './DirectiveDetector.js';
import { saveEventFilter } from './SaveEventFilter.js';

/* ── Handler imports ── */
import { handleCreate } from './handlers/CreateHandler.js';
import { handleGuard } from './handlers/GuardHandler.js';
import { handleSearch } from './handlers/SearchHandler.js';
import { handleAlink } from './handlers/AlinkHandler.js';
import { handleHeader } from './handlers/HeaderHandler.js';
import { handleDraft } from './handlers/DraftHandler.js';

/* ────────── 配置 ────────── */

const DEFAULT_FILE_PATTERN = ['**/*.m', '**/*.h', '**/*.swift', '**/_draft_*.md'];
const IGNORED = [
  '**/node_modules/**', '**/.git/**', '**/.mgit/**', '**/.easybox/**',
  '**/xcuserdata/**', '**/.build/**', '**/*.swp', '**/*.tmp', '**/*~.m', '**/*~.h',
  '**/DerivedData/**', '**/Pods/**', '**/Carthage/**',
];
const DEBOUNCE_DELAY = 300;

/* ────────── FileWatcher ────────── */

export class FileWatcher {
  /**
   * @param {string} specPath  boxspec.json 绝对路径
   * @param {string} projectRoot 项目根目录
   * @param {object} [opts]
   * @param {boolean} [opts.quiet=false]
   * @param {string[]} [opts.exts] 可选扩展名列表
   * @param {string} [opts.pathPrefix] 可选路径前缀过滤
   * @param {Function} [opts.onEvent] 可选事件回调
   */
  constructor(specPath, projectRoot, opts = {}) {
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
      ? this.exts.map((e) => `**/*${e.startsWith('.') ? e : '.' + e}`)
      : DEFAULT_FILE_PATTERN;

    if (!this.quiet) {
      console.log(`✅ 文件监听已启动: ${watchRoot}`);
    }

    this._watcher = chokidarWatch(filePattern, {
      cwd: watchRoot,
      ignored: IGNORED,
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
      usePolling: process.env.ASD_WATCH_POLLING === 'true',
      interval: 100,
      binaryInterval: 300,
    });

    const handleEvent = (relativePath) => {
      const fullPath = join(watchRoot, relativePath);

      if (process.env.ASD_DEBUG === '1') {
        console.log(`[Watch] 检测到文件变化: ${relativePath}`);
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
        console.log('文件监听器已就绪，等待文件变更...');
      }
      if (process.env.ASD_DEBUG === '1') {
        console.log(`[Watch] 监听目录: ${watchRoot}`);
        console.log(`[Watch] 监听模式: ${filePattern.join(', ')}`);
      }
    });

    return this._watcher;
  }

  /**
   * 停止监听
   */
  async stop() {
    if (this._watcher) {
      await this._watcher.close();
      this._watcher = null;
    }
    for (const timer of this._debounceTimers.values()) {
      clearTimeout(timer);
    }
    this._debounceTimers.clear();
  }

  /* ────────── 内部：文件处理（分派到 handlers） ────────── */

  async _processFile(fullPath, relativePath) {
    try {
      accessSync(fullPath);
      const stat = statSync(fullPath);
      if (stat.isDirectory() || stat.size > 1024 * 1024) return;
    } catch {
      return;
    }

    let data;
    try {
      data = readFileSync(fullPath, 'utf8');
    } catch (err) {
      console.error(`❌ 读取文件失败: ${fullPath}`, err.message);
      return;
    }

    // ── 保存事件过滤：self-write / 内容未变 / Xcode 非前台 ──
    const verdict = saveEventFilter.shouldProcess(fullPath, data);
    if (!verdict.process) {
      if (process.env.ASD_DEBUG === '1') {
        console.log(`[Watch] 保存事件已过滤 (${verdict.reason}): ${relativePath}`);
      }
      return;
    }

    if (process.env.ASD_DEBUG === '1') {
      console.log(`[Watch] 读取文件内容成功，检查指令...`);
    }

    const filename = basename(fullPath);

    // _draft_*.md 文件自动处理
    if (REGEX.DRAFT_FILE.test(filename)) {
      await handleDraft(this, fullPath, relativePath, data);
    }

    // 检测指令
    const triggers = detectTriggers(data, filename);

    if (process.env.ASD_DEBUG === '1') {
      console.log(`[Watch] 指令检测结果:`, {
        createLine: !!triggers.createLine,
        guardLine: !!triggers.guardLine,
        searchLine: !!triggers.searchLine,
        alinkLine: !!triggers.alinkLine,
        headerLine: !!triggers.headerLine,
      });
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
        handleAlink(triggers.alinkLine).catch(err => {
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
          handleHeader(this, fullPath, triggers.headerLine, triggers.importArray, triggers.isSwift).catch(err => {
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
    const validItems = items.filter(item => {
      const title = (item.title || '').trim();
      const code = (item.code || '').trim();
      if (!title || !code) {
        console.warn(`[Watcher] 跳过无效候选: title=${JSON.stringify(title)}, code length=${code.length}`);
        return false;
      }
      return true;
    });
    if (validItems.length === 0) {
      throw new Error('所有候选条目缺少 title 或 code，无法提交');
    }

    // 优先 ServiceContainer
    let serviceError = null;
    try {
      const { ServiceContainer } = await import('../../injection/ServiceContainer.js');
      const container = ServiceContainer.getInstance();
      const knowledgeService = container.get('knowledgeService');
      const context = { userId: 'filewatcher' };
      for (const item of validItems) {
        await knowledgeService.create({
          content: {
            pattern: item.code || '',
          },
          language: item.language || 'objc',
          category: item.category || 'Utility',
          source: source || 'watch',
          title: item.title,
          summary_cn: item.summary || item.summary_cn || '',
          summary_en: item.summary_en || '',
          usage_guide_cn: item.usageGuide || item.usageGuide_cn || '',
          usage_guide_en: item.usageGuide_en || '',
          module_name: item.moduleName || 'watch-create',
          trigger: item.trigger || '',
          headers: item.headers || [],
          tags: item.tags || [],
          metadata: {
            trigger: item.trigger,
            usageGuide: item.usageGuide,
            headers: item.headers,
          },
        }, context);
      }
      return;
    } catch (err) {
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
            summary_cn: item.summary || item.summary_cn || '',
            module_name: item.moduleName || 'watch-create',
            trigger: item.trigger || '',
            headers: item.headers || [],
          }),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      }
      return;
    } catch (err) {
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
        if (resolved && resolved.headers && resolved.headers.length > 0) {
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
      .catch(() => {
        console.log(`💡 请手动访问: ${url}`);
      });
  }

  /**
   * macOS 通知
   */
  _notify(msg) {
    import('../../infrastructure/external/NativeUi.js')
      .then(NU => NU.notify(msg))
      .catch(() => console.log(`[AutoSnippet] ${msg}`));
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
        Promise.resolve().then(() => fn()).catch((err) => {
          console.error('[Watch] 处理文件失败:', err.message);
          if (process.env.ASD_DEBUG === '1') console.error(err.stack);
        });
      }, DEBOUNCE_DELAY)
    );
  }
}

export default FileWatcher;
