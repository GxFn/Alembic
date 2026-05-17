/**
 * Skill hook system type definitions.
 */

/** Hook execution mode, inspired by Tapable and reduced to core semantics. */
export type HookMode =
  /** Execute handlers in priority order and ignore return values. */
  | 'series'
  /** Execute handlers with Promise.allSettled style fire-and-forget semantics. */
  | 'parallel'
  /** Pass each handler return value as the next handler's first argument. */
  | 'waterfall'
  /** Stop after the first truthy return value, including { block: true }. */
  | 'bail';

export interface HookDefinition {
  name: string;
  mode: HookMode;
  description: string;
}

export interface HookHandlerOptions {
  name: string;
  priority?: number;
  timeout?: number;
}

export interface RegisteredHandler {
  fn: (...args: unknown[]) => Promise<unknown> | unknown;
  name: string;
  priority: number;
  timeout: number;
}
