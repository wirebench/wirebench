/**
 * Where the `${…}` references in a piece of text are, and what each one names — without resolving
 * anything. The editor uses it to complete, explain and mark references as they are typed (#340).
 *
 * It scans exactly as `properties.ts`'s expansion does: `$${` is an escape (a run of three dollars
 * never opens a reference), braces nest, and an unterminated `${` runs to the end of the text. Only
 * the outermost references are reported, at the offsets `expand()` would report them. A reference
 * whose name is built from another one is `nested`: what it names is only known once expanded.
 *
 * Pure, and free of Node modules, so the renderer can import it through `@wirebench/engine/rest`.
 */

/** How a reference is written. */
export type PropertyReferenceForm =
  'shorthand' | 'scoped' | 'secret' | 'dynamic' | 'nested' | 'unknown-scope' | 'malformed';

/** One outermost `${…}` reference in a text. */
export interface PropertyReference {
  /** Offset of the `$`. */
  readonly start: number;
  /** Offset just past the closing `}` (or the end of the text, when unterminated). */
  readonly end: number;
  readonly form: PropertyReferenceForm;
  /** The explicit scope: `Env`, `Project`, …, `Secret` for `${secret:…}`, `Dynamic` for `${$…}`. */
  readonly scope?: string;
  /** The name referenced; a dynamic generator's without its arguments; `''` when malformed. */
  readonly name: string;
}

/** The scopes `${#Scope#name}` may name, as `properties.ts` accepts them. */
const SCOPES = new Set(['Project', 'Env', 'Workspace', 'Global', 'System', 'Sequence', 'Data', 'Dynamic']);

/** A dynamic generator's name, without the `(…)` arguments it may be given. */
function generatorName(text: string): string {
  const open = text.indexOf('(');
  return open === -1 ? text : text.slice(0, open);
}

/** What the inside of one terminated `${…}` names. */
function classify(inner: string, start: number, end: number): PropertyReference {
  if (inner.includes('${')) {
    return { start, end, form: 'nested', name: inner };
  }
  if (inner.startsWith('#')) {
    const second = inner.indexOf('#', 1);
    if (second !== -1) {
      const scope = inner.slice(1, second);
      const name = inner.slice(second + 1);
      if (scope === 'Dynamic') {
        return { start, end, form: 'dynamic', scope, name: generatorName(name) };
      }
      return { start, end, form: SCOPES.has(scope) ? 'scoped' : 'unknown-scope', scope, name };
    }
  }
  if (inner.length > 1 && inner.startsWith('$')) {
    return { start, end, form: 'dynamic', scope: 'Dynamic', name: generatorName(inner.slice(1)) };
  }
  if (inner.startsWith('secret:')) {
    return { start, end, form: 'secret', scope: 'Secret', name: inner.slice('secret:'.length) };
  }
  return { start, end, form: 'shorthand', name: inner };
}

/** Every outermost `${…}` reference in `text`, in order. */
export function propertyReferences(text: string): PropertyReference[] {
  const found: PropertyReference[] = [];
  let i = 0;
  while (i < text.length) {
    if (text.startsWith('$${', i)) {
      i += 3;
      continue;
    }
    if (!text.startsWith('${', i)) {
      i++;
      continue;
    }
    const start = i;
    let depth = 1;
    let j = i + 2;
    while (j < text.length && depth > 0) {
      if (text.startsWith('${', j)) {
        depth++;
        j += 2;
      } else {
        if (text[j] === '}') depth--;
        j++;
      }
    }
    if (depth > 0) {
      found.push({ start, end: text.length, form: 'malformed', name: '' });
      break;
    }
    found.push(classify(text.slice(start + 2, j - 1), start, j));
    i = j;
  }
  return found;
}
