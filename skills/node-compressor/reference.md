# node-compressor — API reference

Every export comes from the package root: `import { … } from '@open-rlb/node-compressor'`.

## Buffers

| Function | Signature |
| --- | --- |
| `compress` | `(input: Uint8Array \| string, options?: CompressOptions) => Promise<Buffer>` |
| `compressSync` | same, synchronous |
| `decompress` | `(input: Uint8Array \| string, options?: DecompressOptions) => Promise<Buffer>` |
| `decompressSync` | same, synchronous |
| `decompressToString` | `(input, options? & { encoding?: BufferEncoding }) => Promise<string>` |

## Streams

| Function | Returns |
| --- | --- |
| `createCompressStream(options?)` | `Transform` |
| `createDecompressStream(options?)` | `Duplex`, sniffs the header when `algorithm: 'auto'` |
| `compressStream(source, options?)` | `Readable` |
| `decompressStream(source, options?)` | `Readable` |
| `createProgressStream(cb, total?)` | `PassThrough` counting bytes |

## Files

`compressFile(source, destination?, options?)` and
`decompressFile(source, destination?, options?)` return a `FileResult`:

```ts
interface FileResult {
  source: string;
  destination: string;
  algorithm: Algorithm;
  bytesRead: number;
  bytesWritten: number;
  compressionRatio: number; // bytesWritten / bytesRead
  durationMs: number;
}
```

## Archives

| Function | Purpose |
| --- | --- |
| `createArchive(destination, sources, options?)` | tar or zip, chosen by extension |
| `extractArchive(source, destination, options?)` | format detected from the content |
| `listArchive(source, options?)` | entries without extracting |
| `createTarArchive` / `createTarStream` | force tar |
| `extractTar` / `listTar` / `readTarEntries` | tar reading, streamed |
| `createZipArchive` / `createZipStream` | force zip |
| `extractZip` / `listZip` / `readZipEntry` | zip reading |
| `ZipArchive.open(pathOrBuffer)` | random access: `.entries`, `.read()`, `.stream()`, `.extract()`, `.close()` |
| `detectArchiveFormat(head)` / `detectArchiveFile(path)` | `'tar' \| 'zip' \| undefined` |
| `formatForPath` / `compressionForArchivePath` | what a destination name implies |

Sources accepted by `createArchive`:

```ts
type ArchiveSource =
  | string                                             // file or directory on disk
  | { path: string; source: string }                   // disk file, renamed inside
  | { path: string; data: Uint8Array | string }        // in-memory content
  | { path: string; type: 'directory' }
  | { path: string; type: 'symlink'; linkPath: string };
```

An `ArchiveEntry` carries `path`, `type` (`file` | `directory` | `symlink`),
`size`, `mode`, `mtime`, optional `linkPath` and `compressedSize`.

## Options

**CompressOptions** — `algorithm` (default `gzip`), `preset` (default
`balanced`), `level`, `chunkSize`, `sizeHint`, `signal`, `native`.

**DecompressOptions** — `algorithm` (default `auto`), `fallbackAlgorithm`,
`maxOutputSize`, `passthroughUncompressed`, `chunkSize`, `signal`, `native`.

**File options** — `overwrite` (default `false`), `createDestinationDir`
(default `false`), `onProgress(progress)`.

**CreateArchiveOptions** — `root`, `filter(entry)`, `onEntry(entry)`,
`followSymlinks`, `compression`, `compressionOptions`, `method` (zip only),
`overwrite`, `createDestinationDir`, `signal`.

**ExtractOptions** — `overwrite`, `strip`, `filter(entry)`, `onEntry(entry)`,
`symlinks` (`allow` | `skip` | `error`), `preserveMode`, `preserveMtime`,
`compression`, `signal`.

## Preset to native level

| Preset | gzip / deflate (0-9) | brotli (0-11) | zstd (1-22) |
| --- | --- | --- | --- |
| `fastest` | 1 | 0 | 1 |
| `fast` | 3 | 2 | 3 |
| `balanced` | 6 | 5 | 9 |
| `best` | 9 | 11 | 19 |

## Error codes

`CompressionError.code` is one of: `ERR_UNKNOWN_ALGORITHM`,
`ERR_DETECTION_FAILED`, `ERR_INVALID_LEVEL`, `ERR_INVALID_INPUT`,
`ERR_DESTINATION_EXISTS`, `ERR_DESTINATION_REQUIRED`, `ERR_COMPRESSION_FAILED`,
`ERR_DECOMPRESSION_FAILED`, `ERR_ARCHIVE_INVALID`, `ERR_ARCHIVE_UNSUPPORTED`,
`ERR_UNSAFE_ENTRY_PATH`, `ERR_ENTRY_NOT_FOUND`, `ERR_CHECKSUM_MISMATCH`.

The original zlib error, when there is one, stays in `error.cause`.

## CLI

```
node-compressor compress    [-a algo] [-p preset] [-l level] [-o out] [-c] [-f] <file...>
node-compressor decompress  [-a algo] [-o out] [-c] [-f] [--max-size n] <file...>
node-compressor pack        [--format f] [--compression c] [--method m] [--root d]
                            [-e pattern] [-i pattern] [-f] [-v] <archive> <sources...>
node-compressor unpack      [--strip n] [-e pattern] [-i pattern] [--symlinks p] [-f] [-v]
                            <archive> [directory]
node-compressor list        [-l] <archive>
node-compressor info        <file...>
```

Common to all: `-h/--help`, `-V/--version`, `-q/--quiet`, `--json`.
Aliases: `c`, `d`, `x`/`extract`, `create`, `ls`/`t`.
