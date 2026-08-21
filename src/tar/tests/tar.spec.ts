import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buffer as streamToBuffer } from 'node:stream/consumers';
import { after, before, test } from 'node:test';

import {
  CompressionError,
  createTarArchive,
  createTarStream,
  extractTar,
  listTar,
  readTarEntries,
} from '../../index.ts';
import { encodeTarHeader } from '../header.ts';

let dir = '';
let tree = '';

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'compressor-tar-'));
  tree = join(dir, 'tree');
  await mkdir(join(tree, 'nested'), { recursive: true });
  await writeFile(join(tree, 'a.txt'), 'content A '.repeat(200));
  await writeFile(join(tree, 'nested', 'b.txt'), 'content B');
  await writeFile(join(tree, 'nested', 'empty.bin'), Buffer.alloc(0));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Symlinks need privileges on Windows, so the test adapts. */
async function symlinkSupported(): Promise<boolean> {
  const probe = join(dir, `probe-${Math.random().toString(36).slice(2)}`);
  try {
    await symlink('a.txt', probe);
    return true;
  } catch {
    return false;
  }
}

test('round-trip of a directory tree', async () => {
  const archive = join(dir, 'tree.tar');
  const result = await createTarArchive(archive, [tree]);

  assert.equal(result.format, 'tar');
  assert.equal(result.compression, 'none');
  assert.deepEqual(result.entries.map((entry) => entry.path).sort(), [
    'tree',
    'tree/a.txt',
    'tree/nested',
    'tree/nested/b.txt',
    'tree/nested/empty.bin',
  ]);

  const destination = join(dir, 'extracted');
  const extracted = await extractTar(archive, destination);

  assert.equal(extracted.entries.length, 5);
  assert.equal(
    await readFile(join(destination, 'tree', 'nested', 'b.txt'), 'utf8'),
    'content B'
  );
  assert.equal(
    (await readFile(join(destination, 'tree', 'a.txt'), 'utf8')).length,
    2000
  );
});

test('in-memory entries and compression inferred from the extension', async () => {
  const archive = join(dir, 'mixed.tar.zst');
  const result = await createTarArchive(archive, [
    { path: 'notes/reminder.txt', data: 'hello — àèì' },
    { path: 'empty-dir', type: 'directory' },
    { path: 'binary.bin', data: new Uint8Array([1, 2, 3, 4]) },
  ]);

  assert.equal(result.compression, 'zstd');

  const entries = await listTar(archive);
  assert.deepEqual(
    entries.map((entry) => `${entry.type}:${entry.path}`),
    ['file:notes/reminder.txt', 'directory:empty-dir', 'file:binary.bin']
  );

  const destination = join(dir, 'extracted-mixed');
  await extractTar(archive, destination);
  assert.equal(
    await readFile(join(destination, 'notes', 'reminder.txt'), 'utf8'),
    'hello — àèì'
  );
  assert.deepEqual(
    await readFile(join(destination, 'binary.bin')),
    Buffer.from([1, 2, 3, 4])
  );
});

test('paths longer than 100 bytes go through PAX headers', async () => {
  const longPath = `${'very-long-directory/'.repeat(8)}file.txt`;
  assert.ok(longPath.length > 100);

  const archive = join(dir, 'long-names.tar.gz');
  await createTarArchive(archive, [{ path: longPath, data: 'content' }]);

  const entries = await listTar(archive);
  assert.equal(entries[0]?.path, longPath);

  const destination = join(dir, 'extracted-long-names');
  await extractTar(archive, destination);
  assert.equal(await readFile(join(destination, longPath), 'utf8'), 'content');
});

test('createTarStream composes with the other streams', async () => {
  const tar = createTarStream([
    { path: 'a.txt', data: 'one' },
    { path: 'b.txt', data: 'two' },
  ]);
  const bytes = await streamToBuffer(tar);

  // Header + data + end of archive, all aligned to 512 bytes.
  assert.equal(bytes.byteLength % 512, 0);
  assert.equal(bytes.subarray(257, 262).toString('ascii'), 'ustar');

  const entries = await listTar(bytes);
  assert.deepEqual(
    entries.map((entry) => entry.path),
    ['a.txt', 'b.txt']
  );
});

test('readTarEntries exposes the content entry by entry', async () => {
  const tar = await streamToBuffer(
    createTarStream([
      { path: 'first.txt', data: 'content of the first' },
      { path: 'second.txt', data: 'content of the second' },
    ])
  );

  const letti: string[] = [];
  for await (const entry of readTarEntries(tar)) {
    letti.push(
      `${entry.path}=${(await streamToBuffer(entry.body)).toString('utf8')}`
    );
  }

  assert.deepEqual(letti, [
    'first.txt=content of the first',
    'second.txt=content of the second',
  ]);
});

test('skipping an entry body keeps the parser aligned', async () => {
  const tar = await streamToBuffer(
    createTarStream([
      { path: 'big.txt', data: 'x'.repeat(5000) },
      { path: 'after.txt', data: 'still here' },
    ])
  );

  const paths: string[] = [];
  for await (const entry of readTarEntries(tar)) {
    paths.push(entry.path); // the body is deliberately ignored
  }
  assert.deepEqual(paths, ['big.txt', 'after.txt']);
});

test('strip and filter on extraction', async () => {
  const archive = join(dir, 'filters.tar');
  await createTarArchive(archive, [
    { path: 'package/lib/one.js', data: 'one' },
    { path: 'package/lib/two.js', data: 'two' },
    { path: 'package/test/three.js', data: 'three' },
  ]);

  const destination = join(dir, 'extracted-filters');
  const result = await extractTar(archive, destination, {
    strip: 1,
    filter: (entry) => !entry.path.includes('/test/'),
  });

  assert.equal(result.entries.length, 2);
  assert.deepEqual((await readdir(join(destination, 'lib'))).sort(), [
    'one.js',
    'two.js',
  ]);
  assert.deepEqual(await readdir(destination), ['lib']);
});

test('paths containing ".." are rejected on extraction', async () => {
  const malicious = Buffer.concat([
    encodeTarHeader({
      path: '../outside.txt',
      type: 'file',
      size: 5,
      mode: 0o644,
      mtime: new Date(),
    }),
    Buffer.concat([Buffer.from('BOOM!'), Buffer.alloc(507)]),
    Buffer.alloc(1024),
  ]);

  await assert.rejects(
    () => extractTar(malicious, join(dir, 'extracted-malicious')),
    (error: unknown) =>
      error instanceof CompressionError &&
      error.code === 'ERR_UNSAFE_ENTRY_PATH'
  );
});

test('absolute paths are rejected on extraction', async () => {
  const malicious = Buffer.concat([
    encodeTarHeader({
      path: '/etc/passwd',
      type: 'file',
      size: 0,
      mode: 0o644,
      mtime: new Date(),
    }),
    Buffer.alloc(1024),
  ]);

  await assert.rejects(
    () => extractTar(malicious, join(dir, 'extracted-absolute')),
    (error: unknown) =>
      error instanceof CompressionError &&
      error.code === 'ERR_UNSAFE_ENTRY_PATH'
  );
});

test('a truncated archive raises ERR_ARCHIVE_INVALID', async () => {
  const tar = await streamToBuffer(
    createTarStream([{ path: 'a.txt', data: 'x'.repeat(2000) }])
  );
  await assert.rejects(
    () => listTar(tar.subarray(0, 900)),
    (error: unknown) =>
      error instanceof CompressionError && error.code === 'ERR_ARCHIVE_INVALID'
  );
});

test('a corrupted header raises ERR_ARCHIVE_INVALID', async () => {
  const tar = await streamToBuffer(
    createTarStream([{ path: 'a.txt', data: 'content' }])
  );
  tar[10] = 0x41; // dirties the mode field without fixing the checksum
  await assert.rejects(
    () => listTar(tar),
    (error: unknown) =>
      error instanceof CompressionError && error.code === 'ERR_ARCHIVE_INVALID'
  );
});

test('extraction will not overwrite by default', async () => {
  const archive = join(dir, 'overwrite.tar');
  await createTarArchive(archive, [{ path: 'a.txt', data: 'new content' }]);

  const destination = join(dir, 'extracted-overwrite');
  await mkdir(destination, { recursive: true });
  await writeFile(join(destination, 'a.txt'), 'existing');

  await assert.rejects(
    () => extractTar(archive, destination),
    (error: unknown) =>
      error instanceof CompressionError &&
      error.code === 'ERR_DESTINATION_EXISTS'
  );

  await extractTar(archive, destination, { overwrite: true });
  assert.equal(
    await readFile(join(destination, 'a.txt'), 'utf8'),
    'new content'
  );
});

test('symbolic links survive the round-trip', async (t) => {
  if (!(await symlinkSupported())) {
    t.skip('symlinks are not supported on this platform');
    return;
  }

  const source = join(dir, 'with-link');
  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'real.txt'), 'real content');
  await symlink('real.txt', join(source, 'link.txt'));

  const archive = join(dir, 'link.tar');
  const result = await createTarArchive(archive, [source]);
  const symlinkEntry = result.entries.find((entry) => entry.type === 'symlink');
  assert.equal(symlinkEntry?.linkPath, 'real.txt');

  const destination = join(dir, 'extracted-link');
  await extractTar(archive, destination);
  assert.equal(
    await readFile(join(destination, 'with-link', 'link.txt'), 'utf8'),
    'real content'
  );
});

test('links pointing outside the destination are not created', async () => {
  const archive = join(dir, 'external-link.tar');
  await createTarArchive(archive, [
    { path: 'escape.txt', type: 'symlink', linkPath: '../../../etc/passwd' },
  ]);

  const [entry] = await listTar(archive);
  assert.equal(entry?.type, 'symlink');
  assert.equal(entry?.linkPath, '../../../etc/passwd');

  const destination = join(dir, 'extracted-external-link');
  const result = await extractTar(archive, destination);
  assert.equal(result.entries.length, 0);
  assert.deepEqual(await readdir(destination), []);

  await assert.rejects(
    () =>
      extractTar(archive, join(dir, 'extracted-link-error'), {
        symlinks: 'error',
      }),
    (error: unknown) =>
      error instanceof CompressionError &&
      error.code === 'ERR_UNSAFE_ENTRY_PATH'
  );
});

test('root controls the paths stored in the archive', async () => {
  const archive = join(dir, 'root-option.tar');
  const result = await createTarArchive(archive, [join(tree, 'nested')], {
    root: tree,
  });

  assert.deepEqual(result.entries.map((entry) => entry.path).sort(), [
    'nested',
    'nested/b.txt',
    'nested/empty.bin',
  ]);
});
