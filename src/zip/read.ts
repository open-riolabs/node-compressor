import { Readable } from 'node:stream';
import { buffer as streamToBuffer } from 'node:stream/consumers';
import { crc32 } from 'node:zlib';

import {
  randomAccessBuffer,
  randomAccessFile,
  readRange,
  type RandomAccess,
} from '../archive/reader.ts';
import { ExtractTarget, assertDirectory } from '../archive/target.ts';
import type {
  ArchiveEntry,
  EntryType,
  ExtractOptions,
  ExtractResult,
} from '../data/index.ts';
import { CompressionError } from '../data/index.ts';
import { createDecompressStream } from '../stream.ts';
import {
  CENTRAL_HEADER_SIGNATURE,
  CENTRAL_HEADER_SIZE,
  END_OF_CENTRAL_DIRECTORY_SIGNATURE,
  END_OF_CENTRAL_DIRECTORY_SIZE,
  FLAG_ENCRYPTED,
  LOCAL_HEADER_SIGNATURE,
  LOCAL_HEADER_SIZE,
  METHOD_DEFLATE,
  METHOD_STORE,
  METHOD_ZSTD,
  S_IFLNK,
  TIMESTAMP_EXTRA_ID,
  UINT32_MAX,
  ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE,
  ZIP64_EXTRA_ID,
  ZIP64_LOCATOR_SIGNATURE,
  fromDosDateTime,
} from './constants.ts';

/** A zip entry, with the details specific to the format. */
export interface ZipEntry extends ArchiveEntry {
  /** Compression method (0 = store, 8 = deflate, 93 = zstd). */
  method: number;
  /** CRC-32 of the uncompressed content. */
  crc: number;
  compressedSize: number;
  /** Offset of the local header inside the archive. */
  localOffset: number;
  flags: number;
}

/** Source accepted by the zip reader: random access is required. */
export type ZipInput = string | Uint8Array;

const MAX_COMMENT_SIZE = 0xffff;

function invalid(message: string): never {
  throw new CompressionError('ERR_ARCHIVE_INVALID', message);
}

/** Looks for the End Of Central Directory, scanning back from the end. */
async function findEndOfCentralDirectory(
  access: RandomAccess
): Promise<{ buffer: Buffer; offset: number }> {
  const length = Math.min(
    access.size,
    END_OF_CENTRAL_DIRECTORY_SIZE + MAX_COMMENT_SIZE
  );
  if (length < END_OF_CENTRAL_DIRECTORY_SIZE)
    invalid('File too short to be a zip archive.');

  const start = access.size - length;
  const tail = await access.read(start, length);

  for (
    let index = tail.byteLength - END_OF_CENTRAL_DIRECTORY_SIZE;
    index >= 0;
    index -= 1
  ) {
    if (tail.readUInt32LE(index) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE)
      continue;
    const commentLength = tail.readUInt16LE(index + 20);
    if (
      index + END_OF_CENTRAL_DIRECTORY_SIZE + commentLength ===
      tail.byteLength
    ) {
      return { buffer: tail.subarray(index), offset: start + index };
    }
  }
  return invalid(
    'End Of Central Directory not found: this is not a valid zip archive.'
  );
}

interface DirectoryLocation {
  entryCount: number;
  size: number;
  offset: number;
}

async function locateCentralDirectory(
  access: RandomAccess
): Promise<DirectoryLocation> {
  const { buffer, offset } = await findEndOfCentralDirectory(access);
  const location: DirectoryLocation = {
    entryCount: buffer.readUInt16LE(10),
    size: buffer.readUInt32LE(12),
    offset: buffer.readUInt32LE(16),
  };

  const needsZip64 =
    location.entryCount === 0xffff ||
    location.size === UINT32_MAX ||
    location.offset === UINT32_MAX;
  if (!needsZip64 || offset < 20) return location;

  const locator = await access.read(offset - 20, 20);
  if (
    locator.byteLength < 20 ||
    locator.readUInt32LE(0) !== ZIP64_LOCATOR_SIGNATURE
  )
    return location;

  const zip64Offset = Number(locator.readBigUInt64LE(8));
  const record = await access.read(zip64Offset, 56);
  if (
    record.byteLength < 56 ||
    record.readUInt32LE(0) !== ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE
  ) {
    return location;
  }

  return {
    entryCount: Number(record.readBigUInt64LE(32)),
    size: Number(record.readBigUInt64LE(40)),
    offset: Number(record.readBigUInt64LE(48)),
  };
}

/** Reads the extra fields that matter: ZIP64 and the extended timestamp. */
function parseExtraFields(
  extra: Buffer,
  entry: {
    uncompressedSize: number;
    compressedSize: number;
    localOffset: number;
    mtime: Date;
  }
): void {
  let offset = 0;
  while (offset + 4 <= extra.byteLength) {
    const id = extra.readUInt16LE(offset);
    const size = extra.readUInt16LE(offset + 2);
    const body = extra.subarray(offset + 4, offset + 4 + size);
    offset += 4 + size;

    if (id === ZIP64_EXTRA_ID) {
      let cursor = 0;
      if (
        entry.uncompressedSize === UINT32_MAX &&
        cursor + 8 <= body.byteLength
      ) {
        entry.uncompressedSize = Number(body.readBigUInt64LE(cursor));
        cursor += 8;
      }
      if (
        entry.compressedSize === UINT32_MAX &&
        cursor + 8 <= body.byteLength
      ) {
        entry.compressedSize = Number(body.readBigUInt64LE(cursor));
        cursor += 8;
      }
      if (entry.localOffset === UINT32_MAX && cursor + 8 <= body.byteLength) {
        entry.localOffset = Number(body.readBigUInt64LE(cursor));
      }
      continue;
    }

    if (
      id === TIMESTAMP_EXTRA_ID &&
      body.byteLength >= 5 &&
      (body.readUInt8(0) & 0x01) !== 0
    ) {
      entry.mtime = new Date(body.readInt32LE(1) * 1000);
    }
  }
}

function parseCentralDirectory(
  directory: Buffer,
  expectedCount: number
): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let offset = 0;

  while (offset + CENTRAL_HEADER_SIZE <= directory.byteLength) {
    if (directory.readUInt32LE(offset) !== CENTRAL_HEADER_SIGNATURE) break;

    const flags = directory.readUInt16LE(offset + 8);
    const method = directory.readUInt16LE(offset + 10);
    const dosTime = directory.readUInt16LE(offset + 12);
    const dosDate = directory.readUInt16LE(offset + 14);
    const crc = directory.readUInt32LE(offset + 16);
    const nameLength = directory.readUInt16LE(offset + 28);
    const extraLength = directory.readUInt16LE(offset + 30);
    const commentLength = directory.readUInt16LE(offset + 32);
    const externalAttributes = directory.readUInt32LE(offset + 38);

    const name = directory
      .subarray(
        offset + CENTRAL_HEADER_SIZE,
        offset + CENTRAL_HEADER_SIZE + nameLength
      )
      .toString('utf8');
    const extra = directory.subarray(
      offset + CENTRAL_HEADER_SIZE + nameLength,
      offset + CENTRAL_HEADER_SIZE + nameLength + extraLength
    );

    const sizes = {
      uncompressedSize: directory.readUInt32LE(offset + 24),
      compressedSize: directory.readUInt32LE(offset + 20),
      localOffset: directory.readUInt32LE(offset + 42),
      mtime: fromDosDateTime(dosTime, dosDate),
    };
    parseExtraFields(extra, sizes);

    const unixMode = externalAttributes >>> 16;
    const isDirectory = name.endsWith('/') || (externalAttributes & 0x10) !== 0;
    const isSymlink = (unixMode & 0xf000) === S_IFLNK;
    const type: EntryType = isSymlink
      ? 'symlink'
      : isDirectory
        ? 'directory'
        : 'file';

    entries.push({
      path: name.replace(/\/+$/, ''),
      type,
      size: type === 'file' ? sizes.uncompressedSize : 0,
      mode: unixMode & 0o7777 || (isDirectory ? 0o755 : 0o644),
      mtime: sizes.mtime,
      compressedSize: sizes.compressedSize,
      method,
      crc,
      localOffset: sizes.localOffset,
      flags,
    });

    offset += CENTRAL_HEADER_SIZE + nameLength + extraLength + commentLength;
  }

  if (expectedCount > 0 && entries.length !== expectedCount) {
    invalid(
      `Inconsistent central directory: expected ${expectedCount} entries, read ${entries.length}.`
    );
  }
  return entries;
}

/**
 * A zip archive open for reading. Close it with {@link ZipArchive.close} to
 * release the file descriptor.
 */
export class ZipArchive {
  readonly #access: RandomAccess;
  readonly #entries: ZipEntry[];

  private constructor(access: RandomAccess, entries: ZipEntry[]) {
    this.#access = access;
    this.#entries = entries;
  }

  /** Opens an archive from a path on disk or from an in-memory buffer. */
  static async open(source: ZipInput): Promise<ZipArchive> {
    const access =
      typeof source === 'string'
        ? await randomAccessFile(source)
        : randomAccessBuffer(source);
    try {
      const location = await locateCentralDirectory(access);
      const directory = await access.read(location.offset, location.size);
      return new ZipArchive(
        access,
        parseCentralDirectory(directory, location.entryCount)
      );
    } catch (error) {
      await access.close();
      throw error;
    }
  }

  get entries(): readonly ZipEntry[] {
    return this.#entries;
  }

  /** Finds an entry by its path inside the archive. */
  entry(path: string): ZipEntry | undefined {
    const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
    return this.#entries.find((candidate) => candidate.path === normalized);
  }

  #require(target: ZipEntry | string): ZipEntry {
    const entry = typeof target === 'string' ? this.entry(target) : target;
    if (!entry) {
      throw new CompressionError(
        'ERR_ENTRY_NOT_FOUND',
        `Entry not found in the archive: "${target}".`
      );
    }
    return entry;
  }

  /** Returns the content of an entry as a decompressed stream. */
  async stream(target: ZipEntry | string): Promise<Readable> {
    const entry = this.#require(target);

    if ((entry.flags & FLAG_ENCRYPTED) !== 0) {
      throw new CompressionError(
        'ERR_ARCHIVE_UNSUPPORTED',
        `Entry "${entry.path}" is encrypted: unsupported format.`
      );
    }

    const header = await this.#access.read(
      entry.localOffset,
      LOCAL_HEADER_SIZE
    );
    if (
      header.byteLength < LOCAL_HEADER_SIZE ||
      header.readUInt32LE(0) !== LOCAL_HEADER_SIGNATURE
    ) {
      invalid(`Invalid local header for "${entry.path}".`);
    }

    const dataOffset =
      entry.localOffset +
      LOCAL_HEADER_SIZE +
      header.readUInt16LE(26) +
      header.readUInt16LE(28);
    const raw = readRange(this.#access, dataOffset, entry.compressedSize);

    const decompressed =
      entry.method === METHOD_STORE
        ? raw
        : raw.pipe(
            createDecompressStream({ algorithm: decompressionAlgorithm(entry) })
          );

    return Readable.from(verify(decompressed, entry));
  }

  /** Reads an entry in full. */
  async read(target: ZipEntry | string): Promise<Buffer> {
    return streamToBuffer(await this.stream(target));
  }

  /** Extracts every entry into `destination`. */
  async extract(
    destination: string,
    options: ExtractOptions = {}
  ): Promise<ExtractResult> {
    const startedAt = performance.now();
    await assertDirectory(destination);

    const target = new ExtractTarget(destination, options);
    await target.prepare();

    for (const entry of this.#entries) {
      const path = target.plan(entry);
      if (path === undefined) continue;

      if (entry.type === 'directory') {
        await target.writeDirectory(entry, path);
        continue;
      }

      if (entry.type === 'symlink') {
        const linkPath = (await this.read(entry)).toString('utf8');
        await target.writeSymlink({ ...entry, linkPath }, path);
        continue;
      }

      await target.writeFile(entry, path, await this.stream(entry));
    }

    await target.finish();

    return {
      source: '<zip>',
      destination,
      format: 'zip',
      entries: target.entries,
      bytesWritten: target.bytesWritten,
      durationMs: performance.now() - startedAt,
    };
  }

  async close(): Promise<void> {
    await this.#access.close();
  }
}

function decompressionAlgorithm(entry: ZipEntry): 'deflate-raw' | 'zstd' {
  if (entry.method === METHOD_DEFLATE) return 'deflate-raw';
  if (entry.method === METHOD_ZSTD) return 'zstd';
  throw new CompressionError(
    'ERR_ARCHIVE_UNSUPPORTED',
    `Compression method ${entry.method} is not supported for "${entry.path}".`
  );
}

/** Verifies CRC-32 and size while the content is being consumed. */
async function* verify(
  source: AsyncIterable<Buffer>,
  entry: ZipEntry
): AsyncGenerator<Buffer> {
  let checksum = 0;
  let size = 0;

  for await (const chunk of source) {
    const buffer = chunk as Buffer;
    checksum = crc32(buffer, checksum);
    size += buffer.byteLength;
    yield buffer;
  }

  if (size !== entry.size) {
    invalid(`"${entry.path}": expected ${entry.size} bytes, read ${size}.`);
  }
  if (checksum >>> 0 !== entry.crc >>> 0) {
    throw new CompressionError(
      'ERR_CHECKSUM_MISMATCH',
      `CRC-32 mismatch for "${entry.path}": the archive is damaged.`
    );
  }
}

/** Lists the contents of a zip archive. */
export async function listZip(source: ZipInput): Promise<ArchiveEntry[]> {
  const archive = await ZipArchive.open(source);
  try {
    return archive.entries.map(
      ({ method: _m, crc: _c, localOffset: _o, flags: _f, ...entry }) => entry
    );
  } finally {
    await archive.close();
  }
}

/** Reads a single entry without extracting the whole archive. */
export async function readZipEntry(
  source: ZipInput,
  path: string
): Promise<Buffer> {
  const archive = await ZipArchive.open(source);
  try {
    return await archive.read(path);
  } finally {
    await archive.close();
  }
}

/** Extracts a zip archive into `destination`. */
export async function extractZip(
  source: ZipInput,
  destination: string,
  options: ExtractOptions = {}
): Promise<ExtractResult> {
  const archive = await ZipArchive.open(source);
  try {
    const result = await archive.extract(destination, options);
    return {
      ...result,
      source: typeof source === 'string' ? source : '<buffer>',
    };
  } finally {
    await archive.close();
  }
}
