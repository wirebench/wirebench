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
import { fileURLToPath, pathToFileURL } from 'node:url';
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

/** A Windows drive letter in a `file:` URL, upper-cased as Node's own paths spell it. */
function upperDrive(href: string): string {
  return href.replace(/^file:\/\/\/([a-z]):/, (_whole, drive: string) => `file:///${drive.toUpperCase()}:`);
}

/**
 * A document's location as the runner names it, as one canonical absolute location: a `file:` URL
 * with an upper-case drive letter for anything local, the location itself otherwise. The runner
 * hands a file back as a plain path, sometimes re-spelled (forward slashes, a lower-case drive on
 * Windows), so every comparison and every report goes through here.
 */
export function referenceLocation(reference: string): string {
  if (/^file:/i.test(reference)) {
    try {
      return upperDrive(pathToFileURL(fileURLToPath(reference)).href);
    } catch {
      return reference;
    }
  }
  if (isAbsolute(reference) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(reference)) {
    return upperDrive(pathToFileURL(reference).href);
  }
  return reference;
}

/** The runner's source name for a location: the native path for `file:`, the location itself otherwise. */
export function runnerSource(location: string): string {
  if (classifyLocation(location) === 'file') {
    try {
      return fileURLToPath(location);
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
