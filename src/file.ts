import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { pipeline } from 'node:stream/promises';

import { algorithmForExtension, extensionFor } from './algorithms.ts';
import { detectFile } from './detect.ts';
import { CompressionError } from './data/index.ts';
import { prepareDestination, withTemporaryTarget } from './fsutil.ts';
import {
  createCompressStream,
  createDecompressStream,
  createProgressStream,
} from './stream.ts';
import type {
  Algorithm,
  CompressOptions,
  DecompressOptions,
  DestinationOptions,
  FileResult,
  Progress,
} from './data/index.ts';

/** Options shared by the file operations. */
export interface FileOperationOptions extends DestinationOptions {
  /** Called with the bytes read from the source. */
  onProgress?: (progress: Progress) => void;
}

export interface CompressFileOptions
  extends CompressOptions, FileOperationOptions {}
export interface DecompressFileOptions
  extends DecompressOptions, FileOperationOptions {}

function splitArgs<T extends FileOperationOptions>(
  destinationOrOptions: string | T | undefined,
  maybeOptions: T | undefined
): { destination?: string; options: T } {
  if (typeof destinationOrOptions === 'string') {
    return {
      destination: destinationOrOptions,
      options: maybeOptions ?? ({} as T),
    };
  }
  return { options: destinationOrOptions ?? maybeOptions ?? ({} as T) };
}

/** Runs source -> transform -> destination atomically. */
async function runFilePipeline(
  source: string,
  destination: string,
  transform: NodeJS.ReadWriteStream,
  options: FileOperationOptions & { signal?: AbortSignal },
  algorithm: Algorithm
): Promise<FileResult> {
  const startedAt = performance.now();
  const sourceStat = await stat(source);

  const bytesWritten = await withTemporaryTarget(
    destination,
    async (temporary) => {
      const input = createReadStream(source);
      const output = createWriteStream(temporary, { flags: 'wx' });
      const stages: NodeJS.ReadWriteStream[] = [];
      if (options.onProgress)
        stages.push(createProgressStream(options.onProgress, sourceStat.size));
      stages.push(transform);

      await pipeline(
        [input, ...stages, output],
        options.signal ? { signal: options.signal } : {}
      );
      return output.bytesWritten;
    }
  );

  return {
    source,
    destination,
    algorithm,
    bytesRead: sourceStat.size,
    bytesWritten,
    compressionRatio:
      sourceStat.size === 0 ? 1 : bytesWritten / sourceStat.size,
    durationMs: performance.now() - startedAt,
  };
}

/**
 * Compresses a file on disk in streaming, never loading it into memory.
 *
 * The algorithm is picked in this order: `options.algorithm`, the destination
 * extension, then gzip. The default destination is the source plus the
 * algorithm's extension.
 *
 * @example
 * ```ts
 * const result = await compressFile('dump.sql', { algorithm: 'zstd', preset: 'best' });
 * console.log(result.destination, result.compressionRatio);
 * ```
 */
export function compressFile(
  source: string,
  options?: CompressFileOptions
): Promise<FileResult>;
export function compressFile(
  source: string,
  destination: string,
  options?: CompressFileOptions
): Promise<FileResult>;
export async function compressFile(
  source: string,
  destinationOrOptions?: string | CompressFileOptions,
  maybeOptions?: CompressFileOptions
): Promise<FileResult> {
  const { destination, options } = splitArgs(
    destinationOrOptions,
    maybeOptions
  );

  const algorithm: Algorithm =
    options.algorithm ??
    (destination ? algorithmForExtension(extname(destination)) : undefined) ??
    'gzip';

  const target = destination ?? `${source}${extensionFor(algorithm)}`;
  await prepareDestination(target, options, source);

  const sourceStat = await stat(source);
  const transform = createCompressStream({
    ...options,
    algorithm,
    sizeHint: options.sizeHint ?? sourceStat.size,
  });

  return runFilePipeline(source, target, transform, options, algorithm);
}

/**
 * Decompresses a file on disk in streaming.
 *
 * With `algorithm: 'auto'` (the default) the format comes from the magic bytes
 * and, failing that, from the extension. The default destination is the source
 * without its compression extension.
 */
export function decompressFile(
  source: string,
  options?: DecompressFileOptions
): Promise<FileResult>;
export function decompressFile(
  source: string,
  destination: string,
  options?: DecompressFileOptions
): Promise<FileResult>;
export async function decompressFile(
  source: string,
  destinationOrOptions?: string | DecompressFileOptions,
  maybeOptions?: DecompressFileOptions
): Promise<FileResult> {
  const { destination, options } = splitArgs(
    destinationOrOptions,
    maybeOptions
  );
  const requested = options.algorithm ?? 'auto';

  const algorithm: Algorithm =
    requested === 'auto'
      ? ((await detectFile(source)) ??
        options.fallbackAlgorithm ??
        raiseDetectionFailure(source))
      : requested;

  const target = destination ?? stripExtension(source);
  await prepareDestination(target, options, source);

  const transform = createDecompressStream({ ...options, algorithm });
  return runFilePipeline(source, target, transform, options, algorithm);
}

function raiseDetectionFailure(source: string): never {
  throw new CompressionError(
    'ERR_DETECTION_FAILED',
    `Could not detect the format of "${source}": pass "algorithm" or "fallbackAlgorithm".`
  );
}

function stripExtension(source: string): string {
  const extension = extname(source);
  if (extension && algorithmForExtension(extension)) {
    // Common special case: `archive.tgz` becomes `archive.tar` again.
    if (extension.toLowerCase() === '.tgz')
      return `${source.slice(0, -extension.length)}.tar`;
    return source.slice(0, -extension.length);
  }
  throw new CompressionError(
    'ERR_DESTINATION_REQUIRED',
    `"${source}" has no recognised compression extension: pass the destination explicitly.`
  );
}
