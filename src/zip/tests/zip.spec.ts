import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buffer as streamToBuffer } from 'node:stream/consumers';
import { after, before, test } from 'node:test';

import {
  CompressionError,
  ZipArchive,
  createZipArchive,
  createZipStream,
  extractZip,
  listZip,
  readZipEntry,
} from '../../index.ts';

let dir = '';
let tree = '';

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'compressor-zip-'));
  tree = join(dir, 'tree');
  await mkdir(join(tree, 'nested'), { recursive: true });
  await writeFile(join(tree, 'a.txt'), 'content A '.repeat(200));
  await writeFile(join(tree, 'nested', 'b.txt'), 'content B');
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('round-trip of a directory tree', async () => {
  const archive = join(dir, 'tree.zip');
  const result = await createZipArchive(archive, [tree]);

  assert.equal(result.format, 'zip');
  assert.ok(
    result.bytesWritten < result.bytesRead,
    'deflate must shrink the payload'
  );

  const destination = join(dir, 'extracted');
  const extracted = await extractZip(archive, destination);

  assert.equal(extracted.entries.length, 4);
  assert.equal(
    await readFile(join(destination, 'tree', 'nested', 'b.txt'), 'utf8'),
    'content B'
  );
  assert.equal(
    (await readFile(join(destination, 'tree', 'a.txt'), 'utf8')).length,
    2000
  );
});

test('listZip reports both compressed and uncompressed sizes', async () => {
  const archive = join(dir, 'metadata.zip');
  await createZipArchive(archive, [
    { path: 'text.txt', data: 'repeated '.repeat(500) },
  ]);

  const [entry] = await listZip(archive);
  assert.equal(entry?.path, 'text.txt');
  assert.equal(entry?.type, 'file');
  assert.equal(entry?.size, 4500);
  assert.ok((entry?.compressedSize ?? Infinity) < 4500);
});

test('the store method leaves the data uncompressed', async () => {
  const data = 'incompressible '.repeat(100);
  const archive = join(dir, 'store.zip');
  await createZipArchive(archive, [{ path: 'a.txt', data }], {
    method: 'store',
  });

  const [entry] = await listZip(archive);
  assert.equal(entry?.compressedSize, entry?.size);
  assert.equal((await readZipEntry(archive, 'a.txt')).toString('utf8'), data);
});

test('the zstd method', async () => {
  const data = 'repeated '.repeat(1000);
  const archive = join(dir, 'zstd.zip');
  await createZipArchive(archive, [{ path: 'a.txt', data }], {
    method: 'zstd',
  });

  const zip = await ZipArchive.open(archive);
  try {
    assert.equal(zip.entries[0]?.method, 93);
    assert.ok((zip.entries[0]?.compressedSize ?? Infinity) < data.length);
  } finally {
    await zip.close();
  }
  assert.equal((await readZipEntry(archive, 'a.txt')).toString('utf8'), data);
});

test('reading from an in-memory buffer', async () => {
  const bytes = await streamToBuffer(
    createZipStream([
      { path: 'one.txt', data: 'first' },
      { path: 'two.txt', data: 'second' },
    ])
  );

  assert.deepEqual(
    (await listZip(bytes)).map((entry) => entry.path),
    ['one.txt', 'two.txt']
  );
  assert.equal(
    (await readZipEntry(bytes, 'two.txt')).toString('utf8'),
    'second'
  );
});

test('ZipArchive reads single entries without extracting everything', async () => {
  const archive = join(dir, 'targeted.zip');
  await createZipArchive(archive, [
    { path: 'big.bin', data: Buffer.alloc(200_000, 7) },
    { path: 'small.txt', data: 'this was all I needed' },
  ]);

  const zip = await ZipArchive.open(archive);
  try {
    assert.equal(zip.entries.length, 2);
    assert.equal(
      (await zip.read('small.txt')).toString('utf8'),
      'this was all I needed'
    );
    assert.equal(
      (await streamToBuffer(await zip.stream('big.bin'))).byteLength,
      200_000
    );
    assert.equal(zip.entry('missing.txt'), undefined);
  } finally {
    await zip.close();
  }
});

test('a missing entry raises ERR_ENTRY_NOT_FOUND', async () => {
  const archive = join(dir, 'missing.zip');
  await createZipArchive(archive, [{ path: 'a.txt', data: 'x' }]);

  await assert.rejects(
    () => readZipEntry(archive, 'b.txt'),
    (error: unknown) =>
      error instanceof CompressionError && error.code === 'ERR_ENTRY_NOT_FOUND'
  );
});

test('the CRC catches damaged data', async () => {
  const data = 'verified content '.repeat(50);
  const bytes = await streamToBuffer(
    createZipStream([{ path: 'a.txt', data }], { method: 'store' })
  );

  // Stored data starts right after the local header.
  const dataOffset = 30 + bytes.readUInt16LE(26) + bytes.readUInt16LE(28);
  bytes[dataOffset + 10] = bytes[dataOffset + 10]! ^ 0xff;

  await assert.rejects(
    () => readZipEntry(bytes, 'a.txt'),
    (error: unknown) =>
      error instanceof CompressionError &&
      error.code === 'ERR_CHECKSUM_MISMATCH'
  );
});

test('a file that is not a zip raises ERR_ARCHIVE_INVALID', async () => {
  await assert.rejects(
    () => listZip(Buffer.from('really not a zip archive')),
    (error: unknown) =>
      error instanceof CompressionError && error.code === 'ERR_ARCHIVE_INVALID'
  );
});

test('strip, filter and overwrite on extraction', async () => {
  const archive = join(dir, 'filters.zip');
  await createZipArchive(archive, [
    { path: 'package/lib/one.js', data: 'one' },
    { path: 'package/test/two.js', data: 'two' },
  ]);

  const destination = join(dir, 'extracted-filters');
  const result = await extractZip(archive, destination, {
    strip: 1,
    filter: (entry) => !entry.path.includes('/test/'),
  });

  assert.equal(result.entries.length, 1);
  assert.deepEqual(await readdir(destination), ['lib']);

  await assert.rejects(
    () => extractZip(archive, destination, { strip: 1 }),
    (error: unknown) =>
      error instanceof CompressionError &&
      error.code === 'ERR_DESTINATION_EXISTS'
  );
  await extractZip(archive, destination, { strip: 1, overwrite: true });
});

test('malicious paths are rejected', async () => {
  // Hand-crafted: the public API refuses to create paths containing "..".
  // The replacement must keep the same length, or the recorded offsets break.
  const bytes = await streamToBuffer(
    createZipStream([{ path: 'innocent.txt', data: 'x' }])
  );
  const patched = Buffer.from(
    bytes.toString('latin1').replaceAll('innocent.txt', '../escape.js'),
    'latin1'
  );

  await assert.rejects(
    () => extractZip(patched, join(dir, 'extracted-malicious')),
    (error: unknown) =>
      error instanceof CompressionError &&
      error.code === 'ERR_UNSAFE_ENTRY_PATH'
  );
});

test('non-ASCII names survive the round-trip', async () => {
  const archive = join(dir, 'unicode.zip');
  await createZipArchive(archive, [
    { path: 'folder/àèìòù — 日本語.txt', data: 'content' },
  ]);

  const [entry] = await listZip(archive);
  assert.equal(entry?.path, 'folder/àèìòù — 日本語.txt');
  assert.equal(
    (await readZipEntry(archive, 'folder/àèìòù — 日本語.txt')).toString('utf8'),
    'content'
  );
});

test('an empty archive', async () => {
  const archive = join(dir, 'empty.zip');
  const result = await createZipArchive(archive, []);
  assert.equal(result.entries.length, 0);
  assert.deepEqual(await listZip(archive), []);
});

test('more than 65535 entries switches to ZIP64', async () => {
  const count = 65_600;
  const sources = Array.from({ length: count }, (_, index) => ({
    path: `entry-${index}.txt`,
    data: 'x',
  }));

  const bytes = await streamToBuffer(
    createZipStream(sources, { method: 'store' })
  );
  const entries = await listZip(bytes);

  assert.equal(entries.length, count);
  assert.equal(entries.at(-1)?.path, `entry-${count - 1}.txt`);
  assert.equal(
    (await readZipEntry(bytes, `entry-${count - 1}.txt`)).toString('utf8'),
    'x'
  );
});
