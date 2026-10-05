/**
 * The credentials of one send, and what authentication did with them.
 *
 * In `http/auth/` because every protocol's send takes a {@link SendAuth} and a protocol folder
 * imports core and itself, never another protocol (protocol modules spec §7.2).
 */

import type { KerberosSendAuth } from './kerberos-token.js';

/**
 * Credentials for one send, already resolved to plaintext: the desktop app looks a
 * `passwordRef` up in its secret store before calling the engine, so the engine never
 * sees a secret reference (and never persists or logs the password).
 */
export type SendAuth =
  | {
      readonly type: 'basic';
      readonly username: string;
      readonly password: string;
      /** Send the `Authorization` header on the first attempt instead of waiting for a 401. */
      readonly preemptive: boolean;
    }
  | {
      readonly type: 'ntlm';
      readonly username: string;
      readonly password: string;
      readonly domain?: string;
      readonly workstation?: string;
    }
  /** A token in an `Authorization` header. `scheme` defaults to `Bearer`. */
  | { readonly type: 'bearer'; readonly token: string; readonly scheme?: string }
  /** A key in one header or one query parameter. */
  | { readonly type: 'api-key'; readonly name: string; readonly value: string; readonly in: 'header' | 'query' }
  /**
   * An OAuth2 access token the host already obtained. The engine never runs a grant during a send:
   * the token is fetched (and cached, and refreshed) by the host, so a send is one exchange and
   * the browser is never opened behind it. On the wire it is a Bearer token.
   */
  | { readonly type: 'oauth2'; readonly accessToken: string }
  /** Kerberos over Negotiate (#40): the OS ticket, or on Windows an explicit account. */
  | KerberosSendAuth;

/** What authentication actually did during one send, for the UI to explain the exchange. */
export interface AuthSummary {
  readonly scheme: SendAuth['type'];
  /** True when the server answered the first attempt with a 401 challenge. */
  readonly challenged: boolean;
  /**
   * How many HTTP attempts the send made: 1 preemptive/unchallenged, 2 after a Basic
   * challenge, 3 for a full NTLM handshake (bare, Type 1, Type 3).
   */
  readonly attempts: 1 | 2 | 3;
  /** The service principal Kerberos asked for, in the platform's form. Not a secret. */
  readonly spn?: string;
}
