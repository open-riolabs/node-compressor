# @open-rlb/node-compressor

Compression of **buffers**, **streams** and **files**, plus **tar**/**zip** archiving, built
exclusively on Node's built-in modules (`node:zlib`, `node:stream`, `node:fs`).
**Zero runtime dependencies**, TypeScript types included, ESM, with a CLI.

Algorithms, all provided by `node:zlib`: `gzip`, `deflate`, `deflate-raw`, `brotli`,
`zstd`. Archive formats: `tar` (ustar/PAX, with outer compression) and `zip` (deflate,
store, zstd, ZIP64).

> Requirements: Node >= 22.15 (for zstd). Without zstd, Node >= 18 is enough.

## Install

```bash
npm install @open-rlb/node-compressor
```

## At a glance

```ts
import {
  compress, decompress, compressFile, createCompressStream,
  createArchive, extractArchive,
} from '@open-rlb/node-compressor';

// buffers and strings
const packed = await compress('something worth shrinking', { algorithm: 'zstd' });
const original = await decompress(packed); // algorithm read from the magic bytes

// files, streamed
const result = await compressFile('dump.sql', { algorithm: 'zstd', preset: 'best' });
// -> dump.sql.zst

// streams, composable with pipeline()
await pipeline(request, createCompressStream({ algorithm: 'brotli' }), response);

// multi-file archives: format and compression come from the extension
await createArchive('release.tar.zst', ['dist', 'README.md']);
await extractArchive('release.tar.zst', 'target/');
```

## API

Every layer shares the same options: what holds for buffers holds unchanged for streams
and files.

### Buffers

| Function | Description |
| --- | --- |
| `compress(input, options?)` | Compresses a `Buffer`, `Uint8Array` or `string` (UTF-8). |
| `compressSync(input, options?)` | Synchronous variant: blocks the event loop. |
| `decompress(input, options?)` | Decompresses, detecting the format by default. |
| `decompressSync(input, options?)` | Synchronous variant. |
| `decompressToString(input, options?)` | Decompresses and decodes as text. |

### Streams

| Function | Description |
| --- | --- |
| `createCompressStream(options?)` | `Transform` that compresses. |
| `createDecompressStream(options?)` | `Duplex` that decompresses; `'auto'` sniffs the header. |
| `compressStream(source, options?)` | Wires a source up and returns the compressed `Readable`. |
| `decompressStream(source, options?)` | The same, decompressing. |
| `createProgressStream(cb, total?)` | `PassThrough` that counts bytes without altering them. |

### Files

| Function | Description |
| --- | --- |
| `compressFile(source, destination?, options?)` | Streamed, written atomically. |
| `decompressFile(source, destination?, options?)` | Streamed, written atomically. |

Both return a `FileResult`:

```ts
{
  source: string;
  destination: string;
  algorithm: Algorithm;
  bytesRead: number;
  bytesWritten: number;
  compressionRatio: number; // bytesWritten / bytesRead
  durationMs: number;
}
```

The destination may be omitted: compression appends the algorithm's extension
(`dump.sql` -> `dump.sql.zst`), decompression drops it (`dump.sql.gz` -> `dump.sql`,
`backup.tgz` -> `backup.tar`).

### Archives

| Function | Description |
| --- | --- |
| `createArchive(destination, sources, options?)` | Creates a tar or zip based on the extension. |
| `extractArchive(source, destination, options?)` | Extracts, detecting the format from the content. |
| `listArchive(source, options?)` | Lists the entries without extracting them. |

Format-specific entry points, when you need to force the choice:

| tar | zip |
| --- | --- |
| `createTarArchive(dest, sources, options?)` | `createZipArchive(dest, sources, options?)` |
| `createTarStream(sources, options?)` | `createZipStream(sources, options?)` |
| `extractTar(source, dest, options?)` | `extractZip(source, dest, options?)` |
| `listTar(source, options?)` | `listZip(source)` |
| `readTarEntries(source, options?)` | `ZipArchive.open(source)`, `readZipEntry(source, path)` |

### Utilities

`detect(buffer)`, `detectFile(path)`, `detectFromPath(path)`, `extensionFor(algorithm)`,
`algorithmForExtension(ext)`, `levelRange(algorithm)`, `isAlgorithm(value)`.

## Options

### Compression

| Option | Default | Notes |
| --- | --- | --- |
| `algorithm` | `'gzip'` | One of the five supported algorithms. |
| `preset` | `'balanced'` | `'fastest' \| 'fast' \| 'balanced' \| 'best'`, portable across algorithms. |
| `level` | — | Native level; takes precedence over the preset. |
| `sizeHint` | actual size | Improves brotli and zstd. Set automatically for buffers and files. |
| `chunkSize` | zlib | Size of the internal blocks. |
| `signal` | — | `AbortSignal`. |
| `native` | — | Raw `node:zlib` options, applied last. |

Presets map to each algorithm's native level:

| Preset | gzip / deflate (0-9) | brotli (0-11) | zstd (1-22) |
| --- | --- | --- | --- |
| `fastest` | 1 | 0 | 1 |
| `fast` | 3 | 2 | 3 |
| `balanced` | 6 | 5 | 9 |
| `best` | 9 | 11 | 19 |

### Decompression

| Option | Default | Notes |
| --- | --- | --- |
| `algorithm` | `'auto'` | `'auto'` reads the format from the magic bytes. |
| `fallbackAlgorithm` | — | Used when detection is inconclusive. |
| `maxOutputSize` | — | Output ceiling in bytes: the zip-bomb guard. |
| `passthroughUncompressed` | `false` | With `'auto'`, pass plain data through instead of failing. |
| `chunkSize` | zlib | |
| `signal` | — | `AbortSignal`. |
| `native` | — | Raw `node:zlib` options. |

### Files

`overwrite` (default `false`), `createDestinationDir` (default `false`),
`onProgress(progress)`.

## Archives

### Sources

Each entry can come from disk or from memory:

```ts
await createArchive('delivery.zip', [
  'dist',                                          // file or directory, recursive
  { path: 'README.txt', data: text },              // in-memory content
  { path: 'bin/app', source: '/tmp/build/app' },   // file on disk, renamed
  { path: 'cache', type: 'directory' },            // empty directory
  { path: 'latest', type: 'symlink', linkPath: 'v2' },
]);
```

For plain strings the path stored in the archive is relative to the directory containing
the source (`'dist'` yields `dist/...`); `root` picks a different base. `filter` drops
entries, `onEntry` reports them one by one.

### Formats and compression

| Destination | Result |
| --- | --- |
| `.zip` | zip, every entry deflated (`method: 'store'` or `'zstd'` to change it) |
| `.tar` | uncompressed tar |
| `.tar.gz`, `.tgz` | tar + gzip |
| `.tar.br`, `.tar.zst`, `.tar.zz` | tar + brotli / zstd / deflate |

`compression` and `compressionOptions` override what the file name implies:

```ts
await createArchive('backup.tar.gz', ['data'], {
  compression: 'zstd',
  compressionOptions: { preset: 'best' },
});
```

When reading, the format is detected from the content (the `PK` signature, the `ustar`
magic, the outer compression). Only `.tar.br` relies on the extension, because brotli has
no magic bytes.

### Extraction

```ts
const result = await extractArchive('release.tar.zst', 'target/', {
  strip: 1,                                    // drop the first path component
  filter: (entry) => entry.path.endsWith('.js'),
  overwrite: true,
  onEntry: (entry) => console.log(entry.path),
});
```

Defences that are always on, with nothing to opt into:

- absolute paths and paths containing `..` are rejected with `ERR_UNSAFE_ENTRY_PATH`
  (zip slip);
- symbolic links that would point outside the destination are not created
  (`symlinks: 'error'` turns that into an error, `'skip'` ignores links entirely);
- in zip, CRC-32 and size are verified on every entry read.

Extraction **does not overwrite** by default: an existing file raises
`ERR_DESTINATION_EXISTS`.

### Reading a single zip entry

`ZipArchive` reads the central directory and reaches individual entries without touching
the rest of the archive:

```ts
const zip = await ZipArchive.open('package.zip');
try {
  const manifest = JSON.parse((await zip.read('package.json')).toString('utf8'));
  await pipeline(await zip.stream('dist/app.js'), createWriteStream('app.js'));
} finally {
  await zip.close();
}
```

It also accepts a zip already in memory: `ZipArchive.open(buffer)`.

### Streaming tar

`createTarStream` and `readTarEntries` work on streams, never touching the disk:

```ts
await pipeline(
  createTarStream(['dist']),
  createCompressStream({ algorithm: 'zstd' }),
  response,
);

for await (const entry of readTarEntries('backup.tar.gz')) {
  if (entry.path.endsWith('.json')) console.log(await streamToBuffer(entry.body));
  // entries whose body is not consumed are skipped automatically
}
```

### Compatibility

The archives produced here are read by GNU tar, by libarchive (the `tar` shipped with
Windows and macOS) and by Windows Explorer; conversely, archives produced by those tools
are read back, including tars using the GNU extensions (`L`/`K`) or PAX headers, and zips
with or without ZIP64. Not supported: encrypted zips, multi-volume archives, and zip
compression methods other than store, deflate and zstd.

## CLI

The package ships a `node-compressor` command:

```bash
npx node-compressor --help
```

| Command | Purpose |
| --- | --- |
| `compress <file...>` | Compress files |
| `decompress <file...>` | Decompress files |
| `pack <archive> <sources...>` | Create a tar or zip archive |
| `unpack <archive> [directory]` | Extract an archive |
| `list <archive>` | List an archive |
| `info <file...>` | Show format, algorithm and size |
| `install-skill [directory]` | Copy the bundled Claude skill into a project |

```bash
node-compressor compress -a zstd -p best dump.sql
```

```bash
node-compressor pack release.tar.zst dist README.md --exclude '*.map'
```

```bash
node-compressor unpack release.tar.zst ./target --strip 1
```

`-` reads from stdin and writes to stdout, so the commands compose:

```bash
cat dump.sql | node-compressor compress -a brotli - > dump.sql.br
```

Every command accepts `--json` for machine-readable output and `--quiet` to silence
progress. Exit codes: `0` success, `1` runtime failure, `2` usage error.

## Errors

Every error is a `CompressionError` carrying a stable `code`; the original zlib error
stays in `cause`.

```ts
import { isCompressionError } from '@open-rlb/node-compressor';

try {
  await decompressFile('archive.gz');
} catch (error) {
  if (isCompressionError(error) && error.code === 'ERR_DESTINATION_EXISTS') { /* ... */ }
}
```

Codes: `ERR_UNKNOWN_ALGORITHM`, `ERR_DETECTION_FAILED`, `ERR_INVALID_LEVEL`,
`ERR_INVALID_INPUT`, `ERR_DESTINATION_EXISTS`, `ERR_DESTINATION_REQUIRED`,
`ERR_COMPRESSION_FAILED`, `ERR_DECOMPRESSION_FAILED`, `ERR_ARCHIVE_INVALID`,
`ERR_ARCHIVE_UNSUPPORTED`, `ERR_UNSAFE_ENTRY_PATH`, `ERR_ENTRY_NOT_FOUND`,
`ERR_CHECKSUM_MISMATCH`.

## Examples

**HTTP response compressed per `Accept-Encoding`**

```ts
import { createCompressStream } from '@open-rlb/node-compressor';
import { pipeline } from 'node:stream/promises';

const accepted = request.headers['accept-encoding'] ?? '';
const algorithm = accepted.includes('zstd') ? 'zstd' : accepted.includes('br') ? 'brotli' : 'gzip';
const encoding = algorithm === 'brotli' ? 'br' : algorithm;

response.setHeader('Content-Encoding', encoding);
await pipeline(source, createCompressStream({ algorithm, preset: 'fast' }), response);
```

**Backup with progress and cancellation**

```ts
const controller = new AbortController();

const result = await compressFile('backup.tar', 'backup.tar.zst', {
  preset: 'best',
  overwrite: true,
  signal: controller.signal,
  onProgress: ({ ratio }) => process.stdout.write(`\r${Math.round((ratio ?? 0) * 100)}%`),
});

console.log(`\n${result.bytesRead} -> ${result.bytesWritten} bytes in ${result.durationMs | 0} ms`);
```

**Defensive decompression of untrusted input**

```ts
const data = await decompress(payload, { maxOutputSize: 10 * 1024 * 1024 });
```

## Implementation notes

- **Atomic writes**: file operations and archive creation write to a temporary file in the
  same directory and rename only once the pipeline completes; on failure the temporary
  file is removed and the destination is left untouched.
- **Backpressure**: no stream API buffers the whole content in memory; automatic detection
  buffers only the first 4 bytes.
- **zstd `pledgedSrcSize`** is set only when the input size is certain (data already in
  memory), never for streams or files, where a mismatch would fail the compression.
- **tar**: ustar format, with PAX headers generated automatically for paths beyond 100
  bytes and base-256 fields for files beyond 8 GiB. Reading additionally accepts the GNU
  `L`/`K` extensions and global PAX records.
- **zip**: every entry uses the data descriptor (bit 3), which keeps writing fully
  streamed without knowing CRC and sizes upfront. ZIP64 kicks in on its own past 4 GiB per
  entry, 4 GiB of offset, or 65,535 entries. POSIX permissions travel in the external
  attributes, with a UNIX "version made by".

## Claude skill

The package ships a Claude Code skill, so an agent working in a project that
depends on this library knows the API without being handed it:

| File | Contents |
| --- | --- |
| `SKILL.md` | When to reach for the library, which layer fits the task, and the behaviour that surprises people — nothing overwrites by default, brotli is undetectable, untrusted input needs `maxOutputSize`. |
| `reference.md` | The full API surface: every function, every option, the error codes, the CLI grammar. |

It lands in the consuming project at `.claude/skills/node-compressor/`.

### Installing it

The copy happens on `npm install` through a `postinstall` hook. **npm 11 and
later block dependency install scripts by default**, so on those versions either
approve the package once:

```bash
npm install-scripts approve @open-rlb/node-compressor
```

or add the policy to your `package.json`:

```json
{
  "allowScripts": {
    "@open-rlb/node-compressor": true
  }
}
```

Otherwise — or any time you want to refresh the skill after an upgrade — install
it explicitly:

```bash
npx node-compressor install-skill
```

The command takes an optional target directory, replaces any previous copy, and
accepts `--json`. Set `NODE_COMPRESSOR_SKIP_SKILL=1` to disable the automatic
install. The hook never writes outside the project that triggered the install,
never touches a directory without a `package.json`, and never fails an install.

### Editing it

The source of truth is [`skills/node-compressor/`](skills/node-compressor) in
this repository. `npm run build` copies that folder into `dist/`, which is the
root of the published package, so edits ship with the next release. Change those
files rather than the copy under a consumer's `.claude/`, which is replaced on
every install.

## Development

```bash
npm test
```

```bash
npm run build
```

Tests run straight off the TypeScript sources using Node's native type stripping, with no
build step in between.
