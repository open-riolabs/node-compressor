import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import { dirname, resolve as resolvePath } from 'node:path';

import { CompressionError } from './data/index.ts';
import type { DestinationOptions } from './data/index.ts';

let temporaryCounter = 0;

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates the destination before any byte is written: identical paths,
 * missing directory, file already there.
 */
export async function prepareDestination(
  destination: string,
  options: DestinationOptions,
  source?: string
): Promise<void> {
  if (
    source !== undefined &&
    resolvePath(source) === resolvePath(destination)
  ) {
    throw new CompressionError(
      'ERR_DESTINATION_EXISTS',
      `Source and destination are the same path: "${destination}".`
    );
  }
  if (options.createDestinationDir === true) {
    await mkdir(dirname(resolvePath(destination)), { recursive: true });
  }
  if (options.overwrite !== true && (await exists(destination))) {
    throw new CompressionError(
      'ERR_DESTINATION_EXISTS',
      `Destination "${destination}" already exists. Pass { overwrite: true } to replace it.`
    );
  }
}

/**
 * Writes to a temporary file in the same directory and renames it only once
 * the operation completed: the destination is never left half-written.
 */
export async function withTemporaryTarget<T>(
  destination: string,
  run: (temporaryPath: string) => Promise<T>
): Promise<T> {
  const temporary = `${destination}.${process.pid}-${temporaryCounter++}.tmp`;
  try {
    const result = await run(temporary);
    await rename(temporary, destination);
    return result;
  } catch (error) {
    await unlink(temporary).catch(() => {
      // The temporary file may never have been created.
    });
    throw error;
  }
}
