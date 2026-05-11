import type { TerminalPtyPolicyInput } from '#tools/adapters/terminal-policy/index.js';
import type { ToolExecutionRequest } from '#tools/core/ToolContracts.js';
import type { ToolResultEnvelope } from '#tools/core/ToolResultEnvelope.js';
import {
  buildTerminalPtyPolicyInput,
  evaluateTerminalPtyPolicy,
} from '../terminal-policy/index.js';
import {
  fileUriToPath,
  materializePtyRunnerArtifact,
  materializeTerminalOutput,
} from './TerminalArtifacts.js';
import {
  envelopeForError,
  envelopeForPolicyBlock,
  envelopeForTerminalResult,
} from './TerminalEnvelopes.js';
import { buildTerminalEnvironment, summarizeTerminalEnv } from './TerminalEnvironment.js';
import {
  type ExecFailure,
  recordAndReturn,
  sandboxedExecFile,
  sandboxedExecFileWithInput,
  shellAuditData,
  statusForFailure,
} from './TerminalExecutorShared.js';
import { buildPtyWrapperCommand } from './TerminalPtyRunner.js';

export async function executePty(
  request: ToolExecutionRequest,
  startedAt: Date,
  startedMs: number
): Promise<ToolResultEnvelope> {
  const built = buildTerminalPtyPolicyInput(
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
  const pty = built.input;
  const policy = evaluateTerminalPtyPolicy(pty);
  if (!policy.allowed) {
    return recordAndReturn(request, envelopeForPolicyBlock(request, startedAt, startedMs, policy));
  }
  const runnerArtifact = materializePtyRunnerArtifact(request);
  const command = buildPtyWrapperCommand(pty, fileUriToPath(runnerArtifact.uri));
  if (!command.ok) {
    return recordAndReturn(
      request,
      envelopeForError(request, startedAt, startedMs, command.error, {
        error: command.error,
        pty: pty.pty,
      })
    );
  }
  const envSummary = summarizeTerminalEnv(pty.env, 'none');
  const ptyEnv = {
    ...pty.env,
    COLUMNS: String(pty.pty.cols),
    LINES: String(pty.pty.rows),
    TERM: 'xterm-256color',
  };
  try {
    const execOptions = {
      cwd: pty.cwd,
      timeout: pty.timeoutMs,
      maxBuffer: 1024 * 1024,
      signal: request.context.abortSignal || undefined,
      env: buildTerminalEnvironment(process.env, ptyEnv),
    };
    const sandboxInput = {
      network: pty.network,
      filesystem: pty.filesystem,
      projectRoot: pty.projectRoot,
      env: ptyEnv,
    };
    const execResult =
      pty.pty.stdin === 'provided'
        ? await sandboxedExecFileWithInput(
            command.bin,
            command.args,
            pty.stdin,
            execOptions,
            sandboxInput
          )
        : await sandboxedExecFile(command.bin, command.args, execOptions, sandboxInput);
    const output = materializeTerminalOutput(request, {
      stdout: execResult.stdout,
      stderr: execResult.stderr,
    });
    return recordAndReturn(
      request,
      envelopeForTerminalResult(
        request,
        startedAt,
        startedMs,
        'success',
        {
          ...ptyStructuredContent(pty, output, 0, command, envSummary, policy),
          sandbox: execResult.sandbox,
        },
        [runnerArtifact, ...output.artifacts]
      )
    );
  } catch (err) {
    const failure = err as ExecFailure & { _sandboxMeta?: Record<string, unknown> };
    const output = materializeTerminalOutput(request, {
      stdout: failure.stdout || '',
      stderr: failure.stderr || failure.message || '',
    });
    return recordAndReturn(
      request,
      envelopeForTerminalResult(
        request,
        startedAt,
        startedMs,
        statusForFailure(request, failure),
        {
          ...ptyStructuredContent(pty, output, failure.code ?? 1, command, envSummary, policy),
          sandbox: failure._sandboxMeta,
        },
        [runnerArtifact, ...output.artifacts]
      )
    );
  }
}

function ptyStructuredContent(
  pty: TerminalPtyPolicyInput,
  output: ReturnType<typeof materializeTerminalOutput>,
  exitCode: number | string,
  command: { bin: string; auditArgs: string[] },
  env: { keys: string[]; persistence: 'none' | 'explicit' },
  policy: ReturnType<typeof evaluateTerminalPtyPolicy>
) {
  return {
    exitCode,
    stdout: output.stdout,
    stderr: output.stderr,
    stdoutTruncated: output.stdoutTruncated,
    stderrTruncated: output.stderrTruncated,
    bin: command.bin,
    args: command.auditArgs,
    cwd: pty.cwd,
    timeoutMs: pty.timeoutMs,
    env,
    network: pty.network,
    filesystem: pty.filesystem,
    interactive: pty.interactive,
    shell: shellAuditData(pty),
    pty: pty.pty,
    policy,
  };
}
