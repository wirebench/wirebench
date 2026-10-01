/**
 * Property expansion for a gRPC call: every `${…}` reference in the target, the metadata rows and
 * the message text, resolved against the same scopes a SOAP or REST send uses. The rules are the
 * REST ones: names as well as values are expanded, an unresolved reference is reported rather than
 * guessed at, and escaping — JSON string escaping, when the request asks for it — applies to the
 * message alone, never to a header or the target.
 */

import { expand } from '../project/properties.js';
import type { PropertyScopes, UnresolvedRef } from '../project/properties.js';
import {
  assertNoControlCharacters,
  assertOriginIndependent,
  expandWithSequenceEscaped,
} from '../project/sequence-guards.js';
import { escapeForLanguage } from '../http/escape.js';
import type { KeyValueEntry } from '../http/entries.js';

/** The parts of a call that carry text a property can appear in. */
export interface GrpcExpandable {
  readonly target: string;
  readonly metadata: readonly KeyValueEntry[];
  readonly messageText: string;
}

/** Options for {@link expandGrpcInput}. */
export interface ExpandGrpcOptions {
  /** JSON-escape every value substituted into the message text: the request's *escape properties* setting. */
  readonly escape?: boolean;
}

/** Expands every property reference in a call's target, metadata and message text. */
export function expandGrpcInput<T extends GrpcExpandable>(
  input: T,
  scopes: PropertyScopes,
  options: ExpandGrpcOptions = {},
): { readonly input: T; readonly unresolved: UnresolvedRef[] } {
  const unresolved: UnresolvedRef[] = [];
  const run = (text: string, place: string): string => {
    const result = expand(text, scopes);
    unresolved.push(...result.unresolved);
    assertNoControlCharacters(place, result, scopes);
    return result.text;
  };
  // The message is JSON. A Sequence value is JSON-escaped whether or not the request asks, because it
  // came from a response and could otherwise add fields to the message (ADR-0015).
  const runMessage = (text: string): string => {
    const result = expand(text, scopes);
    unresolved.push(...result.unresolved);
    return expandWithSequenceEscaped(
      (s) => (options.escape === true ? expand(text, escapedScopes(s)) : expand(text, s)).text,
      scopes,
      (value) => escapeForLanguage(value, 'json'),
    );
  };
  // A target is nothing but where the call goes, so no part of it may come from a response.
  assertOriginIndependent(
    'The target',
    (s) => expand(input.target, s).text,
    scopes,
    (target) => target,
  );
  return {
    input: {
      ...input,
      target: run(input.target, 'The target'),
      metadata: input.metadata.map((row) => ({
        ...row,
        name: run(row.name, 'A metadata key'),
        value: run(row.value, `The ${row.name} metadata`),
      })),
      messageText: runMessage(input.messageText),
    },
    unresolved,
  };
}

/** The same scopes with every value JSON-escaped, so substitution escapes as it goes. */
function escapedScopes(scopes: PropertyScopes): PropertyScopes {
  const escapeMap = (map: Readonly<Record<string, string | undefined>> | undefined): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(map ?? {})) {
      if (value !== undefined) {
        out[name] = escapeForLanguage(value, 'json');
      }
    }
    return out;
  };
  return {
    ...scopes,
    project: escapeMap(scopes.project),
    global: escapeMap(scopes.global),
    system: escapeMap(scopes.system),
    ...(scopes.env !== undefined ? { env: escapeMap(scopes.env) } : {}),
    ...(scopes.workspace !== undefined ? { workspace: escapeMap(scopes.workspace) } : {}),
  };
}
