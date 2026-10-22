/**
 * The `.bru` reader (spec §5.1): Bruno's three grammars (request, collection or folder,
 * environment) read by one line scanner, written by hand. No regular expression runs over a whole
 * line with nested quantifiers, so every input is read in time linear in its length.
 *
 * The rules that matter: a block ends at a line that starts with `}` in the first column, and
 * nothing else ends it; a text block loses up to two leading spaces per line; a `'''` value loses
 * four characters per line, then is trimmed; a key stops at its first `:` unless it is quoted;
 * `~` marks an entry disabled; `@name` lines above a pair annotate it. The grammar has no comments.
 */

import { BrunoError } from '#core/errors';
import type { BruAnnotation, BruBlock, BruFile, BruGrammar, BruPair } from './model.js';

/** Blocks whose body is raw text rather than `key: value` pairs. */
const TEXT_BLOCKS = new Set([
  'body',
  'body:json',
  'body:text',
  'body:xml',
  'body:sparql',
  'body:graphql',
  'body:graphql:vars',
  'tests',
  'docs',
  'example',
]);

/** Blocks whose keys may hold spaces and anything but `:`. */
const FREE_KEY_BLOCKS = new Set(['assert']);

const MULTILINE = "'''";
/** What a `'''` value's content lines lose: two for the pair's indent, two for the value's. */
const MULTILINE_INDENT = 4;

function isTextBlock(name: string): boolean {
  return TEXT_BLOCKS.has(name) || name.startsWith('script:');
}

function isBlank(line: string): boolean {
  return line.trim() === '';
}

function isNameChar(c: string | undefined): boolean {
  return c !== undefined && /[\w-]/.test(c);
}

/** `line` without up to `count` leading spaces. */
function outdent(line: string, count: number): string {
  let start = 0;
  while (start < count && line[start] === ' ') start += 1;
  return line.slice(start);
}

class Reader {
  private readonly lines: string[];
  private at = 0;

  constructor(
    text: string,
    private readonly grammar: BruGrammar,
    private readonly file: string,
  ) {
    this.lines = text.split(/\r\n|\r|\n/);
  }

  private fail(line: number, message: string): never {
    throw new BrunoError('bruno-parse-error', `${this.file}, line ${String(line)}: ${message}`, {
      details: { file: this.file, line },
    });
  }

  read(): BruFile {
    const blocks: BruBlock[] = [];
    while (this.at < this.lines.length) {
      const line = this.lines[this.at] ?? '';
      if (isBlank(line)) {
        this.at += 1;
        continue;
      }
      blocks.push(this.block(line, this.at + 1));
    }
    return { blocks };
  }

  /** The block whose header is `line`, read up to and past its end. */
  private block(line: string, lineNo: number): BruBlock {
    let p = 0;
    while (line[p] === ' ' || line[p] === '\t') p += 1;
    const start = p;
    // A name is words joined by `:` (`body:graphql:vars`); a `:` followed by anything else ends it.
    while (isNameChar(line[p]) || (line[p] === ':' && isNameChar(line[p + 1]))) p += 1;
    const name = line.slice(start, p);
    if (name === '') this.fail(lineNo, line.startsWith('}') ? 'a "}" closes no block' : 'expected a block name');
    while (line[p] === ' ' || line[p] === '\t') p += 1;
    const opener = line[p];
    const rest = line.slice(p + 1);
    if (opener === '{') {
      if (!isBlank(rest)) this.fail(lineNo, `the ${name} block must start its content on the next line`);
      this.at += 1;
      return isTextBlock(name) ? this.text(name, lineNo) : this.dict(name, lineNo);
    }
    if (opener === '[' && this.grammar === 'environment') return this.list(name, rest, lineNo);
    if (opener === ':' && this.grammar === 'environment') {
      // `color: …` and `extends: …` stand alone at the top of an environment file.
      this.at += 1;
      return { kind: 'text', name, text: rest.trim(), line: lineNo };
    }
    return this.fail(lineNo, `expected "{" after ${name}`);
  }

  private text(name: string, lineNo: number): BruBlock {
    while (this.lines[this.at] === '') this.at += 1;
    const body: string[] = [];
    for (;;) {
      const line = this.lines[this.at];
      if (line === undefined) this.fail(lineNo, `the ${name} block is not closed`);
      this.at += 1;
      if (line.startsWith('}')) break;
      body.push(outdent(line, 2));
    }
    return { kind: 'text', name, text: body.join('\n'), line: lineNo };
  }

  private dict(name: string, lineNo: number): BruBlock {
    const pairs: BruPair[] = [];
    let annotations: BruAnnotation[] = [];
    for (;;) {
      const line = this.lines[this.at];
      if (line === undefined) this.fail(lineNo, `the ${name} block is not closed`);
      if (line.startsWith('}')) {
        this.at += 1;
        break;
      }
      if (isBlank(line)) {
        this.at += 1;
        continue;
      }
      const annotation = this.annotation(line);
      if (annotation !== undefined) {
        annotations.push(annotation);
        continue;
      }
      pairs.push(this.pair(line, FREE_KEY_BLOCKS.has(name) && this.grammar === 'request', annotations));
      annotations = [];
    }
    return { kind: 'dict', name, pairs, line: lineNo };
  }

  /**
   * An `@name` or `@name(arg)` line, alone on its line, read past; absent when `line` is something
   * else, such as `@local: value`, a pair whose key starts with `@`.
   */
  private annotation(line: string): BruAnnotation | undefined {
    const lineNo = this.at + 1;
    let p = 0;
    while (line[p] === ' ' || line[p] === '\t') p += 1;
    if (line[p] !== '@') return undefined;
    const start = p + 1;
    p = start;
    while (isNameChar(line[p])) p += 1;
    const name = line.slice(start, p);
    if (name === '') return undefined;
    if (line[p] !== '(') {
      if (!isBlank(line.slice(p))) return undefined;
      this.at += 1;
      return { name };
    }
    const inner = line.slice(p + 1);
    if (inner.startsWith(MULTILINE) && !inner.slice(MULTILINE.length).includes(MULTILINE)) {
      if (!isBlank(inner.slice(MULTILINE.length))) return undefined;
      const content: string[] = [];
      for (let next = this.at + 1; next < this.lines.length; next += 1) {
        const text = this.lines[next] ?? '';
        if (text.trimStart().startsWith(MULTILINE)) {
          this.at = next + 1;
          return { name, arg: content.join('\n').trim() };
        }
        content.push(text.slice(MULTILINE_INDENT));
      }
      return this.fail(lineNo, `the @${name} annotation is not closed`);
    }
    const close = inner.lastIndexOf(')');
    if (close === -1 || !isBlank(inner.slice(close + 1))) return undefined;
    this.at += 1;
    return { name, arg: unquote(inner.slice(0, close).trim()) };
  }

  private pair(line: string, freeKey: boolean, annotations: readonly BruAnnotation[]): BruPair {
    const lineNo = this.at + 1;
    let p = 0;
    while (line[p] === ' ' || line[p] === '\t') p += 1;
    let enabled = true;
    if (line[p] === '~') {
      enabled = false;
      p += 1;
    }
    let key: string;
    if (line[p] === '"' && !freeKey) {
      const parts: string[] = [];
      let q = p + 1;
      for (;;) {
        const c = line[q];
        if (c === undefined) this.fail(lineNo, 'a quoted key is not closed');
        if (c === '\\' && line[q + 1] === '"') {
          parts.push('"');
          q += 2;
        } else if (c === '"') {
          break;
        } else {
          parts.push(c);
          q += 1;
        }
      }
      key = parts.join('');
      q += 1;
      while (line[q] === ' ' || line[q] === '\t') q += 1;
      if (line[q] !== ':') this.fail(lineNo, 'expected ":" after a quoted key');
      p = q;
    } else {
      const colon = line.indexOf(':', p);
      if (colon === -1) this.fail(lineNo, 'expected "key: value"; the format has no comments');
      key = line.slice(p, colon).trim();
      if (key === '') this.fail(lineNo, 'a pair has no key');
      if (!freeKey && /\s/.test(key)) this.fail(lineNo, 'a key with spaces must be quoted');
      p = colon;
    }
    const value = line.slice(p + 1).trim();
    this.at += 1;
    const base = { key, enabled, annotations, line: lineNo };
    if (value.startsWith(MULTILINE) && isBlank(value.slice(MULTILINE.length))) {
      return { ...base, value: this.multiline(lineNo) };
    }
    if (value === '[' && this.grammar === 'request') return { ...base, value: '', list: this.listValue(lineNo) };
    return { ...base, value };
  }

  /** A `'''` value's content: four characters off each line, trimmed, then what follows the closing `'''`. */
  private multiline(lineNo: number): string {
    const content: string[] = [];
    for (;;) {
      const line = this.lines[this.at];
      if (line === undefined) this.fail(lineNo, "a ''' value is not closed");
      this.at += 1;
      const trimmed = line.trimStart();
      if (trimmed.startsWith(MULTILINE)) {
        const tail = trimmed.slice(MULTILINE.length).trim();
        const text = content.join('\n').trim();
        return tail === '' ? text : `${text} ${tail}`;
      }
      content.push(line.slice(MULTILINE_INDENT));
    }
  }

  /** A `[ … ]` value inside a dictionary: one item per line up to the `]` line. */
  private listValue(lineNo: number): string[] {
    const items: string[] = [];
    for (;;) {
      const line = this.lines[this.at];
      if (line === undefined || line.startsWith('}')) this.fail(lineNo, 'a list is not closed');
      this.at += 1;
      const item = line.trim();
      if (item === ']') return items;
      if (item !== '') items.push(item);
    }
  }

  /** A top-level `name [ a, ~b ]` list of an environment file, on one line or several. */
  private list(name: string, first: string, lineNo: number): BruBlock {
    const parts: string[] = [];
    let line = first;
    for (;;) {
      const close = line.indexOf(']');
      if (close !== -1) {
        parts.push(line.slice(0, close));
        if (!isBlank(line.slice(close + 1))) this.fail(this.at + 1, `text follows the ${name} list`);
        this.at += 1;
        break;
      }
      parts.push(line);
      this.at += 1;
      const next = this.lines[this.at];
      if (next === undefined) this.fail(lineNo, `the ${name} list is not closed`);
      line = next;
    }
    const items = parts
      .join('\n')
      .split(/[\s,]+/)
      .filter((item) => item !== '')
      .map((item) =>
        item.startsWith('~') ? { value: item.slice(1), enabled: false } : { value: item, enabled: true },
      );
    return { kind: 'list', name, items, line: lineNo };
  }
}

/** An annotation argument without its quotes; a double-quoted one with its escapes read. */
function unquote(arg: string): string {
  if (arg.length >= 2 && arg.startsWith("'") && arg.endsWith("'")) return arg.slice(1, -1);
  if (arg.length >= 2 && arg.startsWith('"') && arg.endsWith('"')) {
    const escapes: Readonly<Record<string, string>> = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' };
    const out: string[] = [];
    for (let i = 1; i < arg.length - 1; i += 1) {
      const c = arg[i] ?? '';
      const next = arg[i + 1];
      if (c === '\\' && next !== undefined && Object.hasOwn(escapes, next) && i + 1 < arg.length - 1) {
        out.push(escapes[next] ?? next);
        i += 1;
      } else {
        out.push(c);
      }
    }
    return out.join('');
  }
  return arg;
}

/**
 * Reads one `.bru` file with `grammar`.
 *
 * @throws BrunoError `bruno-parse-error`, naming `file` and the line, with both in `details`
 */
export function parseBru(text: string, grammar: BruGrammar, file: string): BruFile {
  return new Reader(text, grammar, file).read();
}

/** The first block named `name`. */
export function block(file: BruFile, name: string): BruBlock | undefined {
  return file.blocks.find((b) => b.name === name);
}

/** Every block named `name`, in file order. */
export function blocks(file: BruFile, name: string): BruBlock[] {
  return file.blocks.filter((b) => b.name === name);
}
