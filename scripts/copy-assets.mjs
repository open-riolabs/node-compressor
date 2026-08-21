#!/usr/bin/env node
/**
 * Build step: `tsc` only emits JavaScript, so the assets that ship with the
 * package — the Claude skill and its installer — are copied into `dist/`, which
 * is the root of the published package.
 */
import { cp, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const packageRoot = dirname(import.meta.dirname);
const dist = join(packageRoot, 'dist');

await cp(join(packageRoot, 'skills'), join(dist, 'skills'), { recursive: true });
await mkdir(join(dist, 'scripts'), { recursive: true });
await cp(
  join(packageRoot, 'scripts', 'install-skill.mjs'),
  join(dist, 'scripts', 'install-skill.mjs')
);

console.log('assets copied into dist/ (skills, scripts/install-skill.mjs)');
