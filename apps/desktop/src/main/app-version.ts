import { app } from 'electron';
import { version as manifestVersion } from '../../package.json' with { type: 'json' };

/**
 * The version to show the user — in the status bar, the About panel and the update prompt.
 *
 * A packaged bundle carries its own `package.json`, so Electron's `app.getVersion()` is
 * authoritative there. An unpackaged run is launched as `out/main/index.js`, whose directory
 * holds no manifest: Electron then falls back to the bundle's own version and reports `0.0`,
 * which the status bar duly rendered as `v0.0`. The manifest this module is compiled against
 * is the same file electron-builder stamps into the bundle, so using it off the packaged path
 * shows the real version in development and in the e2e runs without changing what a shipped
 * build reports. Same reasoning as the `app.setName('Wirebench')` call in `index.ts`.
 */
export function appVersion(): string {
  return app.isPackaged ? app.getVersion() : manifestVersion;
}
