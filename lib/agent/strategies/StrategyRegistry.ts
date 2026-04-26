import { AdaptiveStrategy } from './AdaptiveStrategy.js';
import { FanOutStrategy } from './FanOutStrategy.js';
import { SingleStrategy } from './SingleStrategy.js';
import type { Strategy } from './Strategy.js';

export const StrategyRegistry = {
  _registry: new Map<string, typeof Strategy>([
    ['single', SingleStrategy],
    // 'pipeline' registers itself from PipelineStrategy.js to avoid circular imports.
    ['fan_out', FanOutStrategy],
    ['adaptive', AdaptiveStrategy],
  ]),

  create(name: string, opts: Record<string, unknown> = {}): Strategy {
    const Cls = this._registry.get(name);
    if (!Cls) {
      throw new Error(`Unknown strategy: ${name}`);
    }
    return Reflect.construct(Cls, [opts]) as Strategy;
  },

  register(name: string, cls: typeof Strategy): void {
    this._registry.set(name, cls);
  },
};
