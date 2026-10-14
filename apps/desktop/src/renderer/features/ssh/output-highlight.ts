/**
 * Which stretches of a terminal line stand out (#424): words that mark errors, warnings and notes, and IP
 * addresses. Pure text in, ranges out; the terminal draws the ranges as decorations, so the bytes the remote
 * program sent are never changed.
 *
 * Every pattern here is linear: the word rule is one alternation of literals between word boundaries, and
 * addresses are found by a hand-written scan over runs of address characters, not by a regular expression.
 */

export type HighlightKind = 'error' | 'warning' | 'info' | 'address';

/** One highlighted stretch of a line: `text.slice(start, end)`. */
export interface Highlight {
  readonly start: number;
  readonly end: number;
  readonly kind: HighlightKind;
}

/** A rule as Preferences → Terminal lists it. */
export interface HighlightRule {
  readonly kind: HighlightKind;
  readonly label: string;
  /** What it matches, for the list: the words, or a description. */
  readonly matches: string;
}

const WORDS: Readonly<Record<Exclude<HighlightKind, 'address'>, readonly string[]>> = {
  error: [
    'error',
    'errors',
    'fail',
    'fails',
    'failed',
    'failure',
    'failures',
    'fatal',
    'critical',
    'panic',
    'exception',
    'denied',
    'refused',
  ],
  warning: ['warn', 'warning', 'warnings', 'deprecated'],
  info: ['info', 'notice', 'debug'],
};

/** The rules in the order Preferences lists them. */
export const HIGHLIGHT_RULES: readonly HighlightRule[] = [
  { kind: 'error', label: 'Errors', matches: WORDS.error.join(', ') },
  { kind: 'warning', label: 'Warnings', matches: WORDS.warning.join(', ') },
  { kind: 'info', label: 'Notes', matches: WORDS.info.join(', ') },
  { kind: 'address', label: 'IP addresses', matches: 'IPv4 and IPv6, such as 10.0.0.1 and fe80::1' },
];

const KIND_OF_WORD = new Map<string, HighlightKind>(
  (Object.entries(WORDS) as [Exclude<HighlightKind, 'address'>, readonly string[]][]).flatMap(([kind, words]) =>
    words.map((word): [string, HighlightKind] => [word, kind]),
  ),
);

/** Whole words only, any case: `error` and `ERROR:` match, `stderr` and `error_log` do not. */
const WORD_PATTERN = new RegExp(`\\b(?:${[...KIND_OF_WORD.keys()].join('|')})\\b`, 'gi');

function wordHighlights(text: string): Highlight[] {
  const found: Highlight[] = [];
  for (const match of text.matchAll(WORD_PATTERN)) {
    const kind = KIND_OF_WORD.get(match[0].toLowerCase());
    if (kind !== undefined) found.push({ start: match.index, end: match.index + match[0].length, kind });
  }
  return found;
}

function isHexDigit(c: string): boolean {
  return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}

function isAddressChar(c: string): boolean {
  return isHexDigit(c) || c === ':' || c === '.';
}

function isWordChar(c: string | undefined): boolean {
  return c !== undefined && /\w/.test(c);
}

function isDecimalPart(part: string): boolean {
  if (part.length === 0 || part.length > 3) return false;
  for (const c of part) if (c < '0' || c > '9') return false;
  // A leading zero reads as octal to some tools and as a version elsewhere; neither is an address here.
  return (part === '0' || !part.startsWith('0')) && Number(part) <= 255;
}

/** Dotted-quad IPv4, each part 0–255 without a leading zero. */
export function isIPv4(text: string): boolean {
  const parts = text.split('.');
  return parts.length === 4 && parts.every(isDecimalPart);
}

function isHexGroup(group: string): boolean {
  if (group.length === 0 || group.length > 4) return false;
  for (const c of group) if (!isHexDigit(c)) return false;
  return true;
}

/** IPv6 in its full or `::`-shortened form, with an optional IPv4 tail (`::ffff:10.0.0.1`); no zone. */
export function isIPv6(text: string): boolean {
  if (!text.includes(':') || ![...text].some(isHexDigit)) return false;
  const gap = text.indexOf('::');
  if (gap !== text.lastIndexOf('::')) return false;
  const halves = gap < 0 ? [text] : [text.slice(0, gap), text.slice(gap + 2)];
  let groups = 0;
  for (const [h, half] of halves.entries()) {
    if (half === '') continue;
    const parts = half.split(':');
    for (const [p, part] of parts.entries()) {
      const last = h === halves.length - 1 && p === parts.length - 1;
      if (isHexGroup(part)) groups += 1;
      else if (last && isIPv4(part)) groups += 2;
      else return false;
    }
  }
  return gap < 0 ? groups === 8 : groups < 8;
}

/** How much of a run of address characters is an address, from its start, or `undefined` for none. */
function addressLength(run: string): number | undefined {
  // Sentence punctuation after an address (`from 10.0.0.1.` or `fe80::1:`) is not part of it.
  const trimmed = run.endsWith('.') || run.endsWith(':') ? run.slice(0, -1) : run;
  for (const candidate of [run, trimmed]) {
    if (isIPv6(candidate) || isIPv4(candidate)) return candidate.length;
  }
  // `10.0.0.1:22`: the address, not the port.
  const colon = trimmed.lastIndexOf(':');
  if (colon > 0 && isIPv4(trimmed.slice(0, colon)) && /^\d{1,5}$/.test(trimmed.slice(colon + 1))) return colon;
  return undefined;
}

function addressHighlights(text: string): Highlight[] {
  const found: Highlight[] = [];
  let i = 0;
  while (i < text.length) {
    if (!isAddressChar(text.charAt(i))) {
      i += 1;
      continue;
    }
    let end = i;
    while (end < text.length && isAddressChar(text.charAt(end))) end += 1;
    // A run glued to letters (`v1.2.3.4`, `10.0.0.1ms`) is part of a word, not an address.
    if (!isWordChar(text[i - 1]) && !isWordChar(text[end])) {
      const length = addressLength(text.slice(i, end));
      if (length !== undefined) found.push({ start: i, end: i + length, kind: 'address' });
    }
    i = end;
  }
  return found;
}

/** Every highlight in one line of terminal text, in order and never overlapping. */
export function findHighlights(text: string): Highlight[] {
  const all = [...wordHighlights(text), ...addressHighlights(text)].sort((a, b) => a.start - b.start);
  const kept: Highlight[] = [];
  for (const highlight of all) {
    const previous = kept.at(-1);
    if (previous === undefined || highlight.start >= previous.end) kept.push(highlight);
  }
  return kept;
}
