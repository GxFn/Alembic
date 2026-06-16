import { describe, it } from 'vitest';

describe.skip('legacy Core panorama CouplingAnalyzer tests', () => {
  it('moved with Core project-intelligence internals', () => {
    // Core retired the old project-intelligence facade from the Alembic
    // consumer surface. These implementation-level assertions now belong in
    // AlembicCore; this Alembic suite keeps the skip explicit so CI does not
    // reintroduce private Core imports.
  });
});
