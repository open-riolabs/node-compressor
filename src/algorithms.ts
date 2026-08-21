import zlib from 'node:zlib';
import type { Transform } from 'node:stream';

import { CompressionError } from './data/index.ts';
import {
  ALGORITHMS,
  type Algorithm,
  type CompressOptions,
  type DecompressOptions,
  type Preset,
} from './data/index.ts';

/** Canonical extension produced for each algorithm. */
const EXTENSIONS: Record<Algorithm, string> = {
  gzip: '.gz',
  deflate: '.zz',
  'deflate-raw': '.deflate',
  brotli: '.br',
  zstd: '.zst',
};

/** Extensions accepted when reading, including the common variants. */
const EXTENSION_ALIASES: Record<string, Algorithm> = {
  '.gz': 'gzip',
  '.gzip': 'gzip',
  '.tgz': 'gzip',
  '.zz': 'deflate',
  '.zlib': 'deflate',
  '.deflate': 'deflate-raw',
  '.br': 'brotli',
  '.brotli': 'brotli',
  '.zst': 'zstd',
  '.zstd': 'zstd',
};

interface LevelSpec {
  min: number;
  max: number;
  presets: Record<Preset, number>;
}

const LEVELS: Record<Algorithm, LevelSpec> = {
  gzip: {
    min: 0,
    max: 9,
    presets: { fastest: 1, fast: 3, balanced: 6, best: 9 },
  },
  deflate: {
    min: 0,
    max: 9,
    presets: { fastest: 1, fast: 3, balanced: 6, best: 9 },
  },
  'deflate-raw': {
    min: 0,
    max: 9,
    presets: { fastest: 1, fast: 3, balanced: 6, best: 9 },
  },
  brotli: {
    min: 0,
    max: 11,
    presets: { fastest: 0, fast: 2, balanced: 5, best: 11 },
  },
  zstd: {
    min: 1,
    max: 22,
    presets: { fastest: 1, fast: 3, balanced: 9, best: 19 },
  },
};

/** Internal options: `exactSize` is only known for in-memory input. */
export interface InternalCompressOptions extends CompressOptions {
  /** `sizeHint` is the exact and final size of the input. */
  exactSize?: boolean;
}

export function isAlgorithm(value: unknown): value is Algorithm {
  return (
    typeof value === 'string' &&
    (ALGORITHMS as readonly string[]).includes(value)
  );
}

export function assertAlgorithm(value: string): Algorithm {
  if (!isAlgorithm(value)) {
    throw new CompressionError(
      'ERR_UNKNOWN_ALGORITHM',
      `Unknown algorithm: "${value}". Expected one of: ${ALGORITHMS.join(', ')}.`
    );
  }
  return value;
}

/** Canonical extension for the algorithm, e.g. `'.gz'`. */
export function extensionFor(algorithm: Algorithm): string {
  return EXTENSIONS[assertAlgorithm(algorithm)];
}

/** Algorithm bound to an extension, with or without the leading dot. */
export function algorithmForExtension(
  extension: string
): Algorithm | undefined {
  const normalized = extension.startsWith('.') ? extension : `.${extension}`;
  return EXTENSION_ALIASES[normalized.toLowerCase()];
}

/** Valid level range for the algorithm. */
export function levelRange(algorithm: Algorithm): { min: number; max: number } {
  const spec = LEVELS[assertAlgorithm(algorithm)];
  return { min: spec.min, max: spec.max };
}

function resolveLevel(algorithm: Algorithm, options: CompressOptions): number {
  const spec = LEVELS[algorithm];
  if (options.level === undefined) {
    return spec.presets[options.preset ?? 'balanced'];
  }
  const level = options.level;
  if (!Number.isInteger(level) || level < spec.min || level > spec.max) {
    throw new CompressionError(
      'ERR_INVALID_LEVEL',
      `Level ${level} is invalid for "${algorithm}": expected an integer between ${spec.min} and ${spec.max}.`
    );
  }
  return level;
}

type NativeOpts = zlib.ZlibOptions & zlib.BrotliOptions & zlib.ZstdOptions;

function baseOptions(
  options: CompressOptions | DecompressOptions
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (options.chunkSize !== undefined) result['chunkSize'] = options.chunkSize;
  return result;
}

/** Translates the library options into native `node:zlib` options. */
export function buildCompressOptions(
  algorithm: Algorithm,
  options: InternalCompressOptions = {}
): NativeOpts {
  const level = resolveLevel(algorithm, options);
  const native = baseOptions(options);

  switch (algorithm) {
    case 'gzip':
    case 'deflate':
    case 'deflate-raw':
      native['level'] = level;
      break;

    case 'brotli': {
      const params: Record<number, number> = {
        [zlib.constants.BROTLI_PARAM_QUALITY]: level,
      };
      if (options.sizeHint !== undefined && options.sizeHint >= 0) {
        params[zlib.constants.BROTLI_PARAM_SIZE_HINT] = options.sizeHint;
      }
      native['params'] = params;
      break;
    }

    case 'zstd': {
      native['params'] = { [zlib.constants.ZSTD_c_compressionLevel]: level };
      // `pledgedSrcSize` must match the input exactly, so it is only set when
      // the size is certain (data already in memory).
      if (options.exactSize === true && options.sizeHint !== undefined) {
        native['pledgedSrcSize'] = options.sizeHint;
      }
      break;
    }
  }

  return { ...native, ...options.native } as NativeOpts;
}

/** Translates the library options into native `node:zlib` options. */
export function buildDecompressOptions(
  options: DecompressOptions = {}
): NativeOpts {
  const native = baseOptions(options);
  if (options.maxOutputSize !== undefined)
    native['maxOutputLength'] = options.maxOutputSize;
  return { ...native, ...options.native } as NativeOpts;
}

const COMPRESSOR_FACTORIES: Record<Algorithm, (opts: NativeOpts) => Transform> =
  {
    gzip: (opts) => zlib.createGzip(opts),
    deflate: (opts) => zlib.createDeflate(opts),
    'deflate-raw': (opts) => zlib.createDeflateRaw(opts),
    brotli: (opts) => zlib.createBrotliCompress(opts),
    zstd: (opts) => zlib.createZstdCompress(opts),
  };

const DECOMPRESSOR_FACTORIES: Record<
  Algorithm,
  (opts: NativeOpts) => Transform
> = {
  gzip: (opts) => zlib.createGunzip(opts),
  deflate: (opts) => zlib.createInflate(opts),
  'deflate-raw': (opts) => zlib.createInflateRaw(opts),
  brotli: (opts) => zlib.createBrotliDecompress(opts),
  zstd: (opts) => zlib.createZstdDecompress(opts),
};

type AsyncFn = (
  buf: Uint8Array,
  opts: NativeOpts,
  cb: (error: Error | null, result: Buffer) => void
) => void;
type SyncFn = (buf: Uint8Array, opts: NativeOpts) => Buffer;

const COMPRESSORS: Record<Algorithm, AsyncFn> = {
  gzip: zlib.gzip,
  deflate: zlib.deflate,
  'deflate-raw': zlib.deflateRaw,
  brotli: zlib.brotliCompress,
  zstd: zlib.zstdCompress,
};

const DECOMPRESSORS: Record<Algorithm, AsyncFn> = {
  gzip: zlib.gunzip,
  deflate: zlib.inflate,
  'deflate-raw': zlib.inflateRaw,
  brotli: zlib.brotliDecompress,
  zstd: zlib.zstdDecompress,
};

const COMPRESSORS_SYNC: Record<Algorithm, SyncFn> = {
  gzip: zlib.gzipSync,
  deflate: zlib.deflateSync,
  'deflate-raw': zlib.deflateRawSync,
  brotli: zlib.brotliCompressSync,
  zstd: zlib.zstdCompressSync,
};

const DECOMPRESSORS_SYNC: Record<Algorithm, SyncFn> = {
  gzip: zlib.gunzipSync,
  deflate: zlib.inflateSync,
  'deflate-raw': zlib.inflateRawSync,
  brotli: zlib.brotliDecompressSync,
  zstd: zlib.zstdDecompressSync,
};

export function createNativeCompressor(
  algorithm: Algorithm,
  opts: NativeOpts
): Transform {
  return COMPRESSOR_FACTORIES[assertAlgorithm(algorithm)](opts);
}

export function createNativeDecompressor(
  algorithm: Algorithm,
  opts: NativeOpts
): Transform {
  return DECOMPRESSOR_FACTORIES[assertAlgorithm(algorithm)](opts);
}

function promisify(
  fn: AsyncFn,
  buf: Uint8Array,
  opts: NativeOpts
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    fn(buf, opts, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

export function nativeCompress(
  algorithm: Algorithm,
  buf: Uint8Array,
  opts: NativeOpts
): Promise<Buffer> {
  return promisify(COMPRESSORS[assertAlgorithm(algorithm)], buf, opts);
}

export function nativeDecompress(
  algorithm: Algorithm,
  buf: Uint8Array,
  opts: NativeOpts
): Promise<Buffer> {
  return promisify(DECOMPRESSORS[assertAlgorithm(algorithm)], buf, opts);
}

export function nativeCompressSync(
  algorithm: Algorithm,
  buf: Uint8Array,
  opts: NativeOpts
): Buffer {
  return COMPRESSORS_SYNC[assertAlgorithm(algorithm)](buf, opts);
}

export function nativeDecompressSync(
  algorithm: Algorithm,
  buf: Uint8Array,
  opts: NativeOpts
): Buffer {
  return DECOMPRESSORS_SYNC[assertAlgorithm(algorithm)](buf, opts);
}
