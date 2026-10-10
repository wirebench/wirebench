/**
 * What the secret scanner and its rewrite share with each protocol's secrets facet: where a finding
 * sits ({@link SecretLocation}), one stored text to scan ({@link ScanTarget}), the walkers over keyed
 * entries and request trees, and the rewriter that replaces a finding's range with a `${secret:…}`
 * token while sharing every branch it leaves alone.
 *
 * Pure module: no I/O. It imports no protocol and not the composition file, so a module can import it.
 */
import { SECRET_NAME_PATTERN, secretToken } from '../secret-token.js';
import type { DetectContext, SecretRule } from './rules.js';

/**
 * Where a finding's value is stored. The finding's `valueStart`/`valueEnd` index into that stored
 * text: the entry's value for the keyed kinds and the properties, the text itself for the others.
 *
 * Beyond the spec's fields, `index` pins a keyed entry by its position in its list (names may
 * repeat), `field` is the position of the form field or multipart text part a `rest-body` finding
 * sits in and `name` that field's name (both absent for a raw body), and `messageId` names the
 * saved message of a `ws-message` finding. `rest-url` and `ws-url` are the request's URL text, with
 * `name` the query parameter a finding in it sits under (absent for any other finding in the URL,
 * a userinfo password included); `rest-query` and `ws-query` are its query table.
 * `grpc-api-metadata` and `ws-api-header` are the entries set on the API itself, sent by every
 * request in it.
 */
export type SecretLocation =
  | {
      readonly kind: 'soap-header' | 'rest-header' | 'rest-query' | 'grpc-metadata' | 'ws-header' | 'ws-query';
      readonly requestId: string;
      readonly name: string;
      readonly index: number;
    }
  | {
      readonly kind: 'grpc-api-metadata' | 'ws-api-header';
      readonly apiId: string;
      readonly name: string;
      readonly index: number;
    }
  | { readonly kind: 'rest-body'; readonly requestId: string; readonly field?: number; readonly name?: string }
  | { readonly kind: 'soap-body' | 'grpc-message'; readonly requestId: string }
  | { readonly kind: 'rest-url' | 'ws-url'; readonly requestId: string; readonly name?: string }
  | { readonly kind: 'ws-message'; readonly requestId: string; readonly messageId: string }
  | { readonly kind: 'project-property'; readonly name: string }
  | { readonly kind: 'env-property'; readonly environmentId: string; readonly name: string };

export interface SecretFinding {
  /** sha256 of the location and value, hex, first 16 characters: stable while neither changes. */
  readonly id: string;
  readonly location: SecretLocation;
  readonly rule: SecretRule;
  /** Display path, `Billing API › GET /invoices › header Authorization`. */
  readonly label: string;
  readonly valueStart: number;
  readonly valueEnd: number;
  /** The credential itself; never crosses IPC (the wire shape carries `maskedPreview`). */
  readonly value: string;
}

/** One stored text to scan. */
export interface ScanTarget {
  readonly location: SecretLocation;
  readonly label: string;
  readonly text: string;
  readonly context: DetectContext;
}

/** Between the parts of a finding's display path. */
export const SEP = ' › ';

/** One target per non-empty entry of `entries`, located by `kind` under `ownerId`. */
export function* keyed(
  kind:
    | 'soap-header'
    | 'rest-header'
    | 'rest-query'
    | 'grpc-metadata'
    | 'ws-header'
    | 'ws-query'
    | 'grpc-api-metadata'
    | 'ws-api-header',
  ownerId: string,
  path: string,
  noun: string,
  nameKind: NonNullable<DetectContext['nameKind']>,
  entries: readonly { readonly name: string; readonly value: string }[],
): Generator<ScanTarget> {
  for (let index = 0; index < entries.length; index++) {
    const { name, value } = entries[index]!;
    if (value === '') continue;
    yield {
      location:
        kind === 'grpc-api-metadata' || kind === 'ws-api-header'
          ? { kind, apiId: ownerId, name, index }
          : { kind, requestId: ownerId, name, index },
      label: `${path}${SEP}${noun} ${name}`,
      text: value,
      context: { fieldName: name, nameKind },
    };
  }
}

/** A request's URL, scanned for its query parameters as form pairs and for any shape. */
export function url(kind: 'rest-url' | 'ws-url', requestId: string, path: string, text: string): ScanTarget {
  return {
    location: { kind, requestId },
    label: `${path}${SEP}URL`,
    text,
    context: { contentType: 'application/x-www-form-urlencoded', nameKind: 'query' },
  };
}

export interface Tree<R> {
  readonly name: string;
  readonly folders: readonly Tree<R>[];
  readonly requests: readonly R[];
}

/** Every request of `node` and its folders, visited with the folder names on its path. */
export function* tree<R>(
  node: Omit<Tree<R>, 'name'>,
  prefix: string,
  visit: (request: R, prefix: string) => Generator<ScanTarget>,
): Generator<ScanTarget> {
  for (const request of node.requests) yield* visit(request, prefix);
  for (const folder of node.folders) yield* tree(folder, `${prefix}${SEP}${folder.name}`, visit);
}

export interface SecretMove {
  readonly finding: SecretFinding;
  /** The secret name to write; must match `SECRET_NAME_PATTERN`. */
  readonly name: string;
}

/** The stored text a location is in: a URL finding's query key is left out, as the URL is one text. */
function locationKey(location: SecretLocation): string {
  if (location.kind === 'rest-url' || location.kind === 'ws-url') {
    return JSON.stringify({ kind: location.kind, requestId: location.requestId });
  }
  return JSON.stringify(location);
}

/** Rewrites stored texts; records which moves applied and the raw values they replaced. */
export class SecretRewriter {
  readonly applied = new Map<string, string>();
  private readonly byKey = new Map<string, SecretMove[]>();

  constructor(moves: readonly SecretMove[]) {
    for (const move of moves) {
      if (!SECRET_NAME_PATTERN.test(move.name)) continue;
      const key = locationKey(move.finding.location);
      const list = this.byKey.get(key) ?? [];
      list.push(move);
      this.byKey.set(key, list);
    }
  }

  /** `text` with every move at `location` applied right to left; the same string when none apply. */
  text(location: SecretLocation, text: string): string {
    const moves = this.byKey.get(locationKey(location));
    if (moves === undefined) return text;
    const sorted = [...moves].sort((a, b) => b.finding.valueStart - a.finding.valueStart);
    let out = text;
    let limit = Infinity;
    for (const { finding, name } of sorted) {
      const { valueStart: start, valueEnd: end, value, id } = finding;
      // Compare against the original `text`: ranges index into it, and moves to the right only change `out` past `limit`.
      if (this.applied.has(id) || end > limit || start >= end || text.slice(start, end) !== value) continue;
      out = out.slice(0, start) + secretToken(name) + out.slice(end);
      limit = start;
      this.applied.set(id, value);
    }
    return out;
  }
}

/** `list` mapped by `fn`, or `list` itself when no element changed. */
export function mapShared<T>(list: readonly T[], fn: (item: T, index: number) => T): readonly T[] {
  let changed = false;
  const out = list.map((item, index) => {
    const next = fn(item, index);
    if (next !== item) changed = true;
    return next;
  });
  return changed ? out : list;
}

/** `obj` with `next` merged in, or `obj` itself when every field in `next` is already the same. */
export function patch<T extends object>(obj: T, next: Partial<T>): T {
  for (const key of Object.keys(next) as (keyof T)[]) {
    if (next[key] !== obj[key]) return { ...obj, ...next };
  }
  return obj;
}

export interface TreeNode<R> {
  readonly folders: readonly TreeNode<R>[];
  readonly requests: readonly R[];
}

/** `node` with `fn` applied to every request in it and its folders, shared where nothing changed. */
export function mapTree<N extends TreeNode<R>, R>(node: N, fn: (request: R) => R): N {
  return patch(node, {
    requests: mapShared(node.requests, fn),
    folders: mapShared(node.folders, (folder) => mapTree(folder, fn)),
  } as Partial<N>);
}

export type KeyedKind = Extract<SecretLocation, { index: number }>['kind'];

/** `entries` with each one's value rewritten at its keyed location. */
export function keyedEntries<E extends { readonly name: string; readonly value: string }>(
  rw: SecretRewriter,
  kind: KeyedKind,
  owner: { requestId: string } | { apiId: string },
  entries: readonly E[],
): readonly E[] {
  return mapShared(entries, (entry, index) => {
    const location = { kind, ...owner, name: entry.name, index } as SecretLocation;
    return patch(entry, { value: rw.text(location, entry.value) } as Partial<E>);
  });
}
