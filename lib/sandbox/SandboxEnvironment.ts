import type { SandboxProfile } from './SandboxPolicy.js';

/**
 * 构建沙箱净化环境变量。
 *
 * 流程:
 *   1. 仅从宿主 process.env 中透传白名单 key
 *   2. 合并命令级自定义 env
 *   3. 注入沙箱标识（HOME→tempDir, SANDBOX=1 等）
 *   4. 最终移除敏感 key（strip 列表，防止 commandEnv 传入）
 */
export function buildSandboxEnvironment(
  commandEnv: Record<string, string>,
  profile: SandboxProfile
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const key of profile.environment.passthrough) {
    const v = process.env[key];
    if (v !== undefined) {
      result[key] = v;
    }
  }

  Object.assign(result, commandEnv);
  Object.assign(result, profile.environment.inject);

  for (const key of profile.environment.strip) {
    delete result[key];
  }

  return result;
}

/**
 * 兼容层：沙箱 disabled 时保持原有 buildTerminalEnvironment 行为（透传全部宿主 env），
 * 沙箱 enabled 时走净化路径。
 */
export function buildTerminalEnvironmentWithSandbox(
  hostEnv: NodeJS.ProcessEnv,
  commandEnv: Record<string, string>,
  profile: SandboxProfile | null
): NodeJS.ProcessEnv {
  if (!profile || profile.mode === 'disabled') {
    return {
      ...hostEnv,
      ...commandEnv,
      CI: '1',
      GIT_PAGER: 'cat',
      GIT_TERMINAL_PROMPT: '0',
      LESS: '-FRX',
      PAGER: 'cat',
    };
  }
  return buildSandboxEnvironment(commandEnv, profile) as NodeJS.ProcessEnv;
}
