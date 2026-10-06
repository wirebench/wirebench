/**
 * One WS-Trust Issue round trip: build the RST, send it (no redirects — credentials never travel
 * to a second host), read the RSTR. The caller caches; this never does.
 */
import { WssError } from '../../errors.js';
import { sendHttp } from '../../http/client.js';
import { selectAlias } from '../../keystore/index.js';
import { buildRst } from './rst.js';
import { parseRstr } from './rstr.js';
import type { HttpExchange, HttpRequest, ProxyOptions, TlsOptions } from '../../http/types.js';
import type { IssuedToken, WssContext, WssIssuedTokenEntry } from '../model.js';

export interface IssuedTokenTarget {
  /** The request's endpoint: the default AppliesTo. */
  readonly endpointUrl: string;
  readonly expand: (text: string) => string;
  /** Mutual TLS to the STS: the caller builds it from `entry.tlsKeystoreRef`, never from the endpoint's own TLS. */
  readonly tls?: TlsOptions;
  readonly proxy?: (url: string) => Promise<ProxyOptions | undefined>;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /**
   * The connection half (`tls`, `proxy`, `timeoutMs`, `signal`) built on demand: asked for only
   * when the token service is contacted, so a cached token never loads the entry's keystore. Its
   * answer stands in for those four fields; the key fields (`endpointUrl`, `expand`) stay as given.
   */
  readonly connection?: () => Promise<Omit<IssuedTokenTarget, 'endpointUrl' | 'expand' | 'connection'>>;
}

export type KerberosTokenFn = (
  spn: string,
  credentials: {
    readonly principal?: string;
    readonly username?: string;
    readonly domain?: string;
    readonly password?: string;
  },
) => Promise<Uint8Array>;

export interface TrustDeps {
  readonly ctx: WssContext;
  readonly send?: (request: HttpRequest) => Promise<HttpExchange>;
  /** #40's seam, for a Kerberos credential (Task 19). Absent: such a credential refuses. */
  readonly kerberosToken?: KerberosTokenFn;
  /** Told about the exchange with the STS, for the host's log. */
  readonly onExchange?: (exchange: HttpExchange) => void;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** The proof certificate a public-key request sends in `UseKey`; undefined for bearer. */
export async function proofCertOf(entry: WssIssuedTokenEntry, ctx: WssContext): Promise<string | undefined> {
  if (entry.keyType !== 'public-key') return undefined;
  if (entry.proofKeystoreRef === undefined || entry.proofKeystoreRef === '') {
    throw new WssError('wss-proof-key-missing', 'A public-key token needs a proof certificate.');
  }
  const keystore = await ctx.keystores(entry.proofKeystoreRef);
  if (keystore === undefined) {
    throw new WssError('wss-keystore-missing', 'The keystore this entry needs is not available.', {
      details: { keystoreRef: entry.proofKeystoreRef },
    });
  }
  return selectAlias(keystore, entry.proofAlias).certPem;
}

/** The target's connection half: built now when the target defers it, else its own fields. */
async function connectionOf(target: IssuedTokenTarget): Promise<IssuedTokenTarget> {
  if (target.connection === undefined) return target;
  const built = await target.connection();
  return {
    endpointUrl: target.endpointUrl,
    expand: target.expand,
    ...(built.tls !== undefined ? { tls: built.tls } : {}),
    ...(built.proxy !== undefined ? { proxy: built.proxy } : {}),
    ...(built.timeoutMs !== undefined ? { timeoutMs: built.timeoutMs } : {}),
    ...(built.signal !== undefined ? { signal: built.signal } : {}),
  };
}

/** @throws WssError `ws-trust-*`, `wss-*`, `kerberos-unavailable`, or the transport's own error */
export async function requestIssuedToken(
  entry: WssIssuedTokenEntry,
  target: IssuedTokenTarget,
  deps: TrustDeps,
): Promise<IssuedToken> {
  const stsUrl = target.expand(entry.stsUrl);
  const appliesTo =
    entry.appliesTo !== undefined && entry.appliesTo !== '' ? target.expand(entry.appliesTo) : target.endpointUrl;
  const proofCertPem = await proofCertOf(entry, deps.ctx);
  let kerberosToken: Uint8Array | undefined;
  if (entry.credential.kind === 'kerberos') {
    if (deps.kerberosToken === undefined) {
      throw new WssError('kerberos-unavailable', 'Kerberos is not available in this build.');
    }
    const { spn, principal, username, domain, passwordRef } = entry.credential;
    const password = passwordRef === undefined ? undefined : await deps.ctx.secrets(passwordRef);
    kerberosToken = await deps.kerberosToken(spn, {
      ...(principal !== undefined ? { principal } : {}),
      ...(username !== undefined ? { username } : {}),
      ...(domain !== undefined ? { domain } : {}),
      ...(password !== undefined ? { password } : {}),
    });
  }
  const rst = await buildRst(entry, {
    stsUrl,
    appliesTo,
    ...(entry.claims !== undefined ? { claims: target.expand(entry.claims) } : {}),
    ctx: deps.ctx,
    ...(proofCertPem !== undefined ? { proofCertPem } : {}),
    ...(kerberosToken !== undefined ? { kerberosToken } : {}),
  });
  const connected = await connectionOf(target);
  const proxy = await connected.proxy?.(stsUrl);
  const send = deps.send ?? sendHttp;
  const exchange = await send({
    url: stsUrl,
    method: 'POST',
    headers: {
      'content-type': rst.contentType,
      ...(entry.soapVersion === '1.1' ? { soapaction: `"${rst.action}"` } : {}),
    },
    body: new TextEncoder().encode(rst.xml),
    timeoutMs: connected.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    followRedirects: false,
    ...(connected.tls !== undefined ? { tls: connected.tls } : {}),
    ...(proxy !== undefined ? { proxy } : {}),
    ...(connected.signal !== undefined ? { signal: connected.signal } : {}),
  });
  deps.onExchange?.(exchange);
  if (exchange.status >= 300 && exchange.status < 400) {
    throw new WssError(
      'ws-trust-sts-fault',
      `The token service redirected (${String(exchange.status)}); redirects are not followed.`,
      { details: { status: exchange.status } },
    );
  }
  const parsed = parseRstr(new TextDecoder().decode(exchange.body), exchange.status);
  return {
    ...parsed,
    keyType: entry.keyType,
    stsHost: new URL(stsUrl).hostname,
    cacheKey: '',
    ...(proofCertPem !== undefined ? { proofCertPem } : {}),
  };
}
