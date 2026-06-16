import { describe, it } from 'vitest';

describe.skip('legacy Core project analysis materialization tests', () => {
  it('moved with Core project-intelligence internals', () => {
    // Materialization-phase helpers are not part of the Alembic consumer package
    // surface anymore. Alembic keeps ProjectScope adapter tests locally and lets
    // AlembicCore own direct materialization helper coverage.
  });
});
