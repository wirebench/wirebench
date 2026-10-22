/**
 * The host functions a script's API is built on (ADR-0016). Each is a pure function of strings: no
 * handle, object or prototype of the host ever reaches the sandbox, only the strings these return.
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { evaluate } from '../../xpath/evaluate.js';
import { SCRIPT_LIMITS, type SandboxLog } from './model.js';

export const HASH_ALGORITHMS = ['md5', 'sha1', 'sha256', 'sha512'] as const;
export const HMAC_ALGORITHMS = ['sha1', 'sha256', 'sha512'] as const;
export const DIGEST_ENCODINGS = ['hex', 'base64'] as const;

type DigestEncoding = (typeof DIGEST_ENCODINGS)[number];

/** Thrown into the script (as its message) when a host function is called with something it refuses. */
export class HostCallError extends Error {}

function oneOf<T extends string>(value: string, allowed: readonly T[], what: string): T {
  if ((allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  throw new HostCallError(`${what} must be one of ${allowed.join(', ')}; got "${value}"`);
}

function digestEncoding(value: string | undefined): DigestEncoding {
  return value === undefined ? 'hex' : oneOf(value, DIGEST_ENCODINGS, 'encoding');
}

export function hash(algorithm: string, data: string, encoding?: string): string {
  return createHash(oneOf(algorithm, HASH_ALGORITHMS, 'algorithm'))
    .update(data, 'utf8')
    .digest(digestEncoding(encoding));
}

export function hmac(algorithm: string, key: string, data: string, encoding?: string): string {
  return createHmac(oneOf(algorithm, HMAC_ALGORITHMS, 'algorithm'), key)
    .update(data, 'utf8')
    .digest(digestEncoding(encoding));
}

export function uuid(): string {
  return randomUUID();
}

export function base64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

export function fromBase64(text: string): string {
  return Buffer.from(text, 'base64').toString('utf8');
}

export function base64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

export function urlEncode(text: string): string {
  return encodeURIComponent(text);
}

/**
 * The strings an XPath expression selects in `xml`, as JSON text: each node's text, or each value.
 * `namespacesJson` is a JSON object of prefix to URI.
 */
export function xpathStrings(xml: string, expression: string, namespacesJson: string): string {
  let namespaces: Record<string, string> = {};
  try {
    const parsed: unknown = JSON.parse(namespacesJson);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      namespaces = Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).filter(
          (e): e is [string, string] => typeof e[1] === 'string',
        ),
      );
    }
  } catch {
    throw new HostCallError('namespaces must be a JSON object');
  }
  const result = evaluate(xml, expression, { language: 'xpath', namespaces });
  switch (result.kind) {
    case 'error':
      throw new HostCallError(result.message);
    case 'empty':
      return '[]';
    default:
      return JSON.stringify(result.items.map((item) => item.text));
  }
}

const TRUNCATED_MARK = '… (log cut short)';

/** Collects `log(...)` lines within the caps; anything past them is dropped and flagged. */
export class LogCollector {
  private readonly lines: string[] = [];
  private bytes = 0;
  private truncated = false;

  add(line: string): void {
    if (this.truncated) {
      return;
    }
    if (this.lines.length >= SCRIPT_LIMITS.logLines) {
      this.truncated = true;
      return;
    }
    const size = Buffer.byteLength(line, 'utf8');
    const room = SCRIPT_LIMITS.logBytes - this.bytes;
    if (size > room) {
      this.lines.push(`${Buffer.from(line, 'utf8').subarray(0, Math.max(0, room)).toString('utf8')}${TRUNCATED_MARK}`);
      this.bytes = SCRIPT_LIMITS.logBytes;
      this.truncated = true;
      return;
    }
    this.lines.push(line);
    this.bytes += size;
  }

  result(): SandboxLog {
    return { lines: [...this.lines], truncated: this.truncated };
  }
}
