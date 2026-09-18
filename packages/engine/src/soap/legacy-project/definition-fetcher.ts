/**
 * A {@link FetchDocument} that answers from a legacy project's cached definition parts, so an
 * interface resolves exactly as it was when the file was saved, without touching the network.
 */

import { WsdlParseError } from '../../errors.js';
import type { FetchDocument } from '../../wsdl/resolver.js';
import type { LegacyDefinitionCache } from './model.js';

/** `location` in a canonical form, so `HTTP://Host/a/../b` and `http://host/b` find the same part. */
function canonical(location: string): string {
  try {
    return new URL(location).href;
  } catch {
    return location;
  }
}

/** Options for {@link fetchDocumentFromCache}. */
export interface CacheFetchOptions {
  /** Asked for any location the cache does not hold. Without one, such a location is an error. */
  readonly fallback?: FetchDocument;
  /** Told each location that had to be fetched through {@link fallback}. */
  readonly onFallback?: (location: string) => void;
}

/**
 * Serves every location held in `cache` from memory, and anything else through `options.fallback`.
 *
 * @throws WsdlParseError `legacy-cache-miss` for a location the cache lacks when there is no fallback.
 */
export function fetchDocumentFromCache(
  cache: LegacyDefinitionCache | undefined,
  options: CacheFetchOptions = {},
): FetchDocument {
  const parts = new Map<string, string>();
  for (const part of cache?.parts ?? []) {
    parts.set(canonical(part.url), part.content);
  }
  const encoder = new TextEncoder();
  return async (location, signal) => {
    const text = parts.get(canonical(location));
    if (text !== undefined) {
      return { location, bytes: encoder.encode(text), text };
    }
    if (options.fallback === undefined) {
      throw new WsdlParseError('legacy-cache-miss', `The project file does not hold a copy of ${location}`, {
        details: { location },
      });
    }
    options.onFallback?.(location);
    return options.fallback(location, signal);
  };
}

/** The location to resolve an interface from: the cache's root part, else the definition URL. */
export function definitionRootOf(
  cache: LegacyDefinitionCache | undefined,
  definitionUrl: string | undefined,
): string | undefined {
  return cache?.rootPart ?? definitionUrl ?? cache?.parts[0]?.url;
}
