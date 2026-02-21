/**
 * DirectiveDetector — 检测 `// as:s`, `// as:c`, `// as:a` 等指令
 *
 * 与 CLI 端 DirectiveDetector.js 保持正则一致。
 * 在 Extension 中通过 onDidSaveTextDocument / onDidChangeTextDocument 触发。
 */

import * as vscode from 'vscode';

/** 指令类型 */
export type DirectiveType = 'search' | 'create' | 'audit';

/** 检测到的指令 */
export interface DetectedDirective {
  type: DirectiveType;
  /** 完整的指令行文本 */
  line: string;
  /** 指令参数 (如 search 关键词, audit scope) */
  argument: string;
  /** 行号 (0-based) */
  lineNumber: number;
  /** 行的 Range */
  range: vscode.Range;
}

// 与 CLI 端 DirectiveDetector.js 保持一致的正则
const SEARCH_RE = /\/\/\s*(?:autosnippet|as):(?:search|s)\s+(.*)/;
const CREATE_RE = /\/\/\s*(?:autosnippet|as):(?:create|c)\b(.*)?/;
const AUDIT_RE = /\/\/\s*(?:autosnippet|as):(?:audit|a)\b(.*)?/;

/**
 * 扫描文档中所有 AutoSnippet 指令
 */
export function detectDirectives(document: vscode.TextDocument): DetectedDirective[] {
  const directives: DetectedDirective[] = [];

  for (let i = 0; i < document.lineCount; i++) {
    const lineText = document.lineAt(i).text;

    let match = SEARCH_RE.exec(lineText);
    if (match) {
      const arg = match[1].trim();
      if (arg) {
        directives.push({
          type: 'search',
          line: lineText,
          argument: arg,
          lineNumber: i,
          range: document.lineAt(i).range,
        });
      }
      continue;
    }

    match = CREATE_RE.exec(lineText);
    if (match) {
      directives.push({
        type: 'create',
        line: lineText,
        argument: (match[1] || '').trim(),
        lineNumber: i,
        range: document.lineAt(i).range,
      });
      continue;
    }

    match = AUDIT_RE.exec(lineText);
    if (match) {
      directives.push({
        type: 'audit',
        line: lineText,
        argument: (match[1] || '').trim(),
        lineNumber: i,
        range: document.lineAt(i).range,
      });
      continue;
    }
  }

  return directives;
}

/**
 * 检测文档中第一个匹配的指令（用于 onSave 快速检查）
 */
export function detectFirstDirective(
  document: vscode.TextDocument,
  type?: DirectiveType
): DetectedDirective | null {
  for (let i = 0; i < document.lineCount; i++) {
    const lineText = document.lineAt(i).text;

    if (!type || type === 'search') {
      const match = SEARCH_RE.exec(lineText);
      if (match && match[1].trim()) {
        return {
          type: 'search',
          line: lineText,
          argument: match[1].trim(),
          lineNumber: i,
          range: document.lineAt(i).range,
        };
      }
    }

    if (!type || type === 'create') {
      const match = CREATE_RE.exec(lineText);
      if (match) {
        return {
          type: 'create',
          line: lineText,
          argument: (match[1] || '').trim(),
          lineNumber: i,
          range: document.lineAt(i).range,
        };
      }
    }

    if (!type || type === 'audit') {
      const match = AUDIT_RE.exec(lineText);
      if (match) {
        return {
          type: 'audit',
          line: lineText,
          argument: (match[1] || '').trim(),
          lineNumber: i,
          range: document.lineAt(i).range,
        };
      }
    }
  }

  return null;
}
