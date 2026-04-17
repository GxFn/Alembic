/**
 * FileChangeCollector — 统一文件变更采集器
 *
 * 5 个信号源 → EventBuffer → HTTP POST /api/v1/file-changes
 *
 * 完全与业务逻辑解耦：不知道 Recipe / Evolution 的存在。
 * 只负责"发生了什么文件变更"，批量推送给服务端。
 *
 * 信号源：
 *   1. onDidRenameFiles  — IDE 内重命名（实时）
 *   2. onDidDeleteFiles  — IDE 内删除（实时）
 *   3. onDidCreateFiles  — IDE 内创建（实时）
 *   4. Git HEAD Diff     — commit/pull/switch（HEAD 变化后 2s）
 *   5. Working Tree Diff — 窗口聚焦 / 5min 定时（覆盖未 commit 的 AI/人工编辑）
 */

import * as vscode from 'vscode';
import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ApiClient, FileChangeReport } from './apiClient';
import { hasAnyProject } from './projectScope';

/* ═══════════════════ Event Model ═══════════════════ */

export type FileChangeEventSource = 'ide-edit' | 'git-head' | 'git-worktree';

export interface FileChangeEvent {
  type: 'created' | 'modified' | 'renamed' | 'deleted';
  path: string;
  oldPath?: string;
  /** 事件来源（文档 §5.1 I2）— 仅 'ide-edit' 允许触发弹窗 */
  eventSource?: FileChangeEventSource;
}

/** Report 回调签名 —— 由 Collector 触发，extension.ts 订阅以弹窗 */
export type FileChangeReportListener = (report: FileChangeReport) => void;

/* ═══════════════════ EventBuffer ═══════════════════ */

/**
 * 去重 + 合并 + 3s 节流的事件缓冲区
 */
class EventBuffer {
  private pending = new Map<string, FileChangeEvent>();
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly apiClient: ApiClient;
  private readonly onReport: FileChangeReportListener | undefined;

  constructor(apiClient: ApiClient, onReport?: FileChangeReportListener) {
    this.apiClient = apiClient;
    this.onReport = onReport;
  }

  push(event: FileChangeEvent): void {
    const pathKey = event.type === 'renamed' ? (event.oldPath ?? event.path) : event.path;

    // 合并规则
    const existing = this.pending.get(pathKey);
    if (existing) {
      // created + deleted → 抵消
      if (existing.type === 'created' && event.type === 'deleted') {
        this.pending.delete(pathKey);
        return;
      }
      // created + modified → 保留 created
      if (existing.type === 'created' && event.type === 'modified') {
        return;
      }
    }

    // renamed 用 oldPath 作 key，防止和后续 modified 冲突
    const key = event.type === 'renamed'
      ? `renamed:${event.oldPath}:${event.path}`
      : `${event.type}:${pathKey}`;

    this.pending.set(key, event);
    this.scheduleFlush();
  }

  /** 强制立即 flush（dispose 时调用） */
  flushNow(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.doFlush();
  }

  dispose(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) { return; }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.doFlush();
    }, 3000);
  }

  private doFlush(): void {
    if (this.pending.size === 0) { return; }
    const events = [...this.pending.values()];
    this.pending.clear();

    const filtered = events.filter(e => !this.isIgnored(e.path));
    if (filtered.length === 0) { return; }

    // 发送并处理响应；失败（返回 null）时静默跳过弹窗
    this.apiClient.reportFileChanges(filtered).then((report) => {
      if (report && this.onReport) {
        try {
          this.onReport(report);
        } catch {
          // 监听器异常不影响事件采集主链路
        }
      }
    }).catch(() => {});
  }

  private isIgnored(filePath: string): boolean {
    return filePath.startsWith('.asd/')
      || filePath.startsWith('.asd\\')
      || filePath.startsWith('.git/')
      || filePath.startsWith('.git\\')
      || filePath.startsWith('node_modules/');
  }
}

/* ═══════════════════ Collector ═══════════════════ */

export class FileChangeCollector implements vscode.Disposable {
  private readonly buffer: EventBuffer;
  private readonly disposables: vscode.Disposable[] = [];

  /** Git HEAD Diff 状态 */
  private lastKnownHeads = new Map<string, string>();

  /** Working Tree Diff 状态 */
  private lastWorkingSets = new Map<string, Set<string>>();
  private workingTreeTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly apiClient: ApiClient,
    context: vscode.ExtensionContext,
    onReport?: FileChangeReportListener,
  ) {
    this.buffer = new EventBuffer(apiClient, onReport);

    if (!hasAnyProject()) { return; }

    this.setupIdeSignals(context);
    this.setupGitHeadDiff(context);
    this.setupWorkingTreeDiff(context);
  }

  dispose(): void {
    this.buffer.flushNow();
    this.buffer.dispose();
    if (this.workingTreeTimer) {
      clearInterval(this.workingTreeTimer);
    }
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  /* ═══ Signal 1-3: IDE File Operations ═══ */

  private setupIdeSignals(context: vscode.ExtensionContext): void {
    // Signal 1: Rename
    const renameDisposable = vscode.workspace.onDidRenameFiles((e) => {
      for (const f of e.files) {
        if (f.oldUri.scheme !== 'file') { continue; }
        this.buffer.push({
          type: 'renamed',
          path: vscode.workspace.asRelativePath(f.newUri),
          oldPath: vscode.workspace.asRelativePath(f.oldUri),
          eventSource: 'ide-edit',
        });
      }
    });

    // Signal 2: Delete
    const deleteDisposable = vscode.workspace.onDidDeleteFiles((e) => {
      for (const f of e.files) {
        if (f.scheme !== 'file') { continue; }
        this.buffer.push({
          type: 'deleted',
          path: vscode.workspace.asRelativePath(f),
          eventSource: 'ide-edit',
        });
      }
    });

    // Signal 3: Create
    const createDisposable = vscode.workspace.onDidCreateFiles((e) => {
      for (const f of e.files) {
        if (f.scheme !== 'file') { continue; }
        this.buffer.push({
          type: 'created',
          path: vscode.workspace.asRelativePath(f),
          eventSource: 'ide-edit',
        });
      }
    });

    context.subscriptions.push(renameDisposable, deleteDisposable, createDisposable);
    this.disposables.push(renameDisposable, deleteDisposable, createDisposable);
  }

  /* ═══ Signal 4: Git HEAD Diff ═══ */

  private setupGitHeadDiff(context: vscode.ExtensionContext): void {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) { return; }

    for (const folder of folders) {
      const gitHeadPath = path.join(folder.uri.fsPath, '.git', 'HEAD');
      if (!fs.existsSync(gitHeadPath)) { continue; }

      // 记录初始 HEAD
      const initialHead = this.execGitSync('rev-parse HEAD', folder.uri.fsPath);
      if (initialHead) {
        this.lastKnownHeads.set(folder.uri.fsPath, initialHead);
      }

      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folder, '.git/HEAD')
      );

      let debounceTimer: ReturnType<typeof setTimeout> | undefined;

      const onHeadChange = () => {
        if (debounceTimer) { clearTimeout(debounceTimer); }
        debounceTimer = setTimeout(() => {
          this.handleHeadChange(folder).catch(() => {});
        }, 2000);
      };

      watcher.onDidChange(onHeadChange);
      watcher.onDidCreate(onHeadChange);

      context.subscriptions.push(watcher);
      context.subscriptions.push({ dispose: () => { if (debounceTimer) { clearTimeout(debounceTimer); } } });
      this.disposables.push(watcher);
    }
  }

  private async handleHeadChange(folder: vscode.WorkspaceFolder): Promise<void> {
    const cwd = folder.uri.fsPath;
    const currentHead = await this.execGit('rev-parse HEAD', cwd);
    if (!currentHead) { return; }

    const lastHead = this.lastKnownHeads.get(cwd);
    this.lastKnownHeads.set(cwd, currentHead);

    if (!lastHead || lastHead === currentHead) { return; }

    const stdout = await this.execGit(`diff --name-only ${lastHead}..${currentHead}`, cwd);
    if (!stdout) { return; }

    const files = stdout.split('\n').filter(f => f.length > 0);
    for (const f of files) {
      this.buffer.push({ type: 'modified', path: f, eventSource: 'git-head' });
    }
  }

  /* ═══ Signal 5: Working Tree Diff ═══ */

  private setupWorkingTreeDiff(context: vscode.ExtensionContext): void {
    // 主触发：窗口焦点恢复
    let focusDebounce: ReturnType<typeof setTimeout> | undefined;

    const windowStateDisposable = vscode.window.onDidChangeWindowState((state) => {
      if (!state.focused) { return; }
      if (focusDebounce) { clearTimeout(focusDebounce); }
      focusDebounce = setTimeout(() => {
        this.diffAllWorkingTrees();
      }, 3000);
    });

    context.subscriptions.push(windowStateDisposable);
    context.subscriptions.push({ dispose: () => { if (focusDebounce) { clearTimeout(focusDebounce); } } });
    this.disposables.push(windowStateDisposable);

    // 兜底：5 分钟定时器
    this.workingTreeTimer = setInterval(() => {
      this.diffAllWorkingTrees();
    }, 5 * 60 * 1000);
  }

  private diffAllWorkingTrees(): void {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) { return; }
    for (const folder of folders) {
      this.diffWorkingTree(folder).catch(() => {});
    }
  }

  private async diffWorkingTree(folder: vscode.WorkspaceFolder): Promise<void> {
    const cwd = folder.uri.fsPath;

    // 检查是否是 git 仓库
    if (!fs.existsSync(path.join(cwd, '.git'))) { return; }

    // tracked 文件的变更（unstaged + staged）
    const tracked = await this.execGit('diff --name-only', cwd);
    const staged = await this.execGit('diff --name-only --cached', cwd);
    // untracked 新文件
    const untracked = await this.execGit('ls-files --others --exclude-standard', cwd);

    const trackedSet = new Set(this.splitLines(tracked));
    const stagedSet = new Set(this.splitLines(staged));
    const untrackedSet = new Set(this.splitLines(untracked));

    const current = new Set([...trackedSet, ...stagedSet, ...untrackedSet]);
    const lastSet = this.lastWorkingSets.get(cwd) ?? new Set<string>();

    // 只报告增量（新出现在 working tree 中的）
    for (const f of current) {
      if (!lastSet.has(f)) {
        this.buffer.push({
          type: untrackedSet.has(f) ? 'created' : 'modified',
          path: f,
          eventSource: 'git-worktree',
        });
      }
    }

    this.lastWorkingSets.set(cwd, current);
  }

  /* ═══ Git Helpers ═══ */

  private execGitSync(args: string, cwd: string): string | undefined {
    try {
      return cp.execSync(`git ${args} 2>/dev/null`, { cwd, timeout: 5000, encoding: 'utf8' }).trim() || undefined;
    } catch {
      return undefined;
    }
  }

  private execGit(args: string, cwd: string): Promise<string | undefined> {
    return new Promise((resolve) => {
      cp.exec(
        `git ${args} 2>/dev/null`,
        { cwd, timeout: 5000, encoding: 'utf8' },
        (err: Error | null, stdout: string) => {
          if (err || !stdout.trim()) {
            resolve(undefined);
          } else {
            resolve(stdout.trim());
          }
        }
      );
    });
  }

  private splitLines(output: string | undefined): string[] {
    if (!output) { return []; }
    return output.split('\n').filter(f => f.length > 0);
  }
}
