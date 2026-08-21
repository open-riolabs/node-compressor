import type { Algorithm } from './enums/compression.enum.ts';

/** Every supported algorithm, in a form usable at runtime. */
export const ALGORITHMS: readonly Algorithm[] = [
  'gzip',
  'deflate',
  'deflate-raw',
  'brotli',
  'zstd',
];
