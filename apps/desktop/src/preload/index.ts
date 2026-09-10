import { contextBridge, ipcRenderer } from 'electron';
import { buildApi } from './build-api.js';

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
);

contextBridge.exposeInMainWorld('wirebench', api);
