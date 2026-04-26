import path from 'node:path';
import { Policy, type PolicyContext } from './Policy.js';

export interface SafetyPolicyOptions {
  fileScope?: string;
  allowedSenders?: string[];
  commandBlacklist?: RegExp[];
  requireApprovalFor?: string[];
}

export class SafetyPolicy extends Policy {
  static DANGEROUS_COMMANDS = Object.freeze([
    /\brm\s+-rf\s+[/~]/,
    /\bsudo\b/,
    /\bmkfs\b/,
    /\bdd\s+if=/,
    /\b(shutdown|reboot|halt)\b/,
    />\s*\/dev\//,
    /\bcurl\b.*\|\s*(bash|sh)/,
    /\bchmod\s+777/,
    /\bpasswd\b/,
    /\bkillall\b/,
  ]);

  static SAFE_COMMANDS = Object.freeze([
    'ls',
    'cat',
    'head',
    'tail',
    'grep',
    'find',
    'wc',
    'echo',
    'pwd',
    'date',
    'which',
    'file',
    'stat',
    'git log',
    'git status',
    'git diff',
    'git branch',
    'npm list',
    'npm outdated',
    'node -v',
    'npm -v',
  ]);

  #fileScope;
  #allowedSenders;
  #commandBlacklist;
  #requireApprovalFor;

  constructor({
    fileScope,
    allowedSenders = [],
    commandBlacklist = [],
    requireApprovalFor = [],
  }: SafetyPolicyOptions = {}) {
    super();
    this.#fileScope = fileScope || null;
    this.#allowedSenders = allowedSenders;
    this.#commandBlacklist = [...SafetyPolicy.DANGEROUS_COMMANDS, ...commandBlacklist];
    this.#requireApprovalFor = requireApprovalFor;
  }

  get name() {
    return 'safety';
  }

  validateBefore(context: PolicyContext) {
    if (this.#allowedSenders.length > 0) {
      const senderId = context.message?.sender?.id;
      if (!senderId || !this.#allowedSenders.includes(senderId)) {
        return { ok: false, reason: `Safety: sender "${senderId}" not in allowlist` };
      }
    }
    return { ok: true };
  }

  checkCommand(command: string) {
    for (const pattern of this.#commandBlacklist) {
      if (pattern.test(command)) {
        return { safe: false, reason: `Blocked: matches dangerous pattern ${pattern}` };
      }
    }
    return { safe: true };
  }

  checkFilePath(filePath: string) {
    if (!this.#fileScope) {
      return { safe: true };
    }
    if (!isWithinPathScope(filePath, this.#fileScope)) {
      return {
        safe: false,
        reason: `File path "${filePath}" outside allowed scope "${this.#fileScope}"`,
      };
    }
    return { safe: true };
  }

  needsApproval(toolName: string) {
    return this.#requireApprovalFor.includes(toolName);
  }

  applyToConfig(config: Record<string, unknown>): Record<string, unknown> {
    return {
      ...config,
      safetyPolicy: this,
    };
  }
}

function isWithinPathScope(filePath: string, scopePath: string) {
  const resolved = path.resolve(filePath);
  const scope = path.resolve(scopePath);
  const relative = path.relative(scope, resolved);
  return (
    relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative))
  );
}
