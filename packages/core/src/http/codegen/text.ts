/**
 * The string handling every code target shares: quoting a value in a language's literal syntax,
 * splicing environment reads into it, and laying lines out at the chosen indent.
 */

import { splitEnv } from './model.js';

/** How one language spells a string and an environment read. */
export interface Syntax {
  /** A literal holding `text` exactly. */
  readonly quote: (text: string) => string;
  /** An expression reading environment variable `name`. */
  readonly env: (name: string) => string;
  /** What joins two string expressions into one: ` + `, ` . `, or nothing for a shell word. */
  readonly join: string;
}

/** `text` as an expression: one literal, or literals and environment reads joined. */
export function expr(syntax: Syntax, text: string): string {
  return splitEnv(text)
    .map((part) => ('env' in part ? syntax.env(part.env) : syntax.quote(part.text)))
    .join(syntax.join);
}

/** A C-family escape of one control character, as `\u00XX`. */
function unicodeEscape(character: string): string {
  return `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`;
}

/** Escapes `\`, `quote`, and control characters, the common ground of C-like string literals. */
export function cEscape(text: string, quote: string, control: (character: string) => string = unicodeEscape): string {
  let out = '';
  for (const character of text) {
    switch (character) {
      case '\\':
        out += '\\\\';
        break;
      case quote:
        out += `\\${quote}`;
        break;
      case '\n':
        out += '\\n';
        break;
      case '\r':
        out += '\\r';
        break;
      case '\t':
        out += '\\t';
        break;
      default:
        out += character < ' ' || character === ' ' || character === ' ' ? control(character) : character;
    }
  }
  return out;
}

/** `\xNN`, as Python and Go spell a control byte. */
export function hexEscape(character: string): string {
  return `\\x${character.charCodeAt(0).toString(16).padStart(2, '0')}`;
}

/** A POSIX shell single-quoted word. */
export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, "'\\''")}'`;
}

/** Lines of code at an indent unit, joined with `\n`. */
export class CodeLines {
  private readonly lines: string[] = [];

  constructor(private readonly unit: string) {}

  /** Appends `text` at nesting `level`. A multi-line `text` indents its first line only. */
  add(level: number, text: string): this {
    this.lines.push(`${this.unit.repeat(level)}${text}`);
    return this;
  }

  blank(): this {
    this.lines.push('');
    return this;
  }

  toString(): string {
    return this.lines.join('\n');
  }
}

/** The indent unit for a setting: a tab, or that many spaces. */
export function indentUnit(indent: number | 'tab'): string {
  return indent === 'tab' ? '\t' : ' '.repeat(Math.max(0, Math.min(8, indent)));
}

/** The final path segment of a file path, for a multipart part's file name. */
export function baseName(path: string): string {
  const segments = path.split(/[\\/]/);
  return segments[segments.length - 1] ?? path;
}

/** The path a file part or binary body names, or a placeholder when none was chosen. */
export function filePath(path: string): string {
  return path.length > 0 ? path : '/path/to/file';
}

/** The value of the first header called `name`, case-insensitively. */
export function headerValue(headers: readonly { name: string; value: string }[], name: string): string | undefined {
  const lower = name.toLowerCase();
  return headers.find((header) => header.name.toLowerCase() === lower)?.value;
}

/**
 * One form-urlencoded value, exactly as the REST send encodes it (`rest/body.ts`). Repeated here
 * rather than imported: the core may not reach into a protocol group.
 */
function formEncode(text: string): string {
  return encodeURIComponent(text)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, '+');
}

/**
 * A form body as one string expression: literal text encoded here, exactly as the send encodes it,
 * and each environment read wrapped in the language's own encoder by `encodeEnv`.
 */
export function formExpr(
  syntax: Syntax,
  fields: readonly { readonly name: string; readonly value: string }[],
  encodeEnv: (read: string) => string,
): string {
  const pieces: ({ text: string } | { code: string })[] = [];
  const literal = (text: string): void => {
    const last = pieces[pieces.length - 1];
    if (last !== undefined && 'text' in last) {
      last.text += text;
    } else {
      pieces.push({ text });
    }
  };
  const encoded = (value: string): void => {
    for (const part of splitEnv(value)) {
      if ('env' in part) {
        pieces.push({ code: encodeEnv(syntax.env(part.env)) });
      } else {
        literal(formEncode(part.text));
      }
    }
  };
  fields.forEach((field, index) => {
    if (index > 0) literal('&');
    encoded(field.name);
    literal('=');
    encoded(field.value);
  });
  if (pieces.length === 0) return syntax.quote('');
  return pieces.map((piece) => ('text' in piece ? syntax.quote(piece.text) : piece.code)).join(syntax.join);
}
