/**
 * Compatibility exports for the external cold-start path.
 *
 * The workflow implementation lives in the outer cold-start adapter.
 */

export {
  getActiveSession,
  runExternalColdStartWorkflow as bootstrapExternal,
} from '../../../workflows/cold-start/external/ExternalColdStartWorkflow.js';
