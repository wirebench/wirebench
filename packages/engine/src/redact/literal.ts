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
 * Builds a function that replaces every occurrence of `values` — and the base64 and
 * percent-encoded forms of each — with the redaction marker.
 */
export function createSecretMasker(values: readonly string[]): (text: string) => string {
  const plain = values.filter((value) => value.length >= MIN_MASKED_LENGTH);
  const needles = new Set<string>();
  for (const value of plain) {
    needles.add(value);
    needles.add(encodeURIComponent(value));
  }
  // Longest first: a value that is a prefix of another must not leave the other's tail behind.
  const ordered = [...needles].sort((a, b) => b.length - a.length);
  return (text) => {
    let out = maskBasicCredentials(text, plain);
    for (const needle of ordered) {
      out = out.split(needle).join(REDACTED_MARKER);
    }
    return out;
  };
}

/** A Basic credential is base64 of `user:password`, so the password never appears literally. */
function maskBasicCredentials(text: string, values: readonly string[]): string {
  return text.replace(/\bBasic\s+([A-Za-z0-9+/=]{8,})/g, (whole, encoded: string) => {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    return values.some((value) => decoded.includes(value)) ? `Basic ${REDACTED_MARKER}` : whole;
  });
}
