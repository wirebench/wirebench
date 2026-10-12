/**
 * The only way the lint runner reaches another document (#342 spec §2).
 *
 * A linted definition is untrusted input, and the runner's stock resolver would read any file and
 * fetch any URL a `$ref` names. This resolver has one reader for `file`, `http` and `https`, and
 * every reference goes through the import reference policy first: a `file:` root stays inside its
 * own folder tree, and nothing reaches the network from a local root unless the caller allows
 * remote references. What passes is read through the caller's {@link FetchDocument} — the network
 * fetcher in the CLI, the offline definition cache in the desktop. A refused reference rejects, and
 * the runner reports it as an `invalid-ref` finding carrying the reason.
 */

import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Resolver } from '@stoplight/spectral-ref-resolver';
import type { FetchDocument } from '../../../http/fetch-document.js';
import { MAX_IMPORT_DOCUMENTS, classifyLocation, referencePolicyFor } from '../../../http/ref-policy.js';

export interface LintResolverOptions {
  /** The root document's absolute location (a `file:` or `http(s):` URL, or another scheme). */
  readonly rootLocation: string;
  readonly fetchDocument: FetchDocument;
  /** Let a local root reference `http(s):` documents. An `http(s):` root may anyway. */
  readonly allowRemoteRefs?: boolean;
  readonly signal?: AbortSignal;
}

/**
 * A reference as the runner hands it over, as an absolute location. A file root's references come as
 * plain paths (the runner was given the root's path), so a path becomes a `file:` URL.
 */
export function referenceLocation(reference: string): string {
  if (isAbsolute(reference) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(reference)) {
    return pathToFileURL(reference).href;
  }
  return reference;
}

/** The runner's source name for a location: a path for `file:`, the location itself otherwise. */
export function runnerSource(location: string): string {
  if (classifyLocation(location) === 'file') {
    try {
      return decodeURIComponent(new URL(location).pathname).replace(/^\/([a-z]:)/i, '$1');
    } catch {
      return location;
    }
  }
  return location;
}

/** Builds the fenced resolver one lint runs with. */
export function lintResolver(options: LintResolverOptions): Resolver {
  const policy = referencePolicyFor(options.rootLocation);
  const rootIsRemote = classifyLocation(options.rootLocation) === 'http';
  let fetched = 0;

  const read = async (uri: { toString(): string }): Promise<string> => {
    const location = referenceLocation(uri.toString());
    const remote = classifyLocation(location) === 'http';
    if (remote && !rootIsRemote && options.allowRemoteRefs !== true) {
      throw new Error(`${location} is a remote reference; remote references are not followed (allow them explicitly)`);
    }
    if (!(remote && options.allowRemoteRefs === true)) {
      const refusal = await policy.allows(location);
      if (refusal !== undefined) {
        throw new Error(refusal.reason);
      }
    }
    fetched += 1;
    if (fetched > MAX_IMPORT_DOCUMENTS) {
      throw new Error(`more than ${String(MAX_IMPORT_DOCUMENTS)} referenced documents; the rest are not followed`);
    }
    const document = await options.fetchDocument(location, options.signal);
    return document.text;
  };

  return new Resolver({
    resolvers: { file: { resolve: read }, http: { resolve: read }, https: { resolve: read } },
  });
}
