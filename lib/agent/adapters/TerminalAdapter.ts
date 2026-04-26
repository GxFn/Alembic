import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  ToolExecutionAdapter,
  ToolExecutionPreviewRequest,
  ToolExecutionRequest,
} from '../core/ToolContracts.js';
import type { ToolExecutionPreview } from '../core/ToolDecision.js';
import type {
  ToolArtifactRef,
  ToolResultEnvelope,
  ToolResultStatus,
} from '../core/ToolResultEnvelope.js';
import {
  buildTerminalCommandPolicyInput,
  evaluateTerminalCommandPolicy,
} from './TerminalCommandPolicy.js';
import {
  InMemoryTerminalSessionManager,
  type TerminalSessionManager,
  type TerminalSessionRecord,
} from './TerminalSessionManager.js';

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_OUTPUT_BYTES = 16_000;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const NON_INTERACTIVE_ENV = {
  CI: '1',
  GIT_PAGER: 'cat',
  GIT_TERMINAL_PROMPT: '0',
  LESS: '-FRX',
  PAGER: 'cat',
};

interface ExecFailure extends Error {
  code?: number | string;
  killed?: boolean;
  stdout?: string;
  stderr?: string;
}

interface WriteZoneLike {
  runtime(sub: string): { absolute: string };
  writeFile(target: { absolute: string }, content: string | Buffer): void;
}

interface TerminalAuditSinkLike {
  log(entry: TerminalAuditEntry): void | Promise<void>;
}

interface TerminalAuditEntry {
  requestId: string;
  actor: string;
  action: string;
  resource: string;
  result: 'success' | 'failure';
  error?: string;
  duration: number;
  data: Record<string, unknown>;
  context: Record<string, unknown>;
}

export class TerminalAdapter implements ToolExecutionAdapter {
  readonly kind = 'terminal-profile' as const;

  readonly #fallbackSessionManager: TerminalSessionManager;

  constructor(options: { sessionManager?: TerminalSessionManager } = {}) {
    this.#fallbackSessionManager = options.sessionManager ?? new InMemoryTerminalSessionManager();
  }

  preview(request: ToolExecutionPreviewRequest): ToolExecutionPreview {
    if (request.manifest.id === 'terminal_session_close') {
      return {
        kind: 'terminal-session',
        summary: `Close terminal session ${String(request.args.id ?? '')}`,
        risk: 'low',
        details: { action: 'close', id: request.args.id },
      };
    }
    if (request.manifest.id === 'terminal_session_cleanup') {
      return {
        kind: 'terminal-session',
        summary: 'Cleanup closed or expired terminal sessions',
        risk: 'low',
        details: { action: 'cleanup' },
      };
    }

    const built = buildTerminalCommandPolicyInput(
      request.args,
      request.projectRoot,
      request.manifest.execution.timeoutMs
    );
    if (!built.ok) {
      return {
        kind: 'terminal-command',
        summary: 'Invalid terminal command',
        risk: 'high',
        details: { error: built.error },
      };
    }
    const policy = evaluateTerminalCommandPolicy(built.input);
    return {
      kind: 'terminal-command',
      summary: policy.preview.command,
      risk: policy.risk,
      details: {
        ...policy.preview,
        allowed: policy.allowed,
        reason: policy.reason,
        matchedRule: policy.matchedRule,
      },
    };
  }

  async execute(request: ToolExecutionRequest): Promise<ToolResultEnvelope> {
    const startedAt = new Date();
    const startedMs = Date.now();
    if (request.manifest.id === 'terminal_session_close') {
      return await this.#executeSessionClose(request, startedAt, startedMs);
    }
    if (request.manifest.id === 'terminal_session_cleanup') {
      return await this.#executeSessionCleanup(request, startedAt, startedMs);
    }

    const built = buildTerminalCommandPolicyInput(
      request.args,
      request.context.projectRoot,
      request.manifest.execution.timeoutMs
    );
    if (!built.ok) {
      const envelope = envelopeForError(request, startedAt, startedMs, built.error, {
        error: built.error,
      });
      await recordTerminalAudit(request, envelope);
      return envelope;
    }

    const terminal = built.input;
    const policy = evaluateTerminalCommandPolicy(terminal);
    if (!policy.allowed) {
      const envelope = envelopeForPolicyBlock(request, startedAt, startedMs, policy);
      await recordTerminalAudit(request, envelope);
      return envelope;
    }

    const sessionManager = getTerminalSessionManager(request, this.#fallbackSessionManager);
    const acquired = sessionManager.acquire(terminal.session, {
      callId: request.context.callId,
      projectRoot: request.context.projectRoot,
      cwd: terminal.cwd,
    });
    if (!acquired.ok) {
      const envelope = envelopeForError(request, startedAt, startedMs, acquired.error, {
        error: acquired.error,
        session: terminal.session,
      });
      await recordTerminalAudit(request, envelope);
      return envelope;
    }
    const executionCwd =
      terminal.session.mode === 'persistent' && request.args.cwd === undefined
        ? acquired.lease.record.cwd
        : terminal.cwd;
    const commandEnv = buildCommandEnvironment(
      terminal.session.envPersistence === 'explicit' ? acquired.lease.env : {},
      terminal.env
    );
    const persistedEnv = terminal.session.envPersistence === 'explicit' ? commandEnv : undefined;
    const envSummary = summarizeTerminalEnv(commandEnv, terminal.session.envPersistence);

    try {
      const { stdout, stderr } = await execFileAsync(terminal.bin, terminal.args, {
        cwd: executionCwd,
        timeout: terminal.timeoutMs,
        maxBuffer: 1024 * 1024,
        signal: request.context.abortSignal || undefined,
        env: buildTerminalEnvironment(process.env, commandEnv),
      });
      const output = materializeTerminalOutput(request, { stdout, stderr });
      const sessionRecord = acquired.lease.release({ cwd: executionCwd, env: persistedEnv });
      const envelope = envelopeForTerminalResult(
        request,
        startedAt,
        startedMs,
        'success',
        {
          exitCode: 0,
          stdout: output.stdout,
          stderr: output.stderr,
          stdoutTruncated: output.stdoutTruncated,
          stderrTruncated: output.stderrTruncated,
          bin: terminal.bin,
          args: terminal.args,
          cwd: executionCwd,
          timeoutMs: terminal.timeoutMs,
          env: envSummary,
          network: terminal.network,
          filesystem: terminal.filesystem,
          interactive: terminal.interactive,
          session: terminal.session,
          sessionRecord,
          policy,
        },
        output.artifacts
      );
      await recordTerminalAudit(request, envelope);
      return envelope;
    } catch (err) {
      const failure = err as ExecFailure;
      const status: ToolResultStatus = request.context.abortSignal?.aborted
        ? 'aborted'
        : failure.killed
          ? 'timeout'
          : 'error';
      const output = materializeTerminalOutput(request, {
        stdout: failure.stdout || '',
        stderr: failure.stderr || failure.message || '',
      });
      const sessionRecord = acquired.lease.release({ cwd: executionCwd, env: persistedEnv });
      const structured = {
        exitCode: failure.code ?? 1,
        stdout: output.stdout,
        stderr: output.stderr,
        stdoutTruncated: output.stdoutTruncated,
        stderrTruncated: output.stderrTruncated,
        bin: terminal.bin,
        args: terminal.args,
        cwd: executionCwd,
        timeoutMs: terminal.timeoutMs,
        env: envSummary,
        network: terminal.network,
        filesystem: terminal.filesystem,
        interactive: terminal.interactive,
        session: terminal.session,
        sessionRecord,
        policy,
      };
      const envelope = envelopeForTerminalResult(
        request,
        startedAt,
        startedMs,
        status,
        structured,
        output.artifacts
      );
      await recordTerminalAudit(request, envelope);
      return envelope;
    }
  }

  async #executeSessionClose(
    request: ToolExecutionRequest,
    startedAt: Date,
    startedMs: number
  ): Promise<ToolResultEnvelope> {
    const id = parseSessionId(request.args.id);
    if (!id.ok) {
      const envelope = envelopeForError(request, startedAt, startedMs, id.error, {
        error: id.error,
      });
      await recordTerminalAudit(request, envelope);
      return envelope;
    }

    const sessionManager = getTerminalSessionManager(request, this.#fallbackSessionManager);
    const before = sessionManager.snapshot(id.id);
    if (before?.status === 'busy') {
      const envelope = envelopeForError(
        request,
        startedAt,
        startedMs,
        `terminal session "${id.id}" is busy`,
        {
          error: `terminal session "${id.id}" is busy`,
          id: id.id,
          sessionRecord: before,
        }
      );
      await recordTerminalAudit(request, envelope);
      return envelope;
    }

    const closed = sessionManager.close(id.id);
    const after = sessionManager.snapshot(id.id);
    const envelope = envelopeForSessionResult(request, startedAt, startedMs, {
      action: 'close',
      id: id.id,
      closed,
      sessionRecord: after ?? before,
    });
    await recordTerminalAudit(request, envelope);
    return envelope;
  }

  async #executeSessionCleanup(
    request: ToolExecutionRequest,
    startedAt: Date,
    startedMs: number
  ): Promise<ToolResultEnvelope> {
    const sessionManager = getTerminalSessionManager(request, this.#fallbackSessionManager);
    const removed = sessionManager.cleanup();
    const envelope = envelopeForSessionResult(request, startedAt, startedMs, {
      action: 'cleanup',
      removed,
    });
    await recordTerminalAudit(request, envelope);
    return envelope;
  }
}

function parseSessionId(value: unknown): { ok: true; id: string } | { ok: false; error: string } {
  if (typeof value !== 'string' || !SESSION_ID_PATTERN.test(value)) {
    return {
      ok: false,
      error: 'terminal session id must match /^[A-Za-z0-9._:-]{1,64}$/',
    };
  }
  return { ok: true, id: value };
}

function getTerminalSessionManager(
  request: ToolExecutionRequest,
  fallback: TerminalSessionManager
): TerminalSessionManager {
  try {
    const candidate = request.context.services.get('terminalSessionManager');
    if (isTerminalSessionManager(candidate)) {
      return candidate;
    }
  } catch {
    return fallback;
  }
  return fallback;
}

function isTerminalSessionManager(value: unknown): value is TerminalSessionManager {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as TerminalSessionManager).acquire === 'function' &&
    typeof (value as TerminalSessionManager).snapshot === 'function' &&
    typeof (value as TerminalSessionManager).close === 'function' &&
    typeof (value as TerminalSessionManager).cleanup === 'function'
  );
}

async function recordTerminalAudit(
  request: ToolExecutionRequest,
  envelope: ToolResultEnvelope
): Promise<void> {
  const sink = getTerminalAuditSink(request);
  if (!sink) {
    return;
  }

  try {
    await sink.log({
      requestId: request.context.callId,
      actor: request.context.actor.user || request.context.actor.role || 'unknown',
      action: auditActionForTool(request.manifest.id),
      resource: request.manifest.governance.gatewayResource || request.manifest.id,
      result: envelope.ok ? 'success' : 'failure',
      error: envelope.ok ? undefined : envelope.text,
      duration: envelope.durationMs,
      data: buildTerminalAuditData(request, envelope),
      context: {
        surface: request.context.surface,
        source: request.context.source,
        parentCallId: request.context.parentCallId,
      },
    });
  } catch {
    // Audit must never affect terminal execution results.
  }
}

function getTerminalAuditSink(request: ToolExecutionRequest): TerminalAuditSinkLike | null {
  const preferred = safeServiceLookup(request, 'terminalAuditSink');
  if (isTerminalAuditSink(preferred)) {
    return preferred;
  }
  const auditLogger = safeServiceLookup(request, 'auditLogger');
  if (isTerminalAuditSink(auditLogger)) {
    return auditLogger;
  }
  return null;
}

function safeServiceLookup(request: ToolExecutionRequest, name: string): unknown | null {
  try {
    return request.context.services.get(name);
  } catch {
    return null;
  }
}

function isTerminalAuditSink(value: unknown): value is TerminalAuditSinkLike {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as TerminalAuditSinkLike).log === 'function'
  );
}

function auditActionForTool(toolId: string) {
  switch (toolId) {
    case 'terminal_run':
      return 'terminal.run';
    case 'terminal_session_close':
      return 'terminal.session.close';
    case 'terminal_session_cleanup':
      return 'terminal.session.cleanup';
    default:
      return `terminal.${toolId}`;
  }
}

function buildTerminalAuditData(
  request: ToolExecutionRequest,
  envelope: ToolResultEnvelope
): Record<string, unknown> {
  const structured = toRecord(envelope.structuredContent);
  return {
    toolId: request.manifest.id,
    status: envelope.status,
    ok: envelope.ok,
    command: pickCommandAuditData(structured),
    session: structured.session,
    sessionRecord: structured.sessionRecord,
    policy: pickPolicyAuditData(toRecord(structured.policy)),
    lifecycle: pickLifecycleAuditData(structured),
    artifactCount: envelope.artifacts?.length || 0,
  };
}

function pickCommandAuditData(structured: Record<string, unknown>) {
  if (typeof structured.bin !== 'string') {
    return undefined;
  }
  return {
    bin: structured.bin,
    argsCount: Array.isArray(structured.args) ? structured.args.length : 0,
    cwd: structured.cwd,
    env: structured.env,
    timeoutMs: structured.timeoutMs,
    network: structured.network,
    filesystem: structured.filesystem,
    interactive: structured.interactive,
    exitCode: structured.exitCode,
    stdoutTruncated: structured.stdoutTruncated,
    stderrTruncated: structured.stderrTruncated,
  };
}

function buildTerminalEnvironment(
  env: NodeJS.ProcessEnv,
  commandEnv: Record<string, string> = {}
): NodeJS.ProcessEnv {
  return {
    ...env,
    ...commandEnv,
    ...NON_INTERACTIVE_ENV,
  };
}

function buildCommandEnvironment(
  sessionEnv: Record<string, string>,
  commandEnv: Record<string, string>
): Record<string, string> {
  return {
    ...sessionEnv,
    ...commandEnv,
  };
}

function summarizeTerminalEnv(
  env: Record<string, string>,
  persistence: 'none' | 'explicit'
): { keys: string[]; persistence: 'none' | 'explicit' } {
  return {
    keys: Object.keys(env).sort(),
    persistence,
  };
}

function pickPolicyAuditData(policy: Record<string, unknown>) {
  if (!Object.keys(policy).length) {
    return undefined;
  }
  return {
    allowed: policy.allowed,
    risk: policy.risk,
    reason: policy.reason,
    matchedRule: policy.matchedRule,
  };
}

function pickLifecycleAuditData(structured: Record<string, unknown>) {
  if (typeof structured.action !== 'string') {
    return undefined;
  }
  return {
    action: structured.action,
    id: structured.id,
    closed: structured.closed,
    removed: structured.removed,
  };
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function envelopeForPolicyBlock(
  request: ToolExecutionRequest,
  startedAt: Date,
  startedMs: number,
  policy: ReturnType<typeof evaluateTerminalCommandPolicy>
): ToolResultEnvelope {
  const message = policy.reason || 'Terminal command blocked by policy';
  return {
    ok: false,
    toolId: request.manifest.id,
    callId: request.context.callId,
    parentCallId: request.context.parentCallId,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedMs,
    status: 'blocked',
    text: message,
    structuredContent: {
      error: message,
      policy,
    },
    diagnostics: {
      degraded: false,
      fallbackUsed: false,
      warnings: [
        {
          code: 'terminal_policy_blocked',
          message,
          tool: request.manifest.id,
        },
      ],
      timedOutStages: [],
      blockedTools: [{ tool: request.manifest.id, reason: message }],
      truncatedToolCalls: 0,
      emptyResponses: 0,
      aiErrorCount: 0,
      gateFailures: [
        {
          stage: 'execute',
          action: 'terminal-policy',
          reason: message,
        },
      ],
    },
    trust: {
      source: 'terminal',
      sanitized: true,
      containsUntrustedText: false,
      containsSecrets: false,
    },
  };
}

function envelopeForTerminalResult(
  request: ToolExecutionRequest,
  startedAt: Date,
  startedMs: number,
  status: ToolResultStatus,
  structuredContent: Record<string, unknown>,
  artifacts: ToolArtifactRef[] = []
): ToolResultEnvelope {
  const ok = status === 'success';
  const text = ok
    ? `Terminal command completed: ${String(structuredContent.bin)}`
    : `Terminal command failed: ${String(structuredContent.bin)}`;
  return {
    ok,
    toolId: request.manifest.id,
    callId: request.context.callId,
    parentCallId: request.context.parentCallId,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedMs,
    status,
    text,
    structuredContent,
    artifacts: artifacts.length > 0 ? artifacts : undefined,
    diagnostics: {
      degraded: false,
      fallbackUsed: false,
      warnings: ok
        ? []
        : [{ code: 'terminal_command_failed', message: text, tool: request.manifest.id }],
      timedOutStages: status === 'timeout' ? [request.manifest.id] : [],
      blockedTools: [],
      truncatedToolCalls: 0,
      emptyResponses: 0,
      aiErrorCount: 0,
      gateFailures: [],
    },
    trust: {
      source: 'terminal',
      sanitized: true,
      containsUntrustedText: true,
      containsSecrets: false,
    },
  };
}

function envelopeForSessionResult(
  request: ToolExecutionRequest,
  startedAt: Date,
  startedMs: number,
  structuredContent: Record<string, unknown> & {
    action: string;
    sessionRecord?: TerminalSessionRecord | null;
  }
): ToolResultEnvelope {
  return {
    ok: true,
    toolId: request.manifest.id,
    callId: request.context.callId,
    parentCallId: request.context.parentCallId,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedMs,
    status: 'success',
    text: `Terminal session ${structuredContent.action} completed`,
    structuredContent,
    diagnostics: {
      degraded: false,
      fallbackUsed: false,
      warnings: [],
      timedOutStages: [],
      blockedTools: [],
      truncatedToolCalls: 0,
      emptyResponses: 0,
      aiErrorCount: 0,
      gateFailures: [],
    },
    trust: {
      source: 'terminal',
      sanitized: true,
      containsUntrustedText: false,
      containsSecrets: false,
    },
  };
}

function envelopeForError(
  request: ToolExecutionRequest,
  startedAt: Date,
  startedMs: number,
  message: string,
  structuredContent: Record<string, unknown>
): ToolResultEnvelope {
  return {
    ok: false,
    toolId: request.manifest.id,
    callId: request.context.callId,
    parentCallId: request.context.parentCallId,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedMs,
    status: 'error',
    text: message,
    structuredContent,
    diagnostics: {
      degraded: false,
      fallbackUsed: false,
      warnings: [{ code: 'terminal_input_error', message, tool: request.manifest.id }],
      timedOutStages: [],
      blockedTools: [],
      truncatedToolCalls: 0,
      emptyResponses: 0,
      aiErrorCount: 0,
      gateFailures: [],
    },
    trust: {
      source: 'terminal',
      sanitized: true,
      containsUntrustedText: false,
      containsSecrets: false,
    },
  };
}

function truncate(value: string, max = DEFAULT_MAX_OUTPUT_BYTES) {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}\n\n... [output truncated, ${value.length} chars total]`;
}

function materializeTerminalOutput(
  request: ToolExecutionRequest,
  output: { stdout: string; stderr: string }
): {
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  artifacts: ToolArtifactRef[];
} {
  const max = request.manifest.execution.maxOutputBytes;
  const artifacts: ToolArtifactRef[] = [];
  const stdoutArtifact = materializeStreamArtifact(request, 'stdout', output.stdout, max);
  const stderrArtifact = materializeStreamArtifact(request, 'stderr', output.stderr, max);
  if (stdoutArtifact) {
    artifacts.push(stdoutArtifact);
  }
  if (stderrArtifact) {
    artifacts.push(stderrArtifact);
  }
  return {
    stdout: truncate(output.stdout, max),
    stderr: truncate(output.stderr, max),
    stdoutTruncated: output.stdout.length > max,
    stderrTruncated: output.stderr.length > max,
    artifacts,
  };
}

function materializeStreamArtifact(
  request: ToolExecutionRequest,
  kind: 'stdout' | 'stderr',
  content: string,
  maxInlineBytes: number
): ToolArtifactRef | null {
  if (!content || content.length <= maxInlineBytes) {
    return null;
  }
  const relativePath = `artifacts/tools/${request.context.callId}/${kind}.txt`;
  const writeZone = getWriteZone(request);
  const absolutePath = writeZone
    ? writeWithZone(writeZone, relativePath, content)
    : writeLocalArtifact(request.context.projectRoot, relativePath, content);
  return {
    id: `${request.context.callId}:${kind}`,
    kind,
    uri: toFileUri(absolutePath),
    mimeType: 'text/plain; charset=utf-8',
    sizeBytes: Buffer.byteLength(content, 'utf8'),
  };
}

function getWriteZone(request: ToolExecutionRequest): WriteZoneLike | null {
  try {
    const candidate = request.context.services.get('writeZone');
    if (
      candidate &&
      typeof candidate === 'object' &&
      typeof (candidate as WriteZoneLike).runtime === 'function' &&
      typeof (candidate as WriteZoneLike).writeFile === 'function'
    ) {
      return candidate as WriteZoneLike;
    }
  } catch {
    return null;
  }
  return null;
}

function writeWithZone(writeZone: WriteZoneLike, relativePath: string, content: string) {
  const target = writeZone.runtime(relativePath);
  writeZone.writeFile(target, content);
  return target.absolute;
}

function writeLocalArtifact(projectRoot: string, relativePath: string, content: string) {
  const absolutePath = path.join(projectRoot, '.asd', relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content, 'utf8');
  return absolutePath;
}

function toFileUri(absolutePath: string) {
  return `file://${absolutePath}`;
}

export default TerminalAdapter;
