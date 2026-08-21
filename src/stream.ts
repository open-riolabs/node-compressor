import { once } from 'node:events';
import {
  Duplex,
  PassThrough,
  Readable,
  Transform,
  pipeline,
  type Writable,
} from 'node:stream';

import {
  buildCompressOptions,
  buildDecompressOptions,
  createNativeCompressor,
  createNativeDecompressor,
} from './algorithms.ts';
import { resolveDecompressAlgorithm } from './buffer.ts';
import { MAGIC_BYTES_LENGTH, detect } from './detect.ts';
import { CompressionError } from './data/index.ts';
import type {
  CompressOptions,
  DecompressOptions,
  Progress,
} from './data/index.ts';

/** Source accepted by the stream APIs. */
export type StreamSource =
  Readable | AsyncIterable<Uint8Array | string> | Iterable<Uint8Array | string>;

function asBuffer(chunk: Uint8Array | string): Buffer {
  return typeof chunk === 'string'
    ? Buffer.from(chunk, 'utf8')
    : Buffer.from(chunk);
}

function linkSignal(stream: Duplex, signal: AbortSignal | undefined): void {
  if (!signal) return;
  if (signal.aborted) {
    queueMicrotask(() => stream.destroy(signal.reason as Error));
    return;
  }
  const onAbort = (): void => {
    stream.destroy(signal.reason as Error);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  stream.once('close', () => signal.removeEventListener('abort', onAbort));
}

/**
 * Transform that compresses whatever flows through it.
 *
 * @example
 * ```ts
 * await pipeline(input, createCompressStream({ algorithm: 'zstd' }), output);
 * ```
 */
export function createCompressStream(options: CompressOptions = {}): Transform {
  const algorithm = options.algorithm ?? 'gzip';
  const stream = createNativeCompressor(
    algorithm,
    buildCompressOptions(algorithm, options)
  );
  linkSignal(stream, options.signal);
  return stream;
}

/**
 * Transform that decompresses whatever flows through it. With
 * `algorithm: 'auto'` (the default) the format comes from the first bytes.
 */
export function createDecompressStream(
  options: DecompressOptions = {}
): Duplex {
  const algorithm = options.algorithm ?? 'auto';
  if (algorithm === 'auto') return createAutoDecompressStream(options);

  const stream = createNativeDecompressor(
    algorithm,
    buildDecompressOptions(options)
  );
  linkSignal(stream, options.signal);
  return stream;
}

/** Writes a chunk honouring backpressure, without hanging on a dead stream. */
async function writeChunk(
  target: Writable,
  chunk: Buffer,
  closed: Promise<never>
): Promise<void> {
  if (target.write(chunk)) return;
  await Promise.race([once(target, 'drain'), closed]);
}

function resolveInnerStream(
  header: Buffer,
  options: DecompressOptions
): Duplex {
  if (options.passthroughUncompressed === true) {
    const detected = detect(header) ?? options.fallbackAlgorithm;
    if (!detected) return new PassThrough();
    return createDecompressStream({
      ...options,
      algorithm: detected,
      signal: undefined,
    });
  }
  const algorithm = resolveDecompressAlgorithm(header, options);
  return createDecompressStream({ ...options, algorithm, signal: undefined });
}

/**
 * Duplex that buffers the first bytes of the stream to recognise the
 * algorithm, then delegates to the matching decompressor.
 */
function createAutoDecompressStream(options: DecompressOptions): Duplex {
  const duplex = Duplex.from(async function* (
    source: AsyncIterable<Uint8Array | string>
  ) {
    const iterator = source[Symbol.asyncIterator]();
    const head: Buffer[] = [];
    let headSize = 0;

    while (headSize < MAGIC_BYTES_LENGTH) {
      const next = await iterator.next();
      if (next.done === true) break;
      const chunk = asBuffer(next.value);
      if (chunk.byteLength === 0) continue;
      head.push(chunk);
      headSize += chunk.byteLength;
    }

    const header = Buffer.concat(head);
    // May throw ERR_DETECTION_FAILED, which surfaces on the stream.
    const inner = resolveInnerStream(header, options);

    const closed = once(inner, 'close').then<never>(() => {
      throw new CompressionError(
        'ERR_DECOMPRESSION_FAILED',
        'The decompression stream closed before completing.'
      );
    });
    closed.catch(() => {
      // Closing at the end of the stream is not an error worth propagating.
    });

    const pump = (async () => {
      try {
        if (header.byteLength > 0) await writeChunk(inner, header, closed);
        for (;;) {
          const next = await iterator.next();
          if (next.done === true) break;
          await writeChunk(inner, asBuffer(next.value), closed);
        }
        inner.end();
      } catch (error) {
        inner.destroy(error as Error);
      }
    })();

    try {
      yield* inner;
    } finally {
      inner.destroy();
      await pump;
    }
  });

  linkSignal(duplex, options.signal);
  return duplex;
}

/** Compresses a source and returns the compressed stream. */
export function compressStream(
  source: StreamSource,
  options: CompressOptions = {}
): Readable {
  return connect(source, createCompressStream(options));
}

/** Decompresses a source and returns the decompressed stream. */
export function decompressStream(
  source: StreamSource,
  options: DecompressOptions = {}
): Readable {
  return connect(source, createDecompressStream(options));
}

function connect(source: StreamSource, transform: Duplex): Readable {
  const readable = source instanceof Readable ? source : Readable.from(source);
  return pipeline(readable, transform, () => {
    // Errors still surface on the returned stream; the callback only keeps
    // them from becoming unhandled.
  }) as unknown as Readable;
}

/** PassThrough that counts the bytes going by without altering them. */
export function createProgressStream(
  onProgress: (progress: Progress) => void,
  totalBytes?: number
): Transform {
  let bytesRead = 0;
  const stream = new PassThrough();
  stream.on('data', (chunk: Buffer) => {
    bytesRead += chunk.byteLength;
    const progress: Progress = { bytesRead };
    if (totalBytes !== undefined && totalBytes > 0) {
      progress.totalBytes = totalBytes;
      progress.ratio = Math.min(bytesRead / totalBytes, 1);
    }
    onProgress(progress);
  });
  return stream;
}
