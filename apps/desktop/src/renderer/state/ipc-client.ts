import type { WirebenchApi } from '../../preload/build-api.js';

/**
 * Thin accessor for `window.wirebench`, so stores call `ipc()` rather than reaching for the
 * global directly — tests can then stub `window.wirebench` without any other indirection.
 */
export function ipc(): WirebenchApi {
  return window.wirebench;
}
