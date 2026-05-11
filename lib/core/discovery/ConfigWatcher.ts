/**
 * ConfigWatcher — 构建配置文件热更新监听器
 *
 * 监听自研构建系统的配置文件变更，执行增量重解析并通知下游服务。
 *
 * 核心策略：
 *   - debounce 3s（配置文件常有连续保存）
 *   - MD5 hash 差量检测避免无效重解析
 *   - 60s 最大频率保护（防 git checkout 等批量变更风暴）
 *   - 增量解析：单文件变更只影响对应模块
 *   - 通过 SignalBus 触发 PanoramaService 缓存失效
 *   - 通过 RealtimeService 推送 Dashboard WebSocket 事件
 *
 * @module ConfigWatcher
 */

import { createHash } from 'node:crypto';
import { type FSWatcher, watch } from 'node:fs';
import { glob, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import type { SignalBus } from '#infra/signal/SignalBus.js';
import { shutdown } from '#shared/shutdown.js';

/* ═══ Types ═══════════════════════════════════════════════ */

/** 配置文件系统类型 → 需要监听的文件 glob 列表 */
const WATCH_PATTERNS: Record<string, string[]> = {
  easybox: ['Boxfile', 'Boxfile.local', 'Boxfile.overlay', 'LocalModule/**/*.boxspec'],
  tuist: ['Project.swift', 'Tuist/**/*.swift'],
  xcodegen: ['project.yml', 'project.yaml'],
};

/** 变更类型：仅影响范围不同 */
type ChangeScope = 'full' | 'module' | 'overlay';

interface WatchedFile {
  /** 相对于 projectRoot 的路径 */
  relativePath: string;
  /** 上次内容 MD5 hash */
  hash: string;
  /** 变更影响范围 */
  scope: ChangeScope;
  /** 当 scope === 'module' 时，受影响的模块名 */
  moduleName?: string;
}

interface ConfigChangeEvent {
  /** 变更的文件列表 */
  changedFiles: Array<{
    path: string;
    scope: ChangeScope;
    moduleName?: string;
  }>;
  /** 配置系统 ID */
  systemId: string;
  /** 事件触发时间 */
  timestamp: number;
}

export interface ConfigWatcherOptions {
  /** 项目根目录 */
  projectRoot: string;
  /** 配置系统 ID（easybox / tuist / xcodegen）或自定义 */
  systemId: string;
  /** 自定义 watch patterns（当 systemId 不在内置表中时） */
  watchPatterns?: string[];
  /** 信号总线（触发缓存失效） */
  signalBus?: SignalBus | null;
  /** 变更回调（用于外部通知，如 RealtimeService） */
  onChange?: (event: ConfigChangeEvent) => void;
  /** debounce 毫秒数（默认 3000） */
  debounceMs?: number;
  /** 全量重建最小间隔毫秒（默认 60000） */
  fullRebuildIntervalMs?: number;
}

/* ═══ ConfigWatcher ═══════════════════════════════════════ */

export class ConfigWatcher {
  readonly #projectRoot: string;
  readonly #systemId: string;
  readonly #signalBus: SignalBus | null;
  readonly #onChange: ((event: ConfigChangeEvent) => void) | null;
  readonly #debounceMs: number;
  readonly #fullRebuildIntervalMs: number;

  /** fs.watch 实例列表 */
  readonly #watchers: FSWatcher[] = [];
  /** 已知文件 → hash 映射 */
  readonly #fileHashes = new Map<string, WatchedFile>();
  /** debounce 定时器 */
  #debounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** 待处理的变更文件路径（debounce 窗口内合并） */
  readonly #pendingChanges = new Set<string>();
  /** 上次全量重建时间 */
  #lastFullRebuild = 0;
  /** 是否已关闭 */
  #disposed = false;

  constructor(options: ConfigWatcherOptions) {
    this.#projectRoot = options.projectRoot;
    this.#systemId = options.systemId;
    this.#signalBus = options.signalBus ?? null;
    this.#onChange = options.onChange ?? null;
    this.#debounceMs = options.debounceMs ?? 3000;
    this.#fullRebuildIntervalMs = options.fullRebuildIntervalMs ?? 60_000;
  }

  /* ─── Public API ────────────────────────────────── */

  /**
   * 启动文件监听。异步解析初始文件 hash 并注册 fs.watch。
   * 自动注册 shutdown hook 以清理资源。
   */
  async start(): Promise<void> {
    if (this.#disposed) {
      return;
    }

    const patterns = WATCH_PATTERNS[this.#systemId] ?? [];
    if (patterns.length === 0) {
      return;
    }

    // 1. 遍历 glob patterns 收集初始文件
    const resolvedFiles = await this.#resolveWatchFiles(patterns);

    // 2. 计算初始 hash
    for (const file of resolvedFiles) {
      const absPath = join(this.#projectRoot, file.relativePath);
      try {
        const content = await readFile(absPath, 'utf-8');
        file.hash = computeHash(content);
        this.#fileHashes.set(file.relativePath, file);
      } catch {
        /* 文件可能已删除，跳过 */
      }
    }

    // 3. 对每个 pattern 设置 fs.watch（目录级）
    this.#setupWatchers(patterns);

    // 4. 注册 shutdown hook
    shutdown.register(() => this.dispose(), `ConfigWatcher(${this.#systemId})`);
  }

  /**
   * 停止监听，释放所有 fs.watch 资源
   */
  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;

    if (this.#debounceTimer) {
      clearTimeout(this.#debounceTimer);
      this.#debounceTimer = null;
    }

    for (const watcher of this.#watchers) {
      try {
        watcher.close();
      } catch {
        /* 忽略关闭错误 */
      }
    }
    this.#watchers.length = 0;
    this.#pendingChanges.clear();
    this.#fileHashes.clear();
  }

  /** 是否正在监听 */
  get active(): boolean {
    return !this.#disposed && this.#watchers.length > 0;
  }

  /** 监听的文件数 */
  get watchedFileCount(): number {
    return this.#fileHashes.size;
  }

  /* ─── Internal ──────────────────────────────────── */

  /**
   * 解析 glob patterns → WatchedFile 列表
   */
  async #resolveWatchFiles(patterns: string[]): Promise<WatchedFile[]> {
    const files: WatchedFile[] = [];

    for (const pattern of patterns) {
      const scope = inferChangeScope(pattern, this.#systemId);

      try {
        // Node 22 has native glob in fs/promises
        const matches = glob(pattern, { cwd: this.#projectRoot });
        for await (const match of matches) {
          files.push({
            relativePath: match,
            hash: '',
            scope,
            moduleName: scope === 'module' ? extractModuleName(match, this.#systemId) : undefined,
          });
        }
      } catch {
        /* pattern 不匹配或目录不存在 */
      }
    }

    return files;
  }

  /**
   * 设置 fs.watch 监听器
   */
  #setupWatchers(patterns: string[]): void {
    // 收集要监听的目录（去重）
    const watchDirs = new Set<string>();
    watchDirs.add(this.#projectRoot); // 根目录（Boxfile, project.yml 等）

    for (const pattern of patterns) {
      // 对含 ** 的 pattern，监听其父目录
      const slashIdx = pattern.indexOf('/');
      if (slashIdx > 0) {
        const dir = pattern.substring(0, slashIdx);
        const absDir = join(this.#projectRoot, dir);
        watchDirs.add(absDir);
      }
    }

    for (const dir of watchDirs) {
      try {
        const watcher = watch(dir, { recursive: true }, (_eventType, filename) => {
          if (!filename || this.#disposed) {
            return;
          }

          const relPath =
            dir === this.#projectRoot ? filename : join(relative(this.#projectRoot, dir), filename);

          // 过滤非配置文件
          if (this.#isRelevantFile(relPath, patterns)) {
            this.#scheduleCheck(relPath);
          }
        });

        this.#watchers.push(watcher);

        // 处理 watcher 错误（macOS 上目录被删除等）
        watcher.on('error', () => {
          /* 静默忽略，下次变更无法检测可通过手动 rescan 恢复 */
        });
      } catch {
        /* 目录不存在或权限不足 */
      }
    }
  }

  /**
   * 检查文件路径是否匹配 watch patterns
   */
  #isRelevantFile(relPath: string, patterns: string[]): boolean {
    for (const pattern of patterns) {
      // 简单匹配：精确文件名 / 扩展名 / 子目录包含
      if (!pattern.includes('*') && !pattern.includes('/')) {
        // 精确文件名匹配
        if (relPath === pattern) {
          return true;
        }
      } else if (pattern.includes('**')) {
        // glob 通配 — 提取目录前缀和扩展名
        const parts = pattern.split('/');
        const dirPrefix = parts[0];
        const extMatch = pattern.match(/\*(\.\w+)$/);
        if (relPath.startsWith(`${dirPrefix}/`) && extMatch && relPath.endsWith(extMatch[1])) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * debounce 调度：合并多次变更后统一处理
   */
  #scheduleCheck(relPath: string): void {
    this.#pendingChanges.add(relPath);

    if (this.#debounceTimer) {
      clearTimeout(this.#debounceTimer);
    }

    this.#debounceTimer = setTimeout(() => {
      this.#debounceTimer = null;
      void this.#processChanges();
    }, this.#debounceMs);
  }

  /**
   * 处理 debounce 窗口内累积的变更
   */
  async #processChanges(): Promise<void> {
    if (this.#disposed || this.#pendingChanges.size === 0) {
      return;
    }

    // 频率保护：60s 内最多一次全量重建
    const now = Date.now();
    const hasFullScope = [...this.#pendingChanges].some((p) => {
      const watched = this.#fileHashes.get(p);
      return !watched || watched.scope === 'full';
    });

    if (hasFullScope && now - this.#lastFullRebuild < this.#fullRebuildIntervalMs) {
      // 跳过此轮，等待下次
      this.#pendingChanges.clear();
      return;
    }

    const changedPaths = [...this.#pendingChanges];
    this.#pendingChanges.clear();

    // 逐个检查 hash 变化
    const actualChanges: ConfigChangeEvent['changedFiles'] = [];

    for (const relPath of changedPaths) {
      const absPath = join(this.#projectRoot, relPath);
      try {
        const content = await readFile(absPath, 'utf-8');
        const newHash = computeHash(content);
        const existing = this.#fileHashes.get(relPath);

        if (existing && existing.hash === newHash) {
          continue; // hash 未变，跳过
        }

        // 更新 hash
        const scope = existing?.scope ?? inferChangeScope(relPath, this.#systemId);
        const moduleName =
          scope === 'module'
            ? (existing?.moduleName ?? extractModuleName(relPath, this.#systemId))
            : undefined;

        this.#fileHashes.set(relPath, { relativePath: relPath, hash: newHash, scope, moduleName });
        actualChanges.push({ path: relPath, scope, moduleName });
      } catch {
        // 文件被删除 — 也算变更
        if (this.#fileHashes.has(relPath)) {
          const existing = this.#fileHashes.get(relPath)!;
          this.#fileHashes.delete(relPath);
          actualChanges.push({
            path: relPath,
            scope: existing.scope,
            moduleName: existing.moduleName,
          });
        }
      }
    }

    if (actualChanges.length === 0) {
      return; // 所有文件 hash 未变
    }

    if (hasFullScope) {
      this.#lastFullRebuild = now;
    }

    // 发射信号 → PanoramaService 缓存失效
    if (this.#signalBus) {
      this.#signalBus.send('lifecycle', 'ConfigWatcher', 1.0, {
        metadata: {
          event: 'config_changed',
          systemId: this.#systemId,
          changedCount: actualChanges.length,
        },
      });
    }

    // 回调通知（RealtimeService 等）
    const event: ConfigChangeEvent = {
      changedFiles: actualChanges,
      systemId: this.#systemId,
      timestamp: now,
    };

    this.#onChange?.(event);
  }
}

/* ═══ Helpers ═════════════════════════════════════════════ */

function computeHash(content: string): string {
  return createHash('md5').update(content).digest('hex');
}

/**
 * 根据文件 pattern 推断变更影响范围
 */
function inferChangeScope(pattern: string, systemId: string): ChangeScope {
  if (systemId === 'easybox') {
    if (pattern.includes('.boxspec')) {
      return 'module';
    }
    if (pattern.includes('.local') || pattern.includes('.overlay')) {
      return 'overlay';
    }
    return 'full';
  }
  if (systemId === 'tuist') {
    if (pattern.includes('Tuist/')) {
      return 'full';
    }
    return 'full';
  }
  // xcodegen / 其他
  return 'full';
}

/**
 * 从文件路径提取模块名
 * e.g. "LocalModule/BDPictures/BDPictures.boxspec" → "BDPictures"
 */
function extractModuleName(relPath: string, _systemId: string): string | undefined {
  // 通用：取 spec 文件所在目录名
  const parts = relPath.split('/');
  if (parts.length >= 2) {
    return parts[parts.length - 2];
  }
  return undefined;
}
