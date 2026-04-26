import {
  buildTerminalCommandPolicyInput,
  evaluateTerminalCommandPolicy,
} from '#tools/adapters/TerminalCommandPolicy.js';
import type { TerminalSessionManager } from '#tools/adapters/TerminalSessionManager.js';
import type { ToolExecutionRequest } from '#tools/core/ToolContracts.js';
import type { ToolResultEnvelope } from '#tools/core/ToolResultEnvelope.js';
import { materializeTerminalOutput } from './TerminalArtifacts.js';
import {
  envelopeForError,
  envelopeForPolicyBlock,
  envelopeForTerminalResult,
} from './TerminalEnvelopes.js';
import {
  buildCommandEnvironment,
  buildTerminalEnvironment,
  summarizeTerminalEnv,
} from './TerminalEnvironment.js';
import {
  type ExecFailure,
  execFileAsync,
  getTerminalSessionManager,
  recordAndReturn,
  statusForFailure,
} from './TerminalExecutorShared.js';

export async function executeStructuredCommand(
  request: ToolExecutionRequest,
  fallbackSessionManager: TerminalSessionManager,
  startedAt: Date,
  startedMs: number
): Promise<ToolResultEnvelope> {
  const built = buildTerminalCommandPolicyInput(
    request.args,
    request.context.projectRoot,
    request.manifest.execution.timeoutMs
  );
  if (!built.ok) {
    return recordAndReturn(
      request,
      envelopeForError(request, startedAt, startedMs, built.error, { error: built.error })
    );
  }

  const terminal = built.input;
  const policy = evaluateTerminalCommandPolicy(terminal);
  if (!policy.allowed) {
    return recordAndReturn(request, envelopeForPolicyBlock(request, startedAt, startedMs, policy));
  }

  const sessionManager = getTerminalSessionManager(request, fallbackSessionManager);
  const acquired = sessionManager.acquire(terminal.session, {
    callId: request.context.callId,
    projectRoot: request.context.projectRoot,
    cwd: terminal.cwd,
  });
  if (!acquired.ok) {
    return recordAndReturn(
      request,
      envelopeForError(request, startedAt, startedMs, acquired.error, {
        error: acquired.error,
        session: terminal.session,
      })
    );
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
    return recordAndReturn(
      request,
      envelopeForTerminalResult(
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
      )
    );
  } catch (err) {
    const failure = err as ExecFailure;
    const output = materializeTerminalOutput(request, {
      stdout: failure.stdout || '',
      stderr: failure.stderr || failure.message || '',
    });
    const sessionRecord = acquired.lease.release({ cwd: executionCwd, env: persistedEnv });
    return recordAndReturn(
      request,
      envelopeForTerminalResult(
        request,
        startedAt,
        startedMs,
        statusForFailure(request, failure),
        {
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
        },
        output.artifacts
      )
    );
  }
}
