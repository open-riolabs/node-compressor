/**
 * Minimal pattern matcher for the `--include` / `--exclude` options.
 * Supports `*` (within one segment), `**` (across directories) and `?`.
 */

const SPECIAL = /[.+^${}()|[\]\\]/g;

function toRegExp(pattern: string): RegExp {
  let source = '';

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;

    if (char === '*') {
      if (pattern[index + 1] === '*') {
        index += 1;
        if (pattern[index + 1] === '/') index += 1;
        source += '(?:.*/)?';
        continue;
      }
      source += '[^/]*';
      continue;
    }

    source += char === '?' ? '[^/]' : char.replace(SPECIAL, '\\$&');
  }

  return new RegExp(`^${source}$`);
}

const cache = new Map<string, RegExp>();

function compiled(pattern: string): RegExp {
  const existing = cache.get(pattern);
  if (existing) return existing;
  const expression = toRegExp(pattern);
  cache.set(pattern, expression);
  return expression;
}

/**
 * Matches an archive path against a pattern. Patterns without a `/` are also
 * compared against the file name alone, the way `tar --exclude` behaves.
 */
export function matchesPattern(path: string, pattern: string): boolean {
  const expression = compiled(pattern);
  if (expression.test(path)) return true;
  if (pattern.includes('/')) return false;

  const name = path.slice(path.lastIndexOf('/') + 1);
  return expression.test(name);
}

/** True when at least one pattern matches. */
export function matchesAny(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesPattern(path, pattern));
}

/**
 * Builds the filter to hand to the archive APIs from the `--include` and
 * `--exclude` lists.
 */
export function buildFilter(
  include: readonly string[],
  exclude: readonly string[]
): ((entry: { path: string }) => boolean) | undefined {
  if (include.length === 0 && exclude.length === 0) return undefined;

  return (entry) => {
    if (exclude.length > 0 && matchesAny(entry.path, exclude)) return false;
    return include.length === 0 || matchesAny(entry.path, include);
  };
}
