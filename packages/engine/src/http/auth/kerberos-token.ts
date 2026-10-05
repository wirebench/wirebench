/**
 * The one seam every Kerberos caller goes through: HTTP Negotiate (`kerberos-transport.ts`), the
 * preemptive WebSocket, gRPC and definition-fetch paths (`negotiateBearer`), and WS-Trust's STS
 * request (#41, `kerberosToken`). The rules live here once: availability, Windows-only explicit
 * credentials, SPN form and error mapping; mechanism and flags are fixed in `kerberos-native.ts`.
 *
 * The token is the GSS-API initial context token for Kerberos v5 (RFC 4121 framing around an
 * AP-REQ): what a `Negotiate` header carries for a Kerberos-only client, and what WS-Security's
 * `#GSS_Kerberosv5_AP_REQ` value type names. A caller's `signal` and `timeoutMs` bound every wait on the
 * KDC (#267).
 */

import { HttpError } from '../../errors.js';
import { kerberosProvider, type KerberosProvider } from './kerberos-native.js';

export interface KerberosCredentials {
  /** GSSAPI only: pick this principal's ticket from the cache. */
  readonly principal?: string;
  /** Windows only. */
  readonly username?: string;
  /** Windows only. */
  readonly domain?: string;
  /** Windows only; already resolved from a reference by the host. */
  readonly password?: string;
}

export type KerberosSendAuth = { readonly type: 'kerberos'; readonly spn?: string } & KerberosCredentials;

/** What bounds one wait on the KDC or SSPI (#267). Neither set: no limit, as before. */
export interface KerberosWait {
  /** Aborts the wait: the call rejects with `aborted` at once; the native call is abandoned. */
  readonly signal?: AbortSignal;
  /** The most the wait may take, in milliseconds, from the call. */
  readonly timeoutMs?: number;
}

export interface KerberosOptions extends KerberosWait {
  /** Overrides the process-wide provider (`configureKerberos`). */
  readonly provider?: KerberosProvider;
  readonly platform?: NodeJS.Platform;
}

export interface KerberosContext {
  readonly token: Uint8Array;
  /** The SPN actually asked for, in the platform's form. */
  readonly spn: string;
  /** Feeds the acceptor's reply token; throws `kerberos-mutual-auth-failed` when it does not verify. */
  verify(replyToken: Uint8Array, wait?: KerberosWait): Promise<void>;
}

/** A Kerberos field as set or not: a blank or whitespace-only value counts as unset. */
export function kerberosField(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value;
}

/**
 * `HTTP/host`, `HTTP@host` or a bare host, in the form this platform's API wants. GSSAPI's
 * host-based name has no realm, so off Windows `HTTP/host@REALM` loses its `@REALM`.
 */
export function normaliseSpn(spn: string, platform: NodeJS.Platform): string {
  const trimmed = spn.trim();
  const match = /^([^/@]+)[/@](.+)$/.exec(trimmed);
  const service = match?.[1] ?? 'HTTP';
  const host = match?.[2] ?? trimmed;
  if (platform === 'win32') return `${service}/${host}`;
  const withRealm = trimmed.includes('/') ? /^([^@]+)@[^@]*$/.exec(host) : null;
  return `${service}@${withRealm?.[1] ?? host}`;
}

/** `HTTP` plus the URL's hostname, without the port: what Windows asks for by default. */
export function defaultSpn(url: string): string {
  try {
    return `HTTP@${new URL(url).hostname}`;
  } catch (error) {
    throw new HttpError(
      'kerberos-unknown-spn',
      `Cannot derive a Kerberos service principal from ${url}; set one explicitly.`,
      { cause: error, details: { url } },
    );
  }
}

/** Abandoned native calls still running, per provider; a GSSAPI or SSPI call cannot be cancelled. */
const abandoned = new WeakMap<KerberosProvider, number>();
/** Leaves at least two of libuv's four threads for file, DNS and crypto work (#267, D4). */
const MAX_ABANDONED = 2;
/** `setTimeout`'s ceiling; a longer delay would fire at once. */
const MAX_TIMER_MS = 2_147_483_647;

function waitTimedOut(spn: string): HttpError {
  return new HttpError('timeout', `Timed out waiting for a Kerberos ticket for ${spn}.`, {
    details: { spn, stage: 'kerberos' },
  });
}

function waitAborted(spn: string): HttpError {
  return new HttpError('aborted', 'The request was aborted.', { details: { spn, stage: 'kerberos' } });
}

/**
 * Runs one native call within `wait`. A call that loses to the timer or the signal is abandoned: its
 * late result is dropped, and it counts against the cap until it settles.
 */
function bounded<T>(provider: KerberosProvider, spn: string, call: () => Promise<T>, wait: KerberosWait): Promise<T> {
  if (wait.signal?.aborted === true) return Promise.reject(waitAborted(spn));
  if (wait.timeoutMs !== undefined && wait.timeoutMs <= 0) return Promise.reject(waitTimedOut(spn));
  const stuck = abandoned.get(provider) ?? 0;
  if (stuck >= MAX_ABANDONED) {
    return Promise.reject(
      new HttpError(
        'kerberos-failed',
        'Kerberos is still waiting on earlier requests to the Kerberos server; try again shortly.',
        { details: { spn, abandoned: stuck } },
      ),
    );
  }
  const work = call();
  if (wait.signal === undefined && wait.timeoutMs === undefined) return work;
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      wait.signal?.removeEventListener('abort', onAbort);
    };
    const abandon = (error: HttpError): void => {
      cleanup();
      abandoned.set(provider, (abandoned.get(provider) ?? 0) + 1);
      const ended = (): void => {
        const left = (abandoned.get(provider) ?? 1) - 1;
        if (left <= 0) abandoned.delete(provider);
        else abandoned.set(provider, left);
      };
      work.then(ended, ended);
      reject(error);
    };
    const onAbort = (): void => abandon(waitAborted(spn));
    if (wait.timeoutMs !== undefined) {
      timer = setTimeout(() => abandon(waitTimedOut(spn)), Math.min(wait.timeoutMs, MAX_TIMER_MS));
    }
    wait.signal?.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function waitOf(source: KerberosWait | undefined): KerberosWait {
  return {
    ...(source?.signal !== undefined ? { signal: source.signal } : {}),
    ...(source?.timeoutMs !== undefined ? { timeoutMs: source.timeoutMs } : {}),
  };
}

export async function startKerberosContext(
  spn: string,
  credentials: KerberosCredentials,
  options: KerberosOptions = {},
): Promise<KerberosContext> {
  const platform = options.platform ?? process.platform;
  if (kerberosField(spn) === undefined) {
    throw new HttpError('kerberos-unknown-spn', 'A Kerberos service principal is blank; set one, or leave it unset.', {
      details: { spn },
    });
  }
  const provider = options.provider ?? kerberosProvider();
  const target = normaliseSpn(spn, platform);
  const principal = kerberosField(credentials.principal);
  const username = kerberosField(credentials.username);
  const domain = kerberosField(credentials.domain);
  const password = kerberosField(credentials.password);

  if (platform !== 'win32' && (username !== undefined || password !== undefined)) {
    throw new HttpError(
      'kerberos-explicit-credentials-unsupported',
      'Explicit Kerberos credentials are Windows-only. Run `kinit user@REALM` and leave username and password empty.',
      { details: { spn: target } },
    );
  }
  const availability = provider.availability();
  if (!availability.available) {
    throw new HttpError('kerberos-unavailable', availability.reason, { details: { spn: target } });
  }

  try {
    // One limit for init and the first step together: both wait on the KDC.
    const { client, first } = await bounded(
      provider,
      target,
      async () => {
        const client = await provider.initClient({
          spn: target,
          ...(principal !== undefined && platform !== 'win32' ? { principal } : {}),
          ...(username !== undefined ? { user: username } : {}),
          ...(domain !== undefined ? { domain } : {}),
          ...(password !== undefined ? { password } : {}),
        });
        return { client, first: await client.step('') };
      },
      waitOf(options),
    );
    return {
      token: Buffer.from(first, 'base64'),
      spn: target,
      async verify(replyToken, wait) {
        try {
          await bounded(provider, target, () => client.step(Buffer.from(replyToken).toString('base64')), waitOf(wait));
        } catch (error) {
          if (error instanceof HttpError) throw error;
          throw new HttpError(
            'kerberos-mutual-auth-failed',
            `The server's Kerberos reply could not be verified (${target}).`,
            {
              cause: error,
              details: { spn: target, osMessage: messageOf(error) },
            },
          );
        }
      },
    };
  } catch (error) {
    throw kerberosError(error, target);
  }
}

export async function kerberosToken(
  spn: string,
  credentials: KerberosCredentials,
  options?: KerberosOptions,
): Promise<Uint8Array> {
  return (await startKerberosContext(spn, credentials, options)).token;
}

/** One preemptive token as a bearer credential, for the paths whose header builders are synchronous. */
export async function negotiateBearer(
  auth: KerberosSendAuth,
  url: string,
  options?: KerberosOptions,
): Promise<{ readonly type: 'bearer'; readonly scheme: 'Negotiate'; readonly token: string }> {
  const token = await kerberosToken(kerberosField(auth.spn) ?? defaultSpn(url), auth, options);
  return { type: 'bearer', scheme: 'Negotiate', token: Buffer.from(token).toString('base64') };
}

export type NegotiateBearer = { readonly type: 'bearer'; readonly scheme: 'Negotiate'; readonly token: string };

/** The credential for a one-request path: Kerberos becomes a preemptive Negotiate bearer; the rest pass. */
export async function withNegotiate<T extends { readonly type: string }>(
  auth: T | undefined,
  url: string,
  options?: KerberosOptions,
): Promise<T | NegotiateBearer | undefined> {
  return auth?.type === 'kerberos' ? negotiateBearer(auth as unknown as KerberosSendAuth, url, options) : auth;
}

/**
 * GSSAPI texts (MIT and Heimdal) and the Windows binding's, which is "InitializeSecurityContext: "
 * plus the English FormatMessage text, not the symbolic SEC_E_* name. A localised Windows falls
 * through to kerberos-failed, which still carries the OS text.
 */
const KNOWN: readonly (readonly [RegExp, string, (spn: string) => string])[] = [
  [
    /no kerberos credentials|no credentials were supplied|no credentials are available|SEC_E_NO_CREDENTIALS|credentials cache/i,
    'kerberos-no-credentials',
    () => 'No Kerberos ticket. Sign in to the domain, or run `kinit`.',
  ],
  [
    /not found in kerberos database|target is unknown or unreachable|target principal name is incorrect|S_PRINCIPAL_UNKNOWN|SEC_E_TARGET_UNKNOWN/i,
    'kerberos-unknown-spn',
    (spn) => `The KDC does not know ${spn}. Set the SPN to the name the service is registered under.`,
  ],
  [
    /clock skew|clocks on the client and server machines are skewed|TIME_SKEW|AP_ERR_SKEW/i,
    'kerberos-clock-skew',
    () => "This machine's clock differs from the domain's by more than allowed.",
  ],
];

/** An OS failure as one of the named codes; an HttpError passes through. */
export function kerberosError(error: unknown, spn: string): HttpError {
  if (error instanceof HttpError) return error;
  const osMessage = messageOf(error);
  for (const [pattern, code, message] of KNOWN) {
    if (pattern.test(osMessage))
      return new HttpError(code, message(spn), { cause: error, details: { spn, osMessage } });
  }
  return new HttpError('kerberos-failed', `Kerberos failed for ${spn}: ${osMessage}`, {
    cause: error,
    details: { spn, osMessage },
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
