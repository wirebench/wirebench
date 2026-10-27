/**
 * The Electron shell's embedding surface. The agent and the server use only the package root.
 *
 * Each export is something the desktop app's Electron code (`apps/desktop/src/main`) needs beside
 * `createHost`: process set-up done before the host exists, and the pieces its Electron adapters
 * (windows, menu, updater, IPC binding) share with the host.
 */
export { DeviceHelper, DeviceKeys, deviceHelperDir } from './device-keys.js';
export { requireCapability } from './host/capability.js';
export { ALL_CAPABILITIES } from './host/platform.js';
export type { DialogOwner } from './host/platform.js';
export type { AppMenu } from './ipc/app.js';
export { emitEvent } from './ipc/events.js';
export { setUpKerberos } from './kerberos.js';
export {
  APP_SCHEME,
  APP_SCHEME_HOST,
  APP_SCHEME_PRIVILEGES,
  CONTENT_SECURITY_POLICY,
  MAIN_WINDOW_WEB_PREFERENCES,
  denySubframeNavigation,
  isExternalUrlAllowed,
} from './security.js';
export { UpdateController, githubFeedFrom } from './updater.js';
export type { UpdateChannel, UpdateStatus } from './updater.js';
export { runAsCaller } from './window-scope.js';
