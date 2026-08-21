/** Archive formats handled by the library. */
export type ArchiveFormat = 'tar' | 'zip';

/** Kind of entry an archive can hold. */
export type EntryType = 'file' | 'directory' | 'symlink';

/** How extraction treats symbolic links. */
export type SymlinkPolicy = 'allow' | 'skip' | 'error';

/** Compression method applied to the entries of a zip archive. */
export type ZipMethod = 'deflate' | 'store' | 'zstd';
