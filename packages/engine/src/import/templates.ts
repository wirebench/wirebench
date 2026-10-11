// packages/engine/src/import/templates.ts
/**
 * The `{{name}}` template syntax several request formats share, rewritten to Wirebench's
 * `${name}` property syntax. A dynamic `{{$name}}` that names one of Wirebench's generators becomes
 * `${$name}` (the Dynamic scope); any other is left as written and reported rather than turned into
 * a reference that never resolves.
 */

import { isDynamicName } from '../project/dynamic.js';

/** The `${$…}` reference for a dynamic name (the text after `$`), or `undefined` when none fits. */
function dynamicReference(name: string): string | undefined {
  if (isDynamicName(name)) return `\${$${name}}`;
  // The argument forms request files write: `$randomInt min max` and `$datetime iso8601`.
  const range = /^randomInt\s+(-?\d+)\s+(-?\d+)$/.exec(name);
  if (range !== null) return `\${$randomInt(${range[1]},${range[2]})}`;
  if (/^datetime\s+iso8601$/.test(name)) return '${$isoTimestamp}';
  return undefined;
}

/** The name is trimmed in code: a lazy group beside `\s*` backtracks quadratically on a long space run. */
const MUSTACHE = /\{\{([^{}]*)\}\}/g;

/** `text` with every `{{name}}` turned into `${name}`; each dynamic name kept as written is added to `seen`. */
export function rewriteMustache(text: string, seen?: Set<string>): string {
  const escaped = text.replace(/\$\{/g, () => '$${');
  return escaped.replace(MUSTACHE, (match: string, inner: string) => {
    const name = inner.trim();
    if (name.length === 0) return match;
    if (name.startsWith('$')) {
      const reference = dynamicReference(name.slice(1));
      if (reference !== undefined) return reference;
      seen?.add(name);
      return match;
    }
    return `\${${name}}`;
  });
}

/** A `:name` path segment, written as several formats spell a path parameter. */
const COLON_PARAM = /(^|\/):([a-zA-Z0-9_-]+)(?=\/|\?|#|\.|$)/g;

/** `path` with each `:name` segment turned into Wirebench's `{name}`. */
export function colonPathParams(path: string): string {
  return path.replace(COLON_PARAM, '$1{$2}');
}
