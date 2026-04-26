export type TerminalSessionMode = 'ephemeral' | 'persistent';
export type TerminalEnvPersistence = 'none' | 'explicit';

export interface TerminalSessionPlan {
  mode: TerminalSessionMode;
  id: string | null;
  cwdPersistence: 'none';
  envPersistence: TerminalEnvPersistence;
  processPersistence: 'none';
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

export function buildTerminalSessionPlan(
  value: unknown
): { ok: true; session: TerminalSessionPlan } | { ok: false; error: string } {
  if (value === undefined || value === null) {
    return { ok: true, session: createSessionPlan('ephemeral', null) };
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'terminal_run session must be an object when provided' };
  }

  const record = value as Record<string, unknown>;
  const mode = normalizeSessionMode(record.mode);
  if (!mode) {
    return {
      ok: false,
      error: 'terminal_run session.mode must be "ephemeral" or "persistent"',
    };
  }

  const id = normalizeSessionId(record.id);
  if (id === false) {
    return {
      ok: false,
      error: 'terminal_run session.id must match /^[A-Za-z0-9._:-]{1,64}$/',
    };
  }
  if (mode === 'persistent' && !id) {
    return { ok: false, error: 'terminal_run persistent sessions require session.id' };
  }

  const envPersistence = normalizeEnvPersistence(record.envPersistence);
  if (!envPersistence) {
    return {
      ok: false,
      error: 'terminal_run session.envPersistence must be "none" or "explicit"',
    };
  }
  if (envPersistence === 'explicit' && mode !== 'persistent') {
    return {
      ok: false,
      error: 'terminal_run session.envPersistence="explicit" requires a persistent session',
    };
  }

  return { ok: true, session: createSessionPlan(mode, id, envPersistence) };
}

function createSessionPlan(
  mode: TerminalSessionMode,
  id: string | null,
  envPersistence: TerminalEnvPersistence = 'none'
): TerminalSessionPlan {
  return {
    mode,
    id,
    cwdPersistence: 'none',
    envPersistence,
    processPersistence: 'none',
  };
}

function normalizeSessionMode(value: unknown): TerminalSessionMode | null {
  if (value === undefined || value === null) {
    return 'ephemeral';
  }
  if (value === 'ephemeral' || value === 'persistent') {
    return value;
  }
  return null;
}

function normalizeSessionId(value: unknown): string | null | false {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string' || !SESSION_ID_PATTERN.test(value)) {
    return false;
  }
  return value;
}

function normalizeEnvPersistence(value: unknown): TerminalEnvPersistence | null {
  if (value === undefined || value === null) {
    return 'none';
  }
  if (value === 'none' || value === 'explicit') {
    return value;
  }
  return null;
}
