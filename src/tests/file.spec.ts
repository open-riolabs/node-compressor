import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { gzipSync } from 'node:zlib';

import {
  CompressionError,
  compressFile,
  decompressFile,
  detectFile,
  type Progress,
} from '../index.ts';

const CONTENT = Buffer.from('repeated test data — '.repeat(2000), 'utf8');
let dir = '';

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'compressor-test-'));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function fixture(
  name: string,
  content: Buffer = CONTENT
): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, content);
  return path;
}

test('compressFile: destination inferred from the algorithm', async () => {
  const source = await fixture('a.txt');
  const result = await compressFile(source, { algorithm: 'zstd' });

  assert.equal(result.destination, `${source}.zst`);
  assert.equal(result.algorithm, 'zstd');
  assert.equal(result.bytesRead, CONTENT.byteLength);
  assert.ok(
    result.bytesWritten > 0 && result.bytesWritten < CONTENT.byteLength
  );
  assert.ok(result.compressionRatio < 1);
  assert.equal(await detectFile(result.destination), 'zstd');
});

test('compressFile: algorithm inferred from the destination extension', async () => {
  const source = await fixture('b.txt');
  const result = await compressFile(source, join(dir, 'b.txt.br'));
  assert.equal(result.algorithm, 'brotli');
});

test('file round-trip with automatic detection', async () => {
  const source = await fixture('c.txt');
  const { destination } = await compressFile(source, { algorithm: 'gzip' });

  const restored = await decompressFile(
    destination,
    join(dir, 'c.restored.txt')
  );
  assert.equal(restored.algorithm, 'gzip');
  assert.deepEqual(await readFile(restored.destination), CONTENT);
});

test('decompressFile: destination inferred by dropping the extension', async () => {
  const source = await fixture('d.txt');
  const { destination } = await compressFile(
    source,
    join(dir, 'd.copy.txt.gz')
  );
  const restored = await decompressFile(destination);
  assert.equal(restored.destination, join(dir, 'd.copy.txt'));
});

test('.tgz becomes .tar again', async () => {
  const source = await fixture('e.tar');
  const { destination } = await compressFile(source, join(dir, 'e.tgz'));
  const restored = await decompressFile(destination, { overwrite: true });
  assert.equal(restored.destination, join(dir, 'e.tar'));
});

test('an existing destination is protected unless overwrite is passed', async () => {
  const source = await fixture('f.txt');
  await compressFile(source);
  await assert.rejects(
    () => compressFile(source),
    (error: unknown) =>
      error instanceof CompressionError &&
      error.code === 'ERR_DESTINATION_EXISTS'
  );
  const result = await compressFile(source, { overwrite: true });
  assert.equal(result.destination, `${source}.gz`);
});

test('identical source and destination are rejected', async () => {
  const source = await fixture('g.txt');
  await assert.rejects(
    () => compressFile(source, source),
    (error: unknown) =>
      error instanceof CompressionError &&
      error.code === 'ERR_DESTINATION_EXISTS'
  );
});

test('an unrecognised extension requires an explicit destination', async () => {
  // Recognisable content (gzip) but unknown extension: only the destination is missing.
  const source = await fixture('h.bin', gzipSync(CONTENT));
  await assert.rejects(
    () => decompressFile(source),
    (error: unknown) =>
      error instanceof CompressionError &&
      error.code === 'ERR_DESTINATION_REQUIRED'
  );
  const result = await decompressFile(source, join(dir, 'h.out'));
  assert.deepEqual(await readFile(result.destination), CONTENT);
});

test('unrecognisable format: ERR_DETECTION_FAILED', async () => {
  const source = await fixture(
    'plain.bin',
    Buffer.from('not compressed at all')
  );
  await assert.rejects(
    () => decompressFile(source, join(dir, 'plain.out')),
    (error: unknown) =>
      error instanceof CompressionError && error.code === 'ERR_DETECTION_FAILED'
  );
});

test('onProgress reports progress up to 100%', async () => {
  const source = await fixture('i.txt');
  const seen: Progress[] = [];
  await compressFile(source, join(dir, 'i.txt.gz'), {
    onProgress: (p) => seen.push(p),
  });

  assert.ok(seen.length > 0);
  assert.equal(seen.at(-1)?.bytesRead, CONTENT.byteLength);
  assert.equal(seen.at(-1)?.ratio, 1);
});

test('createDestinationDir creates the missing directory', async () => {
  const source = await fixture('j.txt');
  const target = join(dir, 'nested', 'deep', 'j.txt.br');
  const result = await compressFile(source, target, {
    createDestinationDir: true,
  });
  assert.equal(result.destination, target);
});

test('a failure leaves neither partial nor temporary files', async () => {
  const corrupted = join(dir, 'k.txt.gz');
  await writeFile(
    corrupted,
    Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff])
  );

  await assert.rejects(() => decompressFile(corrupted, join(dir, 'k.out.txt')));

  const files = await readdir(dir);
  assert.equal(files.filter((f) => f.endsWith('.tmp')).length, 0);
  assert.ok(!files.includes('k.out.txt'));
});

test('empty file: ratio 1 and a correct round-trip', async () => {
  const source = await fixture('empty.txt', Buffer.alloc(0));
  const result = await compressFile(source, { algorithm: 'gzip' });
  assert.equal(result.compressionRatio, 1);

  const restored = await decompressFile(
    result.destination,
    join(dir, 'empty.out')
  );
  assert.equal(restored.bytesWritten, 0);
});
