const SECRET_KEY_PATTERN =
  /\b(?:sk-[A-Za-z0-9_-]{8,}|sk-ant-[A-Za-z0-9_-]{8,}|sk-proj-[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{8,}|scenario-secret-[A-Za-z0-9_-]+)\b/g;

export function redactText(value: string, secrets: string[] = []): string {
  let text = value;
  for (const secret of secrets.filter(Boolean)) {
    text = text.split(secret).join(`<redacted:${shortSecretLabel(secret)}>`);
  }
  return text.replace(SECRET_KEY_PATTERN, '<redacted:secret>');
}

export function redactValue<T>(value: T, secrets: string[] = []): T {
  if (typeof value === 'string') {
    return redactText(value, secrets) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, secrets)) as T;
  }
  if (value && typeof value === 'object') {
    const redacted: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (/api[_-]?key|token|secret|password/i.test(key)) {
        redacted[key] = child ? `<redacted:${key}>` : child;
      } else {
        redacted[key] = redactValue(child, secrets);
      }
    }
    return redacted as T;
  }
  return value;
}

function shortSecretLabel(secret: string): string {
  return secret.length > 12 ? `${secret.slice(0, 4)}...${secret.slice(-4)}` : 'secret';
}
