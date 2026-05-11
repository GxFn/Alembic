import type { AgentMessage } from '../runtime/AgentMessage.js';

export interface StrategyResult {
  reply: string;
  toolCalls: Array<Record<string, unknown>>;
  tokenUsage: { input: number; output: number };
  iterations: number;
  [key: string]: unknown;
}

export interface StrategyRuntime {
  id: string;
  reactLoop(prompt: string, opts?: Record<string, unknown>): Promise<StrategyResult>;
}

export interface FanOutItem {
  id: string;
  label: string;
  tier?: number;
  prompt?: string;
  guide?: string;
}

export interface ItemResult {
  id: string;
  label: string;
  status: 'completed' | 'failed';
  reply: string;
  toolCalls: Array<Record<string, unknown>>;
  tokenUsage: { input: number; output: number };
  iterations?: number;
  error?: string;
  [key: string]: unknown;
}

export class Strategy {
  get name(): string {
    throw new Error('Subclass must implement name');
  }

  async execute(
    _runtime: StrategyRuntime,
    _message: AgentMessage,
    _opts?: Record<string, unknown>
  ): Promise<StrategyResult> {
    throw new Error('Subclass must implement execute()');
  }
}
