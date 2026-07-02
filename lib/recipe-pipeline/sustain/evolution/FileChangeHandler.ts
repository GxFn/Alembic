/**
 * R1 compatibility shim for the pre-P12 in-process handler name.
 *
 * New Alembic source imports InProcessFileChangeHandler directly; this alias
 * keeps existing FileChangeHandler named imports working during the rename wave.
 */
export {
  InProcessFileChangeHandler,
  InProcessFileChangeHandler as FileChangeHandler,
} from './InProcessFileChangeHandler.js';
