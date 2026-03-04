/**
 * Remote Command Poller — 飞书 → IDE 桥接的 VSCode 侧
 *
 * 架构 (v2 自然语言路由):
 *   飞书消息 → IntentClassifier → bot_agent (服务端直接处理)
 *                                → ide_agent (写入队列 → 本扩展 poll → Copilot)
 *                                → system (服务端直接处理)
 *
 * 本扩展只处理 ide_agent 路由的编程任务:
 *   ✓ 自动探测服务端 → 自动启动
 *   ✓ 会话连续性 — 首条 newChat，后续 followUp 追加
 *   ✓ 可靠注入 — open+query 一步到位，失败重试 2 次
 *   ✓ 执行超时 — 单指令 10 分钟后自动标记 timeout
 *   ✓ 飞书回传 — claim 阶段由服务端发"开始执行"，result 阶段发"完成/失败"
 *   ✓ 状态栏 — 队列深度 + 当前指令摘要
 *   ✓ 通知面板 — 收到指令时气泡提示 + "查看"按钮
 */

import * as vscode from 'vscode';
import type { ApiClient } from './apiClient';

// ─── 常量 ─────────────────────────────────────────

/** 空闲时轮询间隔（毫秒）— 作为 long-poll 的回退 */
const POLL_INTERVAL_IDLE = 2_000;
/** 执行中时轮询间隔（更快检查队列） */
const POLL_INTERVAL_BUSY = 5_000;
/** 单指令执行超时（毫秒） */
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
/** 自动启动探测间隔 */
const AUTO_START_INTERVAL = 5_000;
/** Long-poll 超时（服务端无新消息时多久返回空） */
const LONG_POLL_TIMEOUT = 25_000;
/** Chat 注入最大重试 */
const INJECT_MAX_RETRIES = 2;

/** Auto-Approve 配置项 — 远程编程时全部开启 */
const AUTO_APPROVE_KEYS = [
  'chat.tools.global.autoApprove',
  'chat.tools.edits.autoApprove',
  'chat.agent.terminal.autoApprove',
] as const;

export class RemoteCommandPoller implements vscode.Disposable {
  private timer: ReturnType<typeof setInterval> | undefined;
  private autoStartTimer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private disposed = false;
  /** Long-poll abort controller — 用于取消等待 */
  private longPollAbort: AbortController | null = null;
  /** 是否正在 long-poll 中 */
  private longPolling = false;
  /** 自动审批模式是否已开启 */
  private autoApproveEnabled = false;
  /** 开启前保存的原始值 */
  private savedAutoApproveValues: Map<string, any> = new Map();
  private statusItem: vscode.StatusBarItem;

  /** 当前正在执行的指令 ID */
  private activeCommandId: string | null = null;
  /** 当前指令开始时间 */
  private activeCommandStart = 0;
  /** 已执行指令数 */
  private commandCount = 0;
  /** 是否处于"追加会话"模式 — 连续指令不开新 Chat */
  private sessionActive = false;
  /** 上一次 Chat 注入时间 */
  private lastInjectTime = 0;
  /** 会话超时：超过 5 分钟无新指令则下次开新 Chat */
  private readonly SESSION_GAP_MS = 5 * 60 * 1000;

  constructor(private apiClient: ApiClient) {
    this.statusItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      90
    );
    this.statusItem.command = 'autosnippet.toggleRemotePoller';
    this.updateStatusBar(false);
  }

  // ═══════════════════════════════════════════════════
  //  注册 & 生命周期
  // ═══════════════════════════════════════════════════

  register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      vscode.commands.registerCommand('autosnippet.toggleRemotePoller', () => this.toggle()),
      vscode.commands.registerCommand('autosnippet.startRemotePoller', () => this.start()),
      vscode.commands.registerCommand('autosnippet.stopRemotePoller', () => this.stop()),
      this,
    );

    // 读设置 — 若开启则直接启动
    const config = vscode.workspace.getConfiguration('autosnippet');
    if (config.get<boolean>('enableRemotePoller', false)) {
      this.start();
    } else {
      // 未开启也进行自动探测：如果服务端在跑且飞书已连接 → 自动启动
      this.startAutoDetect();
    }
  }

  // ─── 自动探测 ──────────────────────────────────────

  private startAutoDetect(): void {
    this.autoStartTimer = setInterval(async () => {
      if (this.timer || this.disposed) {
        // 已启动或已销毁，停止探测
        if (this.autoStartTimer) clearInterval(this.autoStartTimer);
        this.autoStartTimer = undefined;
        return;
      }
      try {
        const status = await this.apiClient.getRemoteLarkStatus();
        if (status?.connected) {
          console.log('[RemotePoller] Lark connected detected, auto-starting...');
          this.start();
          if (this.autoStartTimer) clearInterval(this.autoStartTimer);
          this.autoStartTimer = undefined;
        }
      } catch { /* 服务端未运行，静默 */ }
    }, AUTO_START_INTERVAL);
  }

  // ═══════════════════════════════════════════════════
  //  公开控制
  // ═══════════════════════════════════════════════════

  start(): void {
    if (this.timer || this.disposed) return;
    this.timer = setInterval(() => this.poll(), POLL_INTERVAL_IDLE);
    this.updateStatusBar(true);
    vscode.window.showInformationMessage('🛰 远程指令轮询已启动');
    console.log('[RemotePoller] Started');
    // ── 先清理积压指令，再开始正常轮询 ──
    this.flushThenPoll();
  }

  /**
   * 启动时先清理积压指令，避免旧指令涌入 IDE。
   * 清理完成后才启动首次 poll 和 long-poll。
   */
  private async flushThenPoll(): Promise<void> {
    try {
      const { flushed } = await this.apiClient.flushStaleCommands();
      if (flushed > 0) {
        console.log(`[RemotePoller] Flushed ${flushed} stale commands on start`);
        vscode.window.showWarningMessage(
          `🗑 已清理 ${flushed} 条积压指令（IDE 离线期间堆积）`
        );
      }
    } catch (err: any) {
      console.warn('[RemotePoller] Flush failed:', err?.message);
    }
    // 清理完成后启动正常轮询
    this.poll();
    this.startLongPoll();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
    this.activeCommandId = null;
    this.sessionActive = false;
    this.stopLongPoll();
    this.restoreAutoApprove();
    this.updateStatusBar(false);
    vscode.window.showInformationMessage('🛰 远程指令轮询已停止');
    console.log('[RemotePoller] Stopped');
  }

  toggle(): void {
    this.timer ? this.stop() : this.start();
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    if (this.autoStartTimer) clearInterval(this.autoStartTimer);
    this.stopLongPoll();
    this.restoreAutoApprove();
    this.statusItem.dispose();
  }

  // ═══════════════════════════════════════════════════
  //  核心轮询
  // ═══════════════════════════════════════════════════

  private async poll(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      // ── 超时检查 ──
      if (this.activeCommandId && Date.now() - this.activeCommandStart > COMMAND_TIMEOUT_MS) {
        console.warn(`[RemotePoller] Command timeout: ${this.activeCommandId}`);
        await this.apiClient.postRemoteResult(
          this.activeCommandId,
          '⏰ 执行超时（10 分钟），已自动标记。请检查 IDE 状态或重新发送。',
          'timeout'
        );
        this.activeCommandId = null;
        this.updateStatusBar(true);
      }

      // ── 如果有正在执行的指令，暂不拉新的 ──
      if (this.activeCommandId) {
        this.running = false;
        return;
      }

      // ── 拉取待执行指令 ──
      const cmd = await this.apiClient.getRemotePending();
      if (!cmd) {
        this.running = false;
        return;
      }

      console.log(`[RemotePoller] Got command: ${cmd.id} — ${cmd.command.slice(0, 80)}`);

      // ── 认领 ──
      const claimed = await this.apiClient.claimRemoteCommand(cmd.id);
      if (!claimed) {
        console.log(`[RemotePoller] Claim failed: ${cmd.id}`);
        this.running = false;
        return;
      }

      this.activeCommandId = cmd.id;
      this.activeCommandStart = Date.now();
      this.commandCount++;

      // ── 更新 UI ──
      const preview = cmd.command.length > 30 ? cmd.command.slice(0, 30) + '…' : cmd.command;
      this.statusItem.text = `$(sync~spin) Remote: ${preview}`;
      this.statusItem.tooltip = `执行中: ${cmd.command}\n(${cmd.id})`;

      // ── 注入 Copilot Chat ──
      const injected = await this.injectToCopilotChat(cmd.command, cmd.userName || 'remote');

      // ── 注入成功后开启自动审批 ──
      if (injected) {
        await this.enableAutoApprove();
      }

      // ── 回写结果 ──
      // 注入成功 → 标记 completed（Copilot 开始处理）
      // 注入失败 → 标记 failed
      const status = injected ? 'completed' : 'failed';
      const result = injected
        ? `🔄 已注入 Copilot Chat，Agent Mode 处理中...`
        : `❌ Chat 注入失败，请检查 IDE 状态。`;
      await this.apiClient.postRemoteResult(cmd.id, result, status);

      // ── 注入成功后发送通知 ──
      if (injected) {
        await this.apiClient.sendLarkNotify(
          '🔓 已开启自动审批模式，Copilot 将自动执行工具调用/编辑/终端操作。'
        ).catch(() => {});
      }

      this.activeCommandId = null;
      this.updateStatusBar(true);
      console.log(`[RemotePoller] ${status}: ${cmd.id}`);
    } catch (err: any) {
      console.error('[RemotePoller] Poll error:', err?.message || err);
      this.activeCommandId = null;
    } finally {
      this.running = false;
    }
  }

  // ═══════════════════════════════════════════════════
  //  Copilot Chat 注入
  // ═══════════════════════════════════════════════════

  private async injectToCopilotChat(command: string, userName: string): Promise<boolean> {
    // ── 气泡通知 ──
    vscode.window.showInformationMessage(
      `🛰 远程指令: ${command.slice(0, 60)}${command.length > 60 ? '…' : ''}`,
      '查看 Chat'
    ).then(choice => {
      if (choice === '查看 Chat') {
        vscode.commands.executeCommand('workbench.action.chat.open');
      }
    });

    // ── 判断是否需要新会话 ──
    const now = Date.now();
    const gapExpired = now - this.lastInjectTime > this.SESSION_GAP_MS;
    const needNewChat = !this.sessionActive || gapExpired;

    for (let attempt = 0; attempt <= INJECT_MAX_RETRIES; attempt++) {
      try {
        if (needNewChat && attempt === 0) {
          // 打开 Chat 面板 → 新建会话 → 注入
          await vscode.commands.executeCommand('workbench.action.chat.open');
          await sleep(400);
          await vscode.commands.executeCommand('workbench.action.chat.newChat');
          await sleep(300);
        }

        // 核心注入：open with query → 自动发送
        await vscode.commands.executeCommand('workbench.action.chat.open', {
          query: command,
          isPartialQuery: false,
        });

        this.sessionActive = true;
        this.lastInjectTime = now;
        console.log(`[RemotePoller] Injected (attempt ${attempt}): ${command.slice(0, 50)}`);
        return true;
      } catch (err: any) {
        console.warn(`[RemotePoller] Inject attempt ${attempt} failed: ${err?.message}`);
        if (attempt < INJECT_MAX_RETRIES) {
          await sleep(1000 * (attempt + 1));
        }
      }
    }

    // ── 全部重试失败 → 备用方案：写入临时文件 ──
    try {
      const doc = await vscode.workspace.openTextDocument({
        content: [
          `// ═══ 远程编程指令 (from ${userName}) ═══`,
          `// 请将以下内容复制到 Copilot Chat 中执行：`,
          '//',
          `// ${command}`,
          '//',
        ].join('\n'),
        language: 'javascript',
      });
      await vscode.window.showTextDocument(doc);
      vscode.window.showWarningMessage('⚠️ Chat 注入失败，指令已写入临时文件。');
    } catch { /* 连备用方案也失败了 */ }

    return false;
  }

  // ═══════════════════════════════════════════════════
  //  Long-Poll — 服务端有新消息时立即唤醒
  // ═══════════════════════════════════════════════════

  /**
   * 持续 long-poll /api/v1/remote/wait。
   * 服务端收到飞书消息后立即返回，扩展端收到后触发一次 poll()。
   * 连接断开或超时后自动重连。
   */
  private async startLongPoll(): Promise<void> {
    if (this.longPolling || this.disposed) return;
    this.longPolling = true;

    while (this.timer && !this.disposed) {
      try {
        this.longPollAbort = new AbortController();
        const resp = await this.apiClient.waitForNewCommand(
          LONG_POLL_TIMEOUT,
          this.longPollAbort.signal
        );
        if (resp?.hasNew) {
          console.log('[RemotePoller] Long-poll: new command arrived, triggering poll');
          this.poll(); // 立即拾取
        }
      } catch (err: any) {
        if (err?.name === 'AbortError') break; // 主动取消
        // 网络错误 → 短暂等待后重试
        await sleep(2000);
      }
    }

    this.longPolling = false;
    this.longPollAbort = null;
  }

  private stopLongPoll(): void {
    if (this.longPollAbort) {
      this.longPollAbort.abort();
      this.longPollAbort = null;
    }
    this.longPolling = false;
  }
  // ═══════════════════════════════════════════════════
  //  IDE 操作监听 — 飞书 /accept /skip → VSCode 命令
  // ═══════════════════════════════════════════════════

  // ═══════════════════════════════════════════════════
  //  Auto-Approve 管理
  // ═══════════════════════════════════════════════════

  /**
   * 开启自动审批模式 — 远程编程期间 Copilot 工具调用/编辑/终端操作全部自动通过
   */
  private async enableAutoApprove(): Promise<void> {
    if (this.autoApproveEnabled) return;
    try {
      const config = vscode.workspace.getConfiguration();
      // 保存原始值
      for (const key of AUTO_APPROVE_KEYS) {
        const inspect = config.inspect<boolean>(key);
        this.savedAutoApproveValues.set(key, inspect?.globalValue);
      }
      // 全部开启
      for (const key of AUTO_APPROVE_KEYS) {
        await config.update(key, true, vscode.ConfigurationTarget.Global);
      }
      this.autoApproveEnabled = true;
      console.log('[RemotePoller] Auto-approve enabled');
    } catch (err: any) {
      console.error('[RemotePoller] Failed to enable auto-approve:', err?.message);
    }
  }

  /**
   * 恢复自动审批为开启前的值
   */
  private async restoreAutoApprove(): Promise<void> {
    if (!this.autoApproveEnabled) return;
    try {
      const config = vscode.workspace.getConfiguration();
      for (const key of AUTO_APPROVE_KEYS) {
        const original = this.savedAutoApproveValues.get(key);
        await config.update(key, original, vscode.ConfigurationTarget.Global);
      }
      this.savedAutoApproveValues.clear();
      this.autoApproveEnabled = false;
      console.log('[RemotePoller] Auto-approve restored');
      this.apiClient.sendLarkNotify('🔒 自动审批模式已关闭').catch(() => {});
    } catch (err: any) {
      console.error('[RemotePoller] Failed to restore auto-approve:', err?.message);
    }
  }

  // ═══════════════════════════════════════════════════
  //  UI
  // ═══════════════════════════════════════════════════

  private updateStatusBar(active: boolean): void {
    if (active) {
      const suffix = this.commandCount > 0 ? ` (${this.commandCount})` : '';
      this.statusItem.text = `$(radio-tower) Remote: ON${suffix}`;
      this.statusItem.tooltip = `远程指令轮询中\n已处理: ${this.commandCount} 条\n点击切换`;
      this.statusItem.backgroundColor = undefined;
    } else {
      this.statusItem.text = '$(radio-tower) Remote: OFF';
      this.statusItem.tooltip = '远程指令已关闭 — 点击启动';
      this.statusItem.backgroundColor = undefined;
    }
    this.statusItem.show();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
