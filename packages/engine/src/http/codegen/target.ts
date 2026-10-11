/** What every target is handed, and the helpers more than one of them needs. */

import { hasEnv } from './model.js';
import type { CodeHeader, CodeRequest, GeneratedCode } from './model.js';

/** The request's settings with the user's per-target choices applied. */
export interface Layout {
  /** One level of indentation. */
  readonly unit: string;
  readonly followRedirects: boolean;
  /** Only when following. */
  readonly maxRedirects?: number;
  /** Absent: no timeout. */
  readonly timeoutMs?: number;
}

/** One language's generator. */
export type Target = (request: CodeRequest, layout: Layout) => GeneratedCode;

/**
 * Headers with one entry per name, for a language that holds them in a map: a repeated header's
 * values are joined with `, `, which is how HTTP itself folds them (RFC 9110 §5.3). The first
 * spelling of a name is kept.
 */
export function mergedHeaders(headers: readonly CodeHeader[]): CodeHeader[] {
  const out: { name: string; value: string }[] = [];
  for (const header of headers) {
    const same = out.find((row) => row.name.toLowerCase() === header.name.toLowerCase());
    if (same === undefined) {
      out.push({ name: header.name, value: header.value });
    } else {
      same.value = `${same.value}, ${header.value}`;
    }
  }
  return out;
}

/** The headers without `name` (case-insensitive): for a library that takes it as its own argument. */
export function withoutHeader(headers: readonly CodeHeader[], name: string): CodeHeader[] {
  const lower = name.toLowerCase();
  return headers.filter((header) => header.name.toLowerCase() !== lower);
}

/** The note for a request that skips TLS verification in a library with no switch for it. */
export const INSECURE_NOTE = 'This request skips TLS verification; the snippet verifies certificates.';

/** The note for a redirect limit a library cannot set. */
export function maxRedirectsNote(limit: number): string {
  return `The redirect limit of ${String(limit)} is not applied; the library's own limit is.`;
}

/** The note for following redirects in a library that never does. */
export const NO_FOLLOW_NOTE =
  'This request follows redirects; the library does not, so the snippet stops at the first.';

/** Whether any string of the request reads the environment, so the snippet needs its env import. */
export function readsEnv(request: CodeRequest): boolean {
  return hasEnv(JSON.stringify(request));
}

/** Whether the body reads a file from disk. */
export function readsFiles(request: CodeRequest): boolean {
  return (
    request.body.kind === 'binary' ||
    (request.body.kind === 'multipart' && request.body.parts.some((part) => part.kind === 'file'))
  );
}
