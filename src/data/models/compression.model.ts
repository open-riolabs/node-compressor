import type { BrotliOptions, ZlibOptions, ZstdOptions } from 'node:zlib';

import type {
  Algorithm,
  AutoAlgorithm,
  Preset,
} from '../enums/compression.enum.ts';

/** Raw `node:zlib` options, for advanced cases. */
export type NativeOptions = ZlibOptions | BrotliOptions | ZstdOptions;

export interface CompressOptions {
  /** Default: `'gzip'`. */
  algorithm?: Algorithm;
  /**
   * Native level of the algorithm (gzip/deflate 0-9, brotli 0-11, zstd 1-22).
   * Takes precedence over `preset`.
   */
  level?: number;
  /** Portable level. Default: `'balanced'`. */
  preset?: Preset;
  /** Size of zlib's internal chunks, in bytes. */
  chunkSize?: number;
  /**
   * Known input size, in bytes. Improves the compression ratio of brotli and
   * zstd. Set automatically by `compress()` and `compressFile()`.
   */
  sizeHint?: number;
  signal?: AbortSignal;
  /** Raw `node:zlib` options, applied last so they always win. */
  native?: NativeOptions;
}

export interface DecompressOptions {
  /** Default: `'auto'`. */
  algorithm?: AutoAlgorithm;
  /**
   * Algorithm to use when detection is inconclusive: brotli and deflate-raw
   * have no recognisable header. Without it, `'auto'` raises
   * `ERR_DETECTION_FAILED`.
   */
  fallbackAlgorithm?: Algorithm;
  /** Size of zlib's internal chunks, in bytes. */
  chunkSize?: number;
  /** Output ceiling in bytes: going over it fails. Guards against zip bombs. */
  maxOutputSize?: number;
  /**
   * With `algorithm: 'auto'`, pass the data through untouched when no
   * compressed format is recognised instead of raising an error.
   */
  passthroughUncompressed?: boolean;
  signal?: AbortSignal;
  /** Raw `node:zlib` options, applied last so they always win. */
  native?: NativeOptions;
}

/** Options shared by everything that writes a destination file. */
export interface DestinationOptions {
  /** Overwrite the destination if it exists. Default: `false`. */
  overwrite?: boolean;
  /** Create the destination directory when missing. Default: `false`. */
  createDestinationDir?: boolean;
}

/** Progress reported during file operations. */
export interface Progress {
  bytesRead: number;
  /** Total size of the source, when known. */
  totalBytes?: number;
  /** Fraction between 0 and 1, present only when `totalBytes` is known. */
  ratio?: number;
}

/** Outcome of a file operation. */
export interface FileResult {
  source: string;
  destination: string;
  algorithm: Algorithm;
  bytesRead: number;
  bytesWritten: number;
  /** `bytesWritten / bytesRead`. Equals 1 for an empty source. */
  compressionRatio: number;
  durationMs: number;
}
