/**
 * Making sense of what came back: what kind of document it is, how to read it as text, how to show
 * it formatted, and what cookies it set.
 *
 * Everything here is pure and defensive. A response is whatever the server felt like sending — a
 * JSON body labelled `text/plain`, a charset Node has never heard of, HTML where an API was
 * promised, a `Set-Cookie` with an attribute in the wrong order — and none of that may throw,
 * because the user still has to be able to look at it.
 */

import { decodeBody } from '../http/charset.js';
import { mediaTypeOf } from '../http/media-type.js';
import { formatXml } from '../xml/pretty.js';

/** What a response body is, as far as the viewer needs to know. */
export type BodyLanguage = 'json' | 'xml' | 'html' | 'javascript' | 'text' | 'image' | 'binary';

/**
 * The language of a response body.
 *
 * The declared `Content-Type` is believed first, but only so far: `text/plain` and
 * `application/octet-stream` are what servers send when they have not thought about it, so a body
 * that begins like JSON or XML is treated as such. A structured suffix (`+json`, `+xml`) counts as
 * its base type, which is what `application/problem+json` and every SOAP-ish REST API rely on.
 */
export function detectLanguage(contentType: string | undefined, bytes: Uint8Array): BodyLanguage {
  const media = contentType === undefined ? '' : mediaTypeOf(contentType).toLowerCase();
  if (media.startsWith('image/')) {
    return 'image';
  }
  if (media === 'application/json' || media.endsWith('+json')) {
    return 'json';
  }
  if (media === 'text/xml' || media === 'application/xml' || media.endsWith('+xml')) {
    return 'xml';
  }
  if (media === 'text/html' || media === 'application/xhtml+xml') {
    return 'html';
  }
  if (media === 'application/javascript' || media === 'text/javascript') {
    return 'javascript';
  }
  const sniffed = sniff(bytes);
  if (sniffed !== undefined) {
    return sniffed;
  }
  if (media.startsWith('text/')) {
    return 'text';
  }
  return media === '' || media === 'application/octet-stream' ? 'binary' : 'text';
}

/**
 * The first non-whitespace bytes, as a short ASCII string, for sniffing.
 *
 * A UTF-8 byte-order mark is skipped at the byte level: read as characters it would be three
 * Latin-1 letters, and a BOM-prefixed JSON body would then sniff as text.
 */
function head(bytes: Uint8Array, length = 512): string {
  const start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  const slice = bytes.subarray(start, start + length);
  let text = '';
  for (const byte of slice) {
    text += String.fromCharCode(byte);
  }
  return text.trimStart();
}

/** What the first bytes look like, when they look like anything in particular. */
function sniff(bytes: Uint8Array): BodyLanguage | undefined {
  const start = head(bytes);
  if (start === '') {
    return undefined;
  }
  if (start.startsWith('{') || start.startsWith('[')) {
    return 'json';
  }
  if (/^<!doctype html/i.test(start) || /^<html[\s>]/i.test(start)) {
    return 'html';
  }
  if (start.startsWith('<?xml') || /^<[A-Za-z_]/.test(start)) {
    return 'xml';
  }
  return undefined;
}

/** A body decoded to text, plus a note when its declared charset could not be honoured. */
export interface DecodedText {
  readonly text: string;
  /** Set when the charset label was unsupported and UTF-8 was used instead. */
  readonly problem?: string;
}

/**
 * Decodes a body to text per the charset in its `Content-Type`, defaulting to UTF-8.
 *
 * Never throws and never returns nothing: an unsupported label falls back to UTF-8 with a note,
 * and invalid bytes become replacement characters, because a body the user cannot read at all is
 * worse than one they can read imperfectly.
 */
export function decodeResponseText(bytes: Uint8Array, contentType: string | undefined): DecodedText {
  const { text, problem } = decodeBody(bytes, contentType);
  const withoutBom = text.replace(/^﻿/, '');
  return problem === undefined ? { text: withoutBom } : { text: withoutBom, problem: problem.message };
}

/** A formatted body, and whether formatting actually changed anything. */
export interface PrettyBody {
  readonly text: string;
  readonly changed: boolean;
  /** Set when the body could not be formatted (malformed JSON or XML); `text` is then the input. */
  readonly problem?: string;
}

/**
 * Formats a body for reading: JSON re-indented, XML through the engine's own pretty printer, HTML
 * given one tag per line.
 *
 * A malformed document is returned unchanged with a problem rather than repaired or rejected — the
 * broken body *is* the interesting thing when an API misbehaves, and hiding it would hide the bug.
 */
export function prettyBody(text: string, language: BodyLanguage, indent = 2): PrettyBody {
  if (language === 'json') {
    try {
      const formatted = JSON.stringify(JSON.parse(text) as unknown, null, indent);
      return { text: formatted, changed: formatted !== text };
    } catch (error) {
      return { text, changed: false, problem: error instanceof Error ? error.message : 'Invalid JSON' };
    }
  }
  if (language === 'xml') {
    const result = formatXml(text, { indent: ' '.repeat(indent) });
    return result.problem === undefined
      ? { text: result.text, changed: result.changed }
      : { text: result.text, changed: result.changed, problem: result.problem };
  }
  if (language === 'html') {
    const formatted = formatHtml(text, indent);
    return { text: formatted, changed: formatted !== text };
  }
  return { text, changed: false };
}

/**
 * Indents HTML by tag depth.
 *
 * Deliberately not a parser: HTML's void elements, optional end tags and inline content make a
 * faithful formatter a project of its own, and this only has to make a response readable. Text
 * runs are kept on the line of the tag that opened them.
 */
function formatHtml(text: string, indent: number): string {
  const tokens = text
    .replace(/\r\n?/g, '\n')
    .split(/(<[^>]*>)/)
    .filter((token) => token.trim() !== '');
  const pad = ' '.repeat(indent);
  const lines: string[] = [];
  let depth = 0;
  for (const token of tokens) {
    const isTag = token.startsWith('<');
    const isClose = token.startsWith('</');
    const selfCloses =
      /\/>$/.test(token) || /^<(?:area|base|br|col|embed|hr|img|input|link|meta|source|track|wbr|!)/i.test(token);
    if (isTag && isClose) {
      depth = Math.max(0, depth - 1);
    }
    lines.push(pad.repeat(depth) + (isTag ? token.trim() : token.trim()));
    if (isTag && !isClose && !selfCloses) {
      depth += 1;
    }
  }
  return lines.join('\n');
}

export { parseSetCookie } from '../http/cookies.js';
export type { Cookie } from '../http/cookies.js';
