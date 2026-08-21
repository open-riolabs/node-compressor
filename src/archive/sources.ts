import { lstat, readdir, readlink, stat } from 'node:fs/promises';
import {
  basename,
  dirname,
  join,
  relative,
  resolve as resolvePath,
} from 'node:path';

import { CompressionError } from '../data/index.ts';
import { toArchivePath } from './paths.ts';
import type {
  ArchiveBuildOptions,
  ArchiveEntry,
  ArchiveSource,
  ResolvedEntry,
} from '../data/index.ts';

const DEFAULT_FILE_MODE = 0o644;
const DEFAULT_DIRECTORY_MODE = 0o755;
const DEFAULT_SYMLINK_MODE = 0o777;

function toData(value: Uint8Array | string): Buffer {
  return typeof value === 'string'
    ? Buffer.from(value, 'utf8')
    : Buffer.from(value);
}

function accepted(entry: ArchiveEntry, options: ArchiveBuildOptions): boolean {
  return options.filter ? options.filter(entry) === true : true;
}

/**
 * Turns the sources into entries ready for archiving, walking directories
 * recursively.
 */
export async function* resolveSources(
  sources: readonly ArchiveSource[],
  options: ArchiveBuildOptions = {}
): AsyncGenerator<ResolvedEntry> {
  for (const source of sources) {
    if (typeof source === 'string') {
      const absolute = resolvePath(source);
      const root = options.root ? resolvePath(options.root) : dirname(absolute);
      yield* walk(absolute, root, options);
      continue;
    }

    if ('data' in source) {
      const data = toData(source.data);
      const entry: ResolvedEntry = {
        path: toArchivePath(source.path),
        type: 'file',
        size: data.byteLength,
        mode: source.mode ?? DEFAULT_FILE_MODE,
        mtime: source.mtime ?? new Date(),
        data,
      };
      if (accepted(entry, options)) yield entry;
      continue;
    }

    if ('source' in source) {
      const stats = await stat(source.source);
      const entry: ResolvedEntry = {
        path: toArchivePath(source.path),
        type: 'file',
        size: stats.size,
        mode: source.mode ?? stats.mode & 0o7777,
        mtime: source.mtime ?? stats.mtime,
        origin: source.source,
      };
      if (accepted(entry, options)) yield entry;
      continue;
    }

    if (source.type === 'symlink') {
      const entry: ResolvedEntry = {
        path: toArchivePath(source.path),
        type: 'symlink',
        size: 0,
        mode: source.mode ?? DEFAULT_SYMLINK_MODE,
        mtime: source.mtime ?? new Date(),
        linkPath: source.linkPath,
      };
      if (accepted(entry, options)) yield entry;
      continue;
    }

    const entry: ResolvedEntry = {
      path: toArchivePath(source.path),
      type: 'directory',
      size: 0,
      mode: source.mode ?? DEFAULT_DIRECTORY_MODE,
      mtime: source.mtime ?? new Date(),
    };
    if (accepted(entry, options)) yield entry;
  }
}

async function* walk(
  absolute: string,
  root: string,
  options: ArchiveBuildOptions
): AsyncGenerator<ResolvedEntry> {
  const stats =
    options.followSymlinks === true
      ? await stat(absolute)
      : await lstat(absolute);
  const relativePath = relative(root, absolute);
  const archivePath = toArchivePath(
    relativePath === '' ? basename(absolute) : relativePath
  );

  if (stats.isSymbolicLink()) {
    const entry: ResolvedEntry = {
      path: archivePath,
      type: 'symlink',
      size: 0,
      mode: stats.mode & 0o7777,
      mtime: stats.mtime,
      linkPath: (await readlink(absolute)).replace(/\\/g, '/'),
    };
    if (accepted(entry, options)) yield entry;
    return;
  }

  if (stats.isDirectory()) {
    const entry: ResolvedEntry = {
      path: archivePath,
      type: 'directory',
      size: 0,
      mode: stats.mode & 0o7777,
      mtime: stats.mtime,
    };
    if (!accepted(entry, options)) return;
    yield entry;

    const children = await readdir(absolute);
    children.sort();
    for (const child of children) {
      yield* walk(join(absolute, child), root, options);
    }
    return;
  }

  if (!stats.isFile()) {
    throw new CompressionError(
      'ERR_ARCHIVE_UNSUPPORTED',
      `"${absolute}" is not a file, a directory or a symbolic link.`
    );
  }

  const entry: ResolvedEntry = {
    path: archivePath,
    type: 'file',
    size: stats.size,
    mode: stats.mode & 0o7777,
    mtime: stats.mtime,
    origin: absolute,
  };
  if (accepted(entry, options)) yield entry;
}
