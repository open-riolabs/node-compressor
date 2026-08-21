/** Supported algorithms, all provided by `node:zlib`. */
export type Algorithm = 'gzip' | 'deflate' | 'deflate-raw' | 'brotli' | 'zstd';

/** In decompression `'auto'` detects the algorithm from the magic bytes. */
export type AutoAlgorithm = Algorithm | 'auto';

/**
 * Portable level shared by every algorithm: it maps to the matching native
 * level, so you do not have to remember that gzip stops at 9, brotli at 11 and
 * zstd at 22.
 */
export type Preset = 'fastest' | 'fast' | 'balanced' | 'best';
