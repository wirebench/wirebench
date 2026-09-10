/** The three desktop platforms Wirebench ships on; drives modifier glyphs and key mapping. */
export type Platform = 'mac' | 'win' | 'linux';

/**
 * Detects the host platform from the user agent. Electron's renderer is sandboxed, so
 * `process.platform` is unavailable here and the user agent is the honest signal.
 */
export function detectPlatform(userAgent: string = navigator.userAgent): Platform {
  if (/Mac|iPhone|iPad/i.test(userAgent)) {
    return 'mac';
  }
  if (/Win/i.test(userAgent)) {
    return 'win';
  }
  return 'linux';
}
