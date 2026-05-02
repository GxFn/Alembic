/**
 * 解析 macOS Seatbelt sandbox violation 信息。
 *
 * 当 sandbox-exec 拒绝操作时，stderr 中会包含如下格式:
 *   sandbox: <process>(pid) deny(1) file-write-create /path/to/file
 *   sandbox: <process>(pid) deny(1) network-outbound ...
 *
 * 本模块从 stderr 中提取这些 violation 记录，用于审计和调试。
 */

export interface SandboxViolation {
  process: string;
  pid: number;
  operation: string;
  path?: string;
  raw: string;
}

const VIOLATION_RE = /^sandbox:\s+(\S+)\((\d+)\)\s+deny\(\d+\)\s+(\S+)(?:\s+(.+))?$/gm;

export function parseSandboxViolations(stderr: string): SandboxViolation[] {
  const violations: SandboxViolation[] = [];
  let match: RegExpExecArray | null;

  while ((match = VIOLATION_RE.exec(stderr)) !== null) {
    violations.push({
      process: match[1],
      pid: Number.parseInt(match[2], 10),
      operation: match[3],
      path: match[4]?.trim() || undefined,
      raw: match[0],
    });
  }

  return violations;
}

/** 摘要化 violation 列表，用于审计日志 */
export function summarizeViolations(violations: SandboxViolation[]): {
  count: number;
  operations: Record<string, number>;
  paths: string[];
} {
  const operations: Record<string, number> = {};
  const paths: string[] = [];

  for (const v of violations) {
    operations[v.operation] = (operations[v.operation] || 0) + 1;
    if (v.path && paths.length < 10) {
      paths.push(v.path);
    }
  }

  return { count: violations.length, operations, paths };
}
