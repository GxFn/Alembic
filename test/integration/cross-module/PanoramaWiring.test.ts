/**
 * Panorama compatibility wiring smoke test.
 *
 * The legacy project-intelligence services moved out of the Alembic consumer
 * surface. PanoramaModule remains importable as a compatibility target, but it
 * must not re-register retired internal services.
 */
import { describe, expect, it } from 'vitest';
import { PanoramaModule } from '../../../lib/injection/modules/PanoramaModule.js';
import { ServiceContainer } from '../../../lib/injection/ServiceContainer.js';

describe('PanoramaModule DI compatibility', () => {
  const retiredServices = ['roleRefiner', 'couplingAnalyzer', 'layerInferrer', 'panoramaService'];

  it('keeps the compatibility module importable', () => {
    expect(PanoramaModule).toBeDefined();
    expect(typeof PanoramaModule.register).toBe('function');
  });

  it('does not register retired project-intelligence services', () => {
    const container = new ServiceContainer();

    expect(() => PanoramaModule.register(container)).not.toThrow();

    for (const serviceName of retiredServices) {
      expect(() => container.get(serviceName)).toThrow(`Service '${serviceName}' not found`);
    }
  });
});
