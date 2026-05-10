export interface MainlineDatabaseHealth {
  available: boolean;
  driver: string;
  path?: string;
  reason?: string;
}

export interface MainlineDatabaseStatement<Row = Record<string, unknown>> {
  all(...params: readonly unknown[]): Promise<Row[]>;
  get(...params: readonly unknown[]): Promise<Row | null>;
  run(...params: readonly unknown[]): Promise<{ changes: number }>;
}

export interface MainlineDatabasePort {
  health(): MainlineDatabaseHealth;
  prepare<Row = Record<string, unknown>>(sql: string): MainlineDatabaseStatement<Row>;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
}

export class UnavailableMainlineDatabase implements MainlineDatabasePort {
  readonly #reason: string;

  constructor(reason = "Mainline database adapter is not configured.") {
    this.#reason = reason;
  }

  health(): MainlineDatabaseHealth {
    return { available: false, driver: "unavailable", reason: this.#reason };
  }

  prepare<Row = Record<string, unknown>>(_sql: string): MainlineDatabaseStatement<Row> {
    throw new Error(this.#reason);
  }

  async transaction<T>(_fn: () => Promise<T>): Promise<T> {
    throw new Error(this.#reason);
  }
}
