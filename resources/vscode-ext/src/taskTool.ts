/**
 * AutoSnippet Task Tool — lm.registerTool 代理层
 *
 * 通过 VS Code 原生 lm.registerTool 注册工具，在 Copilot Agent Mode
 * 调用时可获取 tokenBudget，用于感知上下文压力并实施分级保护。
 *
 * 架构：lm.registerTool (in-process) → 拦截 tokenBudget → HTTP 转发 → MCP Server
 */

import * as vscode from 'vscode';
import * as http from 'http';

/** tokenBudget 阈值（可通过 settings.json 覆盖） */
function getThresholds(): { critical: number; warning: number } {
  const config = vscode.workspace.getConfiguration('autosnippet');
  return {
    critical: config.get<number>('tokenBudgetCritical', 5000),
    warning: config.get<number>('tokenBudgetWarning', 20000),
  };
}

export function registerTaskTool(context: vscode.ExtensionContext) {
  const tool = vscode.lm.registerTool<TaskToolInput>('autosnippet_taskgraph', {

    async prepareInvocation(
      options: vscode.LanguageModelToolInvocationPrepareOptions<TaskToolInput>,
      _token: vscode.CancellationToken
    ) {
      return {
        invocationMessage: `AutoSnippet TaskGraph: ${options.input?.operation || 'unknown'}`,
      };
    },

    async invoke(
      options: vscode.LanguageModelToolInvocationOptions<TaskToolInput>,
      _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
      const args = options.input;
      const tokenBudget = options.tokenizationOptions?.tokenBudget ?? null;
      const operation = args?.operation || 'unknown';
      const thresholds = getThresholds();

      // ── 1. 转发到 HTTP Server ──
      let serverResult: Record<string, unknown>;
      try {
        serverResult = await forwardToServer(args);
      } catch (err: any) {
        serverResult = {
          success: false,
          message: `Server unreachable: ${err.message}. Is AutoSnippet API Server running?`,
          operation,
        };
      }

      // ── 2. 分级保护：根据 tokenBudget 决定 _contextHint ──
      let contextHint: string | undefined;
      const isCritical = tokenBudget !== null && tokenBudget < thresholds.critical;
      const isWarning = tokenBudget !== null && tokenBudget < thresholds.warning;

      if (isCritical) {
        contextHint = _buildCriticalHint(operation);
      } else if (isWarning) {
        contextHint = _buildWarningHint(operation);
      }

      // ── 3. CRITICAL 时内联 prime 数据 ──
      if (isCritical && operation !== 'prime') {
        try {
          const primeData = await forwardToServer({ operation: 'prime' });
          if (primeData.success) {
            serverResult._inlinePrime = primeData.data;
          }
        } catch {
          // prime 失败不阻塞主操作
        }
      }

      // ── 4. 组装最终结果 ──
      const result: Record<string, unknown> = {
        ...serverResult,
        tokenBudget,
      };

      if (contextHint) {
        result._contextHint = contextHint;
      }

      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2)),
      ]);
    },
  });

  context.subscriptions.push(tool);
}

// ═══ HTTP 转发 ═══════════════════════════════════════

/**
 * 转发请求到 AutoSnippet HTTP Server
 */
async function forwardToServer(args: TaskToolInput | undefined): Promise<Record<string, unknown>> {
  const config = vscode.workspace.getConfiguration('autosnippet');
  const host = config.get<string>('serverHost', 'localhost');
  const port = config.get<number>('serverPort', 3000);

  const body = JSON.stringify(args || {});

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: host,
        port,
        path: '/api/v1/task',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 15000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve({ success: false, message: 'Invalid server response' });
          }
        });
      }
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.write(body);
    req.end();
  });
}

// ═══ _contextHint 差异化消息 ═══════════════════════════

/**
 * CRITICAL 级别提示 — 按 operation 差异化
 */
function _buildCriticalHint(operation: string): string {
  const base = '[CONTEXT_PRESSURE:CRITICAL] Token budget very low.';
  switch (operation) {
    case 'prime':
      return `${base} Focus only on the most urgent in_progress task.`;
    case 'claim':
    case 'create':
      return `${base} Complete current work first. Call autosnippet_taskgraph(operation: "prime") to restore context.`;
    case 'close':
      return `${base} Good — closing tasks frees context. Check _inlinePrime for next steps.`;
    default:
      return `${base} Call autosnippet_taskgraph(operation: "prime") immediately to restore context.`;
  }
}

/**
 * WARNING 级别提示 — 按 operation 差异化
 */
function _buildWarningHint(operation: string): string {
  const base = '[CONTEXT_PRESSURE:WARNING] Token budget getting low.';
  switch (operation) {
    case 'prime':
      return `${base} Prioritize — pick one task and focus.`;
    case 'claim':
      return `${base} Summarize completed work before starting new task.`;
    case 'ready':
      return `${base} Pick the highest priority task only.`;
    default:
      return `${base} Summarize completed work before continuing.`;
  }
}

interface TaskToolInput {
  operation: string;
  id?: string;
  title?: string;
  description?: string;
  design?: string;
  acceptance?: string;
  reason?: string;
  priority?: number;
  taskType?: string;
  parentId?: string;
  assignee?: string;
  limit?: number;
  withKnowledge?: boolean;
  // decompose
  children?: Array<{ title: string; description?: string; priority?: number; blockedByIndex?: number[] }>;
  // dep_add
  taskId?: string;
  dependsOn?: string;
  depType?: string;
  // list
  status?: string;
}
