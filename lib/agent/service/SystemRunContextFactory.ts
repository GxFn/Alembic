import type { AiProvider } from '#external/ai/AiProvider.js';
import { ContextWindow } from '../context/ContextWindow.js';
import { ExplorationTracker } from '../context/ExplorationTracker.js';
import {
  createSystemRunContext,
  projectSystemRunContext,
  type SystemRunContext,
} from '../core/SystemRunContext.js';
import { MemoryCoordinator } from '../memory/MemoryCoordinator.js';

export interface BuildSystemContextOptions {
  budget?: Record<string, unknown>;
  trackerStrategy?: string;
  label?: string;
  lang?: string;
}

export interface SystemRunContextFactoryOptions {
  aiProvider?: Pick<AiProvider, 'model'> | null;
}

export class SystemRunContextFactory {
  #aiProvider: Pick<AiProvider, 'model'> | null;

  constructor({ aiProvider = null }: SystemRunContextFactoryOptions = {}) {
    this.#aiProvider = aiProvider;
  }

  createContextWindow(opts: { isSystem?: boolean } = {}) {
    const modelName = this.#aiProvider?.model || '';
    const tokenBudget = ContextWindow.resolveTokenBudget(modelName, opts);
    return new ContextWindow(tokenBudget);
  }

  createSystemContext({
    budget,
    trackerStrategy = 'analyst',
    label = 'default',
    lang,
  }: BuildSystemContextOptions = {}) {
    const memoryCoordinator = new MemoryCoordinator({ mode: 'bootstrap' });
    const scopeId = `scan:${label}`;
    const activeContext = memoryCoordinator.createDimensionScope(scopeId);
    const systemRunContext = createSystemRunContext({
      memoryCoordinator,
      scopeId,
      activeContext,
      contextWindow: this.createContextWindow({ isSystem: true }),
      tracker: ExplorationTracker.resolve(
        { source: 'system', strategy: trackerStrategy },
        budget || {}
      ),
      source: 'system',
      outputType: 'candidate',
      dimId: label,
      projectLanguage: lang || null,
      sharedState: {
        submittedTitles: new Set(),
        submittedPatterns: new Set(),
      },
    });

    return projectSystemRunContext(systemRunContext);
  }

  project(systemRunContext: SystemRunContext) {
    return projectSystemRunContext(systemRunContext);
  }
}

export default SystemRunContextFactory;
