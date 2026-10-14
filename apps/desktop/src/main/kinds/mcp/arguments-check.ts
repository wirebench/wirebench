/**
 * The tools/call Arguments editor's markers (#79), answered in main as GraphQL's diagnostics are, so
 * the renderer loads no validator: the text as typed, unsaved, checked as JSON and then against the
 * tool's `inputSchema`. A send only warns on a schema mismatch (sending bad input on purpose is a
 * test), so those problems are warnings; text a send would refuse — not JSON, or not one object — is
 * an error.
 */
import { validateJsonSchema } from '@wirebench/engine';
import type { McpArgumentsProblemWire } from '../../../shared/kinds/mcp/wire.js';

/** Above this, nothing is checked: an editor holding a megabyte of arguments gets no markers, and no lag. */
const MAX_TEXT = 512 * 1024;

/** A `${…}` reference: the text is JSON only once a send expands it. */
const REFERENCE = /\$\{[^}]*\}/;

/** The 1-based line and column of `offset` in `text`. */
function positionAt(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, Math.min(Math.max(offset, 0), text.length)).split('\n');
  return { line: before.length, column: before[before.length - 1]!.length + 1 };
}

/**
 * Where `JSON.parse` stopped, from its message: V8 says "at position N" (and, lately, "(line L column
 * C)" too). The end of the text when the message says neither, as for "Unexpected end of JSON input".
 */
function parseErrorPosition(text: string, message: string): { line: number; column: number } {
  const lineColumn = /\(line (\d+) column (\d+)\)/.exec(message);
  if (lineColumn !== null) return { line: Number(lineColumn[1]), column: Number(lineColumn[2]) };
  const at = /at position (\d+)/.exec(message);
  return positionAt(text, at !== null ? Number(at[1]) : text.trimEnd().length);
}

/** The message `JSON.parse` gave, less its position, which the marker shows by where it sits. */
function parseErrorMessage(message: string): string {
  return message
    .replace(/\s*\(line \d+ column \d+\)/, '')
    .replace(/\s*(?:in JSON )?at position \d+/, '')
    .trim();
}

/**
 * The problems with a tool call's arguments `text`, checked against `schema` (the tool's
 * `inputSchema`; absent, only the JSON is checked). Blank text sends `{}`, so `{}` is what is checked.
 */
export function mcpArgumentsCheck(text: string, schema: unknown): McpArgumentsProblemWire[] {
  if (text.length > MAX_TEXT) return [];
  const blank = text.trim() === '';
  let value: unknown = {};
  if (!blank) {
    try {
      value = JSON.parse(text) as unknown;
    } catch (err) {
      if (REFERENCE.test(text)) return [];
      const message = err instanceof Error ? err.message : String(err);
      const reason = parseErrorMessage(message);
      return [
        {
          severity: 'error',
          message: `The arguments are not JSON${reason !== '' ? `: ${reason}` : ''}`,
          pointer: '',
          position: parseErrorPosition(text, message),
        },
      ];
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [{ severity: 'error', message: 'The arguments must be a JSON object', pointer: '' }];
  }
  if (schema === undefined || schema === null) return [];
  return validateJsonSchema(value, schema).map((problem) => ({
    severity: 'warning',
    message: problem.message,
    pointer: problem.path,
    keyword: problem.keyword,
  }));
}
