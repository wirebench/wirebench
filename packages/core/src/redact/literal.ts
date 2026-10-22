/**
 * Masks known secret *values* wherever they turn up. The pattern-based helpers beside this one
 * know where a secret usually sits (an `Authorization` header, a `wsse:Password`); a runner also
 * knows the values themselves, because it just read them from the environment, so it can catch the
 * one that was interpolated somewhere no pattern looks — a query parameter, an assertion's
 * "actual" text, an error message.
 */

import { REDACTED_MARKER } from './index.js';

/** Below this length a value is too likely to occur by chance; masking it would shred the text. */
const MIN_MASKED_LENGTH = 4;

/**
 * The shortest value masked although no secret store handed it out: one seeded from the
 * environment up front (the MCP server's `WIREBENCH_SECRET_*` values), or one a `${#System#…}`
 * reference put on the wire. Such a value may be any ordinary text, and a short one (`1`, `true`)
 * would mask that text everywhere; a secret a send resolves keeps {@link MIN_MASKED_LENGTH}.
 */
export const MIN_SEEDED_SECRET_LENGTH = 8;

/**
 * The forms a value takes on the wire besides itself — each one the engine (or its XML serializer,
 * or `URLSearchParams`) really writes somewhere:
 * - percent-encoded, as `encodeURIComponent` puts it in a URL;
 * - `application/x-www-form-urlencoded`, both as `rest/body.ts`'s `formEncode` writes a form body
 *   and as `URLSearchParams` writes an OAuth2 token request (they differ on `~`);
 * - XML text with the three entities `entitizeValue` and a DOM serializer emit (the SOAP envelope,
 *   a WS-Security `wsse:Password`), and with all five, as `escapeForLanguage` escapes an XML body;
 * - a JSON string's content, as `escapeForLanguage` escapes a JSON body or `JSON.stringify` writes
 *   an error detail.
 * A server echoing the value back is free to use any of them too.
 */
function encodedForms(value: string): string[] {
  const xml3 = value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return [
    encodeURIComponent(value),
    encodeURIComponent(value)
      .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
      .replace(/%20/g, '+'),
    new URLSearchParams({ v: value }).toString().slice(2),
    xml3,
    xml3.replace(/"/g, '&quot;').replace(/'/g, '&apos;'),
    JSON.stringify(value).slice(1, -1),
  ];
}

/**
 * Builds a function that replaces every occurrence of `values` — and the base64, percent-, form-,
 * XML- and JSON-escaped forms of each — with the redaction marker: {@link REDACTED_MARKER}, or
 * `options.marker` (`REDACTED_XML_MARKER` for XML text, so a masked document stays well formed).
 *
 * Every match is found on the original text and overlapping or touching matches are merged before
 * anything is replaced. Masking one needle first would hide the start of another that overlaps it
 * (`token` inside a cut `token-abcdef-12…`), leaving the rest of that one in the output.
 */
export function createSecretMasker(
  values: readonly string[],
  options?: { readonly marker?: string },
): (text: string) => string {
  const marker = options?.marker ?? REDACTED_MARKER;
  const plain = values.filter((value) => value.length >= MIN_MASKED_LENGTH);
  const needles = new Set<string>();
  for (const value of plain) {
    needles.add(value);
    for (const form of encodedForms(value)) {
      // An escaped form is never shorter than the value, but the floor is kept explicit per needle.
      if (form.length >= MIN_MASKED_LENGTH) {
        needles.add(form);
      }
    }
  }
  return (text) =>
    replaceRanges(
      text,
      [...basicCredentialRanges(text, plain), ...needleRanges(text, needles), ...cutPrefixRanges(text, needles)],
      marker,
    );
}

/** A span of the original text to mask, `start` inclusive and `end` exclusive. */
interface Range {
  start: number;
  end: number;
}

/** Replaces each run of overlapping or touching ranges with one `marker`. */
function replaceRanges(text: string, ranges: Range[], marker: string): string {
  if (ranges.length === 0) {
    return text;
  }
  ranges.sort((a, b) => a.start - b.start);
  let out = '';
  let kept = 0;
  let current = { ...ranges[0]! };
  for (const range of ranges.slice(1)) {
    if (range.start <= current.end) {
      current.end = Math.max(current.end, range.end);
    } else {
      out += text.slice(kept, current.start) + marker;
      kept = current.end;
      current = { ...range };
    }
  }
  return out + text.slice(kept, current.start) + marker + text.slice(current.end);
}

/** Every occurrence of every needle, overlapping ones included. */
function needleRanges(text: string, needles: Iterable<string>): Range[] {
  const ranges: Range[] = [];
  for (const needle of needles) {
    for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
      ranges.push({ start: at, end: at + needle.length });
    }
  }
  return ranges;
}

/** The marker every report cap writes where it cut a value. */
const CUT_MARKER = '\u2026';

/**
 * A report cap can cut a value inside a secret, so no whole needle is left to match. Finds the
 * longest needle prefix that ends where a cut was made: just before each `…`, after stepping back
 * over the `\n` of `\n… truncated` and any U+FFFD a byte cap left of a split character.
 */
function cutPrefixRanges(text: string, needles: Iterable<string>): Range[] {
  const ranges: Range[] = [];
  let start = 0;
  for (let at = text.indexOf(CUT_MARKER); at !== -1; at = text.indexOf(CUT_MARKER, at + 1)) {
    let end = at;
    if (end > start && text[end - 1] === '\n') {
      end -= 1;
    }
    while (end > start && text[end - 1] === '\uFFFD') {
      end -= 1;
    }
    const length = cutTailLength(text.slice(start, end), needles);
    if (length > 0) {
      ranges.push({ start: end - length, end });
    }
    start = at + 1;
  }
  return ranges;
}

/** The length of the cut `Basic` base64 run, else of the longest proper needle prefix `head` ends with. */
function cutTailLength(head: string, needles: Iterable<string>): number {
  // Cut base64 cannot be decoded and checked, and it is a credential either way.
  const basic = /\bBasic\s+([A-Za-z0-9+/=]+)$/.exec(head);
  if (basic) {
    return basic[1]!.length;
  }
  let longest = 0;
  for (const needle of needles) {
    for (let length = Math.min(needle.length - 1, head.length); length > longest; length -= 1) {
      if (head.endsWith(needle.slice(0, length))) {
        longest = length;
        break;
      }
    }
  }
  return longest;
}

/** A Basic credential is base64 of `user:password`, so the password never appears literally. */
function basicCredentialRanges(text: string, values: readonly string[]): Range[] {
  const ranges: Range[] = [];
  for (const match of text.matchAll(/\bBasic\s+([A-Za-z0-9+/=]{8,})/g)) {
    const encoded = match[1]!;
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    if (values.some((value) => decoded.includes(value))) {
      const end = match.index + match[0].length;
      ranges.push({ start: end - encoded.length, end });
    }
  }
  return ranges;
}

/**
 * Builds the same masker over a base64 run of raw bytes: each value's UTF-8 bytes are masked
 * wherever they sit, whatever the bytes around them are (a binary WebSocket frame carrying JSON,
 * MessagePack or CBOR). A run with nothing to mask comes back as the same string, not a re-encoding.
 */
export function createSecretBytesMasker(values: readonly string[]): (base64: string) => string {
  if (values.length === 0) {
    return (base64) => base64;
  }
  // Read as latin1 so bytes that are not UTF-8 survive the round trip unchanged.
  const mask = createSecretMasker(values.map((value) => Buffer.from(value, 'utf8').toString('latin1')));
  return (base64) => {
    const text = Buffer.from(base64, 'base64').toString('latin1');
    const masked = mask(text);
    return masked === text ? base64 : Buffer.from(masked, 'latin1').toString('base64');
  };
}
