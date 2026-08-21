/**
 * Error codes raised by the library. They are stable and meant to be used for
 * control flow instead of matching on messages.
 */
export type CompressionErrorCode =
  | 'ERR_UNKNOWN_ALGORITHM'
  | 'ERR_DETECTION_FAILED'
  | 'ERR_INVALID_LEVEL'
  | 'ERR_INVALID_INPUT'
  | 'ERR_DESTINATION_EXISTS'
  | 'ERR_DESTINATION_REQUIRED'
  | 'ERR_COMPRESSION_FAILED'
  | 'ERR_DECOMPRESSION_FAILED'
  | 'ERR_ARCHIVE_INVALID'
  | 'ERR_ARCHIVE_UNSUPPORTED'
  | 'ERR_UNSAFE_ENTRY_PATH'
  | 'ERR_ENTRY_NOT_FOUND'
  | 'ERR_CHECKSUM_MISMATCH';

/** Every error this library throws, always carrying a `code`. */
export class CompressionError extends Error {
  override readonly name = 'CompressionError';
  readonly code: CompressionErrorCode;

  constructor(
    code: CompressionErrorCode,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.code = code;
  }
}

/** Type guard for the catch blocks of consumer code. */
export function isCompressionError(value: unknown): value is CompressionError {
  return value instanceof CompressionError;
}
