import type { SnapshotFormat } from './diff.js';

/** Values truncate to this many characters when shown in a {@link SnapshotChange}. */
export const MAX_VALUE_LENGTH = 200;

/**
 * Truncates `value` to at most {@link MAX_VALUE_LENGTH} characters, the
 * ellipsis that marks a cut included. Used for every `expected`/`actual`
 * value a snapshot diff reports, so a large body never balloons the diff
 * output.
 */
export function truncateValue(value: string): string {
  if (value.length <= MAX_VALUE_LENGTH) {
    return value;
  }
  return `${value.slice(0, MAX_VALUE_LENGTH - 1)}…`;
}

/**
 * Decides whether a snapshot body should be compared as JSON, XML or plain
 * text. `contentType` (when given) takes priority, since it's the type
 * recorded alongside the golden; otherwise the trimmed body's first
 * character decides.
 */
export function detectSnapshotFormat(body: string, contentType?: string): SnapshotFormat {
  if (contentType !== undefined) {
    // Media types are case-insensitive (RFC 9110 §8.3.1).
    const type = contentType.toLowerCase();
    if (type.includes('json')) {
      return 'json';
    }
    if (type.includes('xml')) {
      return 'xml';
    }
  }
  const trimmed = body.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return 'json';
  }
  if (trimmed.startsWith('<')) {
    return 'xml';
  }
  return 'text';
}
