import type { AgentMessage } from '../runtime/AgentMessage.js';
import { Strategy, type StrategyRuntime } from './Strategy.js';

export class SingleStrategy extends Strategy {
  get name() {
    return 'single';
  }

  async execute(
    runtime: StrategyRuntime,
    message: AgentMessage,
    opts: Record<string, unknown> = {}
  ) {
    return runtime.reactLoop(message.content, {
      history: message.history,
      context: message.metadata.context || {},
      ...opts,
    });
  }
}
