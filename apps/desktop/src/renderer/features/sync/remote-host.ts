/**
 * The host part of a sync remote URL, for any UI that must never show the full URL: `https://`
 * and `ssh://` remotes are parsed with `URL`; a scp-like `git@host:path` remote is matched by
 * hand, since `URL` does not accept that syntax. Anything else (or no remote at all) yields
 * `undefined`, and the caller falls back to a host-less message.
 *
 * Shared by the sync banner's pulled notice and the workspace picker's share glyph, so the one
 * rule "never echo the URL" lives in exactly one place.
 */
export function remoteHost(remote: string | undefined): string | undefined {
  if (remote === undefined) {
    return undefined;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(remote)) {
    try {
      const host = new URL(remote).host;
      return host === '' ? undefined : host;
    } catch {
      return undefined;
    }
  }
  const scpMatch = /^[^@/\s]+@([^:/\s]+):/.exec(remote);
  return scpMatch?.[1];
}
