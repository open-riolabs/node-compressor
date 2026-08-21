import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { after, before, test } from 'node:test';

import { run } from '../main.ts';
import { SKILL_NAME, installSkill } from '../skill.ts';

let dir = '';

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'compressor-skill-'));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

function sink(): { stream: Writable; text: () => string } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk as Uint8Array));
      callback();
    },
  });
  return { stream, text: () => Buffer.concat(chunks).toString('utf8') };
}

test('installSkill copies the skill into .claude/skills', async () => {
  const target = await installSkill(dir);

  assert.equal(target, join(dir, '.claude', 'skills', SKILL_NAME));
  assert.deepEqual((await readdir(target)).sort(), [
    'SKILL.md',
    'reference.md',
  ]);

  // Normalised: the checkout materialises CRLF on every platform.
  const skill = (await readFile(join(target, 'SKILL.md'), 'utf8')).replace(
    /\r\n/g,
    '\n'
  );
  assert.match(skill, /^---\nname: node-compressor\n/);
  assert.match(skill, /description: .+/);
});

test('installing twice replaces the previous copy', async () => {
  const first = await installSkill(dir);
  const second = await installSkill(dir);

  assert.equal(first, second);
  assert.deepEqual((await readdir(second)).sort(), [
    'SKILL.md',
    'reference.md',
  ]);
});

test('the CLI command reports where it wrote', async () => {
  const project = join(dir, 'project');
  const out = sink();
  const err = sink();

  const code = await run(['install-skill', project], {
    out: out.stream,
    err: err.stream,
  });

  assert.equal(code, 0);
  assert.match(out.text(), /Claude skill installed in/);
  assert.match(
    await readFile(
      join(project, '.claude', 'skills', SKILL_NAME, 'SKILL.md'),
      'utf8'
    ),
    /node-compressor/
  );
});

test('the CLI command speaks JSON too', async () => {
  const project = join(dir, 'json-project');
  const out = sink();
  const err = sink();

  const code = await run(['install-skill', '--json', project], {
    out: out.stream,
    err: err.stream,
  });

  assert.equal(code, 0);
  const report = JSON.parse(out.text()) as {
    skill: string;
    destination: string;
  };
  assert.equal(report.skill, SKILL_NAME);
  assert.equal(
    report.destination,
    join(project, '.claude', 'skills', SKILL_NAME)
  );
});

test('more than one directory is a usage error', async () => {
  const out = sink();
  const err = sink();

  const code = await run(['install-skill', 'a', 'b'], {
    out: out.stream,
    err: err.stream,
  });

  assert.equal(code, 2);
  assert.match(err.text(), /single directory/);
});
