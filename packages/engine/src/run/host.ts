/**
 * What a host lends the engine for one send (spec §3.1). Only the secret getter is required.
 * Where any other member is absent, the send behaves as the command line's does.
 */
import type { Cookie } from '../http/cookies.js';
import type { ProxyOptions } from '../http/types.js';
import type { Preferences } from '../project/preferences.js';
import type { SelectedBase } from '../protocol/module.js';
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
  readonly events?: {
    onFailed?(item: SelectedBase, failure: SendFailure): void;
    /** A row the host logs that is not the send's result (the WebSocket handshake). */
    onExchange?(item: SelectedBase, exchange: unknown): void;
  };
  readonly cookies?: {
    /** The cookies stored for this request. They are sent only when its `sendCookies` setting is on. */
    cookiesFor(item: SelectedBase): readonly Cookie[] | undefined;
    /** Replaces the stored cookies; an empty list forgets them. */
    remember(item: SelectedBase, cookies: readonly Cookie[]): void;
  };
  /** The response checked against the request's contract. Absent: nothing is checked. */
  readonly contractFor?: (item: SelectedBase, exchange: unknown) => Promise<unknown>;
  /** A webhook item's callback URL, used in place of its target; undefined keeps the target. */
  readonly callbackUrlFor?: (item: SelectedBase) => Promise<string | undefined>;
  // Added later: protoSetFor (Task 10).
}
