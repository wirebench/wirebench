import type { WirebenchApi } from './build-api.js';

declare global {
  interface Window {
    /** The typed IPC surface exposed by the preload script via `contextBridge`. */
    wirebench: WirebenchApi;
  }
}

export {};
