/**
 * Compatibility exports for the external cold-start path.
 *
 * The workflow implementation lives in `#workflows/cold-start/external`.
 */

export {
  getActiveSession,
  runExternalColdStartWorkflow as bootstrapExternal,
} from '#workflows/cold-start/external/ExternalColdStartWorkflow.js';
