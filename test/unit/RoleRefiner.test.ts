import { describe, it } from 'vitest';

describe.skip('legacy Core panorama RoleRefiner tests', () => {
  it('moved with Core project-intelligence internals', () => {
    // RoleRefiner is private to Core's panorama implementation after the public
    // facade cleanup, so Alembic CI must not import it directly.
  });
});
