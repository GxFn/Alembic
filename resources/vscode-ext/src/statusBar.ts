/**
 * StatusBar — 底部状态栏指示器
 *
 * 显示 Alembic API Server 连接状态：
 *   🟢 Alembic    — 已连接
 *   🔴 Alembic    — 未连接
 *   ⏳ Alembic    — 连接中
 */

import * as vscode from 'vscode';
import type { ApiClient } from './apiClient';

export class StatusBar {
  private item: vscode.StatusBarItem;
  private client: ApiClient;
  private pollTimer: NodeJS.Timeout | undefined;
  private _isConnected = false;

  get isConnected(): boolean {
    return this._isConnected;
  }

  constructor(client: ApiClient) {
    this.client = client;
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.item.command = 'asd.status';
    this.item.tooltip = 'Alembic: click for status';
    this.setDisconnected();
    // 不再自动 show()，由 extension.ts 根据 projectScope 决定
  }

  /** 显示状态栏项（仅 UI，不影响轮询） */
  show(): void {
    this.item.show();
  }

  /** 隐藏状态栏项（仅 UI，不影响轮询） */
  hide(): void {
    this.item.hide();
  }

  /** 启动周期性 health check (每 30 秒)，防止重复创建 */
  startPolling(): void {
    if (this.pollTimer) return; // 已在轮询
    this.checkNow();
    this.pollTimer = setInterval(() => this.checkNow(), 30_000);
  }

  /** 停止轮询 */
  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  async checkNow(): Promise<boolean> {
    this.setLoading();
    try {
      const ok = await this.client.isServerRunning();
      if (ok) {
        this.setConnected();
      } else {
        this.setDisconnected();
      }
      return ok;
    } catch {
      this.setDisconnected();
      return false;
    }
  }

  private setConnected(): void {
    this._isConnected = true;
    this.item.text = '$(check) AS';
    this.item.backgroundColor = undefined;
    this.item.tooltip = 'Alembic: Connected to API Server';
  }

  private setDisconnected(): void {
    this._isConnected = false;
    this.item.text = '$(circle-slash) AS';
    this.item.backgroundColor = new vscode.ThemeColor(
      'statusBarItem.warningBackground'
    );
    this.item.tooltip =
      'Alembic: Not connected. Run `asd ui` or `asd start` first.';
  }

  private setLoading(): void {
    this.item.text = '$(loading~spin) AS';
  }

  dispose(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }
    this.item.dispose();
  }
}
