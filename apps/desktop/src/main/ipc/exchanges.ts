import { WirebenchError } from '@wirebench/engine';
import { channels } from '../../shared/ipc.js';
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
  registerHandler(channels.exchanges.get, (request) => {
    const summary = cache.get(request.sendId);
    if (summary === undefined) {
      throw new WirebenchError('unknown-send', `No cached exchange for send "${request.sendId}"`, {
        details: { sendId: request.sendId },
      });
    }
    return Promise.resolve(redactExchangeSummary(summary, { show: showSecrets.get() }));
  });
}
