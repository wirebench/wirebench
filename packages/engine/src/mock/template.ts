/**
 * Response templates (ADR-0022): a response with `values` inserts request values into its body and
 * header values with `{{name}}`. A template reads the request and nothing else, replaces each
 * placeholder in one pass (inserted text is never scanned again), and escapes every value exactly once
 * for where it lands. A response without `values` is literal and is sent as it is.
 */

import { escapeXmlValue } from '../project/sequence-guards.js';
import type { MockBodyLanguage, MockResponse } from './model.js';

/** `{{name}}`, with no space inside the braces; any other `{{…}}` is plain text. */
const PLACEHOLDER = /\{\{([A-Za-z_][A-Za-z0-9_]{0,63})\}\}/g;

/** The names of every placeholder in `text`, in order. */
function placeholderNames(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((match) => match[1] as string);
}

/**
 * The offset of the first placeholder in `json` that is not inside a string literal, or `undefined`.
 * Inside a string, a value is escaped into string content; outside one, it would become structure.
 */
function placeholderOutsideJsonString(json: string): number | undefined {
  const at = new RegExp(PLACEHOLDER.source, 'y');
  let inString = false;
  for (let index = 0; index < json.length; index += 1) {
    const char = json[index];
    if (inString) {
      if (char === '\\') index += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === '{') {
      at.lastIndex = index;
      if (at.test(json)) return index;
    }
  }
  return undefined;
}

/** What {@link checkTemplate} reads of a response. */
export type TemplateParts = Pick<MockResponse, 'values' | 'headers' | 'body' | 'bodyText'>;

/**
 * Why `response` is not a valid template, or `undefined` when it is (or is not a template at all):
 * a placeholder names no declared value, or a JSON body holds one outside a string literal.
 */
export function checkTemplate(response: TemplateParts): string | undefined {
  if (response.values === undefined) return undefined;
  const declared = new Set(Object.keys(response.values));
  const texts = [
    ...response.headers.map((header) => ({ where: `header ${header.name}`, text: header.value })),
    ...(response.body === 'none' ? [] : [{ where: 'body', text: response.bodyText }]),
  ];
  for (const { where, text } of texts) {
    const unknown = placeholderNames(text).find((name) => !declared.has(name));
    if (unknown !== undefined) {
      return `The ${where} uses {{${unknown}}}, which is not one of the response's values`;
    }
  }
  if (response.body === 'json') {
    const offset = placeholderOutsideJsonString(response.bodyText);
    if (offset !== undefined) {
      return `The JSON body has a placeholder outside a string at offset ${offset}; a value may only be inserted into a string`;
    }
  }
  return undefined;
}

/** JSON string content: what `JSON.stringify` writes between the quotes, plus U+2028 and U+2029. */
function escapeJsonContent(value: string): string {
  return JSON.stringify(value)
    .slice(1, -1)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** How a value is escaped into a body of each language. */
export const BODY_ESCAPE: Readonly<Record<MockBodyLanguage, (value: string) => string>> = {
  xml: escapeXmlValue,
  json: escapeJsonContent,
  text: (value) => value,
  none: (value) => value,
};

/** `text` with each declared placeholder replaced, once, by its value escaped by `escape`. */
export function fillTemplate(
  text: string,
  values: ReadonlyMap<string, string>,
  escape: (value: string) => string,
): string {
  return text.replace(PLACEHOLDER, (whole, name: string) => {
    const value = values.get(name);
    return value === undefined ? whole : escape(value);
  });
}
