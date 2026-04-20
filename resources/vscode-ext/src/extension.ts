/**
 * Alembic VSCode Extension — 入口
 *
 * 功能对标 Xcode 工作流：
 *   1. `// as:s <query>` → 搜索知识库 → QuickPick 选择 → editor.edit() 插入代码
 *   2. `// as:c`         → 从选区/剪贴板创建候选知识条目
 *   3. `// as:a`         → 对当前文件/项目运行 Guard 审计 → 波浪线提示
 *   4. CodeLens          → 指令行上方显示操作按钮
 *   5. 状态栏            → API Server 连接状态指示
 *
 * Guard 工作方式：
 *   - **用户手动**：写 `// as:a` 后保存 → 波浪线显示 violations
 *   - **Agent MCP**：调 `alembic_task({ operation: "guard_review" })` → 返回 violations
 *   - 不再在每次保存时自动检查（避免干扰开发流程）
 *
 * 架构：
 *   Extension ←→ ApiClient ←→ Alembic API Server (asd ui / asd start)
 *   Extension → editor.edit() → 原生编辑（支持 Undo）
 */

import * as vscode from 'vscode';
import { ApiClient, type SearchResultItem, type FileChangeReport } from './apiClient';
import { FileChangeCollector } from './FileChangeCollector';
import { DirectiveCodeLensProvider } from './codeLensProvider';
import { insertAtCursor, insertAtTriggerLine, flashHighlight } from './codeInserter';
import { detectDirectives, detectFirstDirective, type DetectedDirective } from './directiveDetector';
import { StatusBar } from './statusBar';
import { hasAnyProject, isDocumentInScope, invalidateCache } from './projectScope';
import { registerTaskTool } from './taskTool';
import { GuardDiagnostics } from './guardDiagnostics';
import { registerGuardCodeActions } from './guardCodeAction';
import { RemoteCommandPoller } from './remoteCommandPoller';

function toErrorMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

let apiClient: ApiClient;
let statusBar: StatusBar;
let codeLensProvider: DirectiveCodeLensProvider;

// ─────────────────────────────────────────────
// Reactive Evolution 弹窗（文档 §5.4 / 策略 C）
// ─────────────────────────────────────────────

/** 每个 Recipe 的连续忽略次数 → 退避天数 = dismissCount（1天、2天、3天…） */
const dismissCount = new Map<string, number>();

/** 每个 Recipe 上次弹窗时间戳 */
const lastPopupTime = new Map<string, number>();

/** 全局弹窗冷却：任意两次弹窗之间至少 2 分钟 */
let lastGlobalPopupTime = 0;
const GLOBAL_POPUP_COOLDOWN_MS = 2 * 60 * 1000;

/** Session 级静默：用户点击"不再提醒"后本次 session 内不再弹窗 */
let popupMutedForSession = false;

/** 一天的毫秒数 */
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 构造交给 IDE Copilot Chat 的进化 prompt（文档 §5.4.4）
 */
function buildEvolvePrompt(report: FileChangeReport): string {
  const lines: string[] = [];
  lines.push('Alembic 检测到源码变更可能影响以下 Recipe。请使用 MCP 工具 alembic_evolve 评估并提交 propose_evolution / confirm_deprecation 决策：');
  lines.push('');
  for (const d of report.details) {
    if (d.action === 'needs-review' || d.action === 'deprecate') {
      lines.push(`- ${d.recipeId} (${d.recipeTitle})`);
      lines.push(`  - 影响级别: ${d.impactLevel ?? 'unknown'}`);
      lines.push(`  - 变更文件: ${d.modifiedPath ?? 'N/A'}`);
      lines.push(`  - 原因: ${d.reason}`);
    }
  }
  lines.push('');
  lines.push('如 Recipe 仍有效，请调用 alembic_evolve 传 action=skip, skipReason=still_valid 以刷新验证时间。');
  return lines.join('\n');
}

/**
 * 根据 report 触发弹窗（策略 C：仅 ide-edit + direct/pattern 影响）
 *
 * 退避策略：用户每次不点击 Review/Auto Check → 该 Recipe 静默天数 +1。
 *   首次忽略 → 1天后才可再弹；第2次忽略 → 2天；第N次 → N天（上限7天）。
 *   点击 Review 或 Auto Check → 重置该 Recipe 退避计数为 0。
 *   未处理的 Recipe 由增量扫描统一处理，不依赖弹窗。
 */
function handleReactiveReport(report: FileChangeReport): void {
  // G0: 用户通过设置或 session 内按钮关闭了弹窗
  if (popupMutedForSession) { return; }
  const popupEnabled = vscode.workspace.getConfiguration('alembic').get<boolean>('enableReactivePopup', true);
  if (!popupEnabled) { return; }

  // C1: 仅 ide-edit 来源允许弹窗
  if (report.eventSource !== 'ide-edit') { return; }
  if (!report.suggestReview) { return; }

  // C2: direct（文件删除）或 pattern（30%+ Recipe token 被 diff 修改）
  const impactDetails = report.details.filter(
    d => (d.impactLevel === 'direct' || d.impactLevel === 'pattern') &&
         (d.action === 'needs-review' || d.action === 'deprecate')
  );
  if (impactDetails.length === 0) { return; }

  const now = Date.now();

  // G1: 全局冷却 — 任意两次弹窗之间至少 2 分钟
  if (now - lastGlobalPopupTime < GLOBAL_POPUP_COOLDOWN_MS) { return; }

  // C3: per-Recipe 递增退避 — dismissCount 次忽略 → 需等 dismissCount 天
  const activeDetails = impactDetails.filter(d => {
    const last = lastPopupTime.get(d.recipeId) ?? 0;
    const count = dismissCount.get(d.recipeId) ?? 0;
    const cooldown = count === 0
      ? GLOBAL_POPUP_COOLDOWN_MS           // 首次：仅受全局冷却约束
      : Math.min(count, 7) * ONE_DAY_MS;  // 已忽略 N 次 → N 天（上限 7 天）
    return now - last > cooldown;
  });
  if (activeDetails.length === 0) { return; }

  // 更新弹窗时间（退避计数在用户响应后更新）
  lastGlobalPopupTime = now;
  for (const d of activeDetails) {
    lastPopupTime.set(d.recipeId, now);
  }

  const recipeIds = activeDetails.map(d => d.recipeId);
  const preview = activeDetails.slice(0, 3).map(d => d.recipeTitle).join('、');
  const more = activeDetails.length > 3 ? ` 等 ${activeDetails.length} 条` : '';
  const msg = `Alembic: 检测到 ${preview}${more} 受近期编辑影响，建议进化评估。`;

  void vscode.window.showInformationMessage(
    msg,
    'Review',
    'Auto Check',
    "Don't Show Again",
  ).then((choice) => {
    if (choice === 'Review') {
      // 用户主动处理 → 重置退避
      for (const id of recipeIds) { dismissCount.delete(id); }
      void vscode.commands.executeCommand('workbench.action.chat.open', {
        query: buildEvolvePrompt({ ...report, details: activeDetails }),
      });
    } else if (choice === 'Auto Check') {
      // 用户主动处理 → 重置退避
      for (const id of recipeIds) { dismissCount.delete(id); }
      const terminal = vscode.window.createTerminal('Alembic Evolve');
      terminal.sendText(`asd evolve-check --recipes ${recipeIds.join(',')}`);
      terminal.show();
    } else if (choice === "Don't Show Again") {
      popupMutedForSession = true;
      void vscode.window.showInformationMessage(
        'Alembic: 已关闭本次 session 的进化弹窗。如需永久关闭，请在设置中禁用 alembic.enableReactivePopup。'
      );
    } else {
      // 用户关闭/忽略弹窗 → 递增退避，Recipe 等待增量扫描统一处理
      for (const id of recipeIds) {
        dismissCount.set(id, (dismissCount.get(id) ?? 0) + 1);
      }
    }
  });
}
let guardDiagnostics: GuardDiagnostics;

// ─────────────────────────────────────────────
// Extension Lifecycle
// ─────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
  // ── lm.registerTool 代理层（#asd 工具引用通道）──
  try {
    registerTaskTool(context);
  } catch (err: unknown) {
    // lm.registerTool 在低版本 VS Code 可能不存在
    console.warn('[Alembic] registerTaskTool skipped:', toErrorMsg(err));
  }

  try {
  const config = vscode.workspace.getConfiguration('alembic');
  const host = config.get<string>('serverHost', 'localhost');
  const port = config.get<number>('serverPort', 3000);

  // 初始化 API Client
  apiClient = new ApiClient(host, port);

  // 状态栏 — 仅在工作区包含 Alembic 项目时显示
  statusBar = new StatusBar(apiClient);
  if (hasAnyProject()) {
    statusBar.show();
    statusBar.startPolling();
  }
  context.subscriptions.push(statusBar);

  // ── Guard Diagnostics（仅 // as:a 触发 → Guard API → 波浪线）──
  guardDiagnostics = new GuardDiagnostics();
  guardDiagnostics.register(context);

  // ── Guard Code Actions（灯泡菜单：搜索知识库修复）──
  registerGuardCodeActions(context);

  // ── Remote Command Poller（飞书 → IDE 远程指令桥接）──
  const remotePoller = new RemoteCommandPoller(apiClient);
  remotePoller.register(context);

  // CodeLens — 暂时关闭，待后续处理
  // codeLensProvider = new DirectiveCodeLensProvider();
  // context.subscriptions.push(
  //   vscode.languages.registerCodeLensProvider({ scheme: 'file' }, codeLensProvider)
  // );

  // ─── 注册命令 ───

  context.subscriptions.push(
    vscode.commands.registerCommand('alembic.search', cmdSearch),
    vscode.commands.registerCommand('alembic.create', cmdCreate),
    vscode.commands.registerCommand('alembic.audit', cmdAudit),
    vscode.commands.registerCommand('alembic.auditProject', cmdAuditProject),
    vscode.commands.registerCommand('alembic.status', cmdStatus),
    // vscode.commands.registerCommand('alembic._executeDirective', cmdExecuteDirective),
  );

  // ─── onSave 指令检测 — 暂时关闭，待后续处理 ───

  // context.subscriptions.push(
  //   vscode.workspace.onDidSaveTextDocument(async (document) => {
  //     if (!isDocumentInScope(document)) return;
  //     if (!config.get<boolean>('enableDirectiveDetection', true)) return;
  //
  //     const directive = detectFirstDirective(document);
  //     if (!directive) return;
  //
  //     const editor = vscode.window.visibleTextEditors.find(
  //       (e) => e.document.uri.toString() === document.uri.toString()
  //     );
  //     if (!editor) return;
  //
  //     await executeDirective(editor, directive);
  //   })
  // );

  // ─── 配置变更 ───

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration('alembic.serverHost') ||
        e.affectsConfiguration('alembic.serverPort')
      ) {
        const cfg = vscode.workspace.getConfiguration('alembic');
        apiClient.updateConfig(
          cfg.get<string>('serverHost', 'localhost'),
          cfg.get<number>('serverPort', 3000)
        );
        statusBar.checkNow();
      }
      // if (e.affectsConfiguration('alembic.enableCodeLens')) {
      //   codeLensProvider.refresh();
      // }
    })
  );

  // ─── 文档变更刷新 CodeLens — 暂时关闭 ───
  // context.subscriptions.push(
  //   vscode.workspace.onDidChangeTextDocument(() => {
  //     codeLensProvider.refresh();
  //   })
  // );

  // ─── 工作区目录变化时重新检测项目 ───
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      invalidateCache();
      if (hasAnyProject()) {
        statusBar.show();
        statusBar.startPolling();
      } else {
        statusBar.hide();
        statusBar.stopPolling();
      }
    })
  );

  // ─── 切换编辑器时更新状态栏可见性 ───
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!hasAnyProject()) {
        statusBar.hide();
        return;
      }
      if (editor && editor.document.uri.scheme === 'file') {
        if (isDocumentInScope(editor.document)) {
          statusBar.show();
        } else {
          statusBar.hide();
        }
      }
    })
  );

  // ─── 文件变更统一采集（FileChangeCollector） ───
  // 5 个信号源 → EventBuffer → HTTP POST，与业务逻辑解耦
  // 服务端回传 ReactiveEvolutionReport → handleReactiveReport 触发弹窗（策略 C）
  const fileChangeCollector = new FileChangeCollector(apiClient, context, handleReactiveReport);
  context.subscriptions.push(fileChangeCollector);

  } catch (err: unknown) {
    console.error('[Alembic] activate() failed:', err);
    vscode.window.showErrorMessage(`Alembic activation error: ${toErrorMsg(err)}`);
  }
}

export function deactivate() {
  // cleanup handled by disposables
}

// ─────────────────────────────────────────────
// Command Handlers
// ─────────────────────────────────────────────

/**
 * asd.search — 搜索知识库
 * 可通过 Command Palette 或快捷键触发
 */
async function cmdSearch() {
  if (!await ensureConnected()) return;

  const query = await vscode.window.showInputBox({
    prompt: 'Search Alembic knowledge base',
    placeHolder: 'e.g. tableview cell, fetch API, auth middleware...',
  });
  if (!query) return;

  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('No active editor');
    return;
  }

  await doSearch(editor, query);
}

/**
 * asd.create — 从选区创建候选
 */
async function cmdCreate() {
  if (!await ensureConnected()) return;

  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('No active editor');
    return;
  }

  const selection = editor.selection;
  const selectedText = editor.document.getText(selection);
  if (!selectedText.trim()) {
    vscode.window.showWarningMessage('Please select some code first');
    return;
  }

  const title = await vscode.window.showInputBox({
    prompt: 'Title for this code snippet',
    placeHolder: 'e.g. Auth middleware, Table cell setup...',
  });
  if (!title) return;

  const languageId = editor.document.languageId;
  const result = await apiClient.createCandidate({
    title,
    code: selectedText,
    language: languageId,
    description: `Created from VSCode selection in ${editor.document.fileName}`,
    filePath: editor.document.fileName,
  });

  if (result.success) {
    vscode.window.showInformationMessage(`✅ Candidate "${title}" created`);
  } else {
    vscode.window.showErrorMessage(`Failed to create candidate: ${result.error}`);
  }
}

/**
 * asd.audit — 审计当前文件
 */
async function cmdAudit() {
  if (!await ensureConnected()) return;

  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('No active editor');
    return;
  }

  await doAudit(editor, 'file');
}

/**
 * asd.auditProject — 审计整个项目
 */
async function cmdAuditProject() {
  if (!await ensureConnected()) return;
  await doAudit(vscode.window.activeTextEditor, 'project');
}

/**
 * asd.status — 显示连接状态
 */
async function cmdStatus() {
  const connected = await statusBar.checkNow();
  const config = vscode.workspace.getConfiguration('alembic');
  const host = config.get<string>('serverHost', 'localhost');
  const port = config.get<number>('serverPort', 3000);

  if (connected) {
    vscode.window.showInformationMessage(
      `✅ Alembic API Server is running at ${host}:${port}`
    );
  } else {
    const action = await vscode.window.showWarningMessage(
      `Alembic API Server is not running at ${host}:${port}.\n` +
      `Run \`asd ui\` or \`asd start\` in your project directory.`,
      'Open Terminal'
    );
    if (action === 'Open Terminal') {
      const terminal = vscode.window.createTerminal('Alembic');
      terminal.show();
      terminal.sendText('asd ui');
    }
  }
}

/**
 * asd._executeDirective — CodeLens / onSave 调用
 */
async function cmdExecuteDirective(directive: DetectedDirective) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  await executeDirective(editor, directive);
}

// ─────────────────────────────────────────────
// Core Logic
// ─────────────────────────────────────────────

/**
 * 执行检测到的指令
 */
async function executeDirective(
  editor: vscode.TextEditor,
  directive: DetectedDirective
) {
  if (!await ensureConnected()) return;

  switch (directive.type) {
    case 'search':
      await doSearch(editor, directive.argument, directive.lineNumber);
      break;
    case 'create':
      await doCreate(editor, directive);
      break;
    case 'audit':
      await doAudit(editor, directive.argument || 'file');
      break;
  }
}

/**
 * 搜索 → QuickPick（带代码预览）→ 插入代码 + 头文件
 */
async function doSearch(
  editor: vscode.TextEditor,
  query: string,
  triggerLineNumber?: number
) {
  // 搜索
  const results = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Searching "${query}"...`,
      cancellable: false,
    },
    () => apiClient.search(query)
  );

  if (results.length === 0) {
    vscode.window.showInformationMessage(`No results found for "${query}"`);
    return;
  }

  // ── QuickPick（带代码预览面板）──
  const selected = await showSearchQuickPick(results, query, editor);
  if (!selected) return;

  const config = vscode.workspace.getConfiguration('alembic');
  const highlightDuration = config.get<number>('insertHighlightDuration', 2000);

  // ── 1. 头文件自动插入到 import 区域（TODO: 以后再做）──
  // let headersInserted = 0;
  // if (selected.headers && selected.headers.length > 0) {
  //   headersInserted = await insertHeadersToImportSection(editor, selected.headers);
  // }
  const headersInserted = 0;

  // ── 2. 插入代码 ──
  let insertedRange: vscode.Range | null;
  const adjustedTriggerLine = triggerLineNumber !== undefined
    ? triggerLineNumber + headersInserted
    : undefined;

  if (adjustedTriggerLine !== undefined) {
    insertedRange = await insertAtTriggerLine(editor, adjustedTriggerLine, selected);
  } else {
    insertedRange = await insertAtCursor(editor, selected);
  }

  if (insertedRange) {
    flashHighlight(editor, insertedRange, highlightDuration);

    const headerInfo = headersInserted > 0
      ? ` (+${headersInserted} imports)`
      : '';
    vscode.window.showInformationMessage(
      `✅ Inserted "${selected.title}"${headerInfo}`
    );
  }
}

/**
 * 带详细代码预览的 QuickPick
 *
 * detail 区域直接展示代码前 8 行，无需侧边面板
 */
async function showSearchQuickPick(
  results: SearchResultItem[],
  query: string,
  _editor: vscode.TextEditor
): Promise<SearchResultItem | undefined> {
  const picks = results.map((item, idx) => {
    const headerBadge = item.headers.length > 0 ? ` 📦${item.headers.length}` : '';
    const codeLines = item.code.split(/\r?\n/).filter(l => l.trim());
    const totalLines = codeLines.length;
    const previewLines = codeLines.slice(0, 8).join('\n');
    const overflow = totalLines > 8 ? `\n… (+${totalLines - 8} more lines)` : '';

    return {
      label: `$(symbol-snippet) ${item.title}${headerBadge}`,
      description: item.trigger ? `[${item.trigger}]` : '',
      detail: previewLines + overflow,
      _index: idx,
    };
  });

  const picked = await vscode.window.showQuickPick(picks, {
    title: `Alembic: "${query}" — ${results.length} results`,
    placeHolder: 'Select a snippet to insert',
    matchOnDetail: true,
  });

  if (!picked) return undefined;
  return results[picked._index];
}

/**
 * 将头文件插入到文件的 import 区域（去重）
 *
 * 模仿 Xcode XcodeIntegration 的行为：
 * 1. 找到文件中最后一个 import/include 行
 * 2. 在其后插入新的 headers（跳过已存在的）
 * 3. 返回实际插入的行数（用于修正后续行号偏移）
 */
async function insertHeadersToImportSection(
  editor: vscode.TextEditor,
  headers: string[]
): Promise<number> {
  const document = editor.document;
  const text = document.getText();
  const lines = text.split(/\r?\n/);

  // 检测已有的 import/include 行
  const importRe = /^\s*(#import\s|@import\s|#include\s|import\s|from\s+\S+\s+import\s|const\s+.*=\s*require\s*\(|use\s|using\s)/;
  const existingImports = new Set<string>();
  let lastImportLine = -1;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (importRe.test(trimmed)) {
      existingImports.add(trimmed);
      lastImportLine = i;
    }
    // 超过文件前 100 行后停止扫描（import 不会在文件很后面）
    if (i > 100 && lastImportLine === -1) break;
    if (lastImportLine >= 0 && i > lastImportLine + 10) break;
  }

  // 过滤掉已存在的 headers
  const newHeaders = headers.filter((h) => !existingImports.has(h.trim()));
  if (newHeaders.length === 0) return 0;

  // 确定插入位置
  const insertLine = lastImportLine >= 0 ? lastImportLine + 1 : 0;
  const insertText = newHeaders.join('\n') + '\n';

  const insertPos = new vscode.Position(insertLine, 0);

  const success = await editor.edit((editBuilder) => {
    editBuilder.insert(insertPos, insertText);
  });

  return success ? newHeaders.length : 0;
}

/**
 * 处理 // as:c 创建指令
 */
async function doCreate(
  editor: vscode.TextEditor,
  directive: DetectedDirective
) {
  const arg = directive.argument;

  if (arg.includes('-c')) {
    // 从剪贴板创建
    const clipboard = await vscode.env.clipboard.readText();
    if (!clipboard.trim()) {
      vscode.window.showWarningMessage('Clipboard is empty');
      return;
    }

    const title = await vscode.window.showInputBox({
      prompt: 'Title for clipboard snippet',
      placeHolder: 'e.g. API Response Handler',
    });
    if (!title) return;

    const result = await apiClient.createCandidate({
      title,
      code: clipboard,
      language: editor.document.languageId,
      filePath: editor.document.fileName,
    });

    // 删除触发行
    await editor.edit((editBuilder) => {
      editBuilder.delete(directive.range);
    });

    if (result.success) {
      vscode.window.showInformationMessage(`✅ Candidate "${title}" created from clipboard`);
    } else {
      vscode.window.showErrorMessage(`Failed: ${result.error}`);
    }
  } else {
    // 打开 Dashboard
    const config = vscode.workspace.getConfiguration('alembic');
    const host = config.get<string>('serverHost', 'localhost');
    const port = config.get<number>('serverPort', 3000);
    const url = `http://${host}:${port}/?action=create`;
    vscode.env.openExternal(vscode.Uri.parse(url));

    // 删除触发行
    await editor.edit((editBuilder) => {
      editBuilder.delete(directive.range);
    });
  }
}

/**
 * 审计文件/项目
 */
async function doAudit(
  editor: vscode.TextEditor | undefined,
  scope: string
) {
  if (scope === 'project') {
    // ── 项目级审计：收集源文件 → 调用 Guard batch API ──
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Alembic Guard: Auditing project…' },
      async () => {
        const roots = (await import('./projectScope')).getActiveProjectRoots();
        if (roots.length === 0) {
          vscode.window.showWarningMessage('No Alembic project found in workspace.');
          return;
        }
        // 搜集所有打开的编辑器中的文件（或扫描项目源文件）
        const openDocs = vscode.workspace.textDocuments.filter(
          (d) => d.uri.scheme === 'file' && !d.isClosed
        );
        if (openDocs.length === 0) {
          vscode.window.showInformationMessage('No open files to audit.');
          return;
        }
        // 对所有打开的文档逐个触发 Guard 检查
        let totalViolations = 0;
        let totalErrors = 0;
        let totalWarnings = 0;
        let filesChecked = 0;
        for (const doc of openDocs) {
          try {
            const result = await apiClient.auditFile(
              doc.uri.fsPath,
              doc.getText(),
              doc.languageId
            );
            if (result?.success && result.data) {
              filesChecked++;
              totalViolations += result.data.summary?.total || 0;
              totalErrors += result.data.summary?.errors || 0;
              totalWarnings += result.data.summary?.warnings || 0;
              // 写入诊断集合（复用 guardDiagnostics 的格式）
              if ((result.data.violations?.length ?? 0) > 0 && guardDiagnostics) {
                guardDiagnostics.checkFile(doc);
              }
            }
          } catch {
            // 单文件失败不阻断
          }
        }
        if (totalViolations === 0) {
          vscode.window.showInformationMessage(
            `✅ Guard: ${filesChecked} files checked, no violations found.`
          );
        } else {
          vscode.window.showWarningMessage(
            `🛡️ Guard: ${filesChecked} files — ${totalErrors} errors, ${totalWarnings} warnings, ${totalViolations} total violations. See Problems panel.`
          );
        }
      }
    );
    return;
  }

  // ── 单文件审计 ──
  if (!editor) {
    vscode.window.showWarningMessage('No active editor');
    return;
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Alembic Guard: Checking file…' },
    async () => {
      // 直接复用 guardDiagnostics.checkFile 来写入诊断
      if (guardDiagnostics) {
        await guardDiagnostics.checkFile(editor.document);
      }

      // 同时从 API 获取汇总信息
      try {
        const result = await apiClient.auditFile(
          editor.document.uri.fsPath,
          editor.document.getText(),
          editor.document.languageId
        );
        if (result?.success && result.data) {
          const s = result.data.summary;
          if (!s || s.total === 0) {
            vscode.window.showInformationMessage('✅ Guard: No violations found.');
          } else {
            vscode.window.showWarningMessage(
              `🛡️ Guard: ${s.errors ?? 0} errors, ${s.warnings ?? 0} warnings, ${s.infos ?? 0} info — see Problems panel.`
            );
          }
        }
      } catch (err: unknown) {
        vscode.window.showErrorMessage(`Guard audit failed: ${toErrorMsg(err)}`);
      }
    }
  );

  // 如果是从指令触发，删除指令行
  if (scope !== 'project') {
    const directive = detectFirstDirective(editor.document, 'audit');
    if (directive) {
      await editor.edit((editBuilder) => {
        editBuilder.delete(directive.range);
      });
    }
  }
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

async function ensureConnected(): Promise<boolean> {
  if (statusBar.isConnected) return true;

  const ok = await statusBar.checkNow();
  if (ok) return true;

  const action = await vscode.window.showWarningMessage(
    'Alembic API Server is not running. Start it with `asd ui` or `asd start`.',
    'Open Terminal',
    'Retry'
  );

  if (action === 'Open Terminal') {
    const terminal = vscode.window.createTerminal('Alembic');
    terminal.show();
    terminal.sendText('asd ui');
    return false;
  }
  if (action === 'Retry') {
    return statusBar.checkNow();
  }
  return false;
}

function truncate(text: string, maxLen: number): string {
  if (!text) return '';
  const oneLine = text.replace(/\n/g, ' ').replace(/\s+/g, ' ');
  return oneLine.length > maxLen ? oneLine.substring(0, maxLen) + '...' : oneLine;
}

/**
 * 截取代码前 N 行作为 QuickPick detail 预览
 */
function truncateMultiLine(text: string, maxLines: number): string {
  if (!text) return '';
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  const preview = lines.slice(0, maxLines).map(l => l.trim()).join('  ·  ');
  const suffix = lines.length > maxLines ? ` … (+${lines.length - maxLines} lines)` : '';
  return preview + suffix;
}
