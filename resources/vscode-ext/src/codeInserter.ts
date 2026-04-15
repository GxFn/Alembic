/**
 * CodeInserter — 原生 VSCode editor.edit() 代码插入
 *
 * 核心优势（相比 osascript / 文件写入）：
 *   - 完美 Undo：所有操作在同一个 editBuilder 事务内
 *   - 精确光标：插入后光标定位到代码末尾
 *   - 视觉反馈：插入区域高亮闪烁
 *   - 跨平台：不依赖 macOS osascript
 */

import * as vscode from 'vscode';
import type { SearchResultItem } from './apiClient';

/** 注释前缀映射 */
function getCommentPrefix(languageId: string): string {
  switch (languageId) {
    case 'python':
    case 'ruby':
    case 'shellscript':
    case 'yaml':
      return '#';
    case 'lua':
    case 'sql':
      return '--';
    case 'html':
    case 'xml':
    case 'vue':
      return '//'; // 行注释在 <script> 中仍用 //
    case 'css':
    case 'scss':
    case 'less':
      return '//'; // 单行注释在现代 CSS 中可用
    default:
      return '//';
  }
}

/** 检测文件的缩进偏好 */
function detectIndent(document: vscode.TextDocument): string {
  const editorConfig = vscode.workspace.getConfiguration('editor', document.uri);
  const insertSpaces = editorConfig.get<boolean>('insertSpaces', true);
  const tabSize = editorConfig.get<number>('tabSize', 2);
  return insertSpaces ? ' '.repeat(tabSize) : '\t';
}

/** 构建注释化 headers 提示块（仅当 headers 未被自动插入时使用） */
function buildCommentedHeaders(
  headers: string[],
  indent: string,
  commentPrefix: string
): string[] {
  if (!headers || headers.length === 0) return [];

  const lines: string[] = [];
  lines.push(`${indent}${commentPrefix} ── 🤖 Alembic deps (already added to imports) ──`);
  for (const h of headers) {
    lines.push(`${indent}${commentPrefix}   ${h.trim()}`);
  }
  return lines;
}

/** 生成 Alembic 插入标记 */
function generateMarker(
  selected: SearchResultItem,
  commentPrefix: string
): string {
  const trigger = selected.trigger ? `[${selected.trigger}]` : '';
  const name = selected.title ? ` from ${selected.title}` : '';
  const timestamp = new Date().toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  return `${commentPrefix} 🤖 Alembic${trigger}${name} @ ${timestamp}`;
}

/**
 * 构建完整的插入文本块
 *
 * @returns 缩进代码文本（纯代码，无标记注释）
 */
function buildInsertBlock(
  selected: SearchResultItem,
  indent: string,
  _languageId: string
): string {
  const lines: string[] = [];

  // 代码行（缩进对齐）
  const codeLines = selected.code.split(/\r?\n/);
  // 移除末尾空行
  while (codeLines.length > 0 && !codeLines[codeLines.length - 1].trim()) {
    codeLines.pop();
  }
  for (const line of codeLines) {
    lines.push(line ? indent + line : '');
  }

  return lines.join('\n');
}

/**
 * 在触发行位置插入代码（替换触发行）
 *
 * 单一 `editor.edit()` 事务：删除触发行 + 插入代码，支持一次 Cmd+Z 撤销。
 *
 * @param editor 活跃编辑器
 * @param triggerLineNumber 触发行行号 (0-based)
 * @param selected 选中的搜索结果
 * @returns 插入的代码 Range，用于高亮反馈
 */
export async function insertAtTriggerLine(
  editor: vscode.TextEditor,
  triggerLineNumber: number,
  selected: SearchResultItem
): Promise<vscode.Range | null> {
  const document = editor.document;
  const triggerLine = document.lineAt(triggerLineNumber);
  const indent = triggerLine.text.match(/^(\s*)/)?.[1] || '';

  const insertText = buildInsertBlock(selected, indent, document.languageId);
  const insertLineCount = insertText.split('\n').length;

  // 单一事务：删除触发行 → 插入代码块
  const success = await editor.edit((editBuilder) => {
    editBuilder.replace(triggerLine.range, insertText);
  });

  if (!success) return null;

  // 计算插入区域 Range
  const startLine = triggerLineNumber;
  const endLine = startLine + insertLineCount - 1;
  const endChar = document.lineAt(Math.min(endLine, document.lineCount - 1)).text.length;
  const insertedRange = new vscode.Range(
    new vscode.Position(startLine, 0),
    new vscode.Position(endLine, endChar)
  );

  // 光标移到代码末尾
  editor.selection = new vscode.Selection(insertedRange.end, insertedRange.end);
  editor.revealRange(insertedRange, vscode.TextEditorRevealType.InCenterIfOutsideViewport);

  return insertedRange;
}

/**
 * 在光标位置插入代码（无触发行，手动 Command Palette 调用）
 */
export async function insertAtCursor(
  editor: vscode.TextEditor,
  selected: SearchResultItem
): Promise<vscode.Range | null> {
  const position = editor.selection.active;
  const currentLine = editor.document.lineAt(position.line);
  const indent = currentLine.text.match(/^(\s*)/)?.[1] || '';

  const insertText =
    buildInsertBlock(selected, indent, editor.document.languageId) + '\n';
  const insertLineCount = insertText.split('\n').length;

  // 在当前行上方插入
  const insertPos = new vscode.Position(position.line, 0);
  const success = await editor.edit((editBuilder) => {
    editBuilder.insert(insertPos, insertText);
  });

  if (!success) return null;

  const startLine = position.line;
  const endLine = startLine + insertLineCount - 2; // -1 for 0-based, -1 for trailing \n
  const endChar = editor.document.lineAt(Math.min(endLine, editor.document.lineCount - 1)).text
    .length;
  const insertedRange = new vscode.Range(
    new vscode.Position(startLine, 0),
    new vscode.Position(endLine, endChar)
  );

  editor.selection = new vscode.Selection(insertedRange.end, insertedRange.end);
  editor.revealRange(insertedRange, vscode.TextEditorRevealType.InCenterIfOutsideViewport);

  return insertedRange;
}

/**
 * 高亮闪烁效果 — 黄色背景渐隐
 */
export function flashHighlight(
  editor: vscode.TextEditor,
  range: vscode.Range,
  durationMs: number = 2000
): void {
  const decoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(255, 214, 0, 0.12)',
    isWholeLine: true,
    borderWidth: '0 0 0 3px',
    borderStyle: 'solid',
    borderColor: 'rgba(255, 214, 0, 0.6)',
  });

  editor.setDecorations(decoration, [range]);

  setTimeout(() => {
    decoration.dispose();
  }, durationMs);
}
