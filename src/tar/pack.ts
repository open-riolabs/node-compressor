import { createReadStream, createWriteStream } from 'node:fs';
import { extname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { algorithmForExtension } from '../algorithms.ts';
import { resolveSources } from '../archive/sources.ts';
import type {
  ArchiveBuildOptions,
  ArchiveEntry,
  ArchiveResult,
  ArchiveSource,
  CreateArchiveOptions,
} from '../data/index.ts';
import { CompressionError } from '../data/index.ts';
import { prepareDestination, withTemporaryTarget } from '../fsutil.ts';
import { createCompressStream } from '../stream.ts';
import type { Algorithm } from '../data/index.ts';
import { BLOCK_SIZE, encodeTarHeader } from './header.ts';

/** Two zeroed blocks close every tar archive. */
const END_OF_ARCHIVE = Buffer.alloc(BLOCK_SIZE * 2);

function padding(size: number): number {
  const remainder = size % BLOCK_SIZE;
  return remainder === 0 ? 0 : BLOCK_SIZE - remainder;
}

/**
 * Generates the tar stream for the given sources, recording the entries it
 * actually wrote into `collected`.
 */
async function* packEntries(
  sources: readonly ArchiveSource[],
  options: ArchiveBuildOptions,
  collected: ArchiveEntry[]
): AsyncGenerator<Buffer> {
  for await (const entry of resolveSources(sources, options)) {
    const { origin, data, ...metadata } = entry;

    yield encodeTarHeader({
      path:
        entry.type === 'directory' && !entry.path.endsWith('/')
          ? `${entry.path}/`
          : entry.path,
      type: entry.type,
      size: entry.type === 'file' ? entry.size : 0,
      mode: entry.mode,
      mtime: entry.mtime,
      ...(entry.linkPath === undefined ? {} : { linkPath: entry.linkPath }),
    });

    if (entry.type === 'file') {
      let written = 0;
      if (data) {
        written = data.byteLength;
        if (written > 0) yield data;
      } else if (origin) {
        for await (const chunk of createReadStream(origin)) {
          const buffer = chunk as Buffer;
          written += buffer.byteLength;
          if (written > entry.size) {
            throw new CompressionError(
              'ERR_ARCHIVE_INVALID',
              `"${origin}" grew while being archived: header and content no longer agree.`
            );
          }
          yield buffer;
        }
      }

      if (written !== entry.size) {
        throw new CompressionError(
          'ERR_ARCHIVE_INVALID',
          `"${origin ?? entry.path}" changed while being archived: expected ${entry.size} bytes, read ${written}.`
        );
      }

      const pad = padding(written);
      if (pad > 0) yield Buffer.alloc(pad);
    }

    collected.push(metadata);
    options.onEntry?.(metadata);
  }

  yield END_OF_ARCHIVE;
}

/**
 * Builds an uncompressed tar stream out of files, directories or in-memory
 * content.
 *
 * @example
 * ```ts
 * const tar = createTarStream(['src', { path: 'note.txt', data: 'hello' }]);
 * await pipeline(tar, createCompressStream({ algorithm: 'zstd' }), output);
 * ```
 */
export function createTarStream(
  sources: readonly ArchiveSource[],
  options: ArchiveBuildOptions = {}
): Readable {
  return Readable.from(packEntries(sources, options, []));
}

/**
 * Infers the compression from the destination extension: `.tar.gz`, `.tgz`,
 * `.tar.br`, `.tar.zst` and friends.
 */
export function compressionForArchivePath(path: string): Algorithm | 'none' {
  const extension = extname(path).toLowerCase();
  if (extension === '.tgz') return 'gzip';
  if (extension === '.tar' || extension === '.zip') return 'none';
  return algorithmForExtension(extension) ?? 'none';
}

/**
 * Creates a tar archive on disk, optionally compressed.
 *
 * @example
 * ```ts
 * await createTarArchive('backup.tar.zst', ['documents', 'photos'], {
 *   compressionOptions: { preset: 'best' },
 * });
 * ```
 */
export async function createTarArchive(
  destination: string,
  sources: readonly ArchiveSource[],
  options: CreateArchiveOptions = {}
): Promise<ArchiveResult> {
  const startedAt = performance.now();
  const compression =
    options.compression ?? compressionForArchivePath(destination);
  await prepareDestination(destination, options);

  const entries: ArchiveEntry[] = [];
  const bytesWritten = await withTemporaryTarget(
    destination,
    async (temporary) => {
      const output = createWriteStream(temporary, { flags: 'wx' });
      const stages: NodeJS.ReadWriteStream[] = [];
      if (compression !== 'none') {
        stages.push(
          createCompressStream({
            ...options.compressionOptions,
            algorithm: compression,
          })
        );
      }

      await pipeline(
        [
          Readable.from(packEntries(sources, options, entries)),
          ...stages,
          output,
        ],
        options.signal ? { signal: options.signal } : {}
      );
      return output.bytesWritten;
    }
  );

  return {
    destination,
    format: 'tar',
    compression,
    entries,
    bytesRead: entries.reduce((total, entry) => total + entry.size, 0),
    bytesWritten,
    durationMs: performance.now() - startedAt,
  };
}
