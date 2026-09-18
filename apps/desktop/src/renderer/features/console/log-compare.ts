/**
 * Comparing two HTTP Log rows: which headers differ, and both bodies made comparable — pretty-printed
 * the same way when both sides are JSON, or both XML.
 */
import { formatXml } from '@wirebench/engine/xml';
import { decodeBase64Text } from '../../lib/format-size.js';
import type { LogEntry } from '../../state/exchanges.js';

export type HeaderChange = 'same' | 'added' | 'removed' | 'changed';

export interface HeaderDiffRow {
  readonly name: string;
  readonly left?: string;
  readonly right?: string;
  readonly change: HeaderChange;
}

/** Case-insensitive by name, sorted by name; the first-seen spelling of a name wins. */
export function diffHeaders(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): HeaderDiffRow[] {
  const spelling = new Map<string, string>();
  const lower = (headers: Readonly<Record<string, string>>): Map<string, string> => {
    const map = new Map<string, string>();
    for (const [name, value] of Object.entries(headers)) {
      const key = name.toLowerCase();
      if (!spelling.has(key)) spelling.set(key, name);
      map.set(key, value);
    }
    return map;
  };
  const l = lower(left);
  const r = lower(right);
  return [...spelling.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((key): HeaderDiffRow => {
      const name = spelling.get(key) ?? key;
      const a = l.get(key);
      const b = r.get(key);
      if (a === undefined) return { name, right: b ?? '', change: 'added' };
      if (b === undefined) return { name, left: a, change: 'removed' };
      return { name, left: a, right: b, change: a === b ? 'same' : 'changed' };
    });
}

export interface ComparableBodies {
  readonly left: string;
  readonly right: string;
  readonly language: 'json' | 'xml' | 'plaintext';
}

function parseJson(text: string): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return undefined;
  }
}

function isXml(text: string): boolean {
  if (!text.trim().startsWith('<') || typeof DOMParser === 'undefined') return false;
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  return doc.getElementsByTagName('parsererror').length === 0;
}

/** Pretty-prints JSON or XML only when both sides parse as the same kind. */
export function comparableBodies(left: string, right: string): ComparableBodies {
  const a = parseJson(left);
  const b = parseJson(right);
  if (a !== undefined && b !== undefined) {
    return { left: JSON.stringify(a.value, null, 2), right: JSON.stringify(b.value, null, 2), language: 'json' };
  }
  if (isXml(left) && isXml(right)) {
    return { left: formatXml(left).text, right: formatXml(right).text, language: 'xml' };
  }
  return { left, right, language: 'plaintext' };
}

/** From rawRequestBase64 after the blank line; '' when there is none. */
export function requestBodyOf(entry: LogEntry): string {
  const raw = entry.kind === 'exchange' ? entry.exchange.http.rawRequestBase64 : entry.failure.rawRequestBase64;
  const text = raw === undefined ? undefined : decodeBase64Text(raw);
  if (text === undefined) return '';
  const crlf = text.indexOf('\r\n\r\n');
  if (crlf !== -1) return text.slice(crlf + 4);
  const lf = text.indexOf('\n\n');
  return lf === -1 ? '' : text.slice(lf + 2);
}

/** Decoded bodyBase64; '' for a failure. */
export function responseBodyOf(entry: LogEntry): string {
  return entry.kind === 'exchange' ? (decodeBase64Text(entry.exchange.http.bodyBase64) ?? '') : '';
}
