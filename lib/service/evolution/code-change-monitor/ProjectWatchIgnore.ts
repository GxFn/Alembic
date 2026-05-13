import { isAbsolute, normalize, relative } from 'node:path';

const IGNORED_ANY_SEGMENTS = new Set([
  '.asd',
  '.git',
  '.next',
  '.nuxt',
  '.turbo',
  '.vite',
  'DerivedData',
  'node_modules',
]);

const IGNORED_GENERATED_SEGMENTS = new Set(['build', 'coverage', 'dist', 'target']);

const IGNORED_ROOT_SEGMENTS = new Set(['.cache', 'cache', 'logs', 'temp', 'tmp', 'vendor']);

const IGNORED_EXTENSIONS = ['.log'];

export function normalizeProjectRelativePath(filePath: string): string {
  let normalized = normalize(filePath).replaceAll('\\', '/');
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }
  return normalized === '.' ? '' : normalized;
}

export function toProjectRelativePath(filePath: string, projectRoot: string): string {
  if (!isAbsolute(filePath)) {
    return normalizeProjectRelativePath(filePath);
  }
  return normalizeProjectRelativePath(relative(projectRoot, filePath));
}

export function isSafeProjectRelativePath(filePath: string): boolean {
  const normalized = normalizeProjectRelativePath(filePath);
  return (
    normalized.length > 0 &&
    !isAbsolute(normalized) &&
    !normalized.startsWith('../') &&
    normalized !== '..' &&
    !normalized.includes('/../')
  );
}

export function shouldIgnoreProjectPath(filePath: string): boolean {
  const normalized = normalizeProjectRelativePath(filePath);
  if (normalized.length === 0) {
    return false;
  }
  const parts = normalized.split('/').filter(Boolean);
  if (parts.some((part) => IGNORED_ANY_SEGMENTS.has(part))) {
    return true;
  }
  if (parts.some((part) => IGNORED_GENERATED_SEGMENTS.has(part))) {
    return true;
  }
  if (parts[0] && IGNORED_ROOT_SEGMENTS.has(parts[0])) {
    return true;
  }
  return IGNORED_EXTENSIONS.some((extension) => normalized.endsWith(extension));
}
