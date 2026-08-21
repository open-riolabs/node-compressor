import { createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, symlink, unlink, utimes } from 'node:fs/promises';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { pipeline } from 'node:stream/promises';

import { CompressionError } from '../data/index.ts';
import { exists } from '../fsutil.ts';
import { isInside, sanitizeExtractPath } from './paths.ts';
import type { ArchiveEntry, ExtractOptions } from '../data/index.ts';

/**
 * Destination of an extraction: applies filters, `strip` and the path safety
 * checks, then materialises the entries on disk.
 */
export class ExtractTarget {
  readonly #destination: string;
  readonly #options: ExtractOptions;
  readonly #entries: ArchiveEntry[] = [];
  readonly #directoryTimes: Array<{ path: string; mtime: Date }> = [];
  #bytesWritten = 0;

  constructor(destination: string, options: ExtractOptions = {}) {
    this.#destination = resolvePath(destination);
    this.#options = options;
  }

  get entries(): ArchiveEntry[] {
    return this.#entries;
  }

  get bytesWritten(): number {
    return this.#bytesWritten;
  }

  async prepare(): Promise<void> {
    await mkdir(this.#destination, { recursive: true });
  }

  /**
   * Applies filter, `strip` and the zip-slip checks. Returns the absolute
   * destination path, or `undefined` when the entry should be skipped.
   */
  plan(entry: ArchiveEntry): string | undefined {
    this.#options.signal?.throwIfAborted();
    if (this.#options.filter && this.#options.filter(entry) !== true)
      return undefined;

    const relativePath = sanitizeExtractPath(
      entry.path,
      this.#options.strip ?? 0
    );
    if (relativePath === undefined) return undefined;

    const target = join(this.#destination, relativePath);
    if (!isInside(this.#destination, target)) {
      throw new CompressionError(
        'ERR_UNSAFE_ENTRY_PATH',
        `Entry "${entry.path}" would escape the destination directory.`
      );
    }
    return target;
  }

  async #ensureWritable(target: string): Promise<void> {
    await mkdir(dirname(target), { recursive: true });
    if (this.#options.overwrite === true) {
      await unlink(target).catch(() => {
        // Not existing yet is the normal case.
      });
      return;
    }
    if (await exists(target)) {
      throw new CompressionError(
        'ERR_DESTINATION_EXISTS',
        `"${target}" already exists. Pass { overwrite: true } to replace it.`
      );
    }
  }

  async #applyMetadata(target: string, entry: ArchiveEntry): Promise<void> {
    if (this.#options.preserveMode !== false && entry.mode > 0) {
      await chmod(target, entry.mode).catch(() => {
        // Some filesystems do not support permissions.
      });
    }
    if (this.#options.preserveMtime !== false) {
      await utimes(target, entry.mtime, entry.mtime).catch(() => {
        // Same for timestamps.
      });
    }
  }

  async writeDirectory(entry: ArchiveEntry, target: string): Promise<void> {
    await mkdir(target, { recursive: true });
    if (this.#options.preserveMode !== false && entry.mode > 0) {
      await chmod(target, entry.mode).catch(() => undefined);
    }
    // Directory timestamps are applied at the end: writing children would
    // bump them again.
    if (this.#options.preserveMtime !== false) {
      this.#directoryTimes.push({ path: target, mtime: entry.mtime });
    }
    this.#record(entry);
  }

  async writeFile(
    entry: ArchiveEntry,
    target: string,
    body: AsyncIterable<Buffer>
  ): Promise<void> {
    await this.#ensureWritable(target);
    const output = createWriteStream(target, { flags: 'wx' });
    await pipeline(
      body,
      output,
      this.#options.signal ? { signal: this.#options.signal } : {}
    );
    this.#bytesWritten += output.bytesWritten;
    await this.#applyMetadata(target, entry);
    this.#record(entry);
  }

  async writeSymlink(entry: ArchiveEntry, target: string): Promise<void> {
    const policy = this.#options.symlinks ?? 'allow';
    if (policy === 'skip') return;

    const linkPath = entry.linkPath ?? '';
    const resolved = resolvePath(dirname(target), linkPath);
    if (!isInside(this.#destination, resolved)) {
      if (policy === 'error') {
        throw new CompressionError(
          'ERR_UNSAFE_ENTRY_PATH',
          `Link "${entry.path}" points outside the destination ("${linkPath}").`
        );
      }
      return;
    }

    await this.#ensureWritable(target);
    try {
      await symlink(linkPath, target);
    } catch (cause) {
      if (policy === 'error') throw cause;
      const code = (cause as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'ENOSYS') return; // Windows without privileges.
      throw cause;
    }
    this.#record(entry);
  }

  #record(entry: ArchiveEntry): void {
    this.#entries.push(entry);
    this.#options.onEntry?.(entry);
  }

  /** Applies directory timestamps, deepest first. */
  async finish(): Promise<void> {
    const sorted = [...this.#directoryTimes].sort(
      (a, b) => b.path.length - a.path.length
    );
    for (const { path, mtime } of sorted) {
      await utimes(path, mtime, mtime).catch(() => undefined);
    }
  }
}

/** Checks that an existing destination is a usable directory. */
export async function assertDirectory(path: string): Promise<void> {
  try {
    const stats = await lstat(path);
    if (!stats.isDirectory()) {
      throw new CompressionError(
        'ERR_DESTINATION_EXISTS',
        `Destination "${path}" exists and is not a directory.`
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
