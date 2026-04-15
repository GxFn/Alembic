/**
 * Guard Code Action Provider — 灯泡菜单集成
 *
 * 当编辑器显示 Alembic Guard 诊断时，在灯泡菜单提供：
 *   1. "搜索 Alembic 知识库修复" → 触发 asd.search 命令
 *   2. "忽略此规则" → 在行首添加 // asd-disable-next-line: <ruleId>
 *
 * Agent 可通过 Code Action 获取修复建议（部分 IDE Agent 支持读取 Code Actions）。
 */

import * as vscode from 'vscode';

const DIAGNOSTIC_SOURCE = 'Alembic Guard';

export class GuardCodeActionProvider implements vscode.CodeActionProvider {
  static readonly providedCodeActionKinds = [
    vscode.CodeActionKind.QuickFix,
  ];

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
    _token: vscode.CancellationToken
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];

    for (const diagnostic of context.diagnostics) {
      if (diagnostic.source !== DIAGNOSTIC_SOURCE) { continue; }

      const ruleId = typeof diagnostic.code === 'string'
        ? diagnostic.code
        : typeof diagnostic.code === 'object' && diagnostic.code !== null
          ? String((diagnostic.code as { value: string | number }).value)
          : '';

      if (!ruleId) { continue; }

      // ── Action 1: 搜索知识库修复 ──
      const searchAction = new vscode.CodeAction(
        `搜索 Alembic 知识库: ${ruleId}`,
        vscode.CodeActionKind.QuickFix
      );
      searchAction.command = {
        title: '搜索 Alembic 知识库',
        command: 'asd.searchGuardFix',
        arguments: [ruleId],
      };
      searchAction.diagnostics = [diagnostic];
      searchAction.isPreferred = true;
      actions.push(searchAction);

      // ── Action 2: 禁用此行规则 ──
      const disableAction = new vscode.CodeAction(
        `禁用此行: ${ruleId}`,
        vscode.CodeActionKind.QuickFix
      );
      disableAction.edit = new vscode.WorkspaceEdit();
      const disableLine = diagnostic.range.start.line;
      const indent = document.lineAt(disableLine).text.match(/^\s*/)?.[0] || '';
      disableAction.edit.insert(
        document.uri,
        new vscode.Position(disableLine, 0),
        `${indent}// asd-disable-next-line: ${ruleId}\n`
      );
      disableAction.diagnostics = [diagnostic];
      actions.push(disableAction);
    }

    return actions;
  }
}

/**
 * 注册 Code Action Provider + 相关命令
 */
export function registerGuardCodeActions(context: vscode.ExtensionContext): void {
  // Code Action Provider — 所有文件类型
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { scheme: 'file' },
      new GuardCodeActionProvider(),
      {
        providedCodeActionKinds: GuardCodeActionProvider.providedCodeActionKinds,
      }
    )
  );

  // 搜索修复命令
  context.subscriptions.push(
    vscode.commands.registerCommand('asd.searchGuardFix', async (ruleId: string) => {
      if (!ruleId) { return; }

      // 尝试通过 MCP 搜索（如果 Agent Mode 可用），否则用 Quick Pick 展示
      vscode.commands.executeCommand('asd.search', ruleId);
    })
  );
}
