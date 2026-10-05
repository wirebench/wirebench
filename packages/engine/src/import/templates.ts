// packages/engine/src/import/templates.ts
/**
 * The `{{name}}` template syntax several request formats share, rewritten to Wirebench's
 * `${name}` property syntax. A dynamic `{{$name}}` has no Wirebench equivalent, so it is left as
 * written and reported rather than turned into a reference that never resolves.
 */

/** The name is trimmed in code: a lazy group beside `\s*` backtracks quadratically on a long space run. */
const MUSTACHE = /\{\{([^{}]*)\}\}/g;

/** `text` with every `{{name}}` turned into `${name}`; each dynamic name kept is added to `seen`. */
export function rewriteMustache(text: string, seen?: Set<string>): string {
  const escaped = text.replace(/\$\{/g, () => '$${');
  return escaped.replace(MUSTACHE, (match: string, inner: string) => {
    const name = inner.trim();
    if (name.length === 0) return match;
    if (name.startsWith('$')) {
      seen?.add(name);
      return match;
    }
    return `\${${name}}`;
  });
}
