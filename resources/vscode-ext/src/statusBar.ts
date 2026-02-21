/**
 * StatusBar — 底部状态栏指示器
 *
 * 显示 AutoSnippet API Server 连接状态：
 *   🟢 AutoSnippet    — 已连接
 *   🔴 AutoSnippet    — 未连接
 *   ⏳ AutoSnippet    — 连接中
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
    this.item.command = 'autosnippet.status';
    this.item.tooltip = 'AutoSnippet: click for status';
    this.setDisconnected();
    this.item.show();
  }

  /** 启动周期性 health check (每 30 秒) */
  startPolling(): void {
    this.checkNow();
    this.pollTimer = setInterval(() => this.checkNow(), 30_000);
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
    this.item.tooltip = 'AutoSnippet: Connected to API Server';
  }

  private setDisconnected(): void {
    this._isConnected = false;
    this.item.text = '$(circle-slash) AS';
    this.item.backgroundColor = new vscode.ThemeColor(
      'statusBarItem.warningBackground'
    );
    this.item.tooltip =
      'AutoSnippet: Not connected. Run `asd ui` or `asd start` first.';
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
