import type { SshConfigBlock, SshConfigDocument } from './load.js';
import type { SshConfigLine } from './types.js';

const WILD = /[*?]/;

/** A `Host` token that names one machine: no wildcard, no negation. */
export const isConcrete = (pattern: string): boolean => !WILD.test(pattern) && !pattern.startsWith('!');

/** Every concrete alias, once, in document order. */
export function concreteAliases(doc: SshConfigDocument): string[] {
  const out: string[] = [];
  for (const block of doc.blocks) {
    if (block.kind !== 'host') continue;
    for (const pattern of block.patterns) if (isConcrete(pattern) && !out.includes(pattern)) out.push(pattern);
  }
  return out;
}

/** `ssh`'s glob: `*` any run, `?` one character, compared without case. */
export function matchPattern(pattern: string, alias: string): boolean {
  const body = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${body}$`, 'i').test(alias);
}

/** A pattern list applies when a positive pattern matches and no `!pattern` does. */
export function blockMatches(patterns: readonly string[], alias: string): boolean {
  let positive = false;
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) {
      if (matchPattern(pattern.slice(1), alias)) return false;
    } else if (matchPattern(pattern, alias)) {
      positive = true;
    }
  }
  return positive;
}

/** What `ssh` would use: the first line per keyword; every `IdentityFile`, in order. */
export interface Effective {
  readonly values: ReadonlyMap<string, SshConfigLine>;
  readonly identityFiles: readonly SshConfigLine[];
}

function collect(doc: SshConfigDocument, applies: (block: SshConfigBlock) => boolean): Effective {
  const values = new Map<string, SshConfigLine>();
  const identityFiles: SshConfigLine[] = [];
  for (const block of doc.blocks) {
    if (block.kind === 'match' || !applies(block)) continue;
    for (const line of block.lines) {
      if (line.keyword === 'identityfile') identityFiles.push(line);
      else if (!values.has(line.keyword)) values.set(line.keyword, line);
    }
  }
  return { values, identityFiles };
}

/** The effective settings for one alias. `Match` blocks never apply. */
export function effective(doc: SshConfigDocument, alias: string): Effective {
  return collect(doc, (block) => block.kind === 'global' || blockMatches(block.patterns, alias));
}

/** The settings every alias gets from the global block and `Host` blocks that list a bare `*`. */
export function allHosts(doc: SshConfigDocument): Effective {
  return collect(doc, (block) => block.kind === 'global' || block.patterns.includes('*'));
}
