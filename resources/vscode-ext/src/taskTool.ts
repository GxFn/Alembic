/**
 * AutoSnippet Task Tool — lm.registerTool 核心通道
 *
 * 通过 #asd 引用激活，Agent Mode 全能力可用。
 *
 * 5 operations: prime, create, close, fail, record_decision
 *
 * 架构：lm.registerTool → 拦截 + 增强 → HTTP 转发 → API Server
 */

import * as vscode from 'vscode';
import * as http from 'http';

export function registerTaskTool(context: vscode.ExtensionContext) {
  const tool = vscode.lm.registerTool<TaskToolInput>('asd', {

    async prepareInvocation(
      options: vscode.LanguageModelToolInvocationPrepareOptions<TaskToolInput>,
      _token: vscode.CancellationToken
    ) {
      const op = options.input?.operation || 'unknown';
      const messages: Record<string, string> = {
        prime: 'Loading project memory...',
        record_decision: 'Recording decision...',
        create: 'Creating task...',
        close: 'Closing task...',
        fail: 'Failing task...',
      };
      return {
        invocationMessage: messages[op] || `AutoSnippet: ${op}`,
      };
    },

    async invoke(
      options: vscode.LanguageModelToolInvocationOptions<TaskToolInput>,
      _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
      const args = options.input;
      const operation = args?.operation || 'unknown';

      // ── 1. 转发到 Server ──
      let serverResult: Record<string, unknown>;
      try {
        serverResult = await forwardToServer(args);
      } catch (err: unknown) {
        return textResult({
          success: false,
          message: `Server unreachable: ${err instanceof Error ? err.message : String(err)}. Run \`asd server\` in the project directory.`,
        });
      }

      // ── 2. prime 响应增强 ──
      if (operation === 'prime' && serverResult.success && serverResult.data) {
        const data = serverResult.data as Record<string, unknown>;
        const knowledge = data.knowledge as Record<string, unknown> | undefined;

        // 提升 knowledge decisions 到顶层
        if (knowledge) {
          const related = knowledge.relatedKnowledge as Array<Record<string, unknown>> | undefined;
          if (related && related.length > 0) {
            serverResult._relatedKnowledge = related.map(r => ({
              id: r.id || r.recipeId,
              title: r.title,
              kind: r.kind,
            }));
          }
        }
      }

      // ── 3. record_decision 确认消息 ──
      if (operation === 'record_decision' && serverResult.success) {
        serverResult._note = 'Decision recorded in current intent. It will be persisted when the task is closed.';
      }

      return textResult(serverResult);
    },
  });

  context.subscriptions.push(tool);
}

// ═══ 工具函数 ═══════════════════════════════════════

function textResult(data: Record<string, unknown>): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([
    new vscode.LanguageModelTextPart(JSON.stringify(data, null, 2)),
  ]);
}

function forwardToServer(args: Record<string, unknown> | undefined): Promise<Record<string, unknown>> {
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
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    req.write(body);
    req.end();
  });
}

interface TaskToolInput {
  operation: string;
  [key: string]: unknown;
}
