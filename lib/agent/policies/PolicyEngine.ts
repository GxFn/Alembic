import { BudgetPolicy } from './BudgetPolicy.js';
import type { Policy, PolicyContext, PolicyResult, StepState } from './Policy.js';
import { SafetyPolicy } from './SafetyPolicy.js';

export class PolicyEngine {
  #policies;

  constructor(policies: Policy[] = []) {
    this.#policies = policies;
  }

  get policies() {
    return [...this.#policies];
  }

  get<T extends Policy>(PolicyClass: abstract new (...args: never[]) => T): T | null {
    return this.#policies.find((p): p is T => p instanceof PolicyClass) ?? null;
  }

  validateBefore(context: PolicyContext) {
    for (const policy of this.#policies) {
      const result = policy.validateBefore(context);
      if (!result.ok) {
        return result;
      }
    }
    return { ok: true };
  }

  validateDuring(stepState: StepState) {
    for (const policy of this.#policies) {
      const result = policy.validateDuring(stepState);
      if (!result.ok) {
        return result;
      }
    }
    return { ok: true, action: 'continue' };
  }

  validateAfter(result: PolicyResult) {
    for (const policy of this.#policies) {
      const val = policy.validateAfter(result);
      if (!val.ok) {
        return val;
      }
    }
    return { ok: true };
  }

  applyToConfig(config: Record<string, unknown>) {
    let result = config;
    for (const policy of this.#policies) {
      result = policy.applyToConfig(result);
    }
    return result;
  }

  getBudget() {
    const bp = this.get(BudgetPolicy);
    return bp
      ? {
          maxIterations: bp.maxIterations,
          maxTokens: bp.maxTokens,
          timeoutMs: bp.timeoutMs,
          temperature: bp.temperature,
          maxSessionInputTokens: bp.maxSessionInputTokens,
          maxSessionTokens: bp.maxSessionTokens,
        }
      : null;
  }

  validateToolCall(toolName: string, args: Record<string, unknown>) {
    const safety = this.get(SafetyPolicy);
    if (!safety) {
      return { ok: true };
    }

    if (toolName === 'terminal' && typeof args?.bin === 'string') {
      const check = safety.checkCommand(formatTerminalRunForSafetyPolicy(args));
      if (!check.safe) {
        return { ok: false, reason: `[SafetyPolicy] 命令拦截: ${check.reason}` };
      }
    }

    if (toolName === 'write_project_file' && args?.filePath) {
      const check = safety.checkFilePath(args.filePath as string);
      if (!check.safe) {
        return { ok: false, reason: `[SafetyPolicy] 路径拦截: ${check.reason}` };
      }
    }

    const filePathsToCheck: string[] = [];
    if (toolName === 'code') {
      const p = (args?.params || args) as Record<string, unknown>;
      if (typeof p?.path === 'string') {
        filePathsToCheck.push(p.path);
      }
      if (typeof p?.filePath === 'string') {
        filePathsToCheck.push(p.filePath);
      }
      if (Array.isArray(p?.filePaths)) {
        filePathsToCheck.push(
          ...(p.filePaths as unknown[]).filter(
            (filePath): filePath is string => typeof filePath === 'string'
          )
        );
      }
    }

    for (const filePath of filePathsToCheck) {
      const check = safety.checkFilePath(filePath);
      if (!check.safe) {
        return { ok: false, reason: `[SafetyPolicy] 路径拦截: ${check.reason}` };
      }
    }

    if (safety.needsApproval(toolName)) {
      return { ok: false, reason: `[SafetyPolicy] 工具 "${toolName}" 需要人工确认` };
    }

    return { ok: true };
  }
}

function formatTerminalRunForSafetyPolicy(args: Record<string, unknown>) {
  const commandArgs = Array.isArray(args.args)
    ? args.args.filter((arg): arg is string => typeof arg === 'string')
    : [];
  return [args.bin as string, ...commandArgs].join(' ');
}
