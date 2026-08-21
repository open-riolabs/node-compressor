import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { buffer as toBuffer } from 'node:stream/consumers';
import { test } from 'node:test';

import {
  ALGORITHMS,
  CompressionError,
  compressStream,
  createCompressStream,
  createDecompressStream,
  createProgressStream,
  decompressStream,
  type Progress,
} from '../index.ts';

const CHUNKS = Array.from({ length: 64 }, (_, i) =>
  Buffer.from(`line number ${i}\n`.repeat(64))
);
const EXPECTED = Buffer.concat(CHUNKS);

for (const algorithm of ALGORITHMS) {
  test(`${algorithm}: stream round-trip`, async () => {
    const compressed = await toBuffer(
      compressStream(Readable.from(CHUNKS), { algorithm })
    );
    assert.ok(compressed.byteLength < EXPECTED.byteLength);

    const restored = await toBuffer(
      decompressStream(Readable.from([compressed]), { algorithm })
    );
    assert.deepEqual(restored, EXPECTED);
  });
}

test('auto decompression detects the format from the stream', async () => {
  for (const algorithm of ['gzip', 'deflate', 'zstd'] as const) {
    const compressed = await toBuffer(
      compressStream(Readable.from(CHUNKS), { algorithm })
    );
    const restored = await toBuffer(
      decompressStream(Readable.from([compressed]), {})
    );
    assert.deepEqual(restored, EXPECTED);
  }
});

test('auto decompression copes with one-byte chunks', async () => {
  const compressed = await toBuffer(
    compressStream(Readable.from(CHUNKS), { algorithm: 'gzip' })
  );
  const oneByteAtATime = Readable.from(
    (function* () {
      for (const byte of compressed) yield Buffer.from([byte]);
    })()
  );
  assert.deepEqual(await toBuffer(decompressStream(oneByteAtATime)), EXPECTED);
});

test('auto with an explicit brotli fallback', async () => {
  const compressed = await toBuffer(
    compressStream(Readable.from(CHUNKS), { algorithm: 'brotli' })
  );
  const restored = await toBuffer(
    decompressStream(Readable.from([compressed]), {
      fallbackAlgorithm: 'brotli',
    })
  );
  assert.deepEqual(restored, EXPECTED);
});

test('auto without a fallback emits ERR_DETECTION_FAILED on the stream', async () => {
  const compressed = await toBuffer(
    compressStream(Readable.from(CHUNKS), { algorithm: 'brotli' })
  );
  await assert.rejects(
    () => toBuffer(decompressStream(Readable.from([compressed]))),
    (error: unknown) =>
      error instanceof CompressionError && error.code === 'ERR_DETECTION_FAILED'
  );
});

test('the transforms compose with pipeline()', async () => {
  const chunks: Buffer[] = [];
  await pipeline(
    Readable.from(CHUNKS),
    createCompressStream({ algorithm: 'zstd', preset: 'fast' }),
    createDecompressStream({ algorithm: 'zstd' }),
    async function* (source) {
      for await (const chunk of source) {
        chunks.push(Buffer.from(chunk as Uint8Array));
        yield chunk;
      }
    }
  );
  assert.deepEqual(Buffer.concat(chunks), EXPECTED);
});

test('createProgressStream counts bytes without altering them', async () => {
  const seen: Progress[] = [];
  const output = await toBuffer(
    Readable.from(CHUNKS).pipe(
      createProgressStream((p) => seen.push(p), EXPECTED.byteLength)
    )
  );
  assert.deepEqual(output, EXPECTED);
  assert.equal(seen.at(-1)?.bytesRead, EXPECTED.byteLength);
  assert.equal(seen.at(-1)?.ratio, 1);
});

test('AbortSignal cancels compression', async () => {
  const controller = new AbortController();
  const source = Readable.from(
    (async function* () {
      for (;;) {
        yield Buffer.alloc(1024, 1);
        await new Promise((r) => setTimeout(r, 1));
      }
    })()
  );
  const stream = compressStream(source, {
    algorithm: 'gzip',
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(() => toBuffer(stream));
});

test('an error from the source propagates to the consumer', async () => {
  const failing = Readable.from(
    (function* () {
      yield Buffer.from('hello');
      throw new Error('broken source');
    })()
  );
  await assert.rejects(
    () => toBuffer(compressStream(failing)),
    /broken source/
  );
});
