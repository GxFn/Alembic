import type { TerminalSessionManager } from '#tools/adapters/TerminalSessionManager.js';
import type { ToolExecutionRequest } from '#tools/core/ToolContracts.js';
import type { ToolResultEnvelope } from '#tools/core/ToolResultEnvelope.js';
import { executePty } from './TerminalPtyExecutor.js';
import { executeStructuredCommand } from './TerminalRunExecutor.js';
import { executeScript } from './TerminalScriptExecutor.js';
import {
  executeSessionCleanup,
  executeSessionClose,
  executeSessionStatus,
} from './TerminalSessionExecutor.js';
import { executeShell } from './TerminalShellExecutor.js';

export async function executeTerminalRequest(
  request: ToolExecutionRequest,
  fallbackSessionManager: TerminalSessionManager
): Promise<ToolResultEnvelope> {
  const startedAt = new Date();
  const startedMs = Date.now();
  switch (request.manifest.id) {
    case 'terminal_session_close':
      return executeSessionClose(request, fallbackSessionManager, startedAt, startedMs);
    case 'terminal_session_status':
      return executeSessionStatus(request, fallbackSessionManager, startedAt, startedMs);
    case 'terminal_session_cleanup':
      return executeSessionCleanup(request, fallbackSessionManager, startedAt, startedMs);
    case 'terminal_script':
      return executeScript(request, startedAt, startedMs);
    case 'terminal_shell':
      return executeShell(request, startedAt, startedMs);
    case 'terminal_pty':
      return executePty(request, startedAt, startedMs);
    default:
      return executeStructuredCommand(request, fallbackSessionManager, startedAt, startedMs);
  }
}
