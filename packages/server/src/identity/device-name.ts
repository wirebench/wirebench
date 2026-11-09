/**
 * What a browser session's row is called on the user's device list: the browser and the OS its `User-Agent` names
 * at sign-in ("Chrome on macOS"), so two browser sessions can be told apart. A header that names no browser this
 * knows reads {@link BROWSER_DEVICE_NAME}. Only a label: nothing trusts it.
 */

/** What a browser token's row is called when its `User-Agent` says nothing this knows. */
export const BROWSER_DEVICE_NAME = 'Web browser';

/** Longer than any real `User-Agent`; past it the header is not read at all. */
const MAX_USER_AGENT_LENGTH = 1024;

function browserOf(ua: string): string | undefined {
  // Edge and the iOS browsers carry Chrome's and Safari's tokens too, so they are asked first.
  if (/\bEdg(?:e|A|iOS)?\//.test(ua)) return 'Edge';
  if (/\b(?:Firefox|FxiOS)\//.test(ua)) return 'Firefox';
  if (/\b(?:Chrome|CriOS|Chromium)\//.test(ua)) return 'Chrome';
  if (/\bSafari\//.test(ua) && /\bVersion\//.test(ua)) return 'Safari';
  return undefined;
}

function osOf(ua: string): string | undefined {
  // An iPhone's and an Android phone's agents also name Mac OS X and Linux.
  if (/\b(?:iPhone|iPad|iPod)\b/.test(ua)) return 'iOS';
  if (/\bAndroid\b/.test(ua)) return 'Android';
  if (/\b(?:Macintosh|Mac OS X)\b/.test(ua)) return 'macOS';
  if (/\bWindows\b/.test(ua)) return 'Windows';
  if (/\b(?:Linux|X11|CrOS)\b/.test(ua)) return 'Linux';
  return undefined;
}

/** "<Browser> on <OS>", "<Browser>" when the OS is not named, or {@link BROWSER_DEVICE_NAME}. */
export function browserDeviceName(userAgent: string | readonly string[] | undefined): string {
  const ua = typeof userAgent === 'string' ? userAgent : undefined;
  if (ua === undefined || ua.length > MAX_USER_AGENT_LENGTH) return BROWSER_DEVICE_NAME;
  const browser = browserOf(ua);
  if (browser === undefined) return BROWSER_DEVICE_NAME;
  const os = osOf(ua);
  return os === undefined ? browser : `${browser} on ${os}`;
}
