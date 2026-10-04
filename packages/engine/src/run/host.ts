/**
 * What a host lends the engine for one send (spec §3.1). Only the secret getter is required.
 * Where any other member is absent, the send behaves as the command line's does.
 */
import type { CookieJarHost } from '../http/cookies.js';
import type { ProxyOptions } from '../http/types.js';
import type { Keystore } from '../keystore/index.js';
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
  /** `Date.now()` when the failed stage began: the prepare stage, or the send stage after it. */
  readonly startedAt: number;
  /**
   * How long the failed stage ran. A send-stage failure counts the send stage's own time only, never
   * resolve, a script, a token fetch or a proxy lookup; a host's History records it as the duration.
   */
  readonly durationMs: number;
  /**
   * What was about to go, or went, on the wire; absent when resolution itself failed. It can hold
   * live values — a `${secret:…}` expanded into a header or a metadata row — so a host redacts it
   * before it is shown or logged.
   */
  readonly attempted?: AttemptedRequest;
  /**
   * The protocol's input at the stage that failed, for a host that records the send whole. It holds
   * live credentials — resolved auth, a signing secret, a proxy password, TLS keys — so a host reads
   * only what it records and never logs or serialises it.
   */
  readonly input?: unknown;
  /**
   * What the protocol recorded of an exchange that failed part way, for a host that records the
   * attempt whole: a session cancelled before it opened keeps its transcript. Redacted as `input` is.
   */
  readonly exchange?: unknown;
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
  /**
   * A WS-Security keystore by its project entry id, for signing, encryption, response verification
   * and decryption alike; undefined when the project has no such entry. The app lends its own
   * loader, which also reads a file its user picked this session; absent, a keystore is read from
   * inside the project folder only.
   */
  readonly keystoreFor?: (keystoreId: string) => Promise<Keystore | undefined>;
  /** The OAuth2 token source; a run creates one per run when the host brings none. */
  readonly tokens?: RunTokenSource;
  readonly preferences?: Preferences;
  readonly events?: {
    onFailed?(item: SelectedBase, failure: SendFailure): void;
    /** A row the host logs that is not the send's result (the WebSocket handshake). */
    onExchange?(item: SelectedBase, exchange: unknown): void;
  };
  /**
   * The cookie jar (cookie jar spec §1.4): every REST send stores what each response sets, redirect
   * hops included, and a request whose `sendCookies` setting is on carries what matches each hop's
   * URL. Absent: nothing is stored or sent.
   */
  readonly cookies?: CookieJarHost;
  /** The response checked against the request's contract. Absent: nothing is checked.
   * A rejection means nothing was checked: the send still succeeds, without a contract.
   * `sent` is the protocol's input as it went out, which the operation is looked up from. */
  readonly contractFor?: (item: SelectedBase, exchange: unknown, sent?: unknown) => Promise<unknown>;
  /** A webhook item's callback URL, used in place of its target; undefined keeps the target. */
  readonly callbackUrlFor?: (item: SelectedBase) => Promise<string | undefined>;
  /** An API's schema (a ProtoSet; the gRPC module narrows it), in place of the definition cache. */
  readonly protoSetFor?: (item: SelectedBase) => Promise<unknown>;
}
