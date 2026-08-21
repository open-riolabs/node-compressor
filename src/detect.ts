import { open } from 'node:fs/promises';
import { extname } from 'node:path';

import { algorithmForExtension } from './algorithms.ts';
import type { Algorithm } from './data/index.ts';

/** Bytes needed to attempt magic-byte detection. */
export const MAGIC_BYTES_LENGTH = 4;

/**
 * Detects the algorithm from the leading magic bytes.
 *
 * Brotli and deflate-raw carry no identifying header, so this always returns
 * `undefined` for those formats.
 */
export function detect(data: Uint8Array): Algorithm | undefined {
  const b0 = data[0];
  const b1 = data[1];
  if (b0 === undefined || b1 === undefined) return undefined;

  // gzip: 1f 8b
  if (b0 === 0x1f && b1 === 0x8b) return 'gzip';

  // zstd: standard frame 28 b5 2f fd
  if (b0 === 0x28 && b1 === 0xb5 && data[2] === 0x2f && data[3] === 0xfd)
    return 'zstd';
  // zstd: skippable frame 0x184d2a5? in little endian
  if (
    b0 >= 0x50 &&
    b0 <= 0x5f &&
    b1 === 0x2a &&
    data[2] === 0x4d &&
    data[3] === 0x18
  )
    return 'zstd';

  // zlib (RFC 1950 deflate): method 8 and a valid header checksum.
  if ((b0 & 0x0f) === 0x08 && b0 >> 4 <= 7 && ((b0 << 8) + b1) % 31 === 0)
    return 'deflate';

  return undefined;
}

/** Infers the algorithm from the path extension, when recognised. */
export function detectFromPath(path: string): Algorithm | undefined {
  return algorithmForExtension(extname(path));
}

/**
 * Detects a file's algorithm from its header, falling back to the file
 * extension when the magic bytes are inconclusive.
 */
export async function detectFile(path: string): Promise<Algorithm | undefined> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(MAGIC_BYTES_LENGTH);
    const { bytesRead } = await handle.read(buffer, 0, MAGIC_BYTES_LENGTH, 0);
    return detect(buffer.subarray(0, bytesRead)) ?? detectFromPath(path);
  } finally {
    await handle.close();
  }
}
