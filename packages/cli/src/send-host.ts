/**
 * What the command line lends a send (spec §3.1): the environment's secrets and proxy, and the cookie
 * jar of the run, call or MCP server the send belongs to (cookie jar spec §4). Nothing persists.
 */
import type { CookieJarHost, GetSecret, IssuedTokenSource, SendHost } from '@wirebench/engine';
import { proxyFromEnv } from './proxy-env.js';

export function cliSendHost(args: {
  readonly getSecret: GetSecret;
  readonly env: NodeJS.ProcessEnv;
  readonly onSecretValue: (value: string) => void;
  /** The in-memory jar REST sends store into and, with Send cookies on, read from. */
  readonly cookies?: CookieJarHost;
  /** The issued-token source the run shares; absent, the engine makes one per run. */
  readonly issuedTokens?: IssuedTokenSource;
}): SendHost {
  const proxyFor = proxyFromEnv(args.env);
  return {
    getSecret: args.getSecret,
    proxyFor: (url) => Promise.resolve(proxyFor(url)),
    onSecretValue: args.onSecretValue,
    ...(args.cookies !== undefined ? { cookies: args.cookies } : {}),
    ...(args.issuedTokens !== undefined ? { issuedTokens: args.issuedTokens } : {}),
  };
}
