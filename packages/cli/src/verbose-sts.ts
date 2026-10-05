/**
 * `--verbose`'s line per security token request (#41): the token service's host, the status when
 * it was asked, and how long the token lives. Nothing else — no URL path, no token, no claim.
 */
import type { IssuedTokenSource } from '@wirebench/engine';

/** UTC, as the CLI's other timestamps are; a token with no lifetime is used once. */
function validity(date: Date | undefined): string {
  return date === undefined ? 'single use' : `valid until ${date.toISOString().slice(11, 16)}`;
}

/** Wraps `source` so each `get` reports one line: fetched (with the STS's status) or cached. */
export function verboseIssuedTokens(source: IssuedTokenSource, log: (line: string) => void): IssuedTokenSource {
  return {
    ...source,
    get: async (entry, target, deps) => {
      let status: number | undefined;
      const token = await source.get(entry, target, {
        ...deps,
        onExchange: (exchange) => {
          status = exchange.status;
          deps.onExchange?.(exchange);
        },
      });
      log(
        status === undefined
          ? `STS ${token.stsHost} cached, ${validity(token.expiresAt)}`
          : `STS ${token.stsHost} ${String(status)} fetched, ${validity(token.expiresAt)}`,
      );
      return token;
    },
  };
}
