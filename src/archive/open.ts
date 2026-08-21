import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';

import { detectFromPath } from '../detect.ts';
import { decompressStream } from '../stream.ts';
import type { ArchiveOpenOptions } from '../data/index.ts';

/** Source accepted by the read-only archive APIs. */
export type ArchiveInput = string | Readable | Uint8Array;

export function toReadable(source: ArchiveInput): Readable {
  if (typeof source === 'string') return createReadStream(source);
  if (source instanceof Readable) return source;
  return Readable.from([Buffer.from(source)]);
}

/**
 * Opens an archive, decompressing only when the content really is compressed:
 * `.tar`, `.tar.gz`, `.tgz`, `.tar.br` and `.tar.zst` all go through here
 * without the caller declaring anything.
 */
export function openArchiveStream(
  source: ArchiveInput,
  options: ArchiveOpenOptions = {}
): Readable {
  const stream = toReadable(source);
  const compression = options.compression ?? 'auto';
  const signal = options.signal ? { signal: options.signal } : {};

  if (compression === 'none') return stream;
  if (compression !== 'auto') {
    return decompressStream(stream, { algorithm: compression, ...signal });
  }

  const fallback =
    typeof source === 'string' ? detectFromPath(source) : undefined;
  return decompressStream(stream, {
    passthroughUncompressed: true,
    ...(fallback ? { fallbackAlgorithm: fallback } : {}),
    ...signal,
  });
}
