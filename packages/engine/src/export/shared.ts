/**
 * The rules both exporters share (spec §3.1): Wirebench's `${…}` references rewritten to the
 * `{{name}}` syntax both formats read, URLs made absolute, file names made unique, and the one
 * report every line of the export goes to.
 */

import { ReportBuilder } from '../import/report.js';
import { slugify } from '../project/paths.js';
import { SECRET_NAME_PATTERN } from '../secrets/secret-token.js';

/** The scopes the target's one variable namespace flattens: `${#Env#name}` is written `{{name}}`. */
const FLATTENED = new Set(['Project', 'Env', 'Workspace', 'Global']);

/** The running state of one export: its report and the secret names its references declared. */
export class ExportContext {
  readonly report = new ReportBuilder();
  /** Names a `${secret:name}` reference used, declared as secret variables with no value. */
  readonly secrets = new Set<string>();

  /**
   * `text` with every reference rewritten (spec §3.1 table). A `$${` escape becomes a literal `${`;
   * a reference the target cannot express is kept as written and warned about once.
   */
  mustache(text: string): string {
    if (!text.includes('${')) return text;
    let out = '';
    let i = 0;
    while (i < text.length) {
      if (text.startsWith('$${', i)) {
        out += '${';
        i += 3;
        continue;
      }
      if (!text.startsWith('${', i)) {
        out += text[i];
        i += 1;
        continue;
      }
      const end = closingBrace(text, i);
      if (end === -1) {
        out += text.slice(i);
        break;
      }
      const raw = text.slice(i, end + 1);
      out += this.reference(raw, text.slice(i + 2, end));
      i = end + 1;
    }
    return out;
  }

  private reference(raw: string, inner: string): string {
    if (inner.includes('${')) return this.kept(raw);
    if (inner.startsWith('secret:')) {
      const name = inner.slice('secret:'.length);
      if (!SECRET_NAME_PATTERN.test(name)) return this.kept(raw);
      if (!this.secrets.has(name)) {
        this.secrets.add(name);
        this.report.note(
          `The secret ${name} is written as the variable {{${name}}} with no value; set it in the target tool.`,
        );
      }
      return `{{${name}}}`;
    }
    if (inner.startsWith('#')) {
      const second = inner.indexOf('#', 1);
      const scope = second === -1 ? '' : inner.slice(1, second);
      if (!FLATTENED.has(scope)) return this.kept(raw);
      this.report.note(`References to the ${scope} scope are written as plain {{name}} variables.`);
      return plainName(inner.slice(second + 1)) ?? this.kept(raw);
    }
    return plainName(inner) ?? this.kept(raw);
  }

  private kept(raw: string): string {
    this.report.warn(`The reference ${raw} has no equivalent and was kept as written.`);
    return raw;
  }
}

function plainName(name: string): string | undefined {
  return name === '' || /[{}]/.test(name) ? undefined : `{{${name}}}`;
}

/** The index of the `}` closing the `${` at `start`, nested `${…}` counted; -1 when unterminated. */
function closingBrace(text: string, start: number): number {
  let depth = 1;
  let j = start + 2;
  while (j < text.length) {
    if (text.startsWith('${', j)) {
      depth += 1;
      j += 2;
      continue;
    }
    if (text[j] === '}') {
      depth -= 1;
      if (depth === 0) return j;
    }
    j += 1;
  }
  return -1;
}

/** True when a property value is a single `${secret:name}` reference and nothing else. */
export function isSecretOnly(value: string): boolean {
  const match = /^\$\{secret:([^{}]*)\}$/.exec(value);
  return match !== null && SECRET_NAME_PATTERN.test(match[1]!);
}

/** `{name}` path parameters written `:name`, the spelling both formats read; `${…}` and `{{…}}` left alone. */
export function colonPath(url: string): string {
  return url.replace(/(?<![${])\{([A-Za-z0-9_-]+)\}(?!\})/g, ':$1');
}

/** `name` slugified, lower-cased and made unique among `taken`, which it joins. */
export function uniqueFileStem(name: string, taken: Set<string>): string {
  const base = slugify(name).toLowerCase().replace(/\s+/g, '-');
  let stem = base;
  for (let n = 2; taken.has(stem); n += 1) stem = `${base}-${n}`;
  taken.add(stem);
  return stem;
}
