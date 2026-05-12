export const ALEMBIC_CHANNEL_ID_ENV = 'ALEMBIC_CHANNEL_ID';
export const ALEMBIC_CHANNEL_ID_FALLBACK_ENV = 'ALEMBIC_CHANNEL';
export const CODEX_CHANNEL_ID = 'codex';
export const UNKNOWN_CHANNEL_ID = 'unknown';

export function resolveAlembicChannelId(fallback = UNKNOWN_CHANNEL_ID): string {
  const primary = normalizeChannelId(process.env[ALEMBIC_CHANNEL_ID_ENV]);
  if (primary) {
    return primary;
  }
  const legacy = normalizeChannelId(process.env[ALEMBIC_CHANNEL_ID_FALLBACK_ENV]);
  if (legacy) {
    return legacy;
  }
  return fallback;
}

export function isAlembicChannel(channelId: string, expected: string): boolean {
  return normalizeChannelId(channelId) === normalizeChannelId(expected);
}

function normalizeChannelId(value: string | undefined): string {
  return (value || '').trim().toLowerCase();
}
