/**
 * A request as code in another language: the protocol-neutral description every target renders.
 *
 * Each protocol builds a {@link CodeRequest} from its own resolved send input (`rest/codegen.ts`,
 * `soap/codegen.ts`), the same input its send and its `curl` export use, so every language agrees
 * with the wire. A target knows nothing about REST or SOAP.
 *
 * A string here may carry {@link envMarker}s: a credential the snippet must read from the environment
 * rather than carry. They are made of letters, digits and underscores only, so they pass through URL
 * composition and percent-encoding untouched, and each target turns them into its own environment read.
 */

import { SECRET_ENV_PREFIX } from '../../secrets/env-names.js';
import { secretEnvName } from '../../secrets/secret-token.js';
import type { CurlBody, CurlHeader } from '../curl.js';

/** One header, in the order the user wrote it. */
export type CodeHeader = CurlHeader;

/** What the request sends: the same shapes the `curl` export knows. */
export type CodeBody = CurlBody;

/** A request as every code target sees it. */
export interface CodeRequest {
  readonly method: string;
  readonly url: string;
  /** Headers in order, with the body's `Content-Type` among them when the body implies one. */
  readonly headers: readonly CodeHeader[];
  readonly body: CodeBody;
  /** Basic credentials the transport applies; the password may be an environment marker. */
  readonly basic?: { readonly username: string; readonly password: string };
  /** Send even when the certificate does not verify. */
  readonly insecure?: boolean;
  readonly followRedirects: boolean;
  readonly maxRedirects?: number;
  /** The request's own timeout. Absent: none. */
  readonly timeoutMs?: number;
}

/** The languages the Code panel offers beyond `curl`. */
export const CODE_TARGETS = [
  { id: 'js-fetch', label: 'JavaScript — fetch' },
  { id: 'node-axios', label: 'Node.js — axios' },
  { id: 'python-requests', label: 'Python — requests' },
  { id: 'go-net-http', label: 'Go — net/http' },
  { id: 'java-httpclient', label: 'Java — HttpClient' },
  { id: 'java-okhttp', label: 'Java — OkHttp' },
  { id: 'csharp-httpclient', label: 'C# — HttpClient' },
  { id: 'php-curl', label: 'PHP — cURL' },
  { id: 'ruby-net-http', label: 'Ruby — Net::HTTP' },
  { id: 'powershell-irm', label: 'PowerShell — Invoke-RestMethod' },
  { id: 'httpie', label: 'HTTPie' },
] as const;

export type CodeTargetId = (typeof CODE_TARGETS)[number]['id'];

/** How one snippet is laid out. An absent setting takes the request's own value. */
export interface CodeOptions {
  /** Spaces per level, or a tab. Default: the target's own convention. */
  readonly indent?: number | 'tab';
  readonly followRedirects?: boolean;
  /** Milliseconds; 0 means no timeout. */
  readonly timeoutMs?: number;
}

/** What a target produced: the code, and what it could not express. */
export interface GeneratedCode {
  readonly code: string;
  /** One line each, for the panel to show under the preview; also written as comments in the code. */
  readonly notes: readonly string[];
}

const MARKER_FENCE = 'WBENVx';
const MARKER = /WBENVx([A-Z0-9_]+?)xWBENV/g;

/**
 * A stand-in for "read environment variable `name` here". `name` is upper-cased to the variable
 * names the CLI reads (`WIREBENCH_SECRET_*`), which are what a marker is ever made for.
 */
export function envMarker(name: string): string {
  return `${MARKER_FENCE}${name.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}xWBENV`;
}

/** One piece of a string: literal text, or an environment variable to read. */
export type TextPart = { readonly text: string } | { readonly env: string };

/** `text` split on its environment markers, empty literals dropped. Plain text is one part. */
export function splitEnv(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const match of text.matchAll(MARKER)) {
    if (match.index > last) {
      parts.push({ text: text.slice(last, match.index) });
    }
    parts.push({ env: match[1] as string });
    last = match.index + match[0].length;
  }
  if (last < text.length || parts.length === 0) {
    parts.push({ text: text.slice(last) });
  }
  return parts;
}

/** Whether `text` reads anything from the environment. */
export function hasEnv(text: string): boolean {
  return splitEnv(text).some((part) => 'env' in part);
}

const SECRET_TOKEN = /\$\{secret:([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * `value` with every `${secret:name}` token in its strings replaced by a read of
 * `WIREBENCH_SECRET_<NAME>`, the variable the CLI reads that secret from. Arrays and plain objects
 * are walked; anything else (a function, a byte array) is kept as it is. Run it before the URL is
 * composed: the token's own `${` would otherwise be percent-encoded.
 */
export function secretTokensToEnv<T>(value: T): T {
  if (typeof value === 'string') {
    return value.replace(SECRET_TOKEN, (_, name: string) =>
      envMarker(`${SECRET_ENV_PREFIX}${secretEnvName(name)}`),
    ) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => secretTokensToEnv(item)) as T;
  }
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, secretTokensToEnv(item)])) as T;
  }
  return value;
}
