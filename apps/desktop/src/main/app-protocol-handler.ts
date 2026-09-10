import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { protocol } from 'electron';
import { resolveRendererFile } from './app-protocol.js';
import { APP_SCHEME } from './security.js';

/** Where the built renderer lives relative to the main process's own output directory. */
const RENDERER_OUT_DIR = join(import.meta.dirname, '../renderer');

/**
 * Registers the `app://` protocol handler that serves the packaged renderer's static files
 * from `out/renderer`, in place of `loadFile`'s opaque `file://` origin. Must be called after
 * `app.whenReady()` — `protocol.handle` is not available before then. The scheme itself is
 * registered as privileged earlier, in `main/index.ts`, before `app.ready`.
 */
export function registerAppProtocol(): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    const resolved = resolveRendererFile(RENDERER_OUT_DIR, url.pathname);
    if (resolved === undefined) {
      return new Response('Not found', { status: 404 });
    }
    const data = await readFile(resolved.filePath);
    return new Response(data, { headers: { 'content-type': resolved.contentType } });
  });
}
