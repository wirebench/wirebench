import { BrowserWindow, dialog } from 'electron';
import { nodeFs, WirebenchError, writeFileAtomic } from '@wirebench/engine';
import { channels } from '../../shared/ipc.js';
import { extensionForContentType } from './attachments.js';
import { redactExchangeSummary } from '../engine-wire.js';
import type { ExchangeCache } from '../exchange-cache.js';
import { registerHandler } from './register.js';

/**
 * Registers `exchanges.get`: re-reads one cached exchange and redacts it against the
 * show-secrets flag *at call time*. This is what makes the toggle retroactive — the renderer
 * refetches whatever detail it is showing instead of holding unredacted bytes of its own.
 *
 * @throws WirebenchError `unknown-send` when the exchange has been evicted (or never existed).
 */
export function registerExchangeChannels(cache: ExchangeCache, showSecrets: { get(): boolean }): void {
  registerHandler(channels.exchanges.saveRestBody, async (request, sender) => {
    const summary = cache.getRest(request.sendId);
    const bytes = cache.getRestBody(request.sendId);
    if (summary === undefined || bytes === undefined) {
      throw new WirebenchError('unknown-send', `No cached REST response for send "${request.sendId}"`, {
        details: { sendId: request.sendId },
      });
    }
    // The target is never the renderer's to choose (see the channel's request schema): these are
    // bytes a remote server sent, and letting the page name the file would let it write them
    // anywhere the user can write. It comes from the native dialog, or the e2e override.
    const contentType = summary.http.headers['content-type'] ?? 'application/octet-stream';
    let targetPath = process.env['WIREBENCH_E2E_SAVE_PATH'];
    if (targetPath === undefined) {
      const window = BrowserWindow.fromWebContents(sender) ?? undefined;
      const result = await dialog.showSaveDialog(window as BrowserWindow, {
        title: 'Save response as…',
        defaultPath: `response${extensionForContentType(contentType)}`,
      });
      targetPath = result.canceled ? undefined : result.filePath;
    }
    if (targetPath === undefined) {
      return { cancelled: true as const };
    }
    // Atomic (temp file plus rename), as `attachments.saveResponse` and every project write are:
    // a crash mid-write leaves nothing truncated behind, and a watcher never sees a half file.
    await writeFileAtomic(nodeFs, targetPath, Buffer.from(bytes));
    return { path: targetPath };
  });

  registerHandler(channels.exchanges.get, (request) => {
    const summary = cache.get(request.sendId);
    if (summary === undefined) {
      const rest = cache.getRestView(request.sendId, showSecrets.get());
      if (rest !== undefined) {
        return Promise.resolve(rest);
      }
      throw new WirebenchError('unknown-send', `No cached exchange for send "${request.sendId}"`, {
        details: { sendId: request.sendId },
      });
    }
    const cached = cache.getExchange(request.sendId);
    return Promise.resolve(
      redactExchangeSummary(summary, {
        show: showSecrets.get(),
        ...(cached?.keyParams !== undefined ? { keyParams: cached.keyParams } : {}),
        ...(cached?.keyHeaders !== undefined ? { keyHeaders: cached.keyHeaders } : {}),
      }),
    );
  });
}
