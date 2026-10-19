/**
 * `//` and `/* *\/` comments in a JSON request body (#702): written in the editor, saved with the
 * request, and taken out before the body is sent, so a field can be switched off without deleting it.
 *
 * Every path that turns a saved body into wire bytes — a send from the desktop, the CLI or MCP, a
 * run, *Copy as cURL*, code generation — resolves the request through `resolveRest`, which strips
 * here before anything is expanded. History and the HTTP log record what was sent, so they hold the
 * stripped body too. A comment is removed before expansion on purpose: a `${…}` inside one is never
 * resolved, so a commented-out `${secret:…}` reads no secret and a commented-out typo is no
 * unresolved reference.
 *
 * Pure, and free of Node modules, so the renderer can import it through `@wirebench/engine/rest`.
 */

import { propertyReferences } from '../project/references.js';
import type { RestBody } from './model.js';

/** One line of output while stripping, and whether a comment was taken out of it. */
interface Line {
  text: string;
  commented: boolean;
}

/** Where each `${…}` reference in `text` starts, mapped to where it ends. */
function referenceSpans(text: string): Map<number, number> {
  const spans = new Map<number, number>();
  for (const reference of propertyReferences(text)) spans.set(reference.start, reference.end);
  return spans;
}

/**
 * The text with its `//` line comments and `/* *\/` block comments removed.
 *
 * Comments are recognised only outside JSON strings, so `"http://example.com"` keeps its slashes,
 * and a `${…}` reference is copied whole, so a quote inside one (`${$date("YYYY")}`) is not taken
 * for the start of a string. A line that held nothing but a comment goes altogether, and a comma
 * left trailing before `}` or `]` by a commented-out last field is removed. A text with no comment
 * comes back exactly as it was, trailing commas and all — nothing is reformatted.
 */
export function stripJsonComments(text: string): string {
  if (!text.includes('/')) return text;

  const spans = referenceSpans(text);
  const lines: Line[] = [];
  let line: Line = { text: '', commented: false };
  let found = false;
  let inString = false;
  let i = 0;
  const newline = (): void => {
    lines.push(line);
    line = { text: '', commented: false };
  };

  while (i < text.length) {
    const end = spans.get(i);
    if (end !== undefined) {
      line.text += text.slice(i, end);
      i = end;
      continue;
    }
    const c = text[i];
    if (c === '\n') {
      newline();
      i += 1;
      // A raw newline cannot sit inside a JSON string, so an unterminated one ends with its line.
      inString = false;
      continue;
    }
    if (inString) {
      if (c === '\\' && i + 1 < text.length && text[i + 1] !== '\n') {
        line.text += text.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      line.text += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      inString = true;
      line.text += c;
      i += 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      found = true;
      line.commented = true;
      const next = text.indexOf('\n', i);
      i = next === -1 ? text.length : next;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      found = true;
      line.commented = true;
      const close = text.indexOf('*/', i + 2);
      const stop = close === -1 ? text.length : close + 2;
      const breaks = text.slice(i, stop).split('\n').length - 1;
      for (let n = 0; n < breaks; n += 1) {
        newline();
        line.commented = true;
      }
      // `1/**/2` must not become `12`: a comment within one line still separates what is either side.
      if (breaks === 0) line.text += ' ';
      i = stop;
      continue;
    }
    line.text += c;
    i += 1;
  }
  lines.push(line);

  if (!found) return text;
  const kept = lines
    .filter((l) => !l.commented || l.text.trim() !== '')
    .map((l) => (l.commented ? l.text.trimEnd() : l.text));
  const stripped = removeTrailingCommas(kept.join('\n'));
  // A last line that was only a comment took the final newline with it; the body keeps the one it had.
  return text.endsWith('\n') && !stripped.endsWith('\n') ? `${stripped}\n` : stripped;
}

/** Removes every `,` whose next non-blank character, outside strings and references, is `}` or `]`. */
function removeTrailingCommas(text: string): string {
  const spans = referenceSpans(text);
  let out = '';
  let inString = false;
  let i = 0;
  while (i < text.length) {
    const end = spans.get(i);
    if (end !== undefined) {
      out += text.slice(i, end);
      i = end;
      continue;
    }
    const c = text[i];
    if (inString) {
      if (c === '\\' && i + 1 < text.length) {
        out += text.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c === '"' || c === '\n') inString = false;
      out += c;
      i += 1;
      continue;
    }
    if (c === '"') inString = true;
    if (c === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j] ?? '')) j += 1;
      if (text[j] === '}' || text[j] === ']') {
        i += 1;
        continue;
      }
    }
    out += c;
    i += 1;
  }
  return out;
}

/** Whether `text` holds a `//` or `/* *\/` comment outside its strings. */
export function hasJsonComments(text: string): boolean {
  return stripJsonComments(text) !== text;
}

/**
 * The body a send puts on the wire, comments out: a raw JSON body's text and a GraphQL body's
 * variables are stripped; every other body, and a raw body in another language, is returned as is.
 * Whether a body is JSON is the language chosen in the editor, never a `Content-Type` header.
 */
export function stripRestBodyComments(body: RestBody): RestBody {
  if (body.kind === 'raw' && body.language === 'json') {
    const text = stripJsonComments(body.text);
    return text === body.text ? body : { ...body, text };
  }
  if (body.kind === 'graphql') {
    const variables = stripJsonComments(body.variables);
    return variables === body.variables ? body : { ...body, variables };
  }
  return body;
}
