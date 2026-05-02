import type { ToolExecutionRequest } from '#tools/core/ToolContracts.js';
import type { ToolResultEnvelope } from '#tools/core/ToolResultEnvelope.js';

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

export async function recordTerminalAudit(
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
    case 'terminal_script':
      return 'terminal.script';
    case 'terminal_shell':
      return 'terminal.shell';
    case 'terminal_pty':
      return 'terminal.pty';
    case 'terminal_session_close':
      return 'terminal.session.close';
    case 'terminal_session_status':
      return 'terminal.session.status';
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
    sandbox: pickSandboxAuditData(toRecord(structured.sandbox)),
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
    script: structured.script,
    shell: structured.shell,
    pty: structured.pty,
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

function pickSandboxAuditData(sandbox: Record<string, unknown>) {
  if (!Object.keys(sandbox).length) {
    return undefined;
  }
  return {
    mode: sandbox.mode,
    sandboxed: sandbox.sandboxed,
    degradeReason: sandbox.degradeReason,
    violations: sandbox.violations,
    networkDenied: sandbox.networkDenied,
    filesystemMode: sandbox.filesystemMode,
    envStripped: sandbox.envStripped,
  };
}

function pickLifecycleAuditData(structured: Record<string, unknown>) {
  if (typeof structured.action !== 'string') {
    return undefined;
  }
  return {
    action: structured.action,
    id: structured.id,
    found: structured.found,
    count: structured.count,
    closed: structured.closed,
    removed: structured.removed,
  };
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
