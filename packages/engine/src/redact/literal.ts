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
 * XML- and JSON-escaped forms of each — with the redaction marker.
 */
export function createSecretMasker(values: readonly string[]): (text: string) => string {
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
  // Longest first: a value that is a prefix of another must not leave the other's tail behind.
  const ordered = [...needles].sort((a, b) => b.length - a.length);
  return (text) => {
    let out = maskBasicCredentials(text, plain);
    for (const needle of ordered) {
      out = out.split(needle).join(REDACTED_MARKER);
    }
    return maskCutPrefixes(out, ordered);
  };
}

/** The marker every report cap writes where it cut a value. */
const CUT_MARKER = '\u2026';

/**
 * A report cap can cut a value inside a secret, so no whole needle is left to match. Masks the
 * longest needle prefix that ends where a cut was made: just before each `…`, after stepping back
 * over the `\n` of `\n… truncated` and any U+FFFD a byte cap left of a split character.
 */
function maskCutPrefixes(text: string, needles: readonly string[]): string {
  let out = '';
  let start = 0;
  for (let at = text.indexOf(CUT_MARKER); at !== -1; at = text.indexOf(CUT_MARKER, at + 1)) {
    let end = at;
    if (end > start && text[end - 1] === '\n') {
      end -= 1;
    }
    while (end > start && text[end - 1] === '\uFFFD') {
      end -= 1;
    }
    out += maskCutTail(text.slice(start, end), needles) + text.slice(end, at + 1);
    start = at + 1;
  }
  return out + text.slice(start);
}

/** Masks a cut `Basic` credential whole, else the longest proper needle prefix `head` ends with. */
function maskCutTail(head: string, needles: readonly string[]): string {
  // Cut base64 cannot be decoded and checked, and it is a credential either way.
  const basic = /\bBasic\s+[A-Za-z0-9+/=]+$/.exec(head);
  if (basic) {
    return `${head.slice(0, basic.index)}Basic ${REDACTED_MARKER}`;
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
  return longest > 0 ? head.slice(0, head.length - longest) + REDACTED_MARKER : head;
}

/** A Basic credential is base64 of `user:password`, so the password never appears literally. */
function maskBasicCredentials(text: string, values: readonly string[]): string {
  return text.replace(/\bBasic\s+([A-Za-z0-9+/=]{8,})/g, (whole, encoded: string) => {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    return values.some((value) => decoded.includes(value)) ? `Basic ${REDACTED_MARKER}` : whole;
  });
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
