import { open } from 'node:fs/promises';
import { extname } from 'node:path';

import { algorithmForExtension } from '../algorithms.ts';
import { detect } from '../detect.ts';
import { CompressionError } from '../data/index.ts';
import { createTarArchive, extractTar, listTar } from '../tar/index.ts';
import { createZipArchive, extractZip, listZip } from '../zip/index.ts';
import { openArchiveStream } from './open.ts';
import type {
  ArchiveEntry,
  ArchiveFormat,
  ArchiveOpenOptions,
  ArchiveResult,
  ArchiveSource,
  CreateArchiveOptions,
  CreateZipOptions,
  ExtractOptions,
  ExtractResult,
} from '../data/index.ts';

/** Bytes to read for format detection: the tar magic sits at offset 257. */
const PROBE_SIZE = 512;
const TAR_MAGIC_OFFSET = 257;

/** Detects the archive format from the leading (uncompressed) bytes. */
export function detectArchiveFormat(
  head: Uint8Array
): ArchiveFormat | undefined {
  const buffer = Buffer.from(head.buffer, head.byteOffset, head.byteLength);

  if (
    buffer.byteLength >= 4 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07)
  ) {
    return 'zip';
  }

  if (buffer.byteLength >= TAR_MAGIC_OFFSET + 5) {
    const magic = buffer
      .subarray(TAR_MAGIC_OFFSET, TAR_MAGIC_OFFSET + 5)
      .toString('ascii');
    if (magic === 'ustar') return 'tar';
  }
  return undefined;
}

async function readHead(path: string): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(PROBE_SIZE);
    const { bytesRead } = await handle.read(buffer, 0, PROBE_SIZE, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** True when the file carries, or is named after, a supported compression. */
function looksCompressed(path: string, head: Buffer): boolean {
  return (
    detect(head) !== undefined ||
    algorithmForExtension(extname(path)) !== undefined
  );
}

/** Reads the first blocks through the decompressor, to reach the tar header. */
async function readDecompressedHead(path: string): Promise<Buffer> {
  const stream = openArchiveStream(path);
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
      size += (chunk as Buffer).byteLength;
      if (size >= PROBE_SIZE) break;
    }
  } catch {
    return Buffer.alloc(0);
  } finally {
    stream.destroy();
  }
  return Buffer.concat(chunks);
}

/**
 * Detects the format of an archive on disk, looking through the outer
 * compression when there is one.
 */
export async function detectArchiveFile(
  path: string
): Promise<ArchiveFormat | undefined> {
  const head = await readHead(path);

  const format = detectArchiveFormat(head);
  if (format) return format;
  if (!looksCompressed(path, head)) return undefined;

  return detectArchiveFormat(await readDecompressedHead(path));
}

/** Infers the format from the destination extension. */
export function formatForPath(path: string): ArchiveFormat {
  return extname(path).toLowerCase() === '.zip' ? 'zip' : 'tar';
}

export interface CreateOptions extends CreateArchiveOptions, CreateZipOptions {
  /** Archive format. Default: inferred from the destination extension. */
  format?: ArchiveFormat;
}

/**
 * Creates an archive, picking the format from the extension: `.zip` yields a
 * zip, anything else a tar whose compression also comes from the name
 * (`.tar`, `.tar.gz`, `.tgz`, `.tar.zst`, `.tar.br`, ...).
 *
 * @example
 * ```ts
 * await createArchive('release.tar.zst', ['dist', 'README.md']);
 * await createArchive('release.zip', ['dist']);
 * ```
 */
export async function createArchive(
  destination: string,
  sources: readonly ArchiveSource[],
  options: CreateOptions = {}
): Promise<ArchiveResult> {
  const format = options.format ?? formatForPath(destination);
  return format === 'zip'
    ? createZipArchive(destination, sources, options)
    : createTarArchive(destination, sources, options);
}

/**
 * Extracts an archive, detecting the format from the content: zip, tar, and
 * tar compressed with any of the supported algorithms.
 */
export async function extractArchive(
  source: string,
  destination: string,
  options: ExtractOptions & { format?: ArchiveFormat } = {}
): Promise<ExtractResult> {
  const format = options.format ?? (await resolveFormat(source));
  return format === 'zip'
    ? extractZip(source, destination, options)
    : extractTar(source, destination, options);
}

/**
 * Falls back to tar for compressed files whose header is unreadable: older
 * tars predate the `ustar` magic but extract perfectly well.
 */
async function resolveFormat(source: string): Promise<ArchiveFormat> {
  const detected = await detectArchiveFile(source);
  if (detected) return detected;
  if (looksCompressed(source, await readHead(source))) return 'tar';
  return unsupported(source);
}

/** Lists the contents of an archive without extracting it. */
export async function listArchive(
  source: string,
  options: ArchiveOpenOptions & { format?: ArchiveFormat } = {}
): Promise<ArchiveEntry[]> {
  const format = options.format ?? (await resolveFormat(source));
  return format === 'zip' ? listZip(source) : listTar(source, options);
}

function unsupported(source: string): never {
  throw new CompressionError(
    'ERR_ARCHIVE_UNSUPPORTED',
    `Unrecognised format for "${source}": expected zip, tar or a compressed tar.`
  );
}
