import {
  buildCompressOptions,
  buildDecompressOptions,
  nativeCompress,
  nativeCompressSync,
  nativeDecompress,
  nativeDecompressSync,
  type InternalCompressOptions,
} from './algorithms.ts';
import { detect } from './detect.ts';
import { CompressionError } from './data/index.ts';
import type {
  Algorithm,
  CompressOptions,
  DecompressOptions,
} from './data/index.ts';

/** Input accepted by the buffer APIs: binary data or a UTF-8 string. */
export type BinaryInput = Uint8Array | string;

function toBuffer(input: BinaryInput): Buffer {
  if (typeof input === 'string') return Buffer.from(input, 'utf8');
  if (input instanceof Uint8Array)
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  throw new CompressionError(
    'ERR_INVALID_INPUT',
    'Invalid input: expected a string or a Uint8Array.'
  );
}

/**
 * Picks the algorithm to decompress with, applying automatic detection and the
 * configured fallback.
 */
export function resolveDecompressAlgorithm(
  data: Uint8Array,
  options: DecompressOptions = {}
): Algorithm {
  const requested = options.algorithm ?? 'auto';
  if (requested !== 'auto') return requested;

  const detected = detect(data) ?? options.fallbackAlgorithm;
  if (detected) return detected;

  throw new CompressionError(
    'ERR_DETECTION_FAILED',
    'Could not detect the algorithm from the magic bytes. Brotli and deflate-raw are ' +
      'not identifiable: pass "algorithm" or "fallbackAlgorithm".'
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

/**
 * The input size is only certain when the caller did not supply one, which is
 * the condition for using zstd's `pledgedSrcSize`.
 */
function withKnownSize(
  options: CompressOptions,
  byteLength: number
): InternalCompressOptions {
  if (options.sizeHint !== undefined) return options;
  return { ...options, sizeHint: byteLength, exactSize: true };
}

/** Compresses a buffer or a string. Defaults to gzip at the "balanced" preset. */
export async function compress(
  input: BinaryInput,
  options: CompressOptions = {}
): Promise<Buffer> {
  const data = toBuffer(input);
  const algorithm = options.algorithm ?? 'gzip';
  throwIfAborted(options.signal);
  const native = buildCompressOptions(
    algorithm,
    withKnownSize(options, data.byteLength)
  );
  try {
    return await nativeCompress(algorithm, data, native);
  } catch (cause) {
    throwIfAborted(options.signal);
    throw new CompressionError(
      'ERR_COMPRESSION_FAILED',
      `"${algorithm}" compression failed.`,
      { cause }
    );
  }
}

/** Synchronous {@link compress}. Blocks the event loop. */
export function compressSync(
  input: BinaryInput,
  options: CompressOptions = {}
): Buffer {
  const data = toBuffer(input);
  const algorithm = options.algorithm ?? 'gzip';
  const native = buildCompressOptions(
    algorithm,
    withKnownSize(options, data.byteLength)
  );
  try {
    return nativeCompressSync(algorithm, data, native);
  } catch (cause) {
    throw new CompressionError(
      'ERR_COMPRESSION_FAILED',
      `"${algorithm}" compression failed.`,
      { cause }
    );
  }
}

/** Decompresses a buffer, detecting the format from its magic bytes by default. */
export async function decompress(
  input: BinaryInput,
  options: DecompressOptions = {}
): Promise<Buffer> {
  const data = toBuffer(input);
  const algorithm = resolveDecompressAlgorithm(data, options);
  throwIfAborted(options.signal);
  try {
    return await nativeDecompress(
      algorithm,
      data,
      buildDecompressOptions(options)
    );
  } catch (cause) {
    throwIfAborted(options.signal);
    throw new CompressionError(
      'ERR_DECOMPRESSION_FAILED',
      `"${algorithm}" decompression failed.`,
      { cause }
    );
  }
}

/** Synchronous {@link decompress}. Blocks the event loop. */
export function decompressSync(
  input: BinaryInput,
  options: DecompressOptions = {}
): Buffer {
  const data = toBuffer(input);
  const algorithm = resolveDecompressAlgorithm(data, options);
  try {
    return nativeDecompressSync(
      algorithm,
      data,
      buildDecompressOptions(options)
    );
  } catch (cause) {
    throw new CompressionError(
      'ERR_DECOMPRESSION_FAILED',
      `"${algorithm}" decompression failed.`,
      { cause }
    );
  }
}

/** Decompresses and decodes the result as text. */
export async function decompressToString(
  input: BinaryInput,
  options: DecompressOptions & { encoding?: BufferEncoding } = {}
): Promise<string> {
  const result = await decompress(input, options);
  return result.toString(options.encoding ?? 'utf8');
}
