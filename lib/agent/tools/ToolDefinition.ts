import type { CapabilityLifecycle, ToolRiskProfile } from './CapabilityManifest.js';

export type ToolSurface = 'runtime' | 'http' | 'mcp' | 'dashboard';
export type ToolPolicyProfile = 'read' | 'analysis' | 'write' | 'system' | 'admin';
export type ToolAuditLevel = 'none' | 'checkOnly' | 'full';
export type ToolAbortMode = 'none' | 'preStart' | 'cooperative' | 'hardTimeout';

export interface ToolMetadata {
  /** Manifest owner; defaults to core for built-in internal tools. */
  owner?: string;
  /** Manifest lifecycle; disabled capabilities remain registered but hidden from list projections. */
  lifecycle?: CapabilityLifecycle;
  /** 能力暴露面；最终执行暴露以 CapabilityManifest.surfaces 为准。 */
  surface?: ToolSurface[];
  /** Legacy projection input; do not read from ToolRegistry at runtime. */
  directCallable?: boolean;
  /** 工具是否会写入状态、执行命令或触发外部副作用。 */
  sideEffect?: boolean;
  /** 是否允许作为 DynamicComposer 等组合工具的内部步骤。 */
  composable?: boolean;
  /** 映射到 Gateway 的动作名。 */
  gatewayAction?: string;
  /** Gateway 权限检查使用的资源名或路径。 */
  gatewayResource?: string;
  /** 权限与安全策略画像，用于 manifest 投影。 */
  policyProfile?: ToolPolicyProfile;
  /** HTTP/MCP 入口的审计强度。 */
  auditLevel?: ToolAuditLevel;
  /** 中止信号支持方式。 */
  abortMode?: ToolAbortMode;
  /** Manifest risk overrides. sideEffect is derived separately and cannot be weakened here. */
  risk?: Partial<Omit<ToolRiskProfile, 'sideEffect'>>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  metadata?: ToolMetadata;
  handler: (...args: never[]) => unknown;
}
