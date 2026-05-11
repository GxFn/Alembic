import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type { ToolExecutionAdapter, ToolExecutionRequest } from '#tools/core/ToolContracts.js';
import type {
  ToolArtifactRef,
  ToolResultEnvelope,
  ToolResultStatus,
} from '#tools/core/ToolResultEnvelope.js';
import { RESOURCES_DIR } from '../../shared/package-root.js';

const execFileAsync = promisify(execFile);
const MAX_WINDOW_TITLE_LENGTH = 200;

interface WriteZoneLike {
  runtime(sub: string): { absolute: string };
  writeFile(target: ReturnType<WriteZoneLike['runtime']>, content: string | Buffer): void;
}

type ExecFileRunner = (
  file: string,
  args: string[],
  options: { timeout: number; signal?: AbortSignal | null }
) => Promise<{ stdout: string; stderr: string }>;

export class MacSystemAdapter implements ToolExecutionAdapter {
  readonly kind = 'macos-adapter' as const;

  readonly #platform: NodeJS.Platform;
  readonly #screenshotBinaryPath: string;
  readonly #execFile: ExecFileRunner;

  constructor(
    options: {
      platform?: NodeJS.Platform;
      screenshotBinaryPath?: string;
      execFile?: ExecFileRunner;
    } = {}
  ) {
    this.#platform = options.platform ?? process.platform;
    this.#screenshotBinaryPath =
      options.screenshotBinaryPath ?? path.join(RESOURCES_DIR, 'native-ui', 'screenshot');
    this.#execFile = options.execFile ?? execFileAsync;
  }

  async execute(request: ToolExecutionRequest): Promise<ToolResultEnvelope> {
    const startedAt = new Date();
    const startedMs = Date.now();
    try {
      const result = await this.#execute(request);
      return envelopeForMacResult(
        request,
        startedAt,
        startedMs,
        result.status,
        result.content,
        result.artifacts
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return envelopeForMacResult(request, startedAt, startedMs, 'error', {
        success: false,
        error: { code: 'MACOS_ADAPTER_ERROR', message },
      });
    }
  }

  async #execute(request: ToolExecutionRequest): Promise<{
    status: ToolResultStatus;
    content: Record<string, unknown>;
    artifacts?: ToolArtifactRef[];
  }> {
    switch (request.manifest.id) {
      case 'mac_system_info':
        return { status: 'success', content: this.#systemInfo() };
      case 'mac_permission_status':
        return { status: 'success', content: this.#permissionStatus(request) };
      case 'mac_window_list':
        return await this.#windowList(request);
      case 'mac_screenshot':
        return await this.#screenshot(request);
      default:
        return macBlocked(
          `Unknown macOS capability "${request.manifest.id}"`,
          'UNKNOWN_MACOS_CAPABILITY'
        );
    }
  }

  #systemInfo() {
    return {
      success: true,
      data: {
        platform: this.#platform,
        isMacOS: this.#platform === 'darwin',
        arch: os.arch(),
        release: os.release(),
        version: typeof os.version === 'function' ? os.version() : null,
        hostname: os.hostname(),
      },
    };
  }

  #permissionStatus(request: ToolExecutionRequest) {
    const requested = normalizePermission(request.args.permission);
    const permissions =
      requested === 'all' ? ['screen-recording', 'accessibility', 'automation'] : [requested];
    return {
      success: true,
      data: {
        platform: this.#platform,
        permissions: permissions.map((permission) => this.#describePermission(permission)),
        policy: {
          checkedWithoutPrompt: true,
          promptsUser: false,
          bypassesTcc: false,
        },
      },
    };
  }

  #describePermission(permission: string) {
    if (this.#platform !== 'darwin') {
      return {
        permission,
        status: 'unavailable',
        reason: 'macOS permissions are only available on darwin.',
      };
    }
    if (permission === 'screen-recording' && !fs.existsSync(this.#screenshotBinaryPath)) {
      return {
        permission,
        status: 'unavailable',
        reason: 'ScreenCaptureKit helper is not built.',
      };
    }
    return {
      permission,
      status: 'unknown',
      reason: 'This adapter does not prompt for or bypass TCC permissions.',
    };
  }

  async #windowList(request: ToolExecutionRequest) {
    const unavailable = this.#requireMacScreenshotBinary();
    if (unavailable) {
      return unavailable;
    }
    const output = await this.#runScreenshotBinary(request, ['--list-windows']);
    const windows = parseJsonArray(output.stdout);
    const artifact = writeJsonArtifact(request, 'windows.json', windows);
    return {
      status: 'success' as const,
      content: {
        success: true,
        data: {
          total: windows.length,
          artifact: artifactSummary(artifact),
          privacy: {
            titlesIncludedOnlyInArtifact: true,
            containsWindowTitles: true,
          },
        },
      },
      artifacts: [artifact],
    };
  }

  async #screenshot(request: ToolExecutionRequest) {
    const unavailable = this.#requireMacScreenshotBinary();
    if (unavailable) {
      return unavailable;
    }
    const format = normalizeImageFormat(request.args.format);
    const scale = normalizeScale(request.args.scale);
    const windowTitle = normalizeWindowTitle(request.args.windowTitle);
    const outputPath = createArtifactPath(
      request,
      `screenshot.${format === 'png' ? 'png' : 'jpg'}`
    );
    const helperOutputPath = path.join(
      os.tmpdir(),
      `alembic-${request.context.callId}-screenshot.${format === 'png' ? 'png' : 'jpg'}`
    );
    const args = ['--output', helperOutputPath, '--format', format, '--scale', String(scale)];
    if (windowTitle) {
      args.push('--window', windowTitle);
    }
    const output = await this.#runScreenshotBinary(request, args);
    const image = fs.readFileSync(helperOutputPath);
    writeArtifactFile(request, outputPath, image);
    try {
      fs.unlinkSync(helperOutputPath);
    } catch {
      // Best-effort cleanup; artifact has already been materialized through the adapter.
    }
    const result = parseJsonObject(output.stdout);
    const artifact = imageArtifact(request, outputPath, format, image.length);
    return {
      status: 'success' as const,
      content: {
        success: true,
        data: {
          width: result.width,
          height: result.height,
          format,
          bytes: result.bytes,
          scale,
          windowTitleMatched: Boolean(windowTitle),
          artifact: artifactSummary(artifact),
        },
      },
      artifacts: [artifact],
    };
  }

  #requireMacScreenshotBinary() {
    if (this.#platform !== 'darwin') {
      return macBlocked(
        'macOS adapter capability is only available on darwin.',
        'MACOS_UNAVAILABLE'
      );
    }
    if (!fs.existsSync(this.#screenshotBinaryPath)) {
      return macBlocked('ScreenCaptureKit helper is not built.', 'MACOS_HELPER_MISSING');
    }
    return null;
  }

  async #runScreenshotBinary(request: ToolExecutionRequest, args: string[]) {
    try {
      return await this.#execFile(this.#screenshotBinaryPath, args, {
        timeout: request.manifest.execution.timeoutMs,
        signal: request.context.abortSignal,
      });
    } catch (err) {
      throw macExecError(err);
    }
  }
}

function normalizePermission(value: unknown) {
  return value === 'screen-recording' ||
    value === 'accessibility' ||
    value === 'automation' ||
    value === 'all'
    ? value
    : 'all';
}

function normalizeImageFormat(value: unknown): 'png' | 'jpeg' {
  return value === 'png' || value === 'jpeg' ? value : 'jpeg';
}

function normalizeScale(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 1;
  }
  return Math.min(1, Math.max(0.1, value));
}

function normalizeWindowTitle(value: unknown) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim().slice(0, MAX_WINDOW_TITLE_LENGTH);
}

function parseJsonArray(value: string): unknown[] {
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed)) {
    throw new Error('macOS helper returned non-array window list output');
  }
  return parsed;
}

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('macOS helper returned non-object screenshot output');
  }
  return parsed as Record<string, unknown>;
}

function writeJsonArtifact(request: ToolExecutionRequest, fileName: string, value: unknown) {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  const absolutePath = createArtifactPath(request, fileName);
  writeArtifactFile(request, absolutePath, content);
  return {
    id: `${request.context.callId}:${path.parse(fileName).name}`,
    kind: 'resource' as const,
    uri: pathToFileURL(absolutePath).href,
    mimeType: 'application/json',
    sizeBytes: Buffer.byteLength(content, 'utf8'),
  };
}

function imageArtifact(
  request: ToolExecutionRequest,
  absolutePath: string,
  format: 'png' | 'jpeg',
  sizeBytes?: number
): ToolArtifactRef {
  return {
    id: `${request.context.callId}:screenshot`,
    kind: 'image',
    uri: pathToFileURL(absolutePath).href,
    mimeType: format === 'png' ? 'image/png' : 'image/jpeg',
    sizeBytes,
  };
}

function artifactSummary(artifact: ToolArtifactRef) {
  return {
    id: artifact.id,
    kind: artifact.kind,
    uri: artifact.uri,
    mimeType: artifact.mimeType,
    sizeBytes: artifact.sizeBytes,
  };
}

function createArtifactTarget(request: ToolExecutionRequest, fileName: string) {
  const writeZone = getWriteZone(request);
  if (writeZone) {
    return {
      writeZone,
      target: writeZone.runtime(`artifacts/tools/${request.context.callId}/${fileName}`),
    };
  }
  return {
    writeZone: null,
    target: {
      absolute: path.join(
        request.context.projectRoot,
        '.asd',
        'artifacts',
        'tools',
        request.context.callId,
        fileName
      ),
    },
  };
}

function createArtifactPath(request: ToolExecutionRequest, fileName: string) {
  return createArtifactTarget(request, fileName).target.absolute;
}

function writeArtifactFile(
  request: ToolExecutionRequest,
  absolutePath: string,
  content: string | Buffer
) {
  const writeZoneTarget = createArtifactTarget(request, path.basename(absolutePath));
  if (writeZoneTarget.writeZone && writeZoneTarget.target.absolute === absolutePath) {
    writeZoneTarget.writeZone.writeFile(writeZoneTarget.target, content);
    return;
  }
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content);
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

function macBlocked(
  message: string,
  code: string
): { status: ToolResultStatus; content: Record<string, unknown> } {
  return {
    status: 'blocked',
    content: {
      success: false,
      error: { code, message },
    },
  };
}

function macExecError(err: unknown) {
  const error = err as { stderr?: unknown; stdout?: unknown; message?: unknown; code?: unknown };
  const stderr = typeof error.stderr === 'string' ? error.stderr : '';
  const stdout = typeof error.stdout === 'string' ? error.stdout : '';
  const message =
    extractHelperError(stderr || stdout) || stringOrDefault(error.message, 'macOS helper failed');
  const wrapped = new Error(message);
  (wrapped as { code?: unknown }).code = error.code;
  return wrapped;
}

function extractHelperError(value: string) {
  if (!value.trim()) {
    return '';
  }
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && typeof parsed.error === 'string') {
      return parsed.error;
    }
  } catch {
    return value.trim();
  }
  return value.trim();
}

function stringOrDefault(value: unknown, fallback: string) {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function envelopeForMacResult(
  request: ToolExecutionRequest,
  startedAt: Date,
  startedMs: number,
  status: ToolResultStatus,
  structuredContent: Record<string, unknown>,
  artifacts: ToolArtifactRef[] = []
): ToolResultEnvelope {
  const success = structuredContent.success !== false && status === 'success';
  const message =
    extractMessage(structuredContent) ||
    (success ? 'macOS capability completed.' : 'macOS capability failed.');
  return {
    ok: success,
    toolId: request.manifest.id,
    callId: request.context.callId,
    parentCallId: request.context.parentCallId,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedMs,
    status,
    text: message,
    structuredContent,
    artifacts: artifacts.length > 0 ? artifacts : undefined,
    diagnostics: {
      degraded: false,
      fallbackUsed: false,
      warnings: success
        ? []
        : [{ code: 'macos_adapter_error', message, tool: request.manifest.id }],
      timedOutStages: [],
      blockedTools: status === 'blocked' ? [{ tool: request.manifest.id, reason: message }] : [],
      truncatedToolCalls: 0,
      emptyResponses: 0,
      aiErrorCount: 0,
      gateFailures:
        status === 'blocked' ? [{ stage: 'execute', action: 'macos-policy', reason: message }] : [],
    },
    trust: {
      source: 'macos',
      sanitized: true,
      containsUntrustedText: request.manifest.externalTrust?.outputContainsUntrustedText ?? false,
      containsSecrets: Boolean(artifacts.length),
    },
  };
}

function extractMessage(content: Record<string, unknown>) {
  const error = content.error as { message?: unknown } | undefined;
  if (typeof error?.message === 'string') {
    return error.message;
  }
  if (typeof content.message === 'string') {
    return content.message;
  }
  return null;
}

export default MacSystemAdapter;
