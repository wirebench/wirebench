/**
 * Inline rules for the Settings page's free-text rows. Deliberately few: a field is refused only
 * when what was typed cannot work where it goes, never to police style.
 */

const HOST_ONLY = 'Host name or IP only — set the port below';

/**
 * A proxy host: a name or an IP address, nothing more. A scheme, a path, a space, credentials or
 * a `:port` all have their own place (the port and username rows) or no place at all. IPv6
 * literals keep their colons, bare (`::1`) or bracketed (`[::1]`).
 */
export function proxyHostProblem(value: string): string | undefined {
  if (value.length === 0) {
    return undefined;
  }
  if (/^\[[0-9A-Fa-f:.]+(%[\w.-]+)?\]$/.test(value)) {
    return undefined;
  }
  if (!/^[A-Za-z0-9._%:-]+$/.test(value)) {
    return HOST_ONLY; // scheme (`://`), path, space, `@`, …
  }
  const colons = value.split(':').length - 1;
  // One colon is `host:port`; an IPv6 address has at least two.
  return colons === 1 ? HOST_ONLY : undefined;
}

/**
 * A value sent as an HTTP header (User-Agent, Accept): no control characters or line breaks,
 * which would corrupt the request or smuggle a second header. A tab is a legal header character.
 */
export function headerValueProblem(value: string): string | undefined {
  return /[\u0000-\u0008\u000a-\u001f\u007f]/.test(value)
    ? 'Control characters and line breaks are not allowed in a header value'
    : undefined;
}
