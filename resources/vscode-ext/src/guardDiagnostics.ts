/**
 * Guard Diagnostics — VS Code DiagnosticCollection 集成
 *
 * 核心能力：
 *   1. `// as:a` 指令触发 → 调 Guard API → 写入 DiagnosticCollection → 波浪线
 *   2. 诊断消息面向用户优化（嵌入 ruleId + 修复建议）
 *   3. 修复检测（违规消失时记录 fixedViolations）
 *
 * 设计：
 *   - 不自动在每次保存时检查（避免干扰开发流程）
 *   - 用户写 `// as:a` 后保存才触发 Guard 检查（主动式质量审查）
 *   - Agent 通过 MCP guard_review 获取 violations（不依赖波浪线）
 *
 * 架构：
 *   Extension ← HTTP → API Server (Guard API /api/v1/guard/file)
 *   Extension → DiagnosticCollection → 用户看到波浪线
 */

import * as vscode from 'vscode';
import * as http from 'http';

/** Guard 违规对象（来自 API Server） */
interface GuardViolation {
  ruleId: string;
  message: string;
  severity: 'error' | 'warning' | 'info';
  line: number;
  snippet?: string;
  fixSuggestion?: string;
  diagnosticMessage?: string;
}

/** Guard API 响应 */
interface GuardFileResponse {
  success: boolean;
  data?: {
    filePath: string;
    language: string;
    violations: GuardViolation[];
    summary: {
      total: number;
      errors: number;
      warnings: number;
      infos: number;
    };
    fixedViolations?: Array<{
      ruleId: string;
      filePath: string;
      fixRecipeId: string;
    }>;
  };
  message?: string;
}

/** Diagnostic source 标记 */
const DIAGNOSTIC_SOURCE = 'Alembic Guard';

export class GuardDiagnostics {
  private diagnosticCollection: vscode.DiagnosticCollection;
  private enabled: boolean = true;
  /** 输出通道用于调试日志 */
  private outputChannel: vscode.OutputChannel;

  constructor() {
    this.diagnosticCollection = vscode.languages.createDiagnosticCollection('alembic-guard');
    this.outputChannel = vscode.window.createOutputChannel('Alembic Guard', { log: true });
  }

  /**
   * 注册事件绑定
   * - 不再 onDidSave 自动检查
   * - 波浪线只通过 checkFile() 手动触发（由 // as:a 指令或命令触发）
   * @param context Extension context for disposal
   */
  register(context: vscode.ExtensionContext): void {
    // 文件关闭时清除对应诊断
    context.subscriptions.push(
      vscode.workspace.onDidCloseTextDocument((document) => {
        this.diagnosticCollection.delete(document.uri);
      })
    );

    // 注册到 subscriptions 以便 dispose
    context.subscriptions.push(this.diagnosticCollection);
    context.subscriptions.push(this.outputChannel);
  }

  /**
   * 手动触发某文件的 Guard 检查
   */
  async checkFile(document: vscode.TextDocument): Promise<void> {
    if (!this.enabled) { return; }
    if (document.isClosed) { return; }

    const filePath = document.uri.fsPath;
    const content = document.getText();
    const language = this._mapLanguageId(document.languageId);

    try {
      const result = await this._callGuardApi(filePath, content, language);
      if (result?.success && result.data) {
        this._applyDiagnostics(document.uri, result.data.violations);

        // 记录修复检测结果
        if (result.data.fixedViolations?.length) {
          this.outputChannel.appendLine(
            `[Guard] Fixed violations detected in ${filePath}: ` +
            result.data.fixedViolations.map(f => f.ruleId).join(', ')
          );
        }
      }
    } catch (err: unknown) {
      this.outputChannel.appendLine(`[Guard] Check failed for ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 清除所有诊断
   */
  clearAll(): void {
    this.diagnosticCollection.clear();
  }

  /**
   * 启用/禁用
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.clearAll();
    }
  }

  /**
   * Dispose
   */
  dispose(): void {
    this.diagnosticCollection.dispose();
    this.outputChannel.dispose();
  }

  // ═══ 内部方法 ═══════════════════════════════════════

  /**
   * 调用 Guard API
   */
  private async _callGuardApi(
    filePath: string,
    content: string,
    language: string
  ): Promise<GuardFileResponse> {
    // 使用 apiClient 的私有 HTTP 方法不太合适，
    // 直接用 node:http 或 fetch
    const config = vscode.workspace.getConfiguration('alembic');
    const host = config.get<string>('serverHost', 'localhost');
    const port = config.get<number>('serverPort', 3000);

    const url = `http://${host}:${port}/api/v1/guard/file`;
    const body = JSON.stringify({ filePath, content, language });

    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const req = http.request(
        {
          hostname: urlObj.hostname,
          port: urlObj.port,
          path: urlObj.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
          timeout: 10000,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk: string) => (data += chunk));
          res.on('end', () => {
            try {
              resolve(JSON.parse(data));
            } catch {
              reject(new Error('Invalid JSON response from Guard API'));
            }
          });
        }
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Guard API timeout'));
      });
      req.write(body);
      req.end();
    });
  }

  /**
   * 将 Guard violations 转换为 VS Code Diagnostics 并写入 DiagnosticCollection
   */
  private _applyDiagnostics(uri: vscode.Uri, violations: GuardViolation[]): void {
    const diagnostics: vscode.Diagnostic[] = violations.map((v) => {
      // line 是 1-based，VS Code Range 是 0-based
      const line = Math.max(0, (v.line || 1) - 1);
      const range = new vscode.Range(line, 0, line, Number.MAX_VALUE);

      // 使用面向 Agent 优化的诊断消息
      const message = v.diagnosticMessage || this._buildDiagnosticMessage(v);

      const severity = this._mapSeverity(v.severity);
      const diagnostic = new vscode.Diagnostic(range, message, severity);

      // source 标记为 Alembic Guard（Agent 可据此识别）
      diagnostic.source = DIAGNOSTIC_SOURCE;

      // code 使用 ruleId（方便 Code Action 解析）
      diagnostic.code = v.ruleId;

      return diagnostic;
    });

    this.diagnosticCollection.set(uri, diagnostics);
  }

  /**
   * 构建面向用户的诊断消息
   *
   * 用户在编辑器中看到波浪线时的信息：
   *   - ruleId + 违规描述
   *   - 修复建议（如果有）
   *   - 灯泡菜单可搜索知识库
   */
  private _buildDiagnosticMessage(violation: GuardViolation): string {
    const { ruleId, message, fixSuggestion } = violation;

    let msg = `[${ruleId}] ${message}`;

    if (fixSuggestion) {
      msg += `\n💡 ${fixSuggestion}`;
    }

    return msg;
  }

  /**
   * 映射 severity 字符串到 VS Code DiagnosticSeverity
   */
  private _mapSeverity(severity: string): vscode.DiagnosticSeverity {
    switch (severity) {
      case 'error':
        return vscode.DiagnosticSeverity.Error;
      case 'warning':
        return vscode.DiagnosticSeverity.Warning;
      case 'info':
        return vscode.DiagnosticSeverity.Information;
      default:
        return vscode.DiagnosticSeverity.Warning;
    }
  }

  /**
   * 映射 VS Code languageId 到 GuardCheckEngine 语言标识
   */
  private _mapLanguageId(languageId: string): string {
    const mapping: Record<string, string> = {
      'objective-c': 'objc',
      'objective-cpp': 'objc',
      'objectivec': 'objc',
      'swift': 'swift',
      'javascript': 'javascript',
      'javascriptreact': 'javascript',
      'typescript': 'typescript',
      'typescriptreact': 'typescript',
      'python': 'python',
      'java': 'java',
      'kotlin': 'kotlin',
      'go': 'go',
      'rust': 'rust',
      'dart': 'dart',
      'c': 'c',
      'cpp': 'cpp',
    };
    return mapping[languageId] || languageId;
  }
}
