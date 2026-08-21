import { access, cp, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { CompressionError } from '../data/index.ts';

/** Folder name used both inside the package and under `.claude/skills`. */
export const SKILL_NAME = 'node-compressor';

/**
 * Finds the shipped skill: it sits at the package root, which is one level up
 * from `cli/` in the published layout and two in the source tree.
 */
async function locateSkill(): Promise<string> {
  let folder = import.meta.dirname;

  for (let level = 0; level < 3; level += 1) {
    folder = dirname(folder);
    const candidate = join(folder, 'skills', SKILL_NAME);
    try {
      await access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }

  throw new CompressionError(
    'ERR_DESTINATION_REQUIRED',
    'Could not locate the bundled Claude skill inside the package.'
  );
}

/**
 * Copies the Claude skill into `destination/.claude/skills/`, replacing a
 * previous copy so that upgrades land. Returns the folder it wrote.
 */
export async function installSkill(destination: string): Promise<string> {
  const source = await locateSkill();
  const target = join(destination, '.claude', 'skills', SKILL_NAME);

  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { recursive: true, force: true });

  return target;
}
