import { createReadStream, createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32 } from 'node:zlib';

import { resolveSources } from '../archive/sources.ts';
import type {
  ArchiveEntry,
  ArchiveResult,
  ArchiveSource,
  CreateZipOptions,
  ResolvedEntry,
  ZipMethod,
} from '../data/index.ts';
import { CompressionError } from '../data/index.ts';
import { prepareDestination, withTemporaryTarget } from '../fsutil.ts';
import { compressStream } from '../stream.ts';
import {
  CENTRAL_HEADER_SIGNATURE,
  CENTRAL_HEADER_SIZE,
  DATA_DESCRIPTOR_SIGNATURE,
  END_OF_CENTRAL_DIRECTORY_SIGNATURE,
  END_OF_CENTRAL_DIRECTORY_SIZE,
  FLAG_DATA_DESCRIPTOR,
  FLAG_UTF8,
  LOCAL_HEADER_SIGNATURE,
  LOCAL_HEADER_SIZE,
  METHOD_DEFLATE,
  METHOD_STORE,
  METHOD_ZSTD,
  S_IFDIR,
  S_IFLNK,
  S_IFREG,
  TIMESTAMP_EXTRA_ID,
  UINT16_MAX,
  UINT32_MAX,
  VERSION_MADE_BY,
  VERSION_NEEDED,
  VERSION_NEEDED_ZIP64,
  ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE,
  ZIP64_EXTRA_ID,
  ZIP64_LOCATOR_SIGNATURE,
  toDosDateTime,
} from './constants.ts';

interface CentralRecord {
  name: Buffer;
  method: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
  externalAttributes: number;
  dosTime: number;
  dosDate: number;
  mtime: Date;
}

function methodCode(method: ZipMethod): number {
  if (method === 'store') return METHOD_STORE;
  return method === 'zstd' ? METHOD_ZSTD : METHOD_DEFLATE;
}

function resolveMethod(options: CreateZipOptions): ZipMethod {
  if (options.method) return options.method;
  if (options.compression === 'none') return 'store';
  if (options.compression === 'zstd') return 'zstd';
  return 'deflate';
}

function unixMode(entry: ArchiveEntry): number {
  const permissions = entry.mode & 0o7777;
  if (entry.type === 'directory') return S_IFDIR | (permissions || 0o755);
  if (entry.type === 'symlink') return S_IFLNK | (permissions || 0o777);
  return S_IFREG | (permissions || 0o644);
}

/** Extra field 0x5455: modification time with one-second resolution. */
function timestampExtra(mtime: Date): Buffer {
  const extra = Buffer.alloc(9);
  extra.writeUInt16LE(TIMESTAMP_EXTRA_ID, 0);
  extra.writeUInt16LE(5, 2);
  extra.writeUInt8(0x01, 4);
  extra.writeInt32LE(Math.floor(mtime.getTime() / 1000), 5);
  return extra;
}

/** ZIP64 extra field carrying the three 64-bit values. */
function zip64Extra(
  uncompressed: number,
  compressed: number,
  offset: number
): Buffer {
  const extra = Buffer.alloc(28);
  extra.writeUInt16LE(ZIP64_EXTRA_ID, 0);
  extra.writeUInt16LE(24, 2);
  extra.writeBigUInt64LE(BigInt(uncompressed), 4);
  extra.writeBigUInt64LE(BigInt(compressed), 12);
  extra.writeBigUInt64LE(BigInt(offset), 20);
  return extra;
}

function localHeader(
  name: Buffer,
  method: number,
  dos: { time: number; date: number },
  extra: Buffer,
  zip64: boolean
): Buffer {
  const header = Buffer.alloc(LOCAL_HEADER_SIZE);
  header.writeUInt32LE(LOCAL_HEADER_SIGNATURE, 0);
  header.writeUInt16LE(zip64 ? VERSION_NEEDED_ZIP64 : VERSION_NEEDED, 4);
  header.writeUInt16LE(FLAG_DATA_DESCRIPTOR | FLAG_UTF8, 6);
  header.writeUInt16LE(method, 8);
  header.writeUInt16LE(dos.time, 10);
  header.writeUInt16LE(dos.date, 12);
  // CRC and sizes travel in the data descriptor, after the data.
  header.writeUInt32LE(0, 14);
  header.writeUInt32LE(0, 18);
  header.writeUInt32LE(0, 22);
  header.writeUInt16LE(name.byteLength, 26);
  header.writeUInt16LE(extra.byteLength, 28);
  return Buffer.concat([header, name, extra]);
}

function dataDescriptor(
  crc: number,
  compressed: number,
  uncompressed: number,
  zip64: boolean
): Buffer {
  const descriptor = Buffer.alloc(zip64 ? 24 : 16);
  descriptor.writeUInt32LE(DATA_DESCRIPTOR_SIGNATURE, 0);
  descriptor.writeUInt32LE(crc >>> 0, 4);
  if (zip64) {
    descriptor.writeBigUInt64LE(BigInt(compressed), 8);
    descriptor.writeBigUInt64LE(BigInt(uncompressed), 16);
  } else {
    descriptor.writeUInt32LE(compressed, 8);
    descriptor.writeUInt32LE(uncompressed, 12);
  }
  return descriptor;
}

function centralHeader(record: CentralRecord): Buffer {
  const needsZip64 =
    record.uncompressedSize > UINT32_MAX ||
    record.compressedSize > UINT32_MAX ||
    record.localOffset > UINT32_MAX;

  const extra = Buffer.concat([
    timestampExtra(record.mtime),
    needsZip64
      ? zip64Extra(
          record.uncompressedSize,
          record.compressedSize,
          record.localOffset
        )
      : Buffer.alloc(0),
  ]);

  const header = Buffer.alloc(CENTRAL_HEADER_SIZE);
  header.writeUInt32LE(CENTRAL_HEADER_SIGNATURE, 0);
  header.writeUInt16LE(VERSION_MADE_BY, 4);
  header.writeUInt16LE(needsZip64 ? VERSION_NEEDED_ZIP64 : VERSION_NEEDED, 6);
  header.writeUInt16LE(FLAG_DATA_DESCRIPTOR | FLAG_UTF8, 8);
  header.writeUInt16LE(record.method, 10);
  header.writeUInt16LE(record.dosTime, 12);
  header.writeUInt16LE(record.dosDate, 14);
  header.writeUInt32LE(record.crc >>> 0, 16);
  header.writeUInt32LE(needsZip64 ? UINT32_MAX : record.compressedSize, 20);
  header.writeUInt32LE(needsZip64 ? UINT32_MAX : record.uncompressedSize, 24);
  header.writeUInt16LE(record.name.byteLength, 28);
  header.writeUInt16LE(extra.byteLength, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(record.externalAttributes >>> 0, 38);
  header.writeUInt32LE(needsZip64 ? UINT32_MAX : record.localOffset, 42);
  return Buffer.concat([header, record.name, extra]);
}

function endOfCentralDirectory(
  count: number,
  size: number,
  offset: number
): Buffer {
  const needsZip64 =
    count > UINT16_MAX || size > UINT32_MAX || offset > UINT32_MAX;
  const blocks: Buffer[] = [];

  if (needsZip64) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0);
    record.writeBigUInt64LE(44n, 4); // Record size minus its first 12 bytes.
    record.writeUInt16LE(VERSION_MADE_BY, 12);
    record.writeUInt16LE(VERSION_NEEDED_ZIP64, 14);
    record.writeUInt32LE(0, 16);
    record.writeUInt32LE(0, 20);
    record.writeBigUInt64LE(BigInt(count), 24);
    record.writeBigUInt64LE(BigInt(count), 32);
    record.writeBigUInt64LE(BigInt(size), 40);
    record.writeBigUInt64LE(BigInt(offset), 48);
    blocks.push(record);

    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(ZIP64_LOCATOR_SIGNATURE, 0);
    locator.writeUInt32LE(0, 4);
    locator.writeBigUInt64LE(BigInt(offset + size), 8);
    locator.writeUInt32LE(1, 16);
    blocks.push(locator);
  }

  const eocd = Buffer.alloc(END_OF_CENTRAL_DIRECTORY_SIZE);
  eocd.writeUInt32LE(END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(Math.min(count, UINT16_MAX), 8);
  eocd.writeUInt16LE(Math.min(count, UINT16_MAX), 10);
  eocd.writeUInt32LE(Math.min(size, UINT32_MAX), 12);
  eocd.writeUInt32LE(Math.min(offset, UINT32_MAX), 16);
  eocd.writeUInt16LE(0, 20);
  blocks.push(eocd);

  return Buffer.concat(blocks);
}

function entryContent(entry: ResolvedEntry): AsyncIterable<Buffer> {
  if (entry.type === 'symlink') {
    return Readable.from([Buffer.from(entry.linkPath ?? '', 'utf8')]);
  }
  if (entry.data) return Readable.from([entry.data]);
  if (entry.origin) return createReadStream(entry.origin);
  return Readable.from([]);
}

/** Generates the whole zip stream: entries, central directory, EOCD. */
async function* packZip(
  sources: readonly ArchiveSource[],
  options: CreateZipOptions,
  collected: ArchiveEntry[]
): AsyncGenerator<Buffer> {
  const method = resolveMethod(options);
  const records: CentralRecord[] = [];
  let offset = 0;

  for await (const entry of resolveSources(sources, options)) {
    const isDirectory = entry.type === 'directory';
    const name = Buffer.from(
      isDirectory ? `${entry.path}/` : entry.path,
      'utf8'
    );
    // Directories and links stay uncompressed: they are a few bytes.
    const entryMethod =
      isDirectory || entry.type === 'symlink'
        ? METHOD_STORE
        : methodCode(method);
    const zip64 = entry.size > UINT32_MAX || offset > UINT32_MAX;
    const dos = toDosDateTime(entry.mtime);

    const extra = zip64
      ? Buffer.concat([timestampExtra(entry.mtime), zip64Extra(0, 0, 0)])
      : timestampExtra(entry.mtime);

    const header = localHeader(name, entryMethod, dos, extra, zip64);
    const localOffset = offset;
    offset += header.byteLength;
    yield header;

    let crc = 0;
    let uncompressedSize = 0;
    let compressedSize = 0;

    if (!isDirectory) {
      const tapped = (async function* () {
        for await (const chunk of entryContent(entry)) {
          const buffer = chunk as Buffer;
          crc = crc32(buffer, crc);
          uncompressedSize += buffer.byteLength;
          yield buffer;
        }
      })();

      const payload =
        entryMethod === METHOD_STORE
          ? tapped
          : compressStream(tapped, {
              ...options.compressionOptions,
              algorithm: entryMethod === METHOD_ZSTD ? 'zstd' : 'deflate-raw',
            });

      for await (const chunk of payload) {
        const buffer = chunk as Buffer;
        compressedSize += buffer.byteLength;
        offset += buffer.byteLength;
        yield buffer;
      }
    }

    if (
      !zip64 &&
      (uncompressedSize > UINT32_MAX || compressedSize > UINT32_MAX)
    ) {
      throw new CompressionError(
        'ERR_ARCHIVE_INVALID',
        `"${entry.path}" grew past 4 GiB while being written: the file changed after its metadata was read.`
      );
    }

    const descriptor = dataDescriptor(
      crc,
      compressedSize,
      uncompressedSize,
      zip64
    );
    offset += descriptor.byteLength;
    yield descriptor;

    records.push({
      name,
      method: entryMethod,
      crc,
      compressedSize,
      uncompressedSize,
      localOffset,
      externalAttributes:
        ((unixMode(entry) & 0xffff) << 16) | (isDirectory ? 0x10 : 0),
      dosTime: dos.time,
      dosDate: dos.date,
      mtime: entry.mtime,
    });

    const metadata: ArchiveEntry = {
      path: entry.path,
      type: entry.type,
      size: uncompressedSize,
      mode: entry.mode,
      mtime: entry.mtime,
      compressedSize,
      ...(entry.linkPath === undefined ? {} : { linkPath: entry.linkPath }),
    };
    collected.push(metadata);
    options.onEntry?.(metadata);
  }

  const directoryOffset = offset;
  let directorySize = 0;
  for (const record of records) {
    const header = centralHeader(record);
    directorySize += header.byteLength;
    yield header;
  }

  yield endOfCentralDirectory(records.length, directorySize, directoryOffset);
}

/**
 * Builds a zip stream out of files, directories or in-memory content. Every
 * entry is compressed on its own with deflate.
 */
export function createZipStream(
  sources: readonly ArchiveSource[],
  options: CreateZipOptions = {}
): Readable {
  return Readable.from(packZip(sources, options, []));
}

/**
 * Creates a zip archive on disk.
 *
 * @example
 * ```ts
 * await createZipArchive('delivery.zip', ['src', { path: 'README.txt', data: text }]);
 * ```
 */
export async function createZipArchive(
  destination: string,
  sources: readonly ArchiveSource[],
  options: CreateZipOptions = {}
): Promise<ArchiveResult> {
  const startedAt = performance.now();
  await prepareDestination(destination, options);

  const entries: ArchiveEntry[] = [];
  const bytesWritten = await withTemporaryTarget(
    destination,
    async (temporary) => {
      const output = createWriteStream(temporary, { flags: 'wx' });
      await pipeline(
        Readable.from(packZip(sources, options, entries)),
        output,
        options.signal ? { signal: options.signal } : {}
      );
      return output.bytesWritten;
    }
  );

  return {
    destination,
    format: 'zip',
    compression:
      resolveMethod(options) === 'store'
        ? 'none'
        : resolveMethod(options) === 'zstd'
          ? 'zstd'
          : 'deflate-raw',
    entries,
    bytesRead: entries.reduce((total, entry) => total + entry.size, 0),
    bytesWritten,
    durationMs: performance.now() - startedAt,
  };
}
