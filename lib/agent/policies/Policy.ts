export interface PolicyContext {
  message?: {
    sender?: {
      id?: string;
    };
  };
  [key: string]: unknown;
}

export interface StepState {
  iteration: number;
  startTime: number;
  [key: string]: unknown;
}

export interface PolicyResult {
  reply?: string;
  toolCalls?: unknown[];
  [key: string]: unknown;
}

export class Policy {
  get name(): string {
    throw new Error('Subclass must implement name');
  }

  validateBefore(_context: PolicyContext): { ok: boolean; reason?: string } {
    return { ok: true };
  }

  validateDuring(_stepState: StepState): { ok: boolean; action?: string; reason?: string } {
    return { ok: true, action: 'continue' };
  }

  validateAfter(_result: PolicyResult): { ok: boolean; reason?: string } {
    return { ok: true };
  }

  applyToConfig(config: Record<string, unknown>): Record<string, unknown> {
    return config;
  }
}
