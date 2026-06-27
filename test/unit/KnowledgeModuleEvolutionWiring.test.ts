import { describe, expect, it, vi } from 'vitest';

const evolutionMock = vi.hoisted(() => {
  const decayDetectorOptions: unknown[] = [];
  return {
    DecayDetector: vi.fn(function MockDecayDetector(_knowledgeRepo: unknown, options: unknown) {
      decayDetectorOptions.push(options);
      return { scanAll: vi.fn() };
    }),
    decayDetectorOptions,
  };
});

vi.mock('@alembic/core/evolution', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@alembic/core/evolution')>();
  return {
    ...actual,
    DecayDetector: evolutionMock.DecayDetector,
  };
});

import * as KnowledgeModule from '../../lib/injection/modules/KnowledgeModule.js';

describe('KnowledgeModule evolution wiring', () => {
  it('injects lifecycleStateMachine into DecayDetector options', () => {
    const container = new FakeContainer();
    KnowledgeModule.register(container as never);

    const lifecycleStateMachine = { transition: vi.fn() };
    container.services.knowledgeRepository = () => ({});
    container.services.lifecycleStateMachine = () => lifecycleStateMachine;
    container.services.database = () => ({ getDrizzle: () => ({}) });

    container.get('decayDetector');

    expect(evolutionMock.DecayDetector).toHaveBeenCalledTimes(1);
    expect(evolutionMock.decayDetectorOptions[0]).toMatchObject({
      lifecycleStateMachine,
    });
  });
});

class FakeContainer {
  services: Record<string, () => unknown> = {};
  singletons: Record<string, unknown> = {};

  singleton(name: string, factory: (container: FakeContainer) => unknown): void {
    this.register(name, () => {
      if (!(name in this.singletons)) {
        this.singletons[name] = factory(this);
      }
      return this.singletons[name];
    });
  }

  register(name: string, factory: () => unknown): void {
    this.services[name] = factory;
  }

  get(name: string): unknown {
    const factory = this.services[name];
    if (!factory) {
      throw new Error(`missing service ${name}`);
    }
    return factory();
  }
}
