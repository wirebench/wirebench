/**
 * What a host lends SOAP sends beyond the core `SendHost`: the issued SAML token source. Core keeps
 * it in `SendHost.protocols.soap`, an entry it never reads, so `run/` names no protocol (ADR-0017).
 */
import type { RunContext } from '../run/context.js';
import type { SendHost } from '../run/host.js';
import { createIssuedTokenSource } from '../wss/trust/issued-token.js';
import type { IssuedTokenSource } from '../wss/trust/issued-token.js';
import type { IssuedToken } from '../wss/model.js';
import type { SoapFault } from './fault.js';

/** A host's SOAP entry: `host.protocols.soap`. */
export interface SoapSendHost {
  /** Issued SAML tokens; a run creates one per run when the host brings none. */
  readonly issuedTokens?: IssuedTokenSource;
}

/** The host's SOAP entry, or undefined when it lends none. */
export function soapHostOf(host: SendHost): SoapSendHost | undefined {
  return host.protocols?.['soap'] as SoapSendHost | undefined;
}

/** `host` with its SOAP entry replaced by `soap`; every other protocol's entry is kept. */
export function withSoapHost(host: SendHost, soap: SoapSendHost): SendHost {
  return { ...host, protocols: { ...host.protocols, soap } };
}

/** The send's issued-token source: the host's, the run's shared one, or a fresh one outside a run. */
export function issuedTokenSourceOf(context: RunContext): IssuedTokenSource {
  return (
    soapHostOf(context.host)?.issuedTokens ??
    createIssuedTokenSource(
      context.host.onSecretValue !== undefined ? { onSecretValue: context.host.onSecretValue } : {},
    )
  );
}

/** WS-Security fault codes that mean a token was refused (spec section 3.5). */
const TOKEN_REFUSED = /(?:^|:)(?:InvalidSecurityToken|FailedAuthentication|SecurityTokenUnavailable|MessageExpired)$/;

/** Drops the issued tokens a refused send carried, so the next send fetches anew. Never re-sends. */
export function dropRejectedIssuedToken(
  context: RunContext,
  used: readonly IssuedToken[],
  fault: SoapFault | undefined,
): void {
  // Without a source the host lends (or the run shares), a token lived in a throwaway source that
  // nothing will ask again: there is nothing to drop.
  const source = soapHostOf(context.host)?.issuedTokens;
  if (source === undefined || fault === undefined || used.length === 0) return;
  // Matched lexically: SoapFault keeps only a code's lexical QName, so `wsse:` is whatever prefix the
  // service bound, and the local name is what is compared.
  if (![fault.code, ...fault.subcodes].some((code) => TOKEN_REFUSED.test(code))) return;
  for (const token of used) source.reject(token);
}
