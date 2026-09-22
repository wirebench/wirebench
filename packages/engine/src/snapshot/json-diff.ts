import type { SnapshotChange } from './diff.js';
import { truncateValue } from './format.js';

/** JSON Pointer escaping: `~` first, then `/` (RFC 6901 §4). */
function escapeToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

/**
 * Builds a JSON Pointer from path segments (already unescaped). The root is
 * `/` rather than RFC 6901's empty string, so every path a diff reports can
 * be shown and saved as an ignore rule as it is.
 */
function pointer(segments: readonly string[]): string {
  return segments.length === 0 ? '/' : segments.map((segment) => `/${escapeToken(segment)}`).join('');
}

type JsonKind = 'null' | 'array' | 'object' | 'string' | 'number' | 'boolean' | 'undefined';

function kindOf(value: unknown): JsonKind {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value as JsonKind;
}

function display(value: unknown): string {
  return truncateValue(value === undefined ? 'undefined' : JSON.stringify(value));
}

/**
 * Recursively compares two parsed JSON values and appends every difference
 * found to `changes`, as a JSON Pointer path plus the semantic rules from
 * the "Semantic diff" spec section: key order doesn't matter, `1.0` equals
 * `1`, array tails are `added`/`removed`, and a type change is one `changed`.
 */
function diffValue(golden: unknown, actual: unknown, path: readonly string[], changes: SnapshotChange[]): void {
  const goldenKind = kindOf(golden);
  const actualKind = kindOf(actual);

  if (goldenKind !== actualKind) {
    changes.push({ kind: 'changed', path: pointer(path), expected: display(golden), actual: display(actual) });
    return;
  }

  switch (goldenKind) {
    case 'array': {
      const goldenArray = golden as unknown[];
      const actualArray = actual as unknown[];
      const shared = Math.min(goldenArray.length, actualArray.length);
      for (let i = 0; i < shared; i += 1) {
        diffValue(goldenArray[i], actualArray[i], [...path, String(i)], changes);
      }
      for (let i = shared; i < goldenArray.length; i += 1) {
        changes.push({ kind: 'removed', path: pointer([...path, String(i)]), expected: display(goldenArray[i]) });
      }
      for (let i = shared; i < actualArray.length; i += 1) {
        changes.push({ kind: 'added', path: pointer([...path, String(i)]), actual: display(actualArray[i]) });
      }
      return;
    }
    case 'object': {
      const goldenObject = golden as Record<string, unknown>;
      const actualObject = actual as Record<string, unknown>;
      const keys = new Set([...Object.keys(goldenObject), ...Object.keys(actualObject)]);
      for (const key of keys) {
        const inGolden = Object.hasOwn(goldenObject, key);
        const inActual = Object.hasOwn(actualObject, key);
        if (inGolden && inActual) {
          diffValue(goldenObject[key], actualObject[key], [...path, key], changes);
        } else if (inGolden) {
          changes.push({ kind: 'removed', path: pointer([...path, key]), expected: display(goldenObject[key]) });
        } else {
          changes.push({ kind: 'added', path: pointer([...path, key]), actual: display(actualObject[key]) });
        }
      }
      return;
    }
    case 'number': {
      // Compared by value, so `1.0` and `1` — indistinguishable once parsed — are equal.
      if ((golden as number) !== (actual as number)) {
        changes.push({ kind: 'changed', path: pointer(path), expected: display(golden), actual: display(actual) });
      }
      return;
    }
    default: {
      if (golden !== actual) {
        changes.push({ kind: 'changed', path: pointer(path), expected: display(golden), actual: display(actual) });
      }
    }
  }
}

/** Semantically diffs two JSON documents, returning every change found. */
export function diffJson(golden: unknown, actual: unknown): SnapshotChange[] {
  const changes: SnapshotChange[] = [];
  diffValue(golden, actual, [], changes);
  return changes;
}
