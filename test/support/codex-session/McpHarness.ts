import { type DaemonStatus, DaemonSupervisor } from '../../../lib/daemon/DaemonSupervisor.js';
import { CodexMcpServer, getVisibleCodexTools } from '../../../lib/external/mcp/CodexMcpServer.js';
import { FakeDaemonSupervisor } from './FakeDaemonSupervisor.js';
import type {
  CodexScenarioToolCallFact,
  CodexSessionHarnessMode,
  CodexSessionScenario,
  CodexSessionTranscriptEvent,
} from './ScenarioTypes.js';
import type { TranscriptWriter } from './TranscriptWriter.js';

export interface CodexHarnessSupervisorRecorder {
  readonly ensureCalls: Array<{ projectRoot: string; waitUntilReadyMs?: number }>;
  readonly statusCalls: string[];
  readonly stopCalls: Array<{ projectRoot: string; waitMs?: number }>;
}

export interface CodexMcpHarnessContext {
  mode: CodexSessionHarnessMode;
  projectRoot: string;
  scenario: CodexSessionScenario;
  transcript: TranscriptWriter;
  waitUntilReadyMs?: number;
}

export interface AlembicMcpHarness {
  readonly fetchCalls: Array<{ body: unknown; url: string }>;
  readonly supervisor: CodexHarnessSupervisorRecorder;
  readonly toolCalls: CodexScenarioToolCallFact[];
  readonly transcript: TranscriptWriter;
  callTool(turn: number, name: string, args?: Record<string, unknown>): Promise<unknown>;
  listTools(): Array<{ name: string }>;
  restore(): void;
}

export class AlembicInProcessMcpHarness implements AlembicMcpHarness {
  readonly fetchCalls: Array<{ body: unknown; url: string }> = [];
  readonly supervisor: FakeDaemonSupervisor;
  readonly toolCalls: CodexScenarioToolCallFact[] = [];
  readonly transcript: TranscriptWriter;
  #originalFetch: typeof globalThis.fetch;
  #server: CodexMcpServer;

  constructor(context: CodexMcpHarnessContext) {
    this.transcript = context.transcript;
    this.supervisor = new FakeDaemonSupervisor(context.scenario.fixture.daemon || 'stopped');
    this.#server = new CodexMcpServer({ supervisor: this.supervisor });
    this.#originalFetch = globalThis.fetch;
    this.#installFetchMock();
  }

  async callTool(turn: number, name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    this.transcript.record({
      data: { arguments: args },
      tool: name,
      turn,
      type: 'agent.tool_call',
    });
    const result = await this.#server.handleToolCall(name, args);
    const success =
      typeof result === 'object' && result !== null && 'success' in result
        ? Boolean((result as { success?: unknown }).success)
        : null;
    const errorCode = extractErrorCode(result);
    this.toolCalls.push({ arguments: args, errorCode, name, result, success, turn });
    this.transcript.record({
      data: normalizeResult(result),
      tool: name,
      turn,
      type: 'tool.result',
    });
    return result;
  }

  listTools(): Array<{ name: string }> {
    return getVisibleCodexTools().map((tool) => ({ name: tool.name }));
  }

  restore(): void {
    globalThis.fetch = this.#originalFetch;
  }

  #installFetchMock(): void {
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const body = parseJsonBody(init?.body);
      this.fetchCalls.push({ body, url });
      if (url.includes('/api/v1/jobs/bootstrap')) {
        return jsonResponse(202, {
          success: true,
          data: {
            jobId: 'scenario_bootstrap_job',
            job: { id: 'scenario_bootstrap_job', kind: 'bootstrap' },
          },
        });
      }
      if (url.includes('/api/v1/jobs/rescan')) {
        return jsonResponse(202, {
          success: true,
          data: {
            jobId: 'scenario_rescan_job',
            job: { id: 'scenario_rescan_job', kind: 'rescan' },
          },
        });
      }
      if (url.includes('/api/v1/jobs')) {
        return jsonResponse(200, { success: true, data: { jobs: [] } });
      }
      return jsonResponse(404, { success: false, message: `Unhandled scenario fetch: ${url}` });
    };
  }
}

export class AlembicLiveLocalMcpHarness implements AlembicMcpHarness {
  readonly fetchCalls: Array<{ body: unknown; url: string }> = [];
  readonly supervisor = new RecordingDaemonSupervisor();
  readonly toolCalls: CodexScenarioToolCallFact[] = [];
  readonly transcript: TranscriptWriter;
  #originalFetch: typeof globalThis.fetch;
  #server: CodexMcpServer;

  constructor(context: CodexMcpHarnessContext) {
    this.transcript = context.transcript;
    this.#server = new CodexMcpServer({
      supervisor: this.supervisor,
      waitUntilReadyMs: context.waitUntilReadyMs,
    });
    this.#originalFetch = globalThis.fetch;
    this.#installFetchRecorder();
  }

  async callTool(turn: number, name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    this.transcript.record({
      data: { arguments: args },
      tool: name,
      turn,
      type: 'agent.tool_call',
    });
    const result = await this.#server.handleToolCall(name, args);
    const success =
      typeof result === 'object' && result !== null && 'success' in result
        ? Boolean((result as { success?: unknown }).success)
        : null;
    const errorCode = extractErrorCode(result);
    this.toolCalls.push({ arguments: args, errorCode, name, result, success, turn });
    this.transcript.record({
      data: normalizeResult(result),
      tool: name,
      turn,
      type: 'tool.result',
    });
    return result;
  }

  listTools(): Array<{ name: string }> {
    return getVisibleCodexTools().map((tool) => ({ name: tool.name }));
  }

  restore(): void {
    globalThis.fetch = this.#originalFetch;
  }

  #installFetchRecorder(): void {
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const body = parseJsonBody(init?.body);
      this.fetchCalls.push({ body, url });
      return this.#originalFetch(input, init);
    };
  }
}

export function createCodexMcpHarness(context: CodexMcpHarnessContext): AlembicMcpHarness {
  if (context.mode === 'live-local') {
    return new AlembicLiveLocalMcpHarness(context);
  }
  return new AlembicInProcessMcpHarness(context);
}

class RecordingDaemonSupervisor implements CodexHarnessSupervisorRecorder {
  readonly ensureCalls: Array<{ projectRoot: string; waitUntilReadyMs?: number }> = [];
  readonly statusCalls: string[] = [];
  readonly stopCalls: Array<{ projectRoot: string; waitMs?: number }> = [];
  readonly #inner = new DaemonSupervisor();

  async ensure(options: { projectRoot: string; waitUntilReadyMs?: number }): Promise<DaemonStatus> {
    this.ensureCalls.push(options);
    return this.#inner.ensure(options);
  }

  async status(projectRoot: string): Promise<DaemonStatus> {
    this.statusCalls.push(projectRoot);
    return this.#inner.status(projectRoot);
  }

  async stop(options: { projectRoot: string; waitMs?: number }): Promise<DaemonStatus> {
    this.stopCalls.push(options);
    return this.#inner.stop(options);
  }
}

function extractErrorCode(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') {
    return undefined;
  }
  const data = (result as { data?: unknown }).data;
  if (
    data &&
    typeof data === 'object' &&
    typeof (data as { errorCode?: unknown }).errorCode === 'string'
  ) {
    return (data as { errorCode: string }).errorCode;
  }
  if (typeof (result as { errorCode?: unknown }).errorCode === 'string') {
    return (result as { errorCode: string }).errorCode;
  }
  return undefined;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status,
  });
}

function normalizeResult(result: unknown): Record<string, unknown> {
  return result && typeof result === 'object'
    ? (result as Record<string, unknown>)
    : { value: result };
}

function parseJsonBody(body: BodyInit | null | undefined): unknown {
  if (typeof body !== 'string') {
    return null;
  }
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

export function transcriptEvent(
  type: string,
  data: Record<string, unknown> = {}
): CodexSessionTranscriptEvent {
  return { data, type };
}
