/**
 * What a host lends the engine for one send (spec §3.1). Only the secret getter is required.
 * Where any other member is absent, the send behaves as the command line's does.
 */
import type { ProxyOptions } from '../http/types.js';
import type { Preferences } from '../project/preferences.js';
import type { GetSecret } from '../secrets/resolve.js';
import type { RunTokenSource } from './oauth2-token.js';

export interface ClientIdentity {
  readonly cert: string;
  readonly key: string;
}

export interface AttemptedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface SendFailure {
  readonly stage: 'prepare' | 'send';
  readonly error: unknown;
  /** `Date.now()` when the send began. */
  readonly startedAt: number;
  readonly durationMs: number;
  /** What was about to go, or went, on the wire; absent when resolution itself failed. */
  readonly attempted?: AttemptedRequest;
}

export interface SendHost {
  readonly getSecret: GetSecret;
  /** Told every OAuth2 access token the send obtains, so the host can mask it in all it prints. */
  readonly onSecretValue?: (value: string) => void;
  readonly proxyFor?: (url: string) => Promise<ProxyOptions | undefined>;
  readonly tls?: {
    /** Added to every TLS connection's trust: the system roots, a CA bundle, test anchors. */
    readonly anchors?: readonly string[];
    /** A request's keystore, or the host's default identity when the request names none. */
    identityFor?(keystoreId: string | undefined): Promise<ClientIdentity | undefined>;
  };
  /** The OAuth2 token source; a run creates one per run when the host brings none. */
  readonly tokens?: RunTokenSource;
  readonly preferences?: Preferences;
  // Added later: events (Task 2), cookies, contractFor, callbackUrlFor (Task 6), protoSetFor (Task 10).
}
