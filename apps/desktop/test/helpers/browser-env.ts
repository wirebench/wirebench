import type { Capability } from '@wirebench/wire/capabilities';
import type { WirebenchApi } from '../../src/preload/build-api.js';

/** What the server's hello frame lists today: a public send and nothing of a machine. */
export const BROWSER_CAPABILITIES: readonly Capability[] = ['send:public'];

/**
 * Puts a browser env on an installed `window.wirebench` stub, as the browser bootstrap would: `host`
 * 'browser' and only `capabilities`. A stub without it has every capability, as the desktop does.
 */
export function useBrowserEnv(api: WirebenchApi, capabilities: readonly Capability[] = BROWSER_CAPABILITIES): void {
  Object.defineProperty(api, 'env', {
    configurable: true,
    value: { e2e: false, osTheme: 'dark', host: 'browser', capabilities },
  });
}
