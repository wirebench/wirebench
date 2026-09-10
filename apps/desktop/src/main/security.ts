/**
 * Pure security-policy constants and checks for the main process. Kept free of any
 * `electron` import so they can be unit-tested (including snapshotted) without loading
 * Electron itself.
 */

/**
 * `BrowserWindow` `webPreferences` shared by every window, minus the per-window `preload`
 * path. Sandboxed, isolated, no Node integration, no insecure content — the hardened
 * baseline every Wirebench window must use.
 */
export const MAIN_WINDOW_WEB_PREFERENCES = {
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
} as const;

/**
 * Content-Security-Policy applied both via the `onHeadersReceived` response header and as
 * a `<meta http-equiv>` tag in the renderer's `index.html` (for the electron-vite dev
 * server, which serves the page directly). `style-src 'unsafe-inline'` is required for
 * Monaco's inline styles (Task 12/15); everything else stays same-origin only.
 */
export const CONTENT_SECURITY_POLICY = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:";

/** Protocols that `setWindowOpenHandler` / navigation may hand off to the OS browser. */
const ALLOWED_EXTERNAL_URL_PATTERN = /^https?:\/\//;

/**
 * Whether `url` may be opened in the user's default browser via `shell.openExternal`.
 * Only `http:`/`https:` are allowed; `file:`, `javascript:`, `mailto:`, and anything else
 * is rejected to prevent local-file disclosure or scheme-handler abuse.
 */
export function isExternalUrlAllowed(url: string): boolean {
  return ALLOWED_EXTERNAL_URL_PATTERN.test(url);
}
