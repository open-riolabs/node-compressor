/** Presentation helpers for the CLI: sizes, durations, colours, tables. */

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const;

/** Human-readable size: `1.2 MiB`. */
export function formatBytes(bytes: number): string {
  let value = Math.max(bytes, 0);
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

/** Human-readable duration: `820 ms`, `4.2 s`, `1 m 05 s`. */
export function formatDuration(milliseconds: number): string {
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(1)} s`;
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.round((milliseconds % 60_000) / 1000);
  return `${minutes} m ${String(seconds).padStart(2, '0')} s`;
}

/** Compression ratio as a percentage of the original size. */
export function formatRatio(ratio: number): string {
  return `${(ratio * 100).toFixed(0)}%`;
}

/** Compact local date: `2026-08-21 09:12`. */
export function formatDate(date: Date): string {
  if (Number.isNaN(date.getTime())) return '-'.padEnd(16);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** Permissions in `ls` style: `drwxr-xr-x`. */
export function formatMode(
  mode: number,
  type: 'file' | 'directory' | 'symlink'
): string {
  const prefix = type === 'directory' ? 'd' : type === 'symlink' ? 'l' : '-';
  let result = prefix;
  for (let shift = 6; shift >= 0; shift -= 3) {
    const bits = (mode >> shift) & 0b111;
    result +=
      (bits & 0b100 ? 'r' : '-') +
      (bits & 0b010 ? 'w' : '-') +
      (bits & 0b001 ? 'x' : '-');
  }
  return result;
}

/** ANSI colours, disabled outside a terminal or under `NO_COLOR`. */
export interface Palette {
  bold: (text: string) => string;
  dim: (text: string) => string;
  green: (text: string) => string;
  red: (text: string) => string;
  yellow: (text: string) => string;
}

const identity = (text: string): string => text;

const PLAIN: Palette = {
  bold: identity,
  dim: identity,
  green: identity,
  red: identity,
  yellow: identity,
};

const COLORED: Palette = {
  bold: (text) => `\u001b[1m${text}\u001b[22m`,
  dim: (text) => `\u001b[2m${text}\u001b[22m`,
  green: (text) => `\u001b[32m${text}\u001b[39m`,
  red: (text) => `\u001b[31m${text}\u001b[39m`,
  yellow: (text) => `\u001b[33m${text}\u001b[39m`,
};

export function paletteFor(stream: NodeJS.WritableStream): Palette {
  const isTty = (stream as NodeJS.WriteStream).isTTY === true;
  const disabled =
    process.env['NO_COLOR'] !== undefined || process.env['TERM'] === 'dumb';
  return isTty && !disabled ? COLORED : PLAIN;
}

/** Aligns the columns of a text table. */
export function formatTable(
  rows: readonly (readonly string[])[],
  alignRight: readonly number[] = []
): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, cell.length);
    });
  }
  return rows.map((row) =>
    row
      .map((cell, index) =>
        index === row.length - 1
          ? cell
          : alignRight.includes(index)
            ? cell.padStart(widths[index] ?? 0)
            : cell.padEnd(widths[index] ?? 0)
      )
      .join('  ')
      .trimEnd()
  );
}
