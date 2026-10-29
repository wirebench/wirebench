import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { buildApi } from './build-api.js';
import { OS_THEME_ARGUMENT } from '@wirebench/wire/os-theme-argument';
import { ALL_CAPABILITIES } from '@wirebench/wire/capabilities';

/**
 * The real `window.wirebench` implementation, backed by `ipcRenderer`. Built via the pure,
 * unit-testable {@link buildApi}; `ipcRenderer` itself is never exposed to the renderer.
 */
const api = buildApi(
  (channelName, request) => ipcRenderer.invoke(channelName, request),
  (eventName, listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
      listener(payload);
    };
    ipcRenderer.on(eventName, wrapped);
    return () => {
      ipcRenderer.removeListener(eventName, wrapped);
    };
  },
  {
    e2e: process.env['WIREBENCH_E2E'] === '1',
    // Handed down by `main/windows.ts` via `webPreferences.additionalArguments`: `nativeTheme`
    // is a main-process API, and a sandboxed renderer's `prefers-color-scheme` does not see a
    // per-app appearance override. Absent (a preload loaded outside our window) means dark.
    osTheme: process.argv.includes(`${OS_THEME_ARGUMENT}light`) ? 'light' : 'dark',
    // The desktop's platform has every capability (`main/electron/electron-platform.ts`).
    host: 'electron',
    capabilities: ALL_CAPABILITIES,
    ...(process.env['WIREBENCH_E2E_FIXED_LAYOUT'] === '1' ? { fixedLayout: true } : {}),
    ...(process.env['WIREBENCH_E2E_SEND_TEMPLATES'] === '1' ? { sendTemplatesUnasked: true } : {}),
  },
  (file) => webUtils.getPathForFile(file),
);

contextBridge.exposeInMainWorld('wirebench', api);
