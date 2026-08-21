#!/usr/bin/env node
/**
 * postinstall hook: hands over to the packaged CLI so the copy logic lives in
 * one place. It stays silent on failure — a documentation file is never a
 * reason to break someone's `npm install`.
 *
 * Set `NODE_COMPRESSOR_SKIP_SKILL=1` to opt out. Package managers that block
 * dependency install scripts (npm 11+ by default) skip this entirely; run
 * `npx node-compressor install-skill` instead.
 */
import { spawnSync } from 'node:child_process';
import { access } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

async function installSkill() {
  if (process.env.NODE_COMPRESSOR_SKIP_SKILL) return;

  // npm sets INIT_CWD to the directory the install was started from.
  const projectRoot = process.env.INIT_CWD;
  if (!projectRoot) return;

  const packageRoot = dirname(import.meta.dirname);

  // Installing the package inside its own repository: nothing to copy.
  if (relative(resolve(packageRoot), resolve(projectRoot)) === '') return;

  // Only write into something that actually looks like a project.
  await access(join(projectRoot, 'package.json'));

  const cli = join(packageRoot, 'cli', 'index.js');
  await access(cli);

  spawnSync(process.execPath, [cli, 'install-skill', projectRoot], {
    stdio: 'inherit',
  });
}

installSkill().catch(() => {
  // Never fail the install.
});
