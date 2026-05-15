export {
  type GitDiffCheckpointResult,
  GitDiffCheckpointService,
  type GitDiffCheckpointServiceOptions,
} from './GitDiffCheckpointService.js';
export type {
  GitDiffCheckpointError,
  GitDiffCheckpointErrorCode,
  GitDiffCheckpointStatus,
  GitDiffLastDispatchStatus,
  GitDiffScanStatus,
} from './GitDiffCheckpointStatus.js';
export { createInactiveGitDiffCheckpointStatus } from './GitDiffCheckpointStatus.js';
export {
  addNameStatusEvents,
  GitDiffScanner,
  type GitDiffScannerOptions,
  type GitDiffScanOptions,
  type GitDiffScanResult,
} from './GitDiffScanner.js';
export {
  isSafeProjectRelativePath,
  normalizeProjectRelativePath,
  shouldIgnoreProjectPath,
  toProjectRelativePath,
} from './ProjectDiffIgnore.js';
