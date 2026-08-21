import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buffer as streamToBuffer } from 'node:stream/consumers';
import { after, before, test } from 'node:test';

import {
  CompressionError,
  compressionForArchivePath,
  createArchive,
  createTarStream,
  createZipStream,
  detectArchiveFile,
  detectArchiveFormat,
  extractArchive,
  formatForPath,
  listArchive,
} from '../../index.ts';

let dir = '';
let tree = '';

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'compressor-archive-'));
  tree = join(dir, 'project');
  await mkdir(join(tree, 'src'), { recursive: true });
  await writeFile(join(tree, 'README.md'), '# project\n'.repeat(50));
  await writeFile(
    join(tree, 'src', 'index.ts'),
    'export const value = 42;\n'.repeat(50)
  );
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const VARIANTS = [
  { name: 'project.tar', format: 'tar', compression: 'none' },
  { name: 'project.tar.gz', format: 'tar', compression: 'gzip' },
  { name: 'project.tgz', format: 'tar', compression: 'gzip' },
  { name: 'project.tar.br', format: 'tar', compression: 'brotli' },
  { name: 'project.tar.zst', format: 'tar', compression: 'zstd' },
  { name: 'project.zip', format: 'zip', compression: 'deflate-raw' },
] as const;

for (const variant of VARIANTS) {
  test(`${variant.name}: create, list and extract`, async () => {
    const archive = join(dir, variant.name);
    const created = await createArchive(archive, [tree]);

    assert.equal(created.format, variant.format);
    assert.equal(created.compression, variant.compression);
    assert.equal(created.entries.length, 4);

    assert.equal(await detectArchiveFile(archive), variant.format);

    const listed = await listArchive(archive);
    assert.deepEqual(listed.map((entry) => entry.path).sort(), [
      'project',
      'project/README.md',
      'project/src',
      'project/src/index.ts',
    ]);

    const destination = join(dir, `extracted-${variant.name}`);
    const extracted = await extractArchive(archive, destination);

    assert.equal(extracted.format, variant.format);
    assert.equal(
      await readFile(join(destination, 'project', 'src', 'index.ts'), 'utf8'),
      'export const value = 42;\n'.repeat(50)
    );
  });
}

test('compression really does shrink the archive', async () => {
  const plain = await createArchive(join(dir, 'comparison.tar'), [tree]);
  const compressed = await createArchive(
    join(dir, 'comparison.tar.zst'),
    [tree],
    {
      compressionOptions: { preset: 'best' },
    }
  );

  assert.ok(compressed.bytesWritten < plain.bytesWritten / 4);
});

test('detectArchiveFormat recognises the magic bytes', async () => {
  const tar = await streamToBuffer(
    createTarStream([{ path: 'a.txt', data: 'x' }])
  );
  const zip = await streamToBuffer(
    createZipStream([{ path: 'a.txt', data: 'x' }])
  );

  assert.equal(detectArchiveFormat(tar), 'tar');
  assert.equal(detectArchiveFormat(zip), 'zip');
  assert.equal(detectArchiveFormat(Buffer.from('just some text')), undefined);
});

test('format and compression inferred from the file name', () => {
  assert.equal(formatForPath('a.zip'), 'zip');
  assert.equal(formatForPath('a.tar.gz'), 'tar');
  assert.equal(compressionForArchivePath('a.tar'), 'none');
  assert.equal(compressionForArchivePath('a.tgz'), 'gzip');
  assert.equal(compressionForArchivePath('a.tar.zst'), 'zstd');
  assert.equal(compressionForArchivePath('a.zip'), 'none');
});

test('an explicit format takes precedence over the extension', async () => {
  const archive = join(dir, 'disguised.dat');
  const created = await createArchive(
    archive,
    [{ path: 'a.txt', data: 'hello' }],
    {
      format: 'zip',
    }
  );

  assert.equal(created.format, 'zip');
  assert.equal(await detectArchiveFile(archive), 'zip');
});

test('an unrecognised file raises ERR_ARCHIVE_UNSUPPORTED', async () => {
  const path = join(dir, 'whatever.dat');
  await writeFile(path, 'not an archive at all');

  await assert.rejects(
    () => extractArchive(path, join(dir, 'extracted-whatever')),
    (error: unknown) =>
      error instanceof CompressionError &&
      error.code === 'ERR_ARCHIVE_UNSUPPORTED'
  );
});

test('onEntry reports the entries while the archive is built', async () => {
  const seen: string[] = [];
  await createArchive(join(dir, 'events.tar.gz'), [tree], {
    onEntry: (entry) => seen.push(entry.path),
  });

  assert.deepEqual(seen.sort(), [
    'project',
    'project/README.md',
    'project/src',
    'project/src/index.ts',
  ]);
});

test('overwriting an archive is protected', async () => {
  const archive = join(dir, 'protected.zip');
  await createArchive(archive, [{ path: 'a.txt', data: 'one' }]);

  await assert.rejects(
    () => createArchive(archive, [{ path: 'a.txt', data: 'two' }]),
    (error: unknown) =>
      error instanceof CompressionError &&
      error.code === 'ERR_DESTINATION_EXISTS'
  );

  const result = await createArchive(
    archive,
    [{ path: 'a.txt', data: 'two' }],
    { overwrite: true }
  );
  assert.equal(result.entries.length, 1);
});

test('createDestinationDir creates the archive directory', async () => {
  const archive = join(dir, 'new', 'folder', 'archive.tar.gz');
  const result = await createArchive(
    archive,
    [{ path: 'a.txt', data: 'one' }],
    {
      createDestinationDir: true,
    }
  );
  assert.equal(result.destination, archive);
});

test('AbortSignal cancels the creation', async () => {
  const controller = new AbortController();
  const sources = Array.from({ length: 500 }, (_, index) => ({
    path: `entry-${index}.txt`,
    data: 'x'.repeat(10_000),
  }));

  const promise = createArchive(join(dir, 'aborted.tar.gz'), sources, {
    signal: controller.signal,
  });
  controller.abort();

  await assert.rejects(promise);
});
