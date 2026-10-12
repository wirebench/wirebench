/**
 * Pure edits of `snippets.yaml` as the view holds it: each returns a new file and leaves its input alone.
 * Every save sends the whole file; main validates it.
 */
import type { SnippetPackageWire, SnippetWire, SnippetsFileWire } from '../../../../shared/snippets-wire.js';

/** A declared variable or a secret name; mirrors the model's grammar (`packages/ssh`, `SECRET_NAME`). */
const NAME = '[A-Za-z_][A-Za-z0-9_]*';
const TOKEN = new RegExp(`\\$\\{(secret:)?(${NAME})\\}`, 'g');
/** Any `${…}` without a nested brace: what the editor marks as shell text when it is not ours. */
const ANY_TOKEN = /\$\{[^{}]*\}/g;

function withoutSnippet(file: SnippetsFileWire, id: string): SnippetsFileWire {
  return {
    ...file,
    packages: file.packages.map((p) => ({ ...p, snippets: p.snippets.filter((s) => s.id !== id) })),
    snippets: file.snippets.filter((s) => s.id !== id),
  };
}

function findSnippet(file: SnippetsFileWire, id: string): { snippet: SnippetWire; packageId?: string } | undefined {
  for (const pkg of file.packages) {
    const snippet = pkg.snippets.find((s) => s.id === id);
    if (snippet !== undefined) return { snippet, packageId: pkg.id };
  }
  const snippet = file.snippets.find((s) => s.id === id);
  return snippet === undefined ? undefined : { snippet };
}

function append(file: SnippetsFileWire, packageId: string | undefined, snippet: SnippetWire): SnippetsFileWire {
  if (packageId === undefined) return { ...file, snippets: [...file.snippets, snippet] };
  return {
    ...file,
    packages: file.packages.map((p) => (p.id === packageId ? { ...p, snippets: [...p.snippets, snippet] } : p)),
  };
}

/** Maps the list that holds snippet `id` (a package's or the top level). */
function mapHolder(
  file: SnippetsFileWire,
  id: string,
  fn: (snippets: readonly SnippetWire[]) => SnippetWire[],
): SnippetsFileWire {
  return {
    ...file,
    packages: file.packages.map((p) => (p.snippets.some((s) => s.id === id) ? { ...p, snippets: fn(p.snippets) } : p)),
    snippets: file.snippets.some((s) => s.id === id) ? fn(file.snippets) : file.snippets,
  };
}

/** Replaces the snippet with the same id in place; a new id, or one changing package, goes last in `packageId`. */
export function upsertSnippet(
  file: SnippetsFileWire,
  packageId: string | undefined,
  snippet: SnippetWire,
): SnippetsFileWire {
  const found = findSnippet(file, snippet.id);
  if (found === undefined) return append(file, packageId, snippet);
  if (found.packageId !== packageId) return append(withoutSnippet(file, snippet.id), packageId, snippet);
  return mapHolder(file, snippet.id, (list) => list.map((s) => (s.id === snippet.id ? snippet : s)));
}

export function moveSnippet(file: SnippetsFileWire, id: string, packageId: string | undefined): SnippetsFileWire {
  const found = findSnippet(file, id);
  if (found === undefined || found.packageId === packageId) return file;
  return append(withoutSnippet(file, id), packageId, found.snippet);
}

export function removeSnippet(file: SnippetsFileWire, id: string): SnippetsFileWire {
  return withoutSnippet(file, id);
}

/** Every package and snippet id: ids are unique across the whole file. */
function allIds(file: SnippetsFileWire): Set<string> {
  const ids = new Set<string>();
  for (const pkg of file.packages) {
    ids.add(pkg.id);
    for (const s of pkg.snippets) ids.add(s.id);
  }
  for (const s of file.snippets) ids.add(s.id);
  return ids;
}

/** `base`, or `base-2`, `base-3`, … — the first id the file does not use. */
function freeId(file: SnippetsFileWire, base: string): string {
  const taken = allIds(file);
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${String(n)}`;
  return id;
}

/** The workspace id grammar `[a-z0-9][a-z0-9-]*`, from a free-text name; `fallback` when nothing is left. */
function slug(name: string, fallback: string): string {
  const out = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return out === '' ? fallback : out;
}

/** An id for a new snippet called `name`, unique across the file. */
export function freeSnippetId(file: SnippetsFileWire, name: string): string {
  return freeId(file, slug(name, 'snippet'));
}

/** New id `x-copy`, then `x-copy-2`, …; placed after the original. */
export function duplicateSnippet(file: SnippetsFileWire, id: string): { file: SnippetsFileWire; id: string } {
  const found = findSnippet(file, id);
  if (found === undefined) return { file, id };
  const copy: SnippetWire = { ...found.snippet, id: freeId(file, `${id}-copy`), name: `${found.snippet.name} copy` };
  const next = mapHolder(file, id, (list) => list.flatMap((s) => (s.id === id ? [s, copy] : [s])));
  return { file: next, id: copy.id };
}

/** Id slugged from the name, made unique across the file. */
export function addPackage(file: SnippetsFileWire, name: string): { file: SnippetsFileWire; id: string } {
  const pkg: SnippetPackageWire = { id: freeId(file, slug(name, 'package')), name: name.trim(), snippets: [] };
  return { file: { ...file, packages: [...file.packages, pkg] }, id: pkg.id };
}

export function renamePackage(file: SnippetsFileWire, id: string, name: string): SnippetsFileWire {
  return { ...file, packages: file.packages.map((p) => (p.id === id ? { ...p, name: name.trim() } : p)) };
}

/** @throws Error when the package still holds snippets. */
export function removePackage(file: SnippetsFileWire, id: string): SnippetsFileWire {
  if (file.packages.some((p) => p.id === id && p.snippets.length > 0)) throw new Error('package is not empty');
  return { ...file, packages: file.packages.filter((p) => p.id !== id) };
}

/** `${name}` tokens in the script that are neither declared nor `secret:`, once each, in order of first use. */
export function undeclaredTokens(script: string, variables: readonly { name: string }[]): string[] {
  const declared = new Set(variables.map((v) => v.name));
  const out = new Set<string>();
  for (const match of script.matchAll(TOKEN)) {
    const name = match[2];
    if (match[1] === undefined && name !== undefined && !declared.has(name)) out.add(name);
  }
  return [...out];
}

export type ScriptTokenKind = 'variable' | 'secret' | 'shell';

/** Where each `${…}` in the script is, and whether it is a declared variable, a secret or shell text. */
export function scriptTokens(
  script: string,
  variables: readonly { name: string }[],
): { start: number; end: number; kind: ScriptTokenKind }[] {
  const declared = new Set(variables.map((v) => v.name));
  const ours = new RegExp(`^${TOKEN.source}$`);
  return [...script.matchAll(ANY_TOKEN)].map((match) => {
    const text = match[0];
    const parts = ours.exec(text);
    const kind: ScriptTokenKind =
      parts === null
        ? 'shell'
        : parts[1] !== undefined
          ? 'secret'
          : declared.has(parts[2] ?? '')
            ? 'variable'
            : 'shell';
    return { start: match.index, end: match.index + text.length, kind };
  });
}
