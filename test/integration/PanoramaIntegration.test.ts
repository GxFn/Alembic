import { describe, it } from 'vitest';

describe.skip('legacy Core panorama integration pipeline', () => {
  it('moved with Core project-intelligence internals', () => {
    // The end-to-end Panorama pipeline here assembled private Core classes.
    // Core now owns that implementation boundary; Alembic validates public Core
    // consumption and host wiring instead.
  });
});
