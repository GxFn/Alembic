/**
 * AutoSnippet Task Tool — lm.registerTool 核心通道
 *
 * 通过 #asd 引用激活，Agent Mode 全能力可用。
 *
 * 智能层：
 *   1. prime 响应时提升 decisions 到顶层 + 添加行为提示 + 刷新缓存
 *   2. 非 prime 操作自动补注入 decisions（带 TTL 缓存，防止 Agent 跳过 prime）
 *   3. record_decision / revise_decision / unpin_decision 时 invalidate 缓存
 *   4. record_decision 响应时确认消息
 *
 * 架构：lm.registerTool → 拦截 + 增强 → HTTP 转发 → API Server
 */

import * as vscode from 'vscode';
import * as http from 'http';

// ── P1: Decision 缓存（30s TTL） ──────────────────────────
interface DecisionCacheEntry {
  decisions: Array<{ id: string; title: string }>;
  fetchedAt: number;
}
const DECISION_CACHE_TTL = 30_000; // 30s
let decisionCache: DecisionCacheEntry | null = null;
let decisionCachePending: Promise<Array<{ id: string; title: string }> | null> | null = null;

/**
 * 获取 decisions（带缓存 + 防并发）
 * 缓存有效时直接返回；失效时发一次 prime 请求拉取。
 * Server 不可达时降级返回过期缓存。
 */
async function getCachedDecisions(): Promise<Array<{ id: string; title: string }> | null> {
  // 缓存有效
  if (decisionCache && (Date.now() - decisionCache.fetchedAt) < DECISION_CACHE_TTL) {
    return decisionCache.decisions;
  }

  // 防并发：如果有正在发的请求，等它
  if (decisionCachePending) {
    try { return await decisionCachePending; } catch { return decisionCache?.decisions || null; }
  }

  // 发新请求
  decisionCachePending = (async () => {
    try {
      const primeRes = await forwardToServer({ operation: 'prime' });
      if (primeRes.success && primeRes.data) {
        const pd = primeRes.data as Record<string, unknown>;
        const decisions = pd.decisions as Array<Record<string, unknown>> | undefined;
        if (decisions && decisions.length > 0) {
          decisionCache = {
            decisions: decisions.map(d => ({
              id: d.id as string,
              title: d.title as string,
            })),
            fetchedAt: Date.now(),
          };
          return decisionCache.decisions;
        }
      }
      // prime 成功但无 decisions → 缓存空结果避免频繁请求
      decisionCache = { decisions: [], fetchedAt: Date.now() };
      return [];
    } catch {
      // server 不可达，返回过期缓存兜底
      return decisionCache?.decisions || null;
    } finally {
      decisionCachePending = null;
    }
  })();

  return decisionCachePending;
}

/** 决策写操作列表 — 这些操作会 invalidate 缓存 */
const DECISION_WRITE_OPS = ['record_decision', 'revise_decision', 'unpin_decision'];

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
        list: 'Listing tasks...',
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
      } catch (err: any) {
        return textResult({
          success: false,
          message: `Server unreachable: ${err.message}. Run \`asd server\` in the project directory.`,
        });
      }

      // ── 2. prime 响应增强 + 刷新缓存 ──
      if (operation === 'prime' && serverResult.success && serverResult.data) {
        const data = serverResult.data as Record<string, unknown>;
        const decisions = data.decisions as Array<Record<string, unknown>> | undefined;

        // 提升 decisions 到顶层，让 Agent 一眼看到
        if (decisions && decisions.length > 0) {
          serverResult._decisions = decisions.map(d => ({
            id: d.id,
            title: d.title,
            summary: typeof d.summary === 'string' ? d.summary : (typeof d.description === 'string' ? (d.description as string).slice(0, 150) : ''),
          }));
          serverResult._instruction = 'You MUST respect these decisions. If user asks to contradict one, discuss first and use revise_decision if agreed.';

          // P1: 刷新缓存
          decisionCache = {
            decisions: decisions.map(d => ({
              id: d.id as string,
              title: d.title as string,
            })),
            fetchedAt: Date.now(),
          };
        } else {
          // prime 成功但无 decisions → 缓存空结果
          decisionCache = { decisions: [], fetchedAt: Date.now() };
        }

        // 提升 hint
        if (data._decisionHint) {
          serverResult._decisionHint = data._decisionHint;
        }
      }

      // ── 3. 决策写操作：invalidate 缓存 ──
      if (DECISION_WRITE_OPS.includes(operation)) {
        decisionCache = null;
      }

      // ── 4. 非 prime 操作：自动补注入 decisions（带缓存） ──
      if (operation !== 'prime') {
        try {
          const decisions = await getCachedDecisions();
          if (decisions && decisions.length > 0) {
            serverResult._activeDecisions = decisions;
          }
        } catch {
          // 不阻塞
        }
      }

      // ── 5. record_decision 确认消息 ──
      if (operation === 'record_decision' && serverResult.success) {
        serverResult._note = 'Decision recorded. It will appear in all future prime responses. This decision is now enforced across sessions.';
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
