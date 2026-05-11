export { AdaptiveStrategy } from './AdaptiveStrategy.js';
export { FanOutStrategy } from './FanOutStrategy.js';
export { SingleStrategy } from './SingleStrategy.js';
export {
  type FanOutItem,
  type ItemResult,
  Strategy,
  type StrategyResult,
  type StrategyRuntime,
} from './Strategy.js';
export { StrategyRegistry } from './StrategyRegistry.js';

import { AdaptiveStrategy } from './AdaptiveStrategy.js';
import { FanOutStrategy } from './FanOutStrategy.js';
import { SingleStrategy } from './SingleStrategy.js';
import { Strategy } from './Strategy.js';
import { StrategyRegistry } from './StrategyRegistry.js';

export default { Strategy, SingleStrategy, FanOutStrategy, AdaptiveStrategy, StrategyRegistry };
