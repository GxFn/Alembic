/**
 * DirectiveCodeLensProvider — 在 `// as:s`, `// as:c`, `// as:a` 行上方显示操作按钮
 *
 * 示例效果:
 *   [🔍 Search "tableview cell"]  [❌ Remove directive]
 *   // as:s tableview cell
 */

import * as vscode from 'vscode';
import { detectDirectives, type DetectedDirective } from './directiveDetector';
import { isDocumentInScope } from './projectScope';

export class DirectiveCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  refresh(): void {
    this._onDidChangeCodeLenses.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    // 仅对 AutoSnippet 项目内的文件提供 CodeLens
    if (!isDocumentInScope(document)) {
      return [];
    }

    const config = vscode.workspace.getConfiguration('autosnippet');
    if (!config.get<boolean>('enableCodeLens', true)) {
      return [];
    }

    const directives = detectDirectives(document);
    const lenses: vscode.CodeLens[] = [];

    for (const directive of directives) {
      const range = directive.range;

      switch (directive.type) {
        case 'search':
          lenses.push(
            new vscode.CodeLens(range, {
              title: `🔍 Search "${directive.argument}"`,
              command: 'autosnippet._executeDirective',
              arguments: [directive],
            })
          );
          break;
        case 'create':
          lenses.push(
            new vscode.CodeLens(range, {
              title: `📝 Create Candidate`,
              command: 'autosnippet._executeDirective',
              arguments: [directive],
            })
          );
          break;
        case 'audit':
          lenses.push(
            new vscode.CodeLens(range, {
              title: `🛡️ Audit ${directive.argument || 'file'}`,
              command: 'autosnippet._executeDirective',
              arguments: [directive],
            })
          );
          break;
      }
    }

    return lenses;
  }
}
