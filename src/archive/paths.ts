import { isAbsolute, relative, resolve as resolvePath, sep } from 'node:path';

import { CompressionError } from '../data/index.ts';

/**
 * Normalises a path for storage inside an archive: `/` separators, no drive
 * letter, no `.` or `..` segments.
 */
export function toArchivePath(input: string): string {
  const withoutDrive = input
    .replace(/^[a-zA-Z]:[\\/]/, '')
    .replace(/^[\\/]+/, '');
  const segments = withoutDrive
    .split(/[\\/]+/)
    .filter((segment) => segment !== '' && segment !== '.');

  if (segments.includes('..')) {
    throw new CompressionError(
      'ERR_UNSAFE_ENTRY_PATH',
      `Path "${input}" contains ".." and cannot be archived.`
    );
  }
  return segments.join('/');
}

/**
 * Makes an entry path safe for extraction, dropping the first `strip`
 * components. Returns `undefined` when nothing is left to extract.
 *
 * Absolute paths and paths containing `..` are rejected: this is the defence
 * against zip-slip attacks.
 */
export function sanitizeExtractPath(
  entryPath: string,
  strip = 0
): string | undefined {
  const normalized = entryPath.replace(/\\/g, '/');

  if (/^([a-zA-Z]:)?\//.test(normalized)) {
    throw new CompressionError(
      'ERR_UNSAFE_ENTRY_PATH',
      `Absolute path rejected: "${entryPath}".`
    );
  }

  const segments = normalized
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.');
  if (segments.includes('..')) {
    throw new CompressionError(
      'ERR_UNSAFE_ENTRY_PATH',
      `Path traversal rejected: "${entryPath}".`
    );
  }

  const stripped = segments.slice(strip);
  return stripped.length > 0 ? stripped.join('/') : undefined;
}

/** Checks that `target` stays inside `root`, comparing resolved paths. */
export function isInside(root: string, target: string): boolean {
  const relativePath = relative(resolvePath(root), resolvePath(target));
  return (
    relativePath === '' ||
    (!relativePath.startsWith(`..${sep}`) &&
      relativePath !== '..' &&
      !isAbsolute(relativePath))
  );
}
