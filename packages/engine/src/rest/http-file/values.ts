/**
 * What a `.http` file and its environment files share about a value: the template rewrite, and
 * (from core, shared with every importer) the "references only" test that decides whether a
 * credential-named value may stay in a project and the cut of literal user info from a URL. Pure,
 * and free of Node.
 */

import { rewriteMustache } from '../../import/templates.js';

// The reference test and the user-info cut are every importer's; re-exported for this format's readers.
export { REFERENCE, USERINFO, looksLikeBareAuthority, referencesOnly, stripUserinfo } from '../../import/values.js';

/** Collects what a rewrite kept as written, for the importer's report. */
export interface HttpRewriteContext {
  /** Dynamic `{{$name}}` variables. */
  readonly dynamic: Set<string>;
  /** Request-chaining `{{name.response…}}` references. */
  readonly chained: Set<string>;
}

export function newRewriteContext(): HttpRewriteContext {
  return { dynamic: new Set(), chained: new Set() };
}

const PROCESS_ENV = /\{\{\s*\$processEnv\s+([A-Za-z_]\w*)\s*\}\}/g;
const CHAINING = /\{\{\s*[\w-]+\.(?:response|request)\.[^{}]*\}\}/g;
/**
 * Rewrites a `.http` value: `{{$processEnv X}}` → `${#System#X}`, request chaining kept as written
 * (and collected), then `{{x}}` → `${x}`, dynamic `{{$x}}` kept as written (and collected).
 */
export function rewriteHttpValue(text: string, ctx: HttpRewriteContext): string {
  const kept: string[] = [];
  const shielded = text
    .replace(PROCESS_ENV, (_m, name: string) => `\u0000S${name}\u0000`)
    .replace(CHAINING, (m) => {
      ctx.chained.add(m);
      kept.push(m);
      return `\u0000C${kept.length - 1}\u0000`;
    });
  return rewriteMustache(shielded, ctx.dynamic)
    .replace(/\u0000S(\w+)\u0000/g, (_m, name: string) => `\${#System#${name}}`)
    .replace(/\u0000C(\d+)\u0000/g, (_m, i: string) => kept[Number(i)] ?? '');
}
