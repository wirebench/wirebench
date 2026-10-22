/**
 * What a WSDL/XSD document is allowed to reference.
 *
 * Importing a definition means fetching whatever it points at, transitively. Without a policy
 * that is a file-read primitive handed to whoever wrote the WSDL: a remote document whose
 * `xs:import schemaLocation="file:///etc/hosts"` is followed would exfiltrate a local file
 * into the import bundle, which the UI then happily displays. The rule below is deliberately
 * blunt — a nested reference stays in the same world as the root document — because anything
 * subtler is a rule nobody can hold in their head while reading a WSDL.
 */

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isInsideRealDir } from '../fs.js';

/** How deep an import chain may go before the graph is treated as runaway. */
export const MAX_IMPORT_DEPTH = 32;

/** How many documents one definition may pull in before the graph is treated as runaway. */
export const MAX_IMPORT_DOCUMENTS = 500;

/**
 * Classifies an absolute location by the world it lives in: `'file'`, `'http'` (covering
 * `https`, so an `http` root may reference an `https` document and vice versa), or the
 * location's own scheme for anything else (`mem`, `inline`, `dropped`, …).
 *
 * @param location the absolute location to classify
 * @returns the lower-cased scheme, with `https` folded into `http`
 */
export function classifyLocation(location: string): string {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(location)?.[1]?.toLowerCase();
  if (scheme === undefined) {
    return 'relative';
  }
  return scheme === 'https' ? 'http' : scheme;
}

/** A refused reference, with the sentence shown to the user. */
export interface RefusedReference {
  readonly reason: string;
}

/**
 * The policy a single import graph is resolved under, derived from its root document.
 *
 * - A `file:` root may reference `file:` documents only, and only inside its own directory
 *   tree (real paths, so a planted symlink cannot walk out).
 * - An `http(s):` root may reference any `http(s):` host, and never `file:`. Reaching an
 *   internal host that way is inherent to importing a remote WSDL — the user asked for that
 *   document, and the document says where its schemas live — so it is documented rather than
 *   blocked.
 * - Any other root (a pasted `inline:` or dropped `dropped:` document, a test `mem:` one) may
 *   reference its own scheme or `http(s):`, and never `file:`: it has no directory of its own,
 *   so there is no tree a local reference could be confined to.
 */
export interface ReferencePolicy {
  /**
   * Whether `reference` may be fetched, and why not when it may not.
   *
   * @param reference the absolute location the referring document resolved to
   */
  allows(reference: string): Promise<RefusedReference | undefined>;
}

/** The directory of a `file:` URL, or `undefined` when it is not a usable file path here. */
function toDirOrUndefined(location: string): string | undefined {
  try {
    return dirname(fileURLToPath(location));
  } catch {
    return undefined;
  }
}

/**
 * Builds the {@link ReferencePolicy} for a graph rooted at `rootLocation`.
 *
 * @param rootLocation the root document's absolute location (post-redirect)
 */
export function referencePolicyFor(rootLocation: string): ReferencePolicy {
  const rootClass = classifyLocation(rootLocation);
  // A `file:` URL that no platform can turn into a path (`file:///x` has no drive letter on
  // Windows) leaves the graph with no folder to be confined to. That is a refusal, not a
  // crash: resolving must report a problem, never throw out of the fetcher.
  const rootDir = rootClass === 'file' ? toDirOrUndefined(rootLocation) : undefined;

  return {
    async allows(reference: string): Promise<RefusedReference | undefined> {
      const refClass = classifyLocation(reference);

      if (refClass === 'file') {
        if (rootDir === undefined) {
          return {
            reason:
              rootClass === 'file'
                ? "the definition's own location is not a usable file: URL"
                : rootClass === 'http'
                  ? 'a remote definition may not reference local files'
                  : 'only a definition imported from a file may reference local files',
          };
        }
        let path: string;
        try {
          path = fileURLToPath(reference);
        } catch {
          return { reason: 'the reference is not a usable file: URL' };
        }
        if (!(await isInsideRealDir(rootDir, path))) {
          return { reason: `it resolves outside the definition's folder (${rootDir})` };
        }
        return undefined;
      }

      if (rootClass === 'file') {
        return { reason: 'a definition imported from a file may only reference files beside it' };
      }
      if (refClass === rootClass || refClass === 'http') {
        return undefined;
      }
      return { reason: `a ${rootClass}: definition may not reference a ${refClass}: document` };
    },
  };
}
