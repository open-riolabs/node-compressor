/**
 * Compression and archiving built exclusively on Node's built-in modules
 * (`node:zlib`, `node:stream`, `node:fs`). No runtime dependencies.
 *
 * Four layers of API sharing the same options:
 * - buffers:  {@link compress} / {@link decompress}
 * - streams:  {@link createCompressStream} / {@link createDecompressStream}
 * - files:    {@link compressFile} / {@link decompressFile}
 * - archives: {@link createArchive} / {@link extractArchive} (tar and zip)
 */

export * from './data/index.ts';

export {
  algorithmForExtension,
  extensionFor,
  isAlgorithm,
  levelRange,
} from './algorithms.ts';

export {
  compress,
  compressSync,
  decompress,
  decompressSync,
  decompressToString,
  resolveDecompressAlgorithm,
  type BinaryInput,
} from './buffer.ts';

export {
  MAGIC_BYTES_LENGTH,
  detect,
  detectFile,
  detectFromPath,
} from './detect.ts';

export {
  compressStream,
  createCompressStream,
  createDecompressStream,
  createProgressStream,
  decompressStream,
  type StreamSource,
} from './stream.ts';

export {
  compressFile,
  decompressFile,
  type CompressFileOptions,
  type DecompressFileOptions,
  type FileOperationOptions,
} from './file.ts';

export {
  createArchive,
  detectArchiveFile,
  detectArchiveFormat,
  extractArchive,
  formatForPath,
  listArchive,
  type CreateOptions as CreateArchiveDispatchOptions,
} from './archive/index.ts';

export { openArchiveStream, type ArchiveInput } from './archive/index.ts';

export {
  compressionForArchivePath,
  createTarArchive,
  createTarStream,
} from './tar/index.ts';

export {
  extractTar,
  listTar,
  readTarEntries,
  type TarEntry,
} from './tar/index.ts';

export { createZipArchive, createZipStream } from './zip/index.ts';

export {
  ZipArchive,
  extractZip,
  listZip,
  readZipEntry,
  type ZipEntry,
  type ZipInput,
} from './zip/index.ts';

export { run as runCli, type CliIO } from './cli/main.ts';
