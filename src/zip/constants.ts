/** Signatures and constants of the ZIP format (APPNOTE 6.3.x). */

export const LOCAL_HEADER_SIGNATURE = 0x04034b50;
export const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
export const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
export const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
export const ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06064b50;
export const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;

export const LOCAL_HEADER_SIZE = 30;
export const CENTRAL_HEADER_SIZE = 46;
export const END_OF_CENTRAL_DIRECTORY_SIZE = 22;

export const ZIP64_EXTRA_ID = 0x0001;
export const TIMESTAMP_EXTRA_ID = 0x5455;

export const UINT16_MAX = 0xffff;
export const UINT32_MAX = 0xffffffff;

/** Bit 0: encrypted content (unsupported). */
export const FLAG_ENCRYPTED = 0x0001;
/** Bit 3: sizes and CRC live in the data descriptor after the data. */
export const FLAG_DATA_DESCRIPTOR = 0x0008;
/** Bit 11: name and comment are UTF-8. */
export const FLAG_UTF8 = 0x0800;

export const METHOD_STORE = 0;
export const METHOD_DEFLATE = 8;
export const METHOD_ZSTD = 93;

/** POSIX file-type bits, as stored in the external attributes. */
export const S_IFREG = 0o100000;
export const S_IFDIR = 0o040000;
export const S_IFLNK = 0o120000;

/** "Version made by" 3 = UNIX, which keeps the permissions readable. */
export const VERSION_MADE_BY = (3 << 8) | 63;
export const VERSION_NEEDED = 20;
export const VERSION_NEEDED_ZIP64 = 45;

/** Earliest date representable in MS-DOS format. */
export const DOS_EPOCH_YEAR = 1980;

/** Converts a date into the MS-DOS format used by zip headers. */
export function toDosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(date.getFullYear(), DOS_EPOCH_YEAR);
  return {
    time:
      (date.getHours() << 11) |
      (date.getMinutes() << 5) |
      Math.floor(date.getSeconds() / 2),
    date:
      ((year - DOS_EPOCH_YEAR) << 9) |
      ((date.getMonth() + 1) << 5) |
      date.getDate(),
  };
}

/** Inverse of {@link toDosDateTime}. */
export function fromDosDateTime(time: number, date: number): Date {
  return new Date(
    DOS_EPOCH_YEAR + ((date >> 9) & 0x7f),
    ((date >> 5) & 0x0f) - 1,
    date & 0x1f,
    (time >> 11) & 0x1f,
    (time >> 5) & 0x3f,
    (time & 0x1f) * 2
  );
}
