/**
 * Resolving `$ref` in an OpenAPI document: local JSON pointers, and references into other documents.
 *
 * Every reference is inlined before the parser runs, so the parser never fetches and never has to
 * carry a resolver around. That makes the fetched set the same thing the cache stores, which is what
 * lets the definition be exported byte-exact later.
 *
 * Two rules keep this from being a file-read primitive handed to whoever wrote the document. The
 * *reference policy* is the one WSDL import already uses (`wsdl/ref-policy.ts`): a `file:` root may
 * only reference files inside its own folder tree, an `http(s):` root may never reach a local file.
 * And the walk is bounded — a visited set per pointer, a depth cap, and a document cap — because a
 * cyclic or fan-out document must end in a diagnostic, not a hang.
 */

import { OpenApiError } from '../../errors.js';
import { referencePolicyFor, MAX_IMPORT_DEPTH, MAX_IMPORT_DOCUMENTS } from '../../wsdl/ref-policy.js';
import type { FetchDocument } from '../../wsdl/resolver.js';
import { parseDocumentText } from './parse.js';

/** How deep a chain of `$ref`s may nest before the graph is treated as runaway. */
export const MAX_REF_DEPTH = MAX_IMPORT_DEPTH;

/** One document the resolution pulled in, kept for the definition cache. */
export interface ResolvedDocument {
  /** The absolute location it was fetched from, post-redirect. */
  readonly location: string;
  /** The location that was asked for, before any redirect. */
  readonly requestedLocation: string;
  readonly bytes: Uint8Array;
  readonly text: string;
}

/** A reference that could not be followed, and why. Never fatal: the `$ref` is left in place. */
export interface RefProblem {
  /** The reference as written. */
  readonly ref: string;
  /** Where it was written, as a JSON pointer into the root document. */
  readonly at: string;
  readonly reason: string;
}

/** What {@link resolveRefs} produced. */
export interface ResolvedRefs {
  /** The root document with every reference it could follow inlined. */
  readonly document: unknown;
  /** Every document fetched, root first, in the order they were reached. */
  readonly documents: readonly ResolvedDocument[];
  readonly problems: readonly RefProblem[];
}

export interface ResolveRefsOptions {
  readonly fetchDocument: FetchDocument;
  readonly signal?: AbortSignal;
}

/** Unescapes one JSON pointer token per RFC 6901: `~1` is `/`, `~0` is `~`, in that order. */
export function unescapePointerToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

/**
 * The value one JSON pointer names inside `document`, or `undefined` when the pointer leads nowhere.
 *
 * `''` is the whole document, per RFC 6901. An array index is read as a number; anything else is a
 * key. A pointer into a non-container is `undefined` rather than an error — the caller reports it as
 * a reference problem, which is the only form the user can act on.
 */
export function resolvePointer(document: unknown, pointer: string): unknown {
  if (pointer === '' || pointer === '#') {
    return document;
  }
  const path = pointer.startsWith('#') ? pointer.slice(1) : pointer;
  if (!path.startsWith('/')) {
    return undefined;
  }
  let at: unknown = document;
  for (const raw of path.slice(1).split('/')) {
    const token = unescapePointerToken(decodeURIComponent(raw));
    if (Array.isArray(at)) {
      const index = Number(token);
      if (!Number.isInteger(index) || index < 0 || index >= at.length) {
        return undefined;
      }
      at = at[index];
      continue;
    }
    if (typeof at !== 'object' || at === null) {
      return undefined;
    }
    at = (at as Record<string, unknown>)[token];
    if (at === undefined) {
      return undefined;
    }
  }
  return at;
}

/** Splits a `$ref` into the document part (possibly empty) and its fragment pointer. */
function splitRef(ref: string): { readonly target: string; readonly pointer: string } {
  const hash = ref.indexOf('#');
  if (hash === -1) {
    return { target: ref, pointer: '' };
  }
  return { target: ref.slice(0, hash), pointer: ref.slice(hash) };
}

/** Resolves a possibly relative document location against the document that referenced it. */
function absolute(target: string, base: string): string | undefined {
  try {
    return new URL(target, base).toString();
  } catch {
    return undefined;
  }
}

interface Walk {
  readonly root: unknown;
  readonly rootLocation: string;
  readonly options: ResolveRefsOptions;
  /** Parsed documents by absolute location, so one document is fetched and parsed once. */
  readonly byLocation: Map<string, unknown>;
  readonly documents: ResolvedDocument[];
  readonly problems: RefProblem[];
  /**
   * One resolved subtree per reference target, shared by every `$ref` that names it.
   *
   * Without this, inlining is exponential: a document whose schemas reference each other — which is
   * what every real description looks like — expands as a tree of breadth "refs per schema" and
   * depth {@link MAX_REF_DEPTH}, and a few hundred schemas never finish. Sharing one object per
   * target makes it linear in the number of *distinct* targets, and is safe because a resolved
   * document is only ever read afterwards.
   */
  readonly resolved: Map<string, unknown>;
  /**
   * Targets currently being resolved. A `$ref` back to one of them is a cycle and stays a `$ref`.
   *
   * This is what makes a target's expansion independent of the path that reached it, and therefore
   * what makes {@link Walk.resolved} correct rather than merely fast: the only cut inside a resolved
   * subtree is self-recursion, which is a property of the target and not of its caller.
   */
  readonly inProgress: Set<string>;
}

/**
 * Inlines every `$ref` in `rootText`'s document.
 *
 * @param rootText the root document's text, JSON or YAML
 * @param rootLocation its absolute location, which decides the reference policy
 * @throws OpenApiError `openapi-malformed` when the root document itself does not parse
 */
export async function resolveRefs(
  rootText: string,
  rootLocation: string,
  options: ResolveRefsOptions,
  rootBytes?: Uint8Array,
): Promise<ResolvedRefs> {
  const root = parseDocumentText(rootText);
  const walk: Walk = {
    root,
    rootLocation,
    options,
    byLocation: new Map([[rootLocation, root]]),
    documents: [
      {
        location: rootLocation,
        requestedLocation: rootLocation,
        bytes: rootBytes ?? new TextEncoder().encode(rootText),
        text: rootText,
      },
    ],
    problems: [],
    resolved: new Map(),
    inProgress: new Set(),
  };
  const document = await inline(walk, root, rootLocation, '', 0);
  return { document, documents: walk.documents, problems: walk.problems };
}

/**
 * Walks `value`, replacing each `{ $ref }` with what it names.
 *
 * `seen` holds the references already being followed *on this branch*, which is what makes a cyclic
 * document terminate: the second time a branch reaches the same reference it is left as a `$ref`,
 * and the sample generator treats that as the cut it already caps depth with.
 */
async function inline(walk: Walk, value: unknown, location: string, at: string, depth: number): Promise<unknown> {
  walk.options.signal?.throwIfAborted();
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const [index, entry] of value.entries()) {
      out.push(await inline(walk, entry, location, `${at}/${String(index)}`, depth));
    }
    return out;
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  const record = value as Record<string, unknown>;
  const ref = typeof record['$ref'] === 'string' ? record['$ref'] : undefined;
  if (ref !== undefined) {
    return await follow(walk, record, ref, location, at, depth);
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    out[key] = await inline(walk, entry, location, `${at}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`, depth);
  }
  return out;
}

/** Follows one reference, or leaves it in place with a problem recorded. */
async function follow(
  walk: Walk,
  node: Readonly<Record<string, unknown>>,
  ref: string,
  location: string,
  at: string,
  depth: number,
): Promise<unknown> {
  const { target, pointer } = splitRef(ref);
  const documentLocation = target === '' ? location : absolute(target, location);
  if (documentLocation === undefined) {
    walk.problems.push({ ref, at, reason: 'the reference is not a usable location' });
    return node;
  }
  const key = `${documentLocation}${pointer}`;
  if (walk.inProgress.has(key)) {
    // A cycle. The `$ref` stays, which is exactly what the sample generator's depth cut expects.
    return node;
  }
  const already = walk.resolved.get(key);
  if (already !== undefined) {
    // Seen before, and a target's expansion does not depend on who asked for it: hand back the same
    // subtree rather than building an identical one. This is what keeps a densely cross-referenced
    // document from expanding exponentially.
    return already;
  }
  if (depth >= MAX_REF_DEPTH) {
    walk.problems.push({ ref, at, reason: `references nest deeper than ${String(MAX_REF_DEPTH)} levels` });
    return node;
  }

  let document = walk.byLocation.get(documentLocation);
  if (document === undefined) {
    document = await fetchInto(walk, documentLocation, ref, at);
    if (document === undefined) {
      return node;
    }
  }

  const resolved = resolvePointer(document, pointer);
  if (resolved === undefined) {
    walk.problems.push({ ref, at, reason: 'nothing at that location' });
    return node;
  }
  // Resolved from the *referenced* document's location, so a relative reference inside it is
  // resolved against the document it was written in rather than against the root.
  walk.inProgress.add(key);
  try {
    const inlined = await inline(walk, resolved, documentLocation, at, depth + 1);
    walk.resolved.set(key, inlined);
    return inlined;
  } finally {
    walk.inProgress.delete(key);
  }
}

/** Fetches one referenced document, under the policy, and records it. */
async function fetchInto(walk: Walk, location: string, ref: string, at: string): Promise<unknown> {
  if (walk.documents.length >= MAX_IMPORT_DOCUMENTS) {
    walk.problems.push({ ref, at, reason: `more than ${String(MAX_IMPORT_DOCUMENTS)} documents were referenced` });
    return undefined;
  }
  const refusal = await referencePolicyFor(walk.rootLocation).allows(location);
  if (refusal !== undefined) {
    walk.problems.push({ ref, at, reason: refusal.reason });
    return undefined;
  }
  let fetched;
  try {
    fetched = await walk.options.fetchDocument(location, walk.options.signal);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw error;
    }
    walk.problems.push({
      ref,
      at,
      reason: `could not be fetched: ${error instanceof Error ? error.message : 'failed'}`,
    });
    return undefined;
  }
  // A cancel that lands while a document is in flight must stop the walk here rather than after the
  // next reference: the user pressed Cancel, and the remaining fetches are what they cancelled.
  walk.options.signal?.throwIfAborted();
  let parsed: unknown;
  try {
    parsed = parseDocumentText(fetched.text, location);
  } catch (error) {
    walk.problems.push({ ref, at, reason: error instanceof OpenApiError ? error.message : 'could not be parsed' });
    return undefined;
  }
  walk.documents.push({
    location: fetched.location,
    requestedLocation: location,
    bytes: fetched.bytes,
    text: fetched.text,
  });
  walk.byLocation.set(location, parsed);
  // A redirect means the document also answers to where it ended up, so a sibling reference
  // resolved against that location finds it without a second fetch.
  walk.byLocation.set(fetched.location, parsed);
  return parsed;
}
