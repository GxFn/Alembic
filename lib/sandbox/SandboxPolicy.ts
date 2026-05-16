import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type SandboxMode = 'enforce' | 'audit' | 'disabled';

export interface SandboxProfile {
  mode: SandboxMode;

  filesystem: {
    readPaths: string[];
    writePaths: string[];
    denyPaths: string[];
    tempDir: string;
  };

  network: {
    allow: boolean;
    proxyPort?: number;
    allowedDomains: string[];
  };

  environment: {
    passthrough: string[];
    inject: Record<string, string>;
    strip: string[];
  };

  limits: {
    timeoutMs: number;
    maxOutputBytes: number;
  };
}

export interface SandboxInput {
  network: 'none' | 'allowlisted' | 'open';
  filesystem: 'read-only' | 'project-write' | 'workspace-write';
  cwd: string;
  projectRoot: string;
  timeoutMs: number;
  maxOutputBytes?: number;
  env?: Record<string, string>;
}

const ENV_PASSTHROUGH = [
  'PATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'DEVELOPER_DIR',
  'SDKROOT',
  'MACOSX_DEPLOYMENT_TARGET',
  'SWIFT_DETERMINISTIC_HASHING',
  'NODE_PATH',
  'RUBY_VERSION',
  'GEM_HOME',
  'GEM_PATH',
  'GOPATH',
  'GOROOT',
  'JAVA_HOME',
  'ANDROID_HOME',
  'ANDROID_SDK_ROOT',
  'HOMEBREW_PREFIX',
  'HOMEBREW_CELLAR',
  'CI',
  'GIT_PAGER',
  'GIT_TERMINAL_PROMPT',
  'LESS',
  'PAGER',
];

const ENV_STRIP = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'DEEPSEEK_API_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GITLAB_TOKEN',
  'SSH_AUTH_SOCK',
  'SSH_AGENT_PID',
  'NPM_TOKEN',
  'YARN_TOKEN',
  'DOCKER_HOST',
  'KUBECONFIG',
  'DATABASE_URL',
  'REDIS_URL',
  'ALEMBIC_AI_API_KEY',
];

const DISABLED_PROFILE: SandboxProfile = {
  mode: 'disabled',
  filesystem: { readPaths: [], writePaths: [], denyPaths: [], tempDir: '' },
  network: { allow: true, allowedDomains: [] },
  environment: { passthrough: [], inject: {}, strip: [] },
  limits: { timeoutMs: 30_000, maxOutputBytes: 1_048_576 },
};

export function getSandboxMode(): SandboxMode {
  const v = process.env.ALEMBIC_SANDBOX_MODE?.trim().toLowerCase();
  if (v === 'disabled' || v === '0' || v === 'off') {
    return 'disabled';
  }
  if (v === 'audit') {
    return 'audit';
  }
  return 'enforce';
}

export function getConfiguredAllowedDomains(): string[] {
  const v = process.env.ALEMBIC_SANDBOX_ALLOWED_DOMAINS?.trim();
  if (!v) {
    return [];
  }
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function getExtraReadPaths(): string[] {
  const v = process.env.ALEMBIC_SANDBOX_EXTRA_READ_PATHS?.trim();
  if (!v) {
    return [];
  }
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function homebrewPaths(): string[] {
  const prefix = process.env.HOMEBREW_PREFIX;
  if (prefix) {
    return [prefix];
  }
  return ['/opt/homebrew', '/usr/local'];
}

function safeRealpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function realTmpdir(): string {
  try {
    return fs.realpathSync(os.tmpdir());
  } catch {
    return os.tmpdir();
  }
}

function buildSandboxTempDir(): string {
  return path.join(
    realTmpdir(),
    `alembic-sandbox-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
}

/**
 * 从 terminal policy 的声明式意图构建 OS 级沙箱策略。
 *
 * 映射规则:
 *   network: 'none'        → 阻断所有出站
 *   network: 'allowlisted'  → 启动代理，仅放行配置域名
 *   network: 'open'        → 放行所有（当前 policy 层已拒绝此值）
 *
 *   filesystem: 'read-only'       → 仅 readPaths + tmpdir 可写
 *   filesystem: 'project-write'   → 追加 projectRoot 可写
 *   filesystem: 'workspace-write' → 追加 projectRoot 可写（当前 policy 层已拒绝此值）
 */
export function buildSandboxProfile(input: SandboxInput): SandboxProfile {
  const globalMode = getSandboxMode();
  if (globalMode === 'disabled') {
    return DISABLED_PROFILE;
  }

  const tempDir = buildSandboxTempDir();
  const home = process.env.HOME || '/tmp';
  const projectRoot = safeRealpath(input.projectRoot);

  const readPaths = [
    projectRoot,
    '/usr/lib',
    '/usr/bin',
    '/usr/share',
    '/Library/Frameworks',
    '/System/Library',
    '/Applications/Xcode.app',
    '/bin',
    '/sbin',
    '/private/tmp',
    '/private/var/folders',
    '/etc',
    '/dev',
    '/var/run',
    `${home}/Library/Developer`,
    ...homebrewPaths(),
    ...getExtraReadPaths(),
  ].filter(Boolean);

  const writePaths = [tempDir];
  if (input.filesystem === 'project-write' || input.filesystem === 'workspace-write') {
    writePaths.push(projectRoot);
  }

  const denyPaths = [
    `${home}/.ssh`,
    `${home}/.gnupg`,
    `${home}/.aws`,
    `${home}/.config/gh`,
    `${projectRoot}/.env`,
    `${projectRoot}/.git`,
  ];

  const networkAllow = input.network !== 'none';
  const allowedDomains = input.network === 'allowlisted' ? getConfiguredAllowedDomains() : [];
  const needsProxy = networkAllow && allowedDomains.length > 0;

  return {
    mode: globalMode,
    filesystem: { readPaths, writePaths, denyPaths, tempDir },
    network: {
      allow: networkAllow,
      allowedDomains,
      proxyPort: needsProxy ? -1 : undefined, // -1 = SandboxExecutor 需动态分配
    },
    environment: {
      passthrough: ENV_PASSTHROUGH,
      inject: {
        HOME: tempDir,
        TMPDIR: tempDir,
        SANDBOX: '1',
        ...(input.env ?? {}),
      },
      strip: ENV_STRIP,
    },
    limits: {
      timeoutMs: input.timeoutMs,
      maxOutputBytes: input.maxOutputBytes ?? 1_048_576,
    },
  };
}

/** 沙箱配置摘要 — 用于审计日志 */
export function summarizeSandboxProfile(profile: SandboxProfile): Record<string, unknown> {
  return {
    mode: profile.mode,
    networkAllow: profile.network.allow,
    networkDomains: profile.network.allowedDomains.length,
    filesystemWritePaths: profile.filesystem.writePaths.length,
    filesystemDenyPaths: profile.filesystem.denyPaths.length,
    envStripped: profile.environment.strip.length,
    envPassthrough: profile.environment.passthrough.length,
  };
}
