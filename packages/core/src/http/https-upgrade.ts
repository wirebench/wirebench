/**
 * The same-host `http://` → `https://` redirect (#71): the one redirect a send follows whatever its
 * Follow Redirects setting says, and with its method, body and credentials intact.
 *
 * The shape is strict on purpose (see `docs/specs/2026-10-08-https-upgrade-redirect-design.md`): the
 * server is saying "the same request, over TLS", and nothing else qualifies. A changed path is another
 * resource, and a non-default port is another service.
 */

/** 303 is not here: it means "fetch something else with a GET", never "resend this". */
const UPGRADE_STATUSES = new Set([301, 302, 307, 308]);

/**
 * True when a `status` redirect from `from` to `to` (the `Location` resolved against `from`) is an
 * HTTPS upgrade: `http:` on the default port to `https:` on the default port, with the host, user
 * info, path and query unchanged. The fragment never reaches the wire, so it is not compared.
 */
export function isHttpsUpgrade(status: number, from: URL, to: URL): boolean {
  return (
    UPGRADE_STATUSES.has(status) &&
    upgradedOrigin(from) !== undefined &&
    to.protocol === 'https:' &&
    to.port === '' &&
    to.hostname === from.hostname &&
    to.username === from.username &&
    to.password === from.password &&
    to.pathname === from.pathname &&
    to.search === from.search
  );
}

/**
 * The origin an HTTPS upgrade of `url` lands on — `https://` and the same host — or `undefined` when
 * `url` is not an `http:` URL on the default port and so cannot be upgraded.
 */
export function upgradedOrigin(url: URL): string | undefined {
  return url.protocol === 'http:' && url.port === '' ? `https://${url.hostname}` : undefined;
}

/**
 * The upgrade a send's redirect trail went through, as `from` → `to` URLs, or `undefined` when it went
 * through none. `to` is the hop after it: the next redirect's URL, or the exchange's own.
 */
export function upgradeIn(
  redirects: readonly { readonly url: string; readonly upgrade?: true }[],
  finalUrl: string,
): { readonly from: string; readonly to: string } | undefined {
  const index = redirects.findIndex((hop) => hop.upgrade === true);
  const hop = redirects[index];
  return hop === undefined ? undefined : { from: hop.url, to: redirects[index + 1]?.url ?? finalUrl };
}
