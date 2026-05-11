import type { TerminalShellPolicyInput } from '#tools/adapters/terminal-policy/index.js';
import type { ToolExecutionRequest } from '#tools/core/ToolContracts.js';
import type { ToolResultEnvelope } from '#tools/core/ToolResultEnvelope.js';
import {
  buildTerminalShellPolicyInput,
  evaluateTerminalShellPolicy,
} from '../terminal-policy/index.js';
import { materializeTerminalOutput } from './TerminalArtifacts.js';
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
  shellAuditData,
  statusForFailure,
} from './TerminalExecutorShared.js';

export async function executeShell(
  request: ToolExecutionRequest,
  startedAt: Date,
  startedMs: number
): Promise<ToolResultEnvelope> {
  const built = buildTerminalShellPolicyInput(
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
  const shell = built.input;
  const policy = evaluateTerminalShellPolicy(shell);
  if (!policy.allowed) {
    return recordAndReturn(request, envelopeForPolicyBlock(request, startedAt, startedMs, policy));
  }
  const envSummary = summarizeTerminalEnv(shell.env, 'none');
  try {
    const execResult = await sandboxedExecFile(
      shell.shell,
      ['-lc', shell.command],
      {
        cwd: shell.cwd,
        timeout: shell.timeoutMs,
        maxBuffer: 1024 * 1024,
        signal: request.context.abortSignal || undefined,
        env: buildTerminalEnvironment(process.env, shell.env),
      },
      {
        network: shell.network,
        filesystem: shell.filesystem,
        projectRoot: shell.projectRoot,
        env: shell.env,
      }
    );
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
          ...shellStructuredContent(shell, output, 0, envSummary, policy),
          sandbox: execResult.sandbox,
        },
        output.artifacts
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
          ...shellStructuredContent(shell, output, failure.code ?? 1, envSummary, policy),
          sandbox: failure._sandboxMeta,
        },
        output.artifacts
      )
    );
  }
}

function shellStructuredContent(
  shell: TerminalShellPolicyInput,
  output: ReturnType<typeof materializeTerminalOutput>,
  exitCode: number | string,
  env: { keys: string[]; persistence: 'none' | 'explicit' },
  policy: ReturnType<typeof evaluateTerminalShellPolicy>
) {
  return {
    exitCode,
    stdout: output.stdout,
    stderr: output.stderr,
    stdoutTruncated: output.stdoutTruncated,
    stderrTruncated: output.stderrTruncated,
    bin: shell.shell,
    args: ['-lc', '<command-redacted>'],
    cwd: shell.cwd,
    timeoutMs: shell.timeoutMs,
    env,
    network: shell.network,
    filesystem: shell.filesystem,
    interactive: shell.interactive,
    shell: shellAuditData(shell),
    policy,
  };
}
