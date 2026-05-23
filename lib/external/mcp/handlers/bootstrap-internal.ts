/**
 * Compatibility alias for the resident cold-start handler surface.
 *
 * New Alembic-owned consumers should import from resident/tool-handlers.
 */

export {
  bootstrapKnowledge,
  bootstrapRefine,
} from '../../../resident/tool-handlers/bootstrap-internal.js';
