import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { protocol } from 'electron';
import { resolveRendererFile } from './app-protocol.js';
import { APP_SCHEME } from './security.js';

/** Where the built renderer lives relative to the main process's own output directory. */
const RENDERER_OUT_DIR = join(import.meta.dirname, '../renderer');

/**
 * Handles `app://` protocol requests. Extracted to a separate function to allow testing
 * with fake requests and custom root directories.
 */
export async function handleAppProtocol(
  request: { readonly url: string; readonly method: string },
  rootDir: string = RENDERER_OUT_DIR,
): Promise<Response> {
  // Only GET and HEAD are allowed for static file serving.
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
  }

  const url = new URL(request.url);
  const resolved = resolveRendererFile(rootDir, url.pathname);
  if (resolved === undefined) {
    return new Response('Not found', { status: 404 });
  }
  const data = await readFile(resolved.filePath);
  // HEAD requests return headers without a body; Response automatically handles this.
  return new Response(request.method === 'HEAD' ? undefined : data, {
    headers: { 'content-type': resolved.contentType },
  });
}

/**
 * Registers the `app://` protocol handler that serves the packaged renderer's static files
 * from `out/renderer`, in place of `loadFile`'s opaque `file://` origin. Must be called after
 * `app.whenReady()` — `protocol.handle` is not available before then. The scheme itself is
 * registered as privileged earlier, in `main/index.ts`, before `app.ready`.
 */
export function registerAppProtocol(): void {
  protocol.handle(APP_SCHEME, (request) => handleAppProtocol(request));
}
