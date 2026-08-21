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
import { Writable } from 'node:stream';
import { after, before, test } from 'node:test';

import { run } from '../main.ts';
import { matchesPattern } from '../glob.ts';

let dir = '';
let tree = '';

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'compressor-cli-'));
  tree = join(dir, 'project');
  await mkdir(join(tree, 'src'), { recursive: true });
  await writeFile(join(tree, 'README.md'), '# project\n'.repeat(40));
  await writeFile(
    join(tree, 'src', 'index.ts'),
    'export const value = 42;\n'.repeat(40)
  );
  await writeFile(join(tree, 'src', 'index.ts.map'), '{"version":3}');
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

function collector(): { stream: Writable; text: () => string } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk as Uint8Array));
      callback();
    },
  });
  return { stream, text: () => Buffer.concat(chunks).toString('utf8') };
}

interface Invocation {
  code: number;
  out: string;
  err: string;
}

async function cli(...argv: string[]): Promise<Invocation> {
  const out = collector();
  const err = collector();
  const code = await run(argv, { out: out.stream, err: err.stream });
  return { code, out: out.text(), err: err.text() };
}

test('no arguments prints the general help', async () => {
  const result = await cli();
  assert.equal(result.code, 0);
  assert.match(result.out, /Usage/);
  assert.match(result.out, /compressor <command>/);
});

test('per-command help', async () => {
  const result = await cli('pack', '--help');
  assert.equal(result.code, 0);
  assert.match(result.out, /Create a tar or zip archive/);
  assert.match(result.out, /--exclude/);
});

test('--version prints the package version', async () => {
  const result = await cli('--version');
  assert.equal(result.code, 0);
  assert.match(result.out.trim(), /^\d+\.\d+\.\d+/);
});

test('an unknown command exits with 2', async () => {
  const result = await cli('comprimi', 'file.txt');
  assert.equal(result.code, 2);
  assert.match(result.err, /unknown command/);
});

test('compress and decompress round-trip', async () => {
  const source = join(dir, 'data.txt');
  await writeFile(source, 'repeated content '.repeat(500));

  const compressed = await cli('compress', '-a', 'zstd', '-p', 'best', source);
  assert.equal(compressed.code, 0);
  assert.match(compressed.out, /data\.txt\.zst/);

  const restored = await cli(
    'decompress',
    `${source}.zst`,
    '-o',
    join(dir, 'restored.txt')
  );
  assert.equal(restored.code, 0);
  assert.equal(
    await readFile(join(dir, 'restored.txt'), 'utf8'),
    'repeated content '.repeat(500)
  );
});

test('compress --json reports the numbers', async () => {
  const source = join(dir, 'json-data.txt');
  await writeFile(source, 'x'.repeat(4000));

  const result = await cli('compress', '--json', source);
  assert.equal(result.code, 0);

  const [summary] = JSON.parse(result.out) as Array<{
    destination: string;
    bytesRead: number;
    bytesWritten: number;
  }>;
  assert.equal(summary?.destination, `${source}.gz`);
  assert.equal(summary?.bytesRead, 4000);
  assert.ok((summary?.bytesWritten ?? Infinity) < 4000);
});

test('an existing destination needs --force', async () => {
  const source = join(dir, 'twice.txt');
  await writeFile(source, 'content');

  assert.equal((await cli('compress', '-q', source)).code, 0);

  const blocked = await cli('compress', '-q', source);
  assert.equal(blocked.code, 1);
  assert.match(blocked.err, /ERR_DESTINATION_EXISTS/);

  assert.equal((await cli('compress', '-q', '--force', source)).code, 0);
});

test('pack, list and unpack', async () => {
  const archive = join(dir, 'release.tar.zst');

  const packed = await cli('pack', archive, tree, '--exclude', '*.map');
  assert.equal(packed.code, 0);
  assert.match(packed.out, /4 entries/); // project, README.md, src, src/index.ts

  const listed = await cli('list', archive);
  assert.equal(listed.code, 0);
  assert.match(listed.out, /project\/src\/index\.ts/);
  assert.doesNotMatch(listed.out, /\.map/);

  const target = join(dir, 'extracted');
  const unpacked = await cli('unpack', archive, target, '--strip', '1');
  assert.equal(unpacked.code, 0);
  assert.deepEqual((await readdir(target)).sort(), ['README.md', 'src']);
});

test('list --json exposes the metadata', async () => {
  const archive = join(dir, 'metadata.zip');
  assert.equal((await cli('pack', '-q', archive, tree)).code, 0);

  const result = await cli('list', '--json', archive);
  const entries = JSON.parse(result.out) as Array<{
    path: string;
    type: string;
    mtime: string;
  }>;

  assert.ok(entries.length >= 4);
  assert.ok(entries.every((entry) => typeof entry.mtime === 'string'));
  assert.ok(entries.some((entry) => entry.type === 'directory'));
});

test('list -l shows permissions and dates', async () => {
  const archive = join(dir, 'long.tar');
  assert.equal((await cli('pack', '-q', archive, tree)).code, 0);

  const result = await cli('list', '-l', archive);
  assert.match(result.out, /^[-d][rwx-]{9}\s/m);
  assert.match(result.out, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
});

test('info distinguishes plain files, compressed files and archives', async () => {
  const plain = join(dir, 'plain.txt');
  await writeFile(plain, 'not compressed at all');
  assert.equal((await cli('compress', '-q', plain)).code, 0);

  const archive = join(dir, 'info.tar.gz');
  assert.equal((await cli('pack', '-q', archive, tree)).code, 0);

  const result = await cli('info', plain, `${plain}.gz`, archive);
  assert.equal(result.code, 0);
  assert.match(result.out, /plain\.txt\s+21 B\s+file\s+not compressed/);
  assert.match(result.out, /plain\.txt\.gz\s+\S+ B\s+file\s+gzip compressed/);
  assert.match(
    result.out,
    /info\.tar\.gz\s+\S+ B\s+tar archive\s+gzip compressed/
  );
});

test('unpack refuses to overwrite without --force', async () => {
  const archive = join(dir, 'clash.tar');
  assert.equal((await cli('pack', '-q', archive, tree)).code, 0);

  const target = join(dir, 'clash-target');
  assert.equal((await cli('unpack', '-q', archive, target)).code, 0);

  const blocked = await cli('unpack', '-q', archive, target);
  assert.equal(blocked.code, 1);
  assert.match(blocked.err, /ERR_DESTINATION_EXISTS/);

  assert.equal((await cli('unpack', '-q', '--force', archive, target)).code, 0);
});

test('usage errors exit with 2', async () => {
  const noFile = await cli('compress');
  assert.equal(noFile.code, 2);
  assert.match(noFile.err, /at least one file/);

  const badAlgorithm = await cli('compress', '-a', 'lzma', 'file.txt');
  assert.equal(badAlgorithm.code, 2);
  assert.match(badAlgorithm.err, /unknown algorithm/);

  const badOption = await cli('pack', '--nope', 'a.tar', 'b');
  assert.equal(badOption.code, 2);

  const badLevel = await cli('compress', '-l', 'alto', 'file.txt');
  assert.equal(badLevel.code, 2);
  assert.match(badLevel.err, /non-negative integer/);
});

test('a missing file exits with 1', async () => {
  const result = await cli('compress', join(dir, 'does-not-exist.txt'));
  assert.equal(result.code, 1);
  assert.match(result.err, /file not found/);
});

test('--quiet keeps stdout empty', async () => {
  const source = join(dir, 'quiet.txt');
  await writeFile(source, 'content');

  const result = await cli('compress', '--quiet', source);
  assert.equal(result.code, 0);
  assert.equal(result.out, '');
});

test('glob patterns', () => {
  assert.ok(matchesPattern('src/index.ts', '*.ts'));
  assert.ok(matchesPattern('src/index.ts', 'src/*.ts'));
  assert.ok(matchesPattern('a/b/c/deep.ts', '**/deep.ts'));
  assert.ok(matchesPattern('deep.ts', '**/deep.ts'));
  assert.ok(matchesPattern('file.tsx', 'file.ts?'));
  assert.ok(!matchesPattern('src/index.ts', 'src/*.js'));
  assert.ok(!matchesPattern('src/nested/index.ts', 'src/*.ts'));
  assert.ok(!matchesPattern('index.test.ts', 'index.ts'));
});
