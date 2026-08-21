import { open } from 'node:fs/promises';
import { Readable } from 'node:stream';

import { CompressionError } from '../data/index.ts';

/**
 * Sequential reader over an async stream: lets callers consume an exact number
 * of bytes without materialising the whole content in memory.
 */
export class ChunkReader {
  readonly #iterator: AsyncIterator<Uint8Array | string>;
  #chunks: Buffer[] = [];
  #available = 0;
  #ended = false;
  #position = 0;

  constructor(source: AsyncIterable<Uint8Array | string>) {
    this.#iterator = source[Symbol.asyncIterator]();
  }

  /** Bytes consumed so far. */
  get position(): number {
    return this.#position;
  }

  async #pull(): Promise<boolean> {
    if (this.#ended) return false;
    const next = await this.#iterator.next();
    if (next.done === true) {
      this.#ended = true;
      return false;
    }
    const chunk =
      typeof next.value === 'string'
        ? Buffer.from(next.value, 'utf8')
        : Buffer.from(next.value);
    if (chunk.byteLength === 0) return this.#pull();
    this.#chunks.push(chunk);
    this.#available += chunk.byteLength;
    return true;
  }

  #take(length: number): Buffer {
    const parts: Buffer[] = [];
    let remaining = length;
    while (remaining > 0) {
      const head = this.#chunks[0]!;
      if (head.byteLength <= remaining) {
        parts.push(head);
        remaining -= head.byteLength;
        this.#chunks.shift();
      } else {
        parts.push(head.subarray(0, remaining));
        this.#chunks[0] = head.subarray(remaining);
        remaining = 0;
      }
    }
    this.#available -= length;
    this.#position += length;
    return parts.length === 1 ? parts[0]! : Buffer.concat(parts, length);
  }

  /**
   * Reads exactly `length` bytes. Returns `undefined` when the stream ended
   * with nothing left to read.
   */
  async read(length: number): Promise<Buffer | undefined> {
    while (this.#available < length) {
      if (!(await this.#pull())) {
        if (this.#available === 0) return undefined;
        throw new CompressionError(
          'ERR_ARCHIVE_INVALID',
          `Truncated archive: expected ${length} bytes, only ${this.#available} available.`
        );
      }
    }
    return this.#take(length);
  }

  /** Same as {@link read}, but a finished stream is an error. */
  async readExactly(length: number): Promise<Buffer> {
    const block = await this.read(length);
    if (!block) {
      throw new CompressionError(
        'ERR_ARCHIVE_INVALID',
        `Truncated archive: expected ${length} bytes, stream ended.`
      );
    }
    return block;
  }

  /** Consumes `length` bytes, yielding them chunk by chunk. */
  async *take(length: number): AsyncGenerator<Buffer> {
    let remaining = length;
    while (remaining > 0) {
      if (this.#available === 0 && !(await this.#pull())) {
        throw new CompressionError(
          'ERR_ARCHIVE_INVALID',
          `Truncated archive: ${remaining} bytes missing.`
        );
      }
      const size = Math.min(remaining, this.#available);
      yield this.#take(size);
      remaining -= size;
    }
  }

  /** Discards `length` bytes. */
  async skip(length: number): Promise<void> {
    for await (const _chunk of this.take(length)) {
      // The content is deliberately dropped.
    }
  }

  async close(): Promise<void> {
    this.#chunks = [];
    this.#available = 0;
    await this.#iterator.return?.();
  }
}

/** Random access to binary content, which is what reading zip requires. */
export interface RandomAccess {
  readonly size: number;
  read(offset: number, length: number): Promise<Buffer>;
  close(): Promise<void>;
}

/** Random access backed by an open file descriptor. */
export async function randomAccessFile(path: string): Promise<RandomAccess> {
  const handle = await open(path, 'r');
  const stats = await handle.stat();
  return {
    size: stats.size,
    async read(offset, length) {
      if (length <= 0) return Buffer.alloc(0);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      return buffer.subarray(0, bytesRead);
    },
    async close() {
      await handle.close();
    },
  };
}

/** Random access over an archive already held in memory. */
export function randomAccessBuffer(data: Uint8Array): RandomAccess {
  const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return {
    size: buffer.byteLength,
    async read(offset, length) {
      return buffer.subarray(offset, offset + Math.max(length, 0));
    },
    async close() {
      // Nothing to release.
    },
  };
}

/** Exposes a range of a {@link RandomAccess} as a readable stream. */
export function readRange(
  access: RandomAccess,
  offset: number,
  length: number,
  chunkSize = 64 * 1024
): Readable {
  return Readable.from(
    (async function* () {
      let position = offset;
      let remaining = length;
      while (remaining > 0) {
        const size = Math.min(chunkSize, remaining);
        const chunk = await access.read(position, size);
        if (chunk.byteLength === 0) {
          throw new CompressionError(
            'ERR_ARCHIVE_INVALID',
            'Truncated archive while reading.'
          );
        }
        position += chunk.byteLength;
        remaining -= chunk.byteLength;
        yield chunk;
      }
    })()
  );
}
