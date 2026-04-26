import { Policy, type StepState } from './Policy.js';

export class BudgetPolicy extends Policy {
  #maxIterations;
  #maxTokens;
  #timeoutMs;
  #temperature;

  constructor({
    maxIterations = 20,
    maxTokens = 4096,
    timeoutMs = 300_000,
    temperature = 0.7,
  } = {}) {
    super();
    this.#maxIterations = maxIterations;
    this.#maxTokens = maxTokens;
    this.#timeoutMs = timeoutMs;
    this.#temperature = temperature;
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
      },
    };
  }
}
