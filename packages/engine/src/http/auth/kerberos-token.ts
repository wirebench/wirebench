/**
 * The one seam every Kerberos caller goes through: HTTP Negotiate (`kerberos-transport.ts`), the
 * preemptive WebSocket, gRPC and definition-fetch paths (`negotiateBearer`), and WS-Trust's STS
 * request (#41, `kerberosToken`). The rules live here once: availability, Windows-only explicit
 * credentials, SPN form and error mapping; mechanism and flags are fixed in `kerberos-native.ts`.
 *
 * The token is the GSS-API initial context token for Kerberos v5 (RFC 4121 framing around an
 * AP-REQ): what a `Negotiate` header carries for a Kerberos-only client, and what WS-Security's
 * `#GSS_Kerberosv5_AP_REQ` value type names.
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

export interface KerberosOptions {
  /** Overrides the process-wide provider (`configureKerberos`). */
  readonly provider?: KerberosProvider;
  readonly platform?: NodeJS.Platform;
}

export interface KerberosContext {
  readonly token: Uint8Array;
  /** The SPN actually asked for, in the platform's form. */
  readonly spn: string;
  /** Feeds the acceptor's reply token; throws `kerberos-mutual-auth-failed` when it does not verify. */
  verify(replyToken: Uint8Array): Promise<void>;
}

/** `HTTP/host`, `HTTP@host` or a bare host, in the form this platform's API wants. */
export function normaliseSpn(spn: string, platform: NodeJS.Platform): string {
  const trimmed = spn.trim();
  const match = /^([^/@]+)[/@](.+)$/.exec(trimmed);
  const service = match?.[1] ?? 'HTTP';
  const host = match?.[2] ?? trimmed;
  return platform === 'win32' ? `${service}/${host}` : `${service}@${host}`;
}

/** `HTTP` plus the URL's hostname, without the port: what Windows asks for by default. */
export function defaultSpn(url: string): string {
  return `HTTP@${new URL(url).hostname}`;
}

export async function startKerberosContext(
  spn: string,
  credentials: KerberosCredentials,
  options: KerberosOptions = {},
): Promise<KerberosContext> {
  const platform = options.platform ?? process.platform;
  const provider = options.provider ?? kerberosProvider();
  const target = normaliseSpn(spn, platform);

  if (platform !== 'win32' && (credentials.username !== undefined || credentials.password !== undefined)) {
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
    const client = await provider.initClient({
      spn: target,
      ...(credentials.principal !== undefined && platform !== 'win32' ? { principal: credentials.principal } : {}),
      ...(credentials.username !== undefined ? { user: credentials.username } : {}),
      ...(credentials.domain !== undefined ? { domain: credentials.domain } : {}),
      ...(credentials.password !== undefined ? { password: credentials.password } : {}),
    });
    const first = await client.step('');
    return {
      token: Buffer.from(first, 'base64'),
      spn: target,
      async verify(replyToken) {
        try {
          await client.step(Buffer.from(replyToken).toString('base64'));
        } catch (error) {
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
  const token = await kerberosToken(auth.spn ?? defaultSpn(url), auth, options);
  return { type: 'bearer', scheme: 'Negotiate', token: Buffer.from(token).toString('base64') };
}

const KNOWN: readonly (readonly [RegExp, string, (spn: string) => string])[] = [
  [
    /no kerberos credentials|SEC_E_NO_CREDENTIALS|credentials cache/i,
    'kerberos-no-credentials',
    () => 'No Kerberos ticket. Sign in to the domain, or run `kinit`.',
  ],
  [
    /not found in kerberos database|S_PRINCIPAL_UNKNOWN|SEC_E_TARGET_UNKNOWN/i,
    'kerberos-unknown-spn',
    (spn) => `The KDC does not know ${spn}. Set the SPN to the name the service is registered under.`,
  ],
  [
    /clock skew|TIME_SKEW|AP_ERR_SKEW/i,
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
