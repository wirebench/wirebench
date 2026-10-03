/**
 * The trust a forward sink verifies its destination against (issue #209): the system roots, plus the
 * operator's CA bundle when one is configured. A `ca` given to Node replaces its default roots, and the
 * bundle is meant to add to them, as the definition-fetch CA bundle does. Verification is always on.
 */
import { rootCertificates } from 'node:tls';
import { splitPemBundle } from '@wirebench/engine';

/** The system roots followed by the bundle's certificates; `undefined` (the default roots alone) without one. */
export function trustAnchors(caPem: string | undefined): string[] | undefined {
  if (caPem === undefined) return undefined;
  return [...rootCertificates, ...splitPemBundle(caPem)];
}

/** An error's code, or its message: never a payload, a header or a token. */
export function reason(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = (error as NodeJS.ErrnoException).code;
  return code !== undefined && !error.message.includes(code) ? `${error.message} (${code})` : error.message;
}
