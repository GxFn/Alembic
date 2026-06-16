import { describe, it } from 'vitest';

describe.skip('legacy Core panorama ModuleDiscoverer tests', () => {
  it('moved with Core project-intelligence internals', () => {
    // ModuleDiscoverer is no longer an Alembic consumer import. Core owns this
    // internal panorama implementation and its direct unit coverage.
  });
});
