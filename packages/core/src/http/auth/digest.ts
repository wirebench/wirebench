/**
 * HTTP Digest authentication (RFC 7616): picking the challenge to answer, computing the response, and
 * the per-origin nonce memory that lets later sends skip the 401.
 *
 * Supported: MD5, SHA-256 and their `-sess` forms, with `qop=auth` or no `qop` at all (the RFC 2069
 * form older servers still send). `auth-int`, `userhash` and SHA-512-256 are not: a challenge that
 * leaves nothing else is refused by name rather than answered wrongly. Pure but for the cache, which
 * the send path owns; the cnonce is passed in, so the math is testable.
 */

import { createHash } from 'node:crypto';
import { HttpError } from '../../errors.js';
import type { AuthChallenge } from './basic.js';

/** The hash a challenge names. */
export type DigestAlgorithm = 'MD5' | 'MD5-sess' | 'SHA-256' | 'SHA-256-sess';

/** One Digest challenge this client can answer. */
export interface DigestChallenge {
  readonly realm: string;
  readonly nonce: string;
  readonly opaque?: string;
  readonly algorithm: DigestAlgorithm;
  /** `auth` when the server offered it; absent for the legacy form. */
  readonly qop?: 'auth';
  /** The server's nonce expired but the credentials were right: answer again with the new one. */
  readonly stale: boolean;
}

const ALGORITHMS: Readonly<Record<string, DigestAlgorithm>> = {
  md5: 'MD5',
  'md5-sess': 'MD5-sess',
  'sha-256': 'SHA-256',
  'sha-256-sess': 'SHA-256-sess',
};

/** Stronger first: the order a server's several challenges are tried in. */
const PREFERENCE: readonly DigestAlgorithm[] = ['SHA-256', 'SHA-256-sess', 'MD5', 'MD5-sess'];

/**
 * The Digest challenge to answer among `challenges`, preferring SHA-256; `undefined` when none is a
 * Digest challenge.
 *
 * @throws HttpError `digest-unsupported` when every Digest challenge needs something unsupported:
 * an unknown algorithm, or `qop` without `auth` (only `auth-int`)
 */
export function pickDigestChallenge(challenges: readonly AuthChallenge[]): DigestChallenge | undefined {
  const digest = challenges.filter((challenge) => challenge.scheme === 'digest');
  if (digest.length === 0) return undefined;
  const usable: DigestChallenge[] = [];
  const reasons = new Set<string>();
  for (const { params } of digest) {
    const named = (params['algorithm'] ?? 'MD5').toLowerCase();
    const algorithm = ALGORITHMS[named];
    if (algorithm === undefined) {
      reasons.add(`the ${params['algorithm'] ?? ''} algorithm`);
      continue;
    }
    const offered = params['qop']?.split(',').map((value) => value.trim().toLowerCase());
    if (offered !== undefined && !offered.includes('auth')) {
      reasons.add(`qop=${offered.join(',')}`);
      continue;
    }
    const nonce = params['nonce'];
    if (nonce === undefined) {
      reasons.add('a challenge without a nonce');
      continue;
    }
    usable.push({
      realm: params['realm'] ?? '',
      nonce,
      ...(params['opaque'] !== undefined ? { opaque: params['opaque'] } : {}),
      algorithm,
      ...(offered !== undefined ? { qop: 'auth' as const } : {}),
      stale: params['stale']?.toLowerCase() === 'true',
    });
  }
  const best = [...usable].sort((a, b) => PREFERENCE.indexOf(a.algorithm) - PREFERENCE.indexOf(b.algorithm))[0];
  if (best === undefined) {
    throw new HttpError(
      'digest-unsupported',
      `The server's Digest challenge asks for ${[...reasons].join(' and ')}, which Wirebench does not support: it answers MD5 or SHA-256 (and their -sess forms) with qop=auth.`,
      { details: { reasons: [...reasons] } },
    );
  }
  return best;
}

/** What one `Authorization: Digest …` header is computed from. */
export interface DigestInput {
  readonly username: string;
  readonly password: string;
  readonly method: string;
  /** The request target: path and query, as on the request line. */
  readonly uri: string;
  readonly challenge: DigestChallenge;
  /** This nonce's use count, starting at 1. */
  readonly nc: number;
  readonly cnonce: string;
}

function hash(algorithm: DigestAlgorithm, text: string): string {
  return createHash(algorithm.startsWith('SHA-256') ? 'sha256' : 'md5')
    .update(text, 'utf8')
    .digest('hex');
}

/** A quoted-string value, with `"` and `\` escaped. */
function quoted(value: string): string {
  return `"${value.replace(/["\\]/g, (char) => `\\${char}`)}"`;
}

/** The `Authorization` header value answering `input.challenge`. */
export function digestAuthorization(input: DigestInput): string {
  const { challenge } = input;
  const { algorithm } = challenge;
  const nc = input.nc.toString(16).padStart(8, '0');
  const userHash = hash(algorithm, `${input.username}:${challenge.realm}:${input.password}`);
  const ha1 = algorithm.endsWith('-sess')
    ? hash(algorithm, `${userHash}:${challenge.nonce}:${input.cnonce}`)
    : userHash;
  const ha2 = hash(algorithm, `${input.method.toUpperCase()}:${input.uri}`);
  const response =
    challenge.qop === 'auth'
      ? hash(algorithm, `${ha1}:${challenge.nonce}:${nc}:${input.cnonce}:auth:${ha2}`)
      : hash(algorithm, `${ha1}:${challenge.nonce}:${ha2}`);
  // A `-sess` hash needs the cnonce even in the legacy form, so the server can recompute HA1.
  const withCnonce = challenge.qop === 'auth' || algorithm.endsWith('-sess');
  const parts = [
    `username=${quoted(input.username)}`,
    `realm=${quoted(challenge.realm)}`,
    `uri=${quoted(input.uri)}`,
    `algorithm=${algorithm}`,
    `nonce=${quoted(challenge.nonce)}`,
    ...(challenge.qop === 'auth' ? [`nc=${nc}`] : []),
    ...(withCnonce ? [`cnonce=${quoted(input.cnonce)}`] : []),
    ...(challenge.qop === 'auth' ? ['qop=auth'] : []),
    `response=${quoted(response)}`,
    ...(challenge.opaque !== undefined ? [`opaque=${quoted(challenge.opaque)}`] : []),
  ];
  return `Digest ${parts.join(', ')}`;
}

/**
 * The last nonce each origin issued, and how many times it has been used. One instance lives for the
 * process — the desktop session, or one CLI run — so a later send to the same origin answers before it
 * is asked; tests pass their own.
 */
export class DigestNonceCache {
  readonly #entries = new Map<string, { challenge: DigestChallenge; nc: number }>();

  /** The challenge to answer next for `origin` and its use count, counted up; none when nothing is cached. */
  next(origin: string): { readonly challenge: DigestChallenge; readonly nc: number } | undefined {
    const entry = this.#entries.get(origin);
    if (entry === undefined) return undefined;
    entry.nc += 1;
    return { challenge: entry.challenge, nc: entry.nc };
  }

  /** Keeps `challenge` for `origin`; its count starts again. */
  remember(origin: string, challenge: DigestChallenge): void {
    this.#entries.set(origin, { challenge, nc: 0 });
  }

  forget(origin: string): void {
    this.#entries.delete(origin);
  }
}
