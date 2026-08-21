import { createReadStream, readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { parseArgs, type ParseArgsConfig } from 'node:util';

import { algorithmForExtension, extensionFor } from '../algorithms.ts';
import {
  createArchive,
  detectArchiveFile,
  extractArchive,
  listArchive,
} from '../archive/index.ts';
import type {
  ArchiveEntry,
  ArchiveFormat,
  ExtractOptions,
} from '../data/index.ts';
import { detectFile } from '../detect.ts';
import { isCompressionError } from '../data/index.ts';
import { compressFile, decompressFile } from '../file.ts';
import { createCompressStream, createDecompressStream } from '../stream.ts';
import {
  ALGORITHMS,
  type Algorithm,
  type Preset,
  type Progress,
} from '../data/index.ts';
import {
  formatBytes,
  formatDate,
  formatDuration,
  formatMode,
  formatRatio,
  formatTable,
  paletteFor,
  type Palette,
} from './format.ts';
import { buildFilter } from './glob.ts';
import { SKILL_NAME, installSkill } from './skill.ts';

/** Streams the CLI writes to, replaceable in tests. */
export interface CliIO {
  out: NodeJS.WritableStream;
  err: NodeJS.WritableStream;
  in?: NodeJS.ReadableStream;
}

const DEFAULT_IO: CliIO = {
  out: process.stdout,
  err: process.stderr,
  in: process.stdin,
};

/** Bad invocation: the CLI prints the relevant help and exits with code 2. */
class UsageError extends Error {
  readonly command: string | undefined;

  constructor(message: string, command?: string) {
    super(message);
    this.command = command;
  }
}

const PRESETS: readonly Preset[] = ['fastest', 'fast', 'balanced', 'best'];

const GENERAL_HELP = `node-compressor — compression and archiving on Node's built-in modules only

Usage
  node-compressor <command> [options] [arguments]

Commands
  compress     <file...>              compress the given files
  decompress   <file...>              decompress the given files
  pack         <archive> <sources…>   create a tar or zip archive
  unpack       <archive> [directory]  extract an archive
  list         <archive>              list an archive without extracting it
  info         <file...>              show format, algorithm and size
  install-skill [directory]           copy the Claude skill into a project

Common options
  -h, --help                          general help, or help for one command
  -V, --version                       print the version
  -q, --quiet                         no progress output
      --json                          machine-readable output

Examples
  node-compressor compress -a zstd -p best dump.sql
  node-compressor decompress backup.tar.gz -o backup.tar
  node-compressor pack release.tar.zst dist README.md --exclude '*.map'
  node-compressor unpack release.tar.zst ./target --strip 1
  cat dump.sql | node-compressor compress -a brotli - > dump.sql.br`;

const COMMAND_HELP: Record<string, string> = {
  compress: `Compress one or more files.

Usage
  node-compressor compress [options] <file...>

Options
  -a, --algorithm <name>   gzip | deflate | deflate-raw | brotli | zstd (default: gzip)
  -p, --preset <name>      fastest | fast | balanced | best (default: balanced)
  -l, --level <number>     native level, takes precedence over --preset
  -o, --output <path>      explicit destination (single input file)
  -c, --stdout             write to stdout instead of a file
  -f, --force              overwrite the destination if it exists
  -q, --quiet              no progress output
      --json               summary as JSON

The file "-" reads from stdin and writes to stdout.
Without --output the destination is the input plus the algorithm's
extension (dump.sql -> dump.sql.zst).`,

  decompress: `Decompress one or more files.

Usage
  node-compressor decompress [options] <file...>

Options
  -a, --algorithm <name>   force the algorithm instead of detecting it
  -o, --output <path>      explicit destination (single input file)
  -c, --stdout             write to stdout instead of a file
  -f, --force              overwrite the destination if it exists
      --max-size <bytes>   output limit, guards against zip bombs
  -q, --quiet              no progress output
      --json               summary as JSON

Brotli and deflate-raw carry no magic bytes: those need --algorithm,
unless the file extension gives it away (.br).`,

  pack: `Create a tar or zip archive.

Usage
  node-compressor pack [options] <archive> <sources...>

Options
      --format <name>      tar | zip (default: from the extension)
      --compression <name> outer compression for tar, or "none"
  -p, --preset <name>      fastest | fast | balanced | best
  -l, --level <number>     native compression level
      --method <name>      zip: deflate | store | zstd (default: deflate)
      --root <directory>   base directory for the stored paths
  -e, --exclude <pattern>  skip matching entries (repeatable)
  -i, --include <pattern>  keep only matching entries (repeatable)
      --follow-symlinks    archive the target instead of the link
  -f, --force              overwrite the archive if it exists
  -v, --verbose            print entries as they are added
      --json               summary as JSON

Format and compression are read from the name: .zip, .tar, .tar.gz,
.tgz, .tar.br, .tar.zst.`,

  unpack: `Extract a tar or zip archive.

Usage
  node-compressor unpack [options] <archive> [directory]

Options
      --strip <number>     drop the first N path components
  -e, --exclude <pattern>  skip matching entries (repeatable)
  -i, --include <pattern>  extract only matching entries (repeatable)
      --symlinks <policy>  allow | skip | error (default: allow)
  -f, --force              overwrite existing files
  -v, --verbose            print entries as they are extracted
      --json               summary as JSON

Without a directory the archive is extracted into the current one.
Absolute paths and paths containing ".." are always rejected.`,

  list: `List the contents of an archive.

Usage
  node-compressor list [options] <archive>

Options
  -l, --long               show permissions and modification time
      --json               listing as JSON`,

  info: `Show format, algorithm and size of one or more files.

Usage
  node-compressor info [options] <file...>

Options
      --json               output as JSON`,

  'install-skill': `Copy the bundled Claude skill into a project.

Usage
  node-compressor install-skill [options] [directory]

Options
      --json               report the installed path as JSON

The skill lands in <directory>/.claude/skills/node-compressor, replacing a
previous copy. Without a directory the current one is used.

npm runs this automatically on install, unless the package manager blocks
dependency install scripts (npm 11+ does by default).`,
};

/**
 * Walks up from this module looking for the manifest: the depth differs
 * between running from the sources, from `dist/`, and from the published
 * package, where `package.json` sits next to the compiled `cli/` folder.
 */
function readVersion(): string {
  let folder = import.meta.dirname;

  for (let level = 0; level < 3; level += 1) {
    folder = dirname(folder);
    try {
      const manifest = JSON.parse(
        readFileSync(join(folder, 'package.json'), 'utf8')
      ) as { version?: string };
      if (manifest.version) return manifest.version;
    } catch {
      continue;
    }
  }
  return '0.0.0';
}

function parseAlgorithm(
  value: string | undefined,
  command: string
): Algorithm | undefined {
  if (value === undefined) return undefined;
  const found = ALGORITHMS.find((algorithm) => algorithm === value);
  if (!found) {
    throw new UsageError(
      `unknown algorithm: "${value}" (expected: ${ALGORITHMS.join(', ')})`,
      command
    );
  }
  return found;
}

function parsePreset(
  value: string | undefined,
  command: string
): Preset | undefined {
  if (value === undefined) return undefined;
  const found = PRESETS.find((preset) => preset === value);
  if (!found) {
    throw new UsageError(
      `unknown preset: "${value}" (expected: ${PRESETS.join(', ')})`,
      command
    );
  }
  return found;
}

function parseInteger(
  value: string | undefined,
  name: string,
  command: string
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new UsageError(
      `${name} expects a non-negative integer, got "${value}"`,
      command
    );
  }
  return parsed;
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? (value as string[]) : [];
}

interface ProgressReporter {
  onProgress?: (progress: Progress) => void;
  done: () => void;
}

/** Live progress on a terminal; silent when piped or in --quiet. */
function progressReporter(
  io: CliIO,
  quiet: boolean,
  label: string
): ProgressReporter {
  const stream = io.err as NodeJS.WriteStream;
  if (quiet || stream.isTTY !== true) return { done: () => undefined };

  let lastUpdate = 0;
  return {
    onProgress: (progress) => {
      const now = performance.now();
      if (now - lastUpdate < 80) return;
      lastUpdate = now;
      const detail =
        progress.ratio === undefined
          ? formatBytes(progress.bytesRead)
          : `${formatRatio(progress.ratio)} of ${formatBytes(progress.totalBytes ?? 0)}`;
      stream.write(`\r  ${label} ${detail}   `);
    },
    done: () => stream.write('\r\u001b[K'),
  };
}

interface CommandContext {
  io: CliIO;
  palette: Palette;
  quiet: boolean;
  json: boolean;
}

function line(io: CliIO, text = ''): void {
  io.out.write(`${text}\n`);
}

function emitJson(io: CliIO, value: unknown): void {
  io.out.write(`${JSON.stringify(value, null, 2)}\n`);
}

interface FileSummary {
  source: string;
  destination: string;
  bytesRead: number;
  bytesWritten: number;
  compressionRatio: number;
  durationMs: number;
}

function reportFile(context: CommandContext, result: FileSummary): void {
  const { palette } = context;
  // The ratio is only meaningful when the output actually shrank.
  const ratio =
    result.compressionRatio < 1
      ? `${palette.green(`(${formatRatio(result.compressionRatio)})`)} `
      : '';
  line(
    context.io,
    `${result.source} ${palette.dim('->')} ${palette.bold(result.destination)}  ` +
      `${formatBytes(result.bytesRead)} ${palette.dim('->')} ${formatBytes(result.bytesWritten)} ` +
      ratio +
      palette.dim(`in ${formatDuration(result.durationMs)}`)
  );
}

async function commandCompress(
  argv: string[],
  context: CommandContext
): Promise<number> {
  const { values, positionals } = parse(argv, 'compress', {
    algorithm: { type: 'string', short: 'a' },
    preset: { type: 'string', short: 'p' },
    level: { type: 'string', short: 'l' },
    output: { type: 'string', short: 'o' },
    stdout: { type: 'boolean', short: 'c' },
    force: { type: 'boolean', short: 'f' },
  });

  if (positionals.length === 0)
    throw new UsageError('at least one file is required', 'compress');

  const algorithm =
    parseAlgorithm(values['algorithm'] as string | undefined, 'compress') ??
    'gzip';
  const preset = parsePreset(
    values['preset'] as string | undefined,
    'compress'
  );
  const level = parseInteger(
    values['level'] as string | undefined,
    '--level',
    'compress'
  );
  const output = values['output'] as string | undefined;
  const toStdout = values['stdout'] === true || positionals.includes('-');

  if (positionals.length > 1 && (output !== undefined || toStdout)) {
    throw new UsageError(
      '--output and --stdout take a single input file',
      'compress'
    );
  }

  const options = {
    algorithm,
    ...(preset ? { preset } : {}),
    ...(level === undefined ? {} : { level }),
  };

  if (toStdout) {
    const first = positionals[0]!;
    const input = first === '-' ? context.io.in! : createReadStream(first);
    await pipeline(input, createCompressStream(options), context.io.out);
    return 0;
  }

  const results: FileSummary[] = [];
  for (const file of positionals) {
    const reporter = progressReporter(
      context.io,
      context.quiet,
      `compressing ${basename(file)}`
    );
    try {
      const result = await compressFile(
        file,
        output ?? `${file}${extensionFor(algorithm)}`,
        {
          ...options,
          overwrite: values['force'] === true,
          ...(reporter.onProgress ? { onProgress: reporter.onProgress } : {}),
        }
      );
      results.push(result);
      if (!context.json && !context.quiet) reportFile(context, result);
    } finally {
      reporter.done();
    }
  }

  if (context.json) emitJson(context.io, results);
  return 0;
}

async function commandDecompress(
  argv: string[],
  context: CommandContext
): Promise<number> {
  const { values, positionals } = parse(argv, 'decompress', {
    algorithm: { type: 'string', short: 'a' },
    output: { type: 'string', short: 'o' },
    stdout: { type: 'boolean', short: 'c' },
    force: { type: 'boolean', short: 'f' },
    'max-size': { type: 'string' },
  });

  if (positionals.length === 0)
    throw new UsageError('at least one file is required', 'decompress');

  const algorithm = parseAlgorithm(
    values['algorithm'] as string | undefined,
    'decompress'
  );
  const maxOutputSize = parseInteger(
    values['max-size'] as string | undefined,
    '--max-size',
    'decompress'
  );
  const output = values['output'] as string | undefined;
  const toStdout = values['stdout'] === true || positionals.includes('-');

  if (positionals.length > 1 && (output !== undefined || toStdout)) {
    throw new UsageError(
      '--output and --stdout take a single input file',
      'decompress'
    );
  }

  const options = {
    ...(algorithm ? { algorithm } : {}),
    ...(maxOutputSize === undefined ? {} : { maxOutputSize }),
  };

  if (toStdout) {
    const file = positionals[0]!;
    const input = file === '-' ? context.io.in! : createReadStream(file);
    const fallback =
      file === '-' ? undefined : algorithmForExtension(extname(file));
    await pipeline(
      input,
      createDecompressStream({
        ...options,
        ...(fallback ? { fallbackAlgorithm: fallback } : {}),
      }),
      context.io.out
    );
    return 0;
  }

  const results: FileSummary[] = [];
  for (const file of positionals) {
    const reporter = progressReporter(
      context.io,
      context.quiet,
      `decompressing ${basename(file)}`
    );
    const fileOptions = {
      ...options,
      overwrite: values['force'] === true,
      ...(reporter.onProgress ? { onProgress: reporter.onProgress } : {}),
    };
    try {
      const result = output
        ? await decompressFile(file, output, fileOptions)
        : await decompressFile(file, fileOptions);
      results.push(result);
      if (!context.json && !context.quiet) reportFile(context, result);
    } finally {
      reporter.done();
    }
  }

  if (context.json) emitJson(context.io, results);
  return 0;
}

async function commandPack(
  argv: string[],
  context: CommandContext
): Promise<number> {
  const { values, positionals } = parse(argv, 'pack', {
    format: { type: 'string' },
    compression: { type: 'string' },
    method: { type: 'string' },
    preset: { type: 'string', short: 'p' },
    level: { type: 'string', short: 'l' },
    root: { type: 'string' },
    exclude: { type: 'string', short: 'e', multiple: true },
    include: { type: 'string', short: 'i', multiple: true },
    'follow-symlinks': { type: 'boolean' },
    force: { type: 'boolean', short: 'f' },
    verbose: { type: 'boolean', short: 'v' },
  });

  const [destination, ...sources] = positionals;
  if (!destination)
    throw new UsageError('the archive path is required', 'pack');
  if (sources.length === 0)
    throw new UsageError('at least one source is required', 'pack');

  const format = values['format'] as ArchiveFormat | undefined;
  if (format !== undefined && format !== 'tar' && format !== 'zip') {
    throw new UsageError(
      `unknown format: "${format}" (expected: tar, zip)`,
      'pack'
    );
  }

  const compressionValue = values['compression'] as string | undefined;
  const compression =
    compressionValue === 'none'
      ? 'none'
      : parseAlgorithm(compressionValue, 'pack');

  const method = values['method'] as 'deflate' | 'store' | 'zstd' | undefined;
  if (method !== undefined && !['deflate', 'store', 'zstd'].includes(method)) {
    throw new UsageError(
      `unknown zip method: "${method}" (expected: deflate, store, zstd)`,
      'pack'
    );
  }

  const preset = parsePreset(values['preset'] as string | undefined, 'pack');
  const level = parseInteger(
    values['level'] as string | undefined,
    '--level',
    'pack'
  );
  const filter = buildFilter(
    asStrings(values['include']),
    asStrings(values['exclude'])
  );
  const verbose = values['verbose'] === true && !context.quiet;
  const compressionOptions = {
    ...(preset ? { preset } : {}),
    ...(level === undefined ? {} : { level }),
  };

  const result = await createArchive(destination, sources, {
    ...(format ? { format } : {}),
    ...(compression ? { compression } : {}),
    ...(method ? { method } : {}),
    ...(preset || level !== undefined ? { compressionOptions } : {}),
    ...(values['root'] ? { root: values['root'] as string } : {}),
    ...(filter ? { filter } : {}),
    followSymlinks: values['follow-symlinks'] === true,
    overwrite: values['force'] === true,
    ...(verbose
      ? {
          onEntry: (entry: ArchiveEntry) => line(context.io, `  ${entry.path}`),
        }
      : {}),
  });

  if (context.json) {
    emitJson(context.io, {
      destination: result.destination,
      format: result.format,
      compression: result.compression,
      entries: result.entries.length,
      bytesRead: result.bytesRead,
      bytesWritten: result.bytesWritten,
      durationMs: result.durationMs,
    });
    return 0;
  }

  if (!context.quiet) {
    const { palette } = context;
    const ratio =
      result.bytesRead === 0 ? 1 : result.bytesWritten / result.bytesRead;
    line(
      context.io,
      `${palette.bold(result.destination)}  ${result.entries.length} entries  ` +
        `${formatBytes(result.bytesRead)} ${palette.dim('->')} ${formatBytes(result.bytesWritten)} ` +
        `${palette.green(`(${formatRatio(ratio)})`)} ` +
        palette.dim(`in ${formatDuration(result.durationMs)}`)
    );
  }
  return 0;
}

async function commandUnpack(
  argv: string[],
  context: CommandContext
): Promise<number> {
  const { values, positionals } = parse(argv, 'unpack', {
    strip: { type: 'string' },
    exclude: { type: 'string', short: 'e', multiple: true },
    include: { type: 'string', short: 'i', multiple: true },
    symlinks: { type: 'string' },
    force: { type: 'boolean', short: 'f' },
    verbose: { type: 'boolean', short: 'v' },
  });

  const [source, destination = '.'] = positionals;
  if (!source) throw new UsageError('the archive path is required', 'unpack');

  const symlinks = values['symlinks'] as ExtractOptions['symlinks'];
  if (
    symlinks !== undefined &&
    !['allow', 'skip', 'error'].includes(symlinks)
  ) {
    throw new UsageError(`invalid --symlinks value: "${symlinks}"`, 'unpack');
  }

  const strip = parseInteger(
    values['strip'] as string | undefined,
    '--strip',
    'unpack'
  );
  const filter = buildFilter(
    asStrings(values['include']),
    asStrings(values['exclude'])
  );
  const verbose = values['verbose'] === true && !context.quiet;

  const result = await extractArchive(source, destination, {
    ...(strip === undefined ? {} : { strip }),
    ...(filter ? { filter } : {}),
    ...(symlinks ? { symlinks } : {}),
    overwrite: values['force'] === true,
    ...(verbose
      ? {
          onEntry: (entry: ArchiveEntry) => line(context.io, `  ${entry.path}`),
        }
      : {}),
  });

  if (context.json) {
    emitJson(context.io, {
      source: result.source,
      destination: result.destination,
      format: result.format,
      entries: result.entries.length,
      bytesWritten: result.bytesWritten,
      durationMs: result.durationMs,
    });
    return 0;
  }

  if (!context.quiet) {
    const { palette } = context;
    line(
      context.io,
      `${result.source} ${palette.dim('->')} ${palette.bold(result.destination)}  ` +
        `${result.entries.length} entries  ${formatBytes(result.bytesWritten)} ` +
        palette.dim(`in ${formatDuration(result.durationMs)}`)
    );
  }
  return 0;
}

async function commandList(
  argv: string[],
  context: CommandContext
): Promise<number> {
  const { values, positionals } = parse(argv, 'list', {
    long: { type: 'boolean', short: 'l' },
  });

  const source = positionals[0];
  if (!source) throw new UsageError('the archive path is required', 'list');
  if (positionals.length > 1)
    throw new UsageError('list takes a single archive', 'list');

  const entries = await listArchive(source);

  if (context.json) {
    emitJson(
      context.io,
      entries.map((entry) => ({ ...entry, mtime: entry.mtime.toISOString() }))
    );
    return 0;
  }

  const long = values['long'] === true;
  const label = (entry: ArchiveEntry): string =>
    entry.linkPath ? `${entry.path} -> ${entry.linkPath}` : entry.path;

  const rows = entries.map((entry) =>
    long
      ? [
          formatMode(entry.mode, entry.type),
          formatBytes(entry.size),
          formatDate(entry.mtime),
          label(entry),
        ]
      : [formatBytes(entry.size), label(entry)]
  );

  for (const row of formatTable(rows, long ? [1] : [0])) line(context.io, row);

  if (!context.quiet) {
    const total = entries.reduce((sum, entry) => sum + entry.size, 0);
    const files = entries.filter((entry) => entry.type === 'file').length;
    line(
      context.io,
      context.palette.dim(
        `${entries.length} entries (${files} files), ${formatBytes(total)} uncompressed`
      )
    );
  }
  return 0;
}

async function commandInfo(
  argv: string[],
  context: CommandContext
): Promise<number> {
  const { positionals } = parse(argv, 'info', {});
  if (positionals.length === 0)
    throw new UsageError('at least one file is required', 'info');

  const report = [];
  for (const file of positionals) {
    const stats = await stat(file);
    report.push({
      path: file,
      size: stats.size,
      compression: (await detectFile(file)) ?? null,
      archive: (await detectArchiveFile(file).catch(() => undefined)) ?? null,
    });
  }

  if (context.json) {
    emitJson(context.io, report);
    return 0;
  }

  const { palette } = context;
  const rows = report.map((item) => [
    item.path,
    formatBytes(item.size),
    item.archive ? `${item.archive} archive` : 'file',
    item.compression
      ? `${item.compression} compressed`
      : palette.dim('not compressed'),
  ]);
  for (const row of formatTable(rows, [1])) line(context.io, row);
  return 0;
}

async function commandInstallSkill(
  argv: string[],
  context: CommandContext
): Promise<number> {
  const { positionals } = parse(argv, 'install-skill', {});
  if (positionals.length > 1) {
    throw new UsageError(
      'install-skill takes a single directory',
      'install-skill'
    );
  }

  const destination = positionals[0] ?? process.cwd();
  const target = await installSkill(destination);

  if (context.json) {
    emitJson(context.io, { skill: SKILL_NAME, destination: target });
    return 0;
  }
  if (!context.quiet) {
    line(
      context.io,
      `Claude skill installed in ${context.palette.bold(target)}`
    );
  }
  return 0;
}

type OptionConfig = NonNullable<ParseArgsConfig['options']>;

const COMMON_OPTIONS: OptionConfig = {
  help: { type: 'boolean', short: 'h' },
  quiet: { type: 'boolean', short: 'q' },
  json: { type: 'boolean' },
};

function parse(
  argv: string[],
  command: string,
  options: OptionConfig
): { values: Record<string, unknown>; positionals: string[] } {
  try {
    const parsed = parseArgs({
      args: argv,
      options: { ...COMMON_OPTIONS, ...options },
      allowPositionals: true,
      strict: true,
    });
    return {
      values: parsed.values as Record<string, unknown>,
      positionals: parsed.positionals,
    };
  } catch (error) {
    throw new UsageError((error as Error).message, command);
  }
}

const COMMANDS: Record<
  string,
  (argv: string[], context: CommandContext) => Promise<number>
> = {
  compress: commandCompress,
  decompress: commandDecompress,
  pack: commandPack,
  unpack: commandUnpack,
  list: commandList,
  info: commandInfo,
  'install-skill': commandInstallSkill,
};

const ALIASES: Record<string, string> = {
  c: 'compress',
  d: 'decompress',
  x: 'unpack',
  extract: 'unpack',
  create: 'pack',
  ls: 'list',
  t: 'list',
};

/**
 * CLI entry point. Returns the exit code: 0 success, 1 runtime failure,
 * 2 usage error.
 */
export async function run(
  argv: readonly string[],
  io: CliIO = DEFAULT_IO
): Promise<number> {
  const args = [...argv];
  const palette = paletteFor(io.out);

  if (
    args.length === 0 ||
    args[0] === '--help' ||
    args[0] === '-h' ||
    args[0] === 'help'
  ) {
    const topic = args[1] ? (ALIASES[args[1]] ?? args[1]) : undefined;
    line(io, (topic && COMMAND_HELP[topic]) || GENERAL_HELP);
    return 0;
  }

  if (args[0] === '--version' || args[0] === '-V' || args[0] === 'version') {
    line(io, readVersion());
    return 0;
  }

  const name = ALIASES[args[0]!] ?? args[0]!;
  const command = COMMANDS[name];

  if (!command) {
    io.err.write(
      `${palette.red('error:')} unknown command "${args[0]}"\n\n${GENERAL_HELP}\n`
    );
    return 2;
  }

  const rest = args.slice(1);
  if (rest.includes('--help') || rest.includes('-h')) {
    line(io, COMMAND_HELP[name] ?? GENERAL_HELP);
    return 0;
  }

  try {
    return await command(rest, {
      io,
      palette,
      quiet: rest.includes('--quiet') || rest.includes('-q'),
      json: rest.includes('--json'),
    });
  } catch (error) {
    return reportError(error, io, palette);
  }
}

function reportError(error: unknown, io: CliIO, palette: Palette): number {
  if (error instanceof UsageError) {
    const help = (error.command && COMMAND_HELP[error.command]) || GENERAL_HELP;
    io.err.write(`${palette.red('error:')} ${error.message}\n\n${help}\n`);
    return 2;
  }

  if (isCompressionError(error)) {
    io.err.write(
      `${palette.red('error:')} ${error.message} ${palette.dim(`[${error.code}]`)}\n`
    );
    return 1;
  }

  const errno = error as NodeJS.ErrnoException;
  if (errno.code === 'ENOENT') {
    io.err.write(
      `${palette.red('error:')} file not found: ${errno.path ?? ''}\n`
    );
    return 1;
  }
  if (errno.code === 'EACCES' || errno.code === 'EPERM') {
    io.err.write(
      `${palette.red('error:')} permission denied: ${errno.path ?? ''}\n`
    );
    return 1;
  }

  io.err.write(
    `${palette.red('error:')} ${(error as Error).message ?? String(error)}\n`
  );
  return 1;
}

export { UsageError };
