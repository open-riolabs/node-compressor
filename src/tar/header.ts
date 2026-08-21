import { CompressionError } from '../data/index.ts';
import type { EntryType } from '../data/index.ts';

/** Tar block size. Headers and data alike are aligned to 512 bytes. */
export const BLOCK_SIZE = 512;

const NAME_SIZE = 100;
const PREFIX_SIZE = 155;
const CHECKSUM_OFFSET = 148;
const CHECKSUM_SIZE = 8;
/** Above this value numeric fields no longer fit in 11 octal digits. */
const MAX_OCTAL_SIZE = 0o77777777777;

/** Entry types we recognise, including the POSIX hard link. */
export type TarEntryType = EntryType | 'hardlink';

export interface TarHeaderInput {
  path: string;
  type: TarEntryType;
  size: number;
  mode: number;
  mtime: Date;
  linkPath?: string;
  uid?: number;
  gid?: number;
  uname?: string;
  gname?: string;
}

export interface RawTarHeader {
  name: string;
  mode: number;
  uid: number;
  gid: number;
  size: number;
  mtime: Date;
  typeflag: string;
  linkname: string;
  prefix: string;
  uname: string;
  gname: string;
}

const TYPE_FLAGS: Record<TarEntryType, string> = {
  file: '0',
  directory: '5',
  symlink: '2',
  hardlink: '1',
};

/** Maps a tar typeflag to an entry type, when supported. */
export function typeFromFlag(typeflag: string): TarEntryType | undefined {
  switch (typeflag) {
    case '0':
    case '\0':
    case '7':
      return 'file';
    case '5':
      return 'directory';
    case '2':
      return 'symlink';
    case '1':
      return 'hardlink';
    default:
      return undefined;
  }
}

function writeString(
  block: Buffer,
  value: string,
  offset: number,
  length: number
): void {
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.byteLength > length) {
    throw new CompressionError(
      'ERR_ARCHIVE_INVALID',
      `Tar field too long (${encoded.byteLength} bytes for ${length} available): "${value}".`
    );
  }
  encoded.copy(block, offset);
}

/**
 * Writes a numeric field in octal with a trailing NUL, falling back to the
 * base-256 encoding used by GNU tar for values that do not fit.
 */
function writeNumeric(
  block: Buffer,
  value: number,
  offset: number,
  length: number
): void {
  if (value <= MAX_OCTAL_SIZE || length < 12) {
    const digits = Math.max(value, 0)
      .toString(8)
      .padStart(length - 1, '0');
    if (digits.length > length - 1) {
      throw new CompressionError(
        'ERR_ARCHIVE_INVALID',
        `Tar value out of range: ${value}.`
      );
    }
    block.write(`${digits}\0`, offset, length, 'ascii');
    return;
  }

  block[offset] = 0x80;
  let remaining = BigInt(Math.trunc(value));
  for (let index = offset + length - 1; index > offset; index -= 1) {
    block[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
}

function readString(block: Buffer, offset: number, length: number): string {
  const field = block.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString('utf8');
}

function readNumeric(block: Buffer, offset: number, length: number): number {
  const field = block.subarray(offset, offset + length);

  if ((field[0]! & 0x80) !== 0) {
    let value = 0n;
    for (let index = 1; index < field.length; index += 1) {
      value = (value << 8n) | BigInt(field[index]!);
    }
    return Number(value);
  }

  const text = field.toString('ascii').replace(/[\0 ]/g, '');
  if (text === '') return 0;
  const value = Number.parseInt(text, 8);
  return Number.isNaN(value) ? 0 : value;
}

function checksum(block: Buffer): number {
  let sum = 0;
  for (let index = 0; index < BLOCK_SIZE; index += 1) {
    const isChecksumField =
      index >= CHECKSUM_OFFSET && index < CHECKSUM_OFFSET + CHECKSUM_SIZE;
    sum += isChecksumField ? 0x20 : block[index]!;
  }
  return sum;
}

/** Splits a long path across the `prefix` and `name` fields, if it fits. */
function splitPath(path: string): { name: string; prefix: string } | undefined {
  if (Buffer.byteLength(path) <= NAME_SIZE) return { name: path, prefix: '' };

  for (let index = path.length - 1; index >= 0; index -= 1) {
    if (path[index] !== '/') continue;
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (
      Buffer.byteLength(prefix) <= PREFIX_SIZE &&
      Buffer.byteLength(name) <= NAME_SIZE
    ) {
      return { name, prefix };
    }
  }
  return undefined;
}

/** Builds a PAX record in the `"<len> <key>=<value>\n"` format. */
function paxRecord(key: string, value: string): Buffer {
  const suffix = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(suffix) + 1;
  while (Buffer.byteLength(`${length}${suffix}`) !== length) {
    length = Buffer.byteLength(`${length}${suffix}`);
  }
  return Buffer.from(`${length}${suffix}`, 'utf8');
}

/** Truncates on a character boundary, never splitting a UTF-8 sequence. */
function truncateUtf8(value: string, maxBytes: number): string {
  let result = value;
  while (Buffer.byteLength(result, 'utf8') > maxBytes) {
    result = result.slice(0, -1);
  }
  return result;
}

function padToBlock(data: Buffer): Buffer {
  const remainder = data.byteLength % BLOCK_SIZE;
  if (remainder === 0) return data;
  return Buffer.concat([data, Buffer.alloc(BLOCK_SIZE - remainder)]);
}

function buildBlock(
  input: TarHeaderInput,
  name: string,
  prefix: string,
  typeflag: string
): Buffer {
  const block = Buffer.alloc(BLOCK_SIZE);

  writeString(block, name, 0, NAME_SIZE);
  writeNumeric(block, input.mode & 0o7777, 100, 8);
  writeNumeric(block, input.uid ?? 0, 108, 8);
  writeNumeric(block, input.gid ?? 0, 116, 8);
  writeNumeric(block, input.size, 124, 12);
  writeNumeric(block, Math.floor(input.mtime.getTime() / 1000), 136, 12);
  block.write(typeflag, 156, 1, 'ascii');
  if (input.linkPath !== undefined)
    writeString(block, input.linkPath, 157, NAME_SIZE);
  block.write('ustar\0' + '00', 257, 8, 'ascii');
  writeString(block, input.uname ?? '', 265, 32);
  writeString(block, input.gname ?? '', 297, 32);
  writeString(block, prefix, 345, PREFIX_SIZE);

  const sum = checksum(block);
  block.write(
    `${sum.toString(8).padStart(6, '0')}\0 `,
    CHECKSUM_OFFSET,
    CHECKSUM_SIZE,
    'ascii'
  );
  return block;
}

/**
 * Encodes an entry header. When the path or the link target do not fit the
 * fixed-size fields, a PAX extended header is prepended.
 */
export function encodeTarHeader(input: TarHeaderInput): Buffer {
  const typeflag = TYPE_FLAGS[input.type];
  const split = splitPath(input.path);
  const linkTooLong =
    input.linkPath !== undefined &&
    Buffer.byteLength(input.linkPath) > NAME_SIZE;

  if (split && !linkTooLong) {
    return buildBlock(input, split.name, split.prefix, typeflag);
  }

  const records: Buffer[] = [];
  if (!split) records.push(paxRecord('path', input.path));
  if (linkTooLong) records.push(paxRecord('linkpath', input.linkPath!));
  const payload = Buffer.concat(records);

  const paxName = truncateUtf8(
    `PaxHeader/${input.path.split('/').pop() ?? 'entry'}`,
    NAME_SIZE
  );
  const paxHeader = buildBlock(
    {
      path: paxName,
      type: 'file',
      size: payload.byteLength,
      mode: 0o644,
      mtime: input.mtime,
    },
    paxName,
    '',
    'x'
  );

  // The real header still carries a truncated name, for readers that ignore
  // PAX records.
  const fallbackLink =
    linkTooLong && input.linkPath
      ? truncateUtf8(input.linkPath, NAME_SIZE)
      : input.linkPath;

  return Buffer.concat([
    paxHeader,
    padToBlock(payload),
    buildBlock(
      { ...input, linkPath: fallbackLink },
      truncateUtf8(input.path, NAME_SIZE),
      '',
      typeflag
    ),
  ]);
}

/** A zeroed 512-byte block marks the end of the archive. */
export function isZeroBlock(block: Buffer): boolean {
  for (let index = 0; index < block.byteLength; index += 1) {
    if (block[index] !== 0) return false;
  }
  return true;
}

/** Decodes a tar header, verifying its checksum. */
export function decodeTarHeader(block: Buffer): RawTarHeader {
  const expected = readNumeric(block, CHECKSUM_OFFSET, CHECKSUM_SIZE);
  if (expected !== checksum(block)) {
    throw new CompressionError(
      'ERR_ARCHIVE_INVALID',
      'Invalid tar header: checksum mismatch.'
    );
  }

  return {
    name: readString(block, 0, NAME_SIZE),
    mode: readNumeric(block, 100, 8),
    uid: readNumeric(block, 108, 8),
    gid: readNumeric(block, 116, 8),
    size: readNumeric(block, 124, 12),
    mtime: new Date(readNumeric(block, 136, 12) * 1000),
    typeflag: String.fromCharCode(block[156]!),
    linkname: readString(block, 157, NAME_SIZE),
    prefix: readString(block, 345, PREFIX_SIZE),
    uname: readString(block, 265, 32),
    gname: readString(block, 297, 32),
  };
}

/** Parses the payload of a PAX extended header. */
export function parsePaxRecords(payload: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  let offset = 0;

  while (offset < payload.byteLength) {
    const space = payload.indexOf(0x20, offset);
    if (space === -1) break;

    const length = Number.parseInt(
      payload.subarray(offset, space).toString('ascii'),
      10
    );
    if (
      !Number.isFinite(length) ||
      length <= 0 ||
      offset + length > payload.byteLength
    )
      break;

    const record = payload
      .subarray(space + 1, offset + length)
      .toString('utf8');
    const separator = record.indexOf('=');
    if (separator !== -1) {
      records.set(
        record.slice(0, separator),
        record.slice(separator + 1).replace(/\n$/, '')
      );
    }
    offset += length;
  }
  return records;
}
