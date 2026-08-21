import assert from 'node:assert/strict';
import { test } from 'node:test';
import zlib from 'node:zlib';

import {
  ALGORITHMS,
  CompressionError,
  compress,
  compressSync,
  decompress,
  decompressSync,
  decompressToString,
  detect,
  levelRange,
} from '../index.ts';

const SAMPLE = Buffer.from('lorem ipsum dolor sit amet '.repeat(500), 'utf8');

for (const algorithm of ALGORITHMS) {
  test(`${algorithm}: async round-trip`, async () => {
    const packed = await compress(SAMPLE, { algorithm });
    assert.ok(
      packed.byteLength < SAMPLE.byteLength,
      'the output must be smaller'
    );
    const unpacked = await decompress(packed, { algorithm });
    assert.deepEqual(unpacked, SAMPLE);
  });

  test(`${algorithm}: sync round-trip`, () => {
    const packed = compressSync(SAMPLE, { algorithm, preset: 'fastest' });
    assert.deepEqual(decompressSync(packed, { algorithm }), SAMPLE);
  });

  test(`${algorithm}: the best preset compresses at least as well as fastest`, async () => {
    const fastest = await compress(SAMPLE, { algorithm, preset: 'fastest' });
    const best = await compress(SAMPLE, { algorithm, preset: 'best' });
    assert.ok(best.byteLength <= fastest.byteLength);
  });
}

test('strings are accepted and treated as UTF-8', async () => {
  const packed = await compress('città è perché — ok');
  assert.equal(await decompressToString(packed), 'città è perché — ok');
});

test('gzip is the default', async () => {
  const packed = await compress(SAMPLE);
  assert.equal(detect(packed), 'gzip');
});

test('auto detects gzip, deflate and zstd', async () => {
  for (const algorithm of ['gzip', 'deflate', 'zstd'] as const) {
    const packed = await compress(SAMPLE, { algorithm });
    assert.equal(detect(packed), algorithm);
    assert.deepEqual(await decompress(packed), SAMPLE);
  }
});

test('auto fails on brotli without fallbackAlgorithm', async () => {
  const packed = await compress(SAMPLE, { algorithm: 'brotli' });
  await assert.rejects(
    () => decompress(packed),
    (error: unknown) =>
      error instanceof CompressionError && error.code === 'ERR_DETECTION_FAILED'
  );
  assert.deepEqual(
    await decompress(packed, { fallbackAlgorithm: 'brotli' }),
    SAMPLE
  );
});

test('an out-of-range level is rejected', () => {
  assert.throws(
    () => compressSync(SAMPLE, { algorithm: 'gzip', level: 42 }),
    (error: unknown) =>
      error instanceof CompressionError && error.code === 'ERR_INVALID_LEVEL'
  );
  assert.deepEqual(levelRange('brotli'), { min: 0, max: 11 });
});

test('maxOutputSize guards against zip bombs', async () => {
  const bomb = zlib.gzipSync(Buffer.alloc(1024 * 1024));
  await assert.rejects(
    () => decompress(bomb, { maxOutputSize: 1024 }),
    (error: unknown) =>
      error instanceof CompressionError &&
      error.code === 'ERR_DECOMPRESSION_FAILED'
  );
});

test('corrupted data raises a typed error', async () => {
  const packed = await compress(SAMPLE, { algorithm: 'gzip' });
  packed[20] = packed[20]! ^ 0xff;
  await assert.rejects(
    () => decompress(packed),
    (error: unknown) =>
      error instanceof CompressionError &&
      error.code === 'ERR_DECOMPRESSION_FAILED'
  );
});

test('native options take precedence', async () => {
  const packed = await compress(SAMPLE, {
    algorithm: 'gzip',
    native: { level: zlib.constants.Z_NO_COMPRESSION },
  });
  assert.ok(packed.byteLength > SAMPLE.byteLength / 2);
  assert.deepEqual(await decompress(packed), SAMPLE);
});

test('empty input', async () => {
  const packed = await compress(Buffer.alloc(0), { algorithm: 'zstd' });
  assert.equal((await decompress(packed)).byteLength, 0);
});
