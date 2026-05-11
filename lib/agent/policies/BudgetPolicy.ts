import { Policy, type StepState } from './Policy.js';

export interface BudgetPolicyConfig {
  maxIterations?: number;
  maxTokens?: number;
  timeoutMs?: number;
  temperature?: number;
  /** Session-level cumulative token budget (input + output). undefined = unlimited. */
  maxSessionTokens?: number;
  /** Session-level cumulative input token budget. undefined = unlimited. */
  maxSessionInputTokens?: number;
}

export class BudgetPolicy extends Policy {
  #maxIterations;
  #maxTokens;
  #timeoutMs;
  #temperature;
  #maxSessionTokens;
  #maxSessionInputTokens;

  constructor({
    maxIterations = 20,
    maxTokens = 4096,
    timeoutMs = 300_000,
    temperature = 0.7,
    maxSessionTokens,
    maxSessionInputTokens,
  }: BudgetPolicyConfig = {}) {
    super();
    this.#maxIterations = maxIterations;
    this.#maxTokens = maxTokens;
    this.#timeoutMs = timeoutMs;
    this.#temperature = temperature;
    this.#maxSessionTokens = maxSessionTokens;
    this.#maxSessionInputTokens = maxSessionInputTokens;
  }

  get name() {
    return 'budget';
  }

  get maxIterations() {
    return this.#maxIterations;
  }

  get maxTokens() {
    return this.#maxTokens;
  }

  get timeoutMs() {
    return this.#timeoutMs;
  }

  get temperature() {
    return this.#temperature;
  }

  get maxSessionTokens() {
    return this.#maxSessionTokens;
  }

  get maxSessionInputTokens() {
    return this.#maxSessionInputTokens;
  }

  validateDuring(stepState: StepState) {
    if (stepState.iteration >= this.#maxIterations) {
      return {
        ok: false,
        action: 'stop',
        reason: `Budget: max iterations (${this.#maxIterations}) reached`,
      };
    }
    if (Date.now() - stepState.startTime > this.#timeoutMs) {
      return {
        ok: false,
        action: 'stop',
        reason: `Budget: timeout (${this.#timeoutMs}ms) exceeded`,
      };
    }

    const totalTokens = stepState.totalTokens as number | undefined;
    if (this.#maxSessionTokens && totalTokens && totalTokens >= this.#maxSessionTokens) {
      return {
        ok: false,
        action: 'stop',
        reason: `Budget: session token limit (${this.#maxSessionTokens}) reached — used ${totalTokens}`,
      };
    }

    const totalInputTokens = stepState.totalInputTokens as number | undefined;
    if (
      this.#maxSessionInputTokens &&
      totalInputTokens &&
      totalInputTokens >= this.#maxSessionInputTokens
    ) {
      return {
        ok: false,
        action: 'stop',
        reason: `Budget: session input token limit (${this.#maxSessionInputTokens}) reached — used ${totalInputTokens}`,
      };
    }

    return { ok: true, action: 'continue' };
  }

  applyToConfig(config: Record<string, unknown>) {
    return {
      ...config,
      budget: {
        maxIterations: this.#maxIterations,
        maxTokens: this.#maxTokens,
        timeoutMs: this.#timeoutMs,
        temperature: this.#temperature,
        maxSessionTokens: this.#maxSessionTokens,
        maxSessionInputTokens: this.#maxSessionInputTokens,
      },
    };
  }
}
