export type MainlineWorkflowKind = "bootstrap" | "rescan";
export type MainlineWorkflowStatus = "completed" | "cancelled" | "failed";

export type MainlineWorkflowPhaseId =
  | "normalize"
  | "plan"
  | "track"
  | "scan"
  | "read-files"
  | "build-project-intelligence"
  | "materialize-project-intelligence"
  | "save-artifact"
  | "compile-session"
  | "project"
  | "persist"
  | "recommend";

export interface MainlineWorkflowCancellationToken {
  isCancelled(): boolean | Promise<boolean>;
}

export interface MainlineWorkflowPhaseRecord {
  readonly id: MainlineWorkflowPhaseId;
  readonly status: "completed" | "cancelled" | "failed";
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly error?: string;
}

export class MainlineWorkflowCancelledError extends Error {
  constructor(readonly phase: MainlineWorkflowPhaseId) {
    super(`Mainline workflow cancelled before ${phase}.`);
  }
}

export class ScanWorkflowKernel {
  readonly #phases: MainlineWorkflowPhaseRecord[] = [];
  readonly #cancellation: MainlineWorkflowCancellationToken | undefined;
  readonly #now: () => Date;

  constructor(
    options: {
      readonly cancellation?: MainlineWorkflowCancellationToken;
      readonly now?: () => Date;
    } = {},
  ) {
    this.#cancellation = options.cancellation;
    this.#now = options.now ?? (() => new Date());
  }

  get phases(): readonly MainlineWorkflowPhaseRecord[] {
    return [...this.#phases];
  }

  async runPhase<T>(id: MainlineWorkflowPhaseId, operation: () => Promise<T>): Promise<T> {
    await this.throwIfCancelled(id);
    const startedAt = this.#timestamp();
    try {
      const result = await operation();
      // 中文注释：每个可写 finalizer 阶段完成后也检查取消，避免用户取消后继续写下游副作用。
      await this.throwIfCancelled(id);
      this.#phases.push({ id, status: "completed", startedAt, finishedAt: this.#timestamp() });
      return result;
    } catch (error) {
      if (error instanceof MainlineWorkflowCancelledError) {
        this.#phases.push({ id, status: "cancelled", startedAt, finishedAt: this.#timestamp() });
        throw error;
      }
      this.#phases.push({
        id,
        status: "failed",
        startedAt,
        finishedAt: this.#timestamp(),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async throwIfCancelled(phase: MainlineWorkflowPhaseId): Promise<void> {
    if ((await this.#cancellation?.isCancelled()) === true) {
      throw new MainlineWorkflowCancelledError(phase);
    }
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }
}
