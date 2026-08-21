import type { Algorithm } from '../enums/compression.enum.ts';
import type {
  ArchiveFormat,
  EntryType,
  SymlinkPolicy,
  ZipMethod,
} from '../enums/archive.enum.ts';
import type {
  CompressOptions,
  DestinationOptions,
} from './compression.model.ts';

/** Metadata of a single archive entry. */
export interface ArchiveEntry {
  /** Path inside the archive, always with `/` separators. */
  path: string;
  type: EntryType;
  /** Uncompressed size in bytes. Zero for directories and symlinks. */
  size: number;
  /** POSIX permissions, e.g. `0o644`. */
  mode: number;
  mtime: Date;
  /** Link target, only for `type: 'symlink'`. */
  linkPath?: string;
  /** Size taken inside the archive, when the format reports it (zip). */
  compressedSize?: number;
}

/** Entry whose content comes from a file on disk. */
export interface FileEntryInput {
  /** Path to use inside the archive. */
  path: string;
  /** Path of the file on disk. */
  source: string;
  mode?: number;
  mtime?: Date;
}

/** Entry whose content is provided in memory. */
export interface DataEntryInput {
  path: string;
  data: Uint8Array | string;
  mode?: number;
  mtime?: Date;
}

export interface DirectoryEntryInput {
  path: string;
  type: 'directory';
  mode?: number;
  mtime?: Date;
}

export interface SymlinkEntryInput {
  path: string;
  type: 'symlink';
  linkPath: string;
  mode?: number;
  mtime?: Date;
}

/**
 * Source of an archive entry: a path on disk (a file, or a directory that is
 * walked recursively) or an explicitly described entry.
 */
export type ArchiveSource =
  | string
  | FileEntryInput
  | DataEntryInput
  | DirectoryEntryInput
  | SymlinkEntryInput;

/** Resolved entry, ready to be written into the archive. */
export interface ResolvedEntry extends ArchiveEntry {
  /** File on disk to read the content from. */
  origin?: string;
  /** Content already available in memory. */
  data?: Buffer;
}

export interface ArchiveBuildOptions {
  /**
   * Base directory for sources given as strings: the paths stored in the
   * archive are relative to it. Default: the directory containing each source.
   */
  root?: string;
  /** Archive the link target instead of the link itself. Default: `false`. */
  followSymlinks?: boolean;
  /** Drops the entries this returns `false` for. */
  filter?: (entry: ArchiveEntry) => boolean;
  /** Called for every entry actually written. */
  onEntry?: (entry: ArchiveEntry) => void;
}

export interface CreateArchiveOptions
  extends ArchiveBuildOptions, DestinationOptions {
  /**
   * Compression to apply to the tar archive. Default: taken from the
   * destination extension (`.tar.gz`, `.tgz`, `.tar.zst`, ...), otherwise
   * `'none'`.
   *
   * Ignored by zip, which compresses each entry on its own.
   */
  compression?: Algorithm | 'none';
  /** Level or preset for that compression. */
  compressionOptions?: Omit<CompressOptions, 'algorithm' | 'signal'>;
  signal?: AbortSignal;
}

export interface ZipBuildOptions extends ArchiveBuildOptions {
  /**
   * Method applied to the entries. Default: `'deflate'`, which together with
   * `'store'` is the only universally supported one. `'zstd'` (method 93)
   * needs a recent reader.
   */
  method?: ZipMethod;
  /** Level or preset for the per-entry compression. */
  compressionOptions?: CreateArchiveOptions['compressionOptions'];
}

export interface CreateZipOptions
  extends ZipBuildOptions, CreateArchiveOptions {}

/** Extraction options, shared by tar and zip. */
export interface ExtractOptions {
  /** Overwrite files already present in the destination. Default: `false`. */
  overwrite?: boolean;
  /** Drop the first N path components of every entry. Default: `0`. */
  strip?: number;
  /** Extract only the entries this returns `true` for. */
  filter?: (entry: ArchiveEntry) => boolean;
  /** Called for every extracted entry. */
  onEntry?: (entry: ArchiveEntry) => void;
  /** How to treat symbolic links. Default: `'allow'`. */
  symlinks?: SymlinkPolicy;
  /** Apply the permissions recorded in the archive. Default: `true`. */
  preserveMode?: boolean;
  /** Apply the modification time recorded in the archive. Default: `true`. */
  preserveMtime?: boolean;
  /**
   * Outer compression of the tar archive. Default: `'auto'`, detected from the
   * content and the extension. Ignored by zip.
   */
  compression?: Algorithm | 'none' | 'auto';
  signal?: AbortSignal;
}

/** How to treat the outer compression of a tar archive being read. */
export interface ArchiveOpenOptions {
  /**
   * Compression of the archive. With `'auto'` (the default) it is detected
   * from the magic bytes and, for paths on disk, from the extension — which is
   * what brotli needs, having no identifiable header.
   */
  compression?: Algorithm | 'none' | 'auto';
  signal?: AbortSignal;
}

/** Outcome of creating an archive. */
export interface ArchiveResult {
  destination: string;
  format: ArchiveFormat;
  /** Compression applied to the tar archive, or `'none'`. */
  compression: Algorithm | 'none';
  entries: ArchiveEntry[];
  /** Total uncompressed bytes of the entries. */
  bytesRead: number;
  /** Size of the archive produced. */
  bytesWritten: number;
  durationMs: number;
}

/** Outcome of extracting an archive. */
export interface ExtractResult {
  source: string;
  destination: string;
  format: ArchiveFormat;
  entries: ArchiveEntry[];
  /** Bytes written to disk. */
  bytesWritten: number;
  durationMs: number;
}
