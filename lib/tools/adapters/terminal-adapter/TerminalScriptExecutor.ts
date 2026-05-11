import type { TerminalScriptPolicyInput } from '#tools/adapters/terminal-policy/index.js';
import type { ToolExecutionRequest } from '#tools/core/ToolContracts.js';
import type { ToolResultEnvelope } from '#tools/core/ToolResultEnvelope.js';
import {
  buildTerminalScriptPolicyInput,
  evaluateTerminalScriptPolicy,
} from '../terminal-policy/index.js';
import {
  fileUriToPath,
  materializeScriptArtifact,
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
  execFileAsync,
  recordAndReturn,
  scriptAuditData,
  statusForFailure,
} from './TerminalExecutorShared.js';

export async function executeScript(
  request: ToolExecutionRequest,
  startedAt: Date,
  startedMs: number
): Promise<ToolResultEnvelope> {
  const built = buildTerminalScriptPolicyInput(
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

  const script = built.input;
  const policy = evaluateTerminalScriptPolicy(script);
  if (!policy.allowed) {
    return recordAndReturn(request, envelopeForPolicyBlock(request, startedAt, startedMs, policy));
  }

  const artifact = materializeScriptArtifact(request, script.script, script.scriptHash);
  const scriptPath = fileUriToPath(artifact.uri);
  const envSummary = summarizeTerminalEnv(script.env, 'none');

  try {
    const { stdout, stderr } = await execFileAsync(script.shell, [scriptPath], {
      cwd: script.cwd,
      timeout: script.timeoutMs,
      maxBuffer: 1024 * 1024,
      signal: request.context.abortSignal || undefined,
      env: buildTerminalEnvironment(process.env, script.env),
    });
    const output = materializeTerminalOutput(request, { stdout, stderr });
    return recordAndReturn(
      request,
      envelopeForTerminalResult(
        request,
        startedAt,
        startedMs,
        'success',
        scriptStructuredContent(script, output, 0, scriptPath, envSummary, policy),
        [artifact, ...output.artifacts]
      )
    );
  } catch (err) {
    const failure = err as ExecFailure;
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
        scriptStructuredContent(script, output, failure.code ?? 1, scriptPath, envSummary, policy),
        [artifact, ...output.artifacts]
      )
    );
  }
}

function scriptStructuredContent(
  script: TerminalScriptPolicyInput,
  output: ReturnType<typeof materializeTerminalOutput>,
  exitCode: number | string,
  scriptPath: string,
  env: { keys: string[]; persistence: 'none' | 'explicit' },
  policy: ReturnType<typeof evaluateTerminalScriptPolicy>
) {
  return {
    exitCode,
    stdout: output.stdout,
    stderr: output.stderr,
    stdoutTruncated: output.stdoutTruncated,
    stderrTruncated: output.stderrTruncated,
    bin: script.shell,
    args: [scriptPath],
    cwd: script.cwd,
    timeoutMs: script.timeoutMs,
    env,
    network: script.network,
    filesystem: script.filesystem,
    interactive: script.interactive,
    script: scriptAuditData(script),
    policy,
  };
}
