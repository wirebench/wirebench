import { isWirebenchError } from '../errors.js';
import { truncateValue } from './format.js';
import { diffJson } from './json-diff.js';
import { diffXml } from './xml-diff.js';
import { matchesIgnoreRule } from './ignore.js';

/** How a snapshot body is compared: semantically for `json`/`xml`, exactly for `text`. */
export type SnapshotFormat = 'json' | 'xml' | 'text';

/** One difference {@link diffSnapshot} found between the golden and the actual body. */
export interface SnapshotChange {
  readonly kind: 'added' | 'removed' | 'changed';
  readonly path: string;
  readonly expected?: string;
  readonly actual?: string;
}

/** The result of comparing a golden body against a newly received one. */
export interface SnapshotDiff {
  readonly format: SnapshotFormat;
  readonly changes: readonly SnapshotChange[];
  readonly ignored: number;
  readonly error?: string;
}

/** Normalises line endings before an exact text comparison. */
function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

function diffText(golden: string, actual: string): SnapshotChange[] {
  const normalizedGolden = normalizeLineEndings(golden);
  const normalizedActual = normalizeLineEndings(actual);
  if (normalizedGolden === normalizedActual) {
    return [];
  }
  return [
    {
      kind: 'changed',
      path: '/',
      expected: truncateValue(normalizedGolden),
      actual: truncateValue(normalizedActual),
    },
  ];
}

/** Applies every truncation the spec asks for to a change's `expected`/`actual` values. */
function truncateChange(change: SnapshotChange): SnapshotChange {
  return {
    ...change,
    ...(change.expected !== undefined ? { expected: truncateValue(change.expected) } : {}),
    ...(change.actual !== undefined ? { actual: truncateValue(change.actual) } : {}),
  };
}

/**
 * Semantically compares a golden body against a newly received one. JSON
 * and XML are compared structurally (see {@link diffJson} and
 * {@link diffXml}); anything else, or a body that fails to parse in its
 * declared format, falls back to an exact text comparison and — for the
 * parse-failure case — sets `error`.
 *
 * Changes that a rule in `options.ignore` covers are dropped from the
 * result and counted in `ignored` instead.
 */
export function diffSnapshot(
  golden: string,
  actual: string,
  options: { format: SnapshotFormat; ignore: readonly string[] },
): SnapshotDiff {
  let format = options.format;
  let changes: SnapshotChange[];
  let error: string | undefined;

  try {
    switch (format) {
      case 'json':
        changes = diffJson(JSON.parse(golden), JSON.parse(actual));
        break;
      case 'xml':
        changes = diffXml(golden, actual);
        break;
      default:
        changes = diffText(golden, actual);
    }
  } catch (cause) {
    format = 'text';
    error = isWirebenchError(cause) || cause instanceof Error ? cause.message : String(cause);
    changes = diffText(golden, actual);
  }

  let ignored = 0;
  const kept: SnapshotChange[] = [];
  for (const change of changes) {
    if (options.ignore.some((rule) => matchesIgnoreRule(change.path, rule))) {
      ignored += 1;
    } else {
      kept.push(truncateChange(change));
    }
  }

  return { format, changes: kept, ignored, ...(error !== undefined ? { error } : {}) };
}
