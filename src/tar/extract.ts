import { link } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';

import { openArchiveStream, type ArchiveInput } from '../archive/open.ts';
import { isInside, sanitizeExtractPath } from '../archive/paths.ts';
import { ChunkReader } from '../archive/reader.ts';
import { ExtractTarget, assertDirectory } from '../archive/target.ts';
import type {
  ArchiveEntry,
  ArchiveOpenOptions,
  ExtractOptions,
  ExtractResult,
} from '../data/index.ts';
import {
  BLOCK_SIZE,
  decodeTarHeader,
  isZeroBlock,
  parsePaxRecords,
  typeFromFlag,
} from './header.ts';

/** A tar entry read off the stream, with its content still to consume. */
export interface TarEntry extends ArchiveEntry {
  /** Original typeflag, which is how hard links stay distinguishable. */
  typeflag: string;
  /**
   * Content of the entry. Consume it before moving to the next entry; if you
   * ignore it, the remaining bytes are skipped automatically.
   */
  body: AsyncIterable<Buffer>;
}

function padding(size: number): number {
  const remainder = size % BLOCK_SIZE;
  return remainder === 0 ? 0 : BLOCK_SIZE - remainder;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * Walks the entries of a tar stream, decompressing it when needed.
 *
 * Supports ustar, PAX extended headers and the GNU extensions for long names
 * and long link targets.
 */
export async function* readTarEntries(
  source: ArchiveInput,
  options: ArchiveOpenOptions = {}
): AsyncGenerator<TarEntry> {
  const { signal } = options;
  const reader = new ChunkReader(openArchiveStream(source, options));
  let pax: Map<string, string> | undefined;
  let globalPax: Map<string, string> | undefined;
  let longName: string | undefined;
  let longLink: string | undefined;

  try {
    for (;;) {
      signal?.throwIfAborted();
      const block = await reader.read(BLOCK_SIZE);
      if (!block) break;

      if (isZeroBlock(block)) {
        // The end-of-archive marker is two zeroed blocks.
        await reader.read(BLOCK_SIZE);
        break;
      }

      const raw = decodeTarHeader(block);
      const pad = padding(raw.size);

      if (raw.typeflag === 'x' || raw.typeflag === 'g') {
        const records = parsePaxRecords(await reader.readExactly(raw.size));
        if (raw.typeflag === 'x') pax = records;
        else globalPax = records;
        await reader.skip(pad);
        continue;
      }

      if (raw.typeflag === 'L' || raw.typeflag === 'K') {
        const value = (await reader.readExactly(raw.size))
          .toString('utf8')
          .replace(/\0+$/, '');
        if (raw.typeflag === 'L') longName = value;
        else longLink = value;
        await reader.skip(pad);
        continue;
      }

      const attribute = (key: string): string | undefined =>
        pax?.get(key) ?? globalPax?.get(key);

      const rawPath =
        attribute('path') ??
        longName ??
        (raw.prefix === '' ? raw.name : `${raw.prefix}/${raw.name}`);
      const linkPath = attribute('linkpath') ?? longLink ?? raw.linkname;
      const paxSize = attribute('size');
      const paxMtime = attribute('mtime');
      const size =
        paxSize === undefined ? raw.size : Number.parseInt(paxSize, 10);
      const mtime =
        paxMtime === undefined
          ? raw.mtime
          : new Date(Number.parseFloat(paxMtime) * 1000);

      pax = undefined;
      longName = undefined;
      longLink = undefined;

      const flagType = typeFromFlag(raw.typeflag);
      if (!flagType) {
        // Devices, fifos and the like: not representable, so they are skipped.
        await reader.skip(raw.size + pad);
        continue;
      }

      const endsWithSlash = /[/\\]$/.test(rawPath);
      const type =
        flagType === 'directory' || endsWithSlash ? 'directory' : flagType;
      const isFile = type === 'file' || type === 'hardlink';

      let remaining = isFile ? size : 0;
      const body = (async function* () {
        for await (const chunk of reader.take(remaining)) {
          remaining -= chunk.byteLength;
          yield chunk;
        }
      })();

      yield {
        path: normalizePath(rawPath),
        type: type === 'hardlink' ? 'file' : type,
        size: isFile ? size : 0,
        mode: raw.mode,
        mtime,
        typeflag: raw.typeflag,
        body,
        ...(linkPath === '' ? {} : { linkPath }),
      };

      if (remaining > 0) await reader.skip(remaining);
      await reader.skip(pad);
    }
  } finally {
    await reader.close();
  }
}

/** Lists the contents of a tar archive without extracting it. */
export async function listTar(
  source: ArchiveInput,
  options: ArchiveOpenOptions = {}
): Promise<ArchiveEntry[]> {
  const entries: ArchiveEntry[] = [];
  for await (const entry of readTarEntries(source, options)) {
    const { body: _body, typeflag: _typeflag, ...metadata } = entry;
    entries.push(metadata);
  }
  return entries;
}

/**
 * Extracts a tar archive, compressed or not, into `destination`.
 *
 * Absolute paths and paths containing `..` are rejected, and symbolic links
 * that would point outside the destination are not created.
 */
export async function extractTar(
  source: ArchiveInput,
  destination: string,
  options: ExtractOptions = {}
): Promise<ExtractResult> {
  const startedAt = performance.now();
  await assertDirectory(destination);

  const target = new ExtractTarget(destination, options);
  await target.prepare();

  for await (const entry of readTarEntries(source, {
    ...(options.compression ? { compression: options.compression } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  })) {
    const { body, typeflag, ...metadata } = entry;
    const path = target.plan(metadata);
    if (path === undefined) continue;

    if (metadata.type === 'directory') {
      await target.writeDirectory(metadata, path);
      continue;
    }

    if (metadata.type === 'symlink') {
      await target.writeSymlink(metadata, path);
      continue;
    }

    if (typeflag === '1') {
      await linkHardEntry(destination, metadata, path, options);
      continue;
    }

    await target.writeFile(metadata, path, body);
  }

  await target.finish();

  return {
    source: typeof source === 'string' ? source : '<stream>',
    destination,
    format: 'tar',
    entries: target.entries,
    bytesWritten: target.bytesWritten,
    durationMs: performance.now() - startedAt,
  };
}

/** Recreates a hard link, if the entry it refers to was already extracted. */
async function linkHardEntry(
  destination: string,
  entry: ArchiveEntry,
  path: string,
  options: ExtractOptions
): Promise<void> {
  const linkPath = entry.linkPath;
  if (!linkPath) return;

  const relativePath = sanitizeExtractPath(linkPath, options.strip ?? 0);
  if (relativePath === undefined) return;

  const existing = join(resolvePath(destination), relativePath);
  if (!isInside(destination, existing)) return;

  await link(existing, path).catch(() => {
    // When the referenced file was not extracted, the entry is dropped.
  });
}
