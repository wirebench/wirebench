/**
 * The values of the headers a send adds on the request's behalf when the preferences ask for them:
 * the default `User-Agent` and the `Accept-Encoding` each protocol advertises.
 *
 * Pure and browser-safe, so the Settings hints in the renderer name exactly what the send adds.
 */

/** The product token every default `User-Agent` starts with. */
const USER_AGENT_PRODUCT = 'Wirebench';

/**
 * A default `User-Agent`, as this release or an earlier one wrote it into the preferences: the
 * product alone, or the product and a version (`Wirebench/0.1` up to 6.1, `Wirebench/6.1.0` since).
 */
const DEFAULT_USER_AGENT = /^Wirebench(?:\/\d+(?:\.\d+){1,2}(?:-[0-9A-Za-z.-]+)?)?$/;

/**
 * The `User-Agent` sent when the user has not written their own: `Wirebench/<version>` for a host
 * that knows its version (the desktop app), just `Wirebench` for one that does not.
 */
export function defaultUserAgent(version?: string): string {
  return version === undefined || version === '' ? USER_AGENT_PRODUCT : `${USER_AGENT_PRODUCT}/${version}`;
}

/**
 * Whether `userAgent` is a default rather than one the user wrote, so a host can move it to its own
 * version instead of sending the version that happened to be current when the file was saved.
 */
export function isDefaultUserAgent(userAgent: string): boolean {
  return DEFAULT_USER_AGENT.test(userAgent);
}

/** The `Accept-Encoding` a REST request advertises: everything the response decoding handles. */
export const REST_ACCEPT_ENCODING = 'gzip, deflate, br';

/** The `Accept-Encoding` a SOAP request advertises. */
export const SOAP_ACCEPT_ENCODING = 'gzip, deflate';
