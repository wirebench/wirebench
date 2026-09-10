import diagnosticsChannel from 'node:diagnostics_channel';
import { describe, expect, it } from 'vitest';
import { TimingTracker } from '../../../src/http/timings.js';
import type { TlsSocketLike } from '../../../src/http/tls.js';

/** A minimal TLS socket the `sendHeaders` handler will accept (it gates on `encrypted === true`). */
function fakeSocket(fingerprint: string): TlsSocketLike & { encrypted: boolean } {
  return {
    encrypted: true,
    getPeerCertificate: () => ({ fingerprint256: fingerprint, subject: { CN: 'x' }, issuer: { CN: 'y' } }),
    getProtocol: () => 'TLSv1.3',
    getCipher: () => ({ name: 'TLS_AES_256_GCM_SHA384' }),
  };
}

/**
 * REQUIRED regardless of the integration test's fate (see the code-review ruling on
 * task 31): proves, with fake diagnostics-channel events, that `onSendHeaders`
 * correlates by request identity rather than origin — the fix for `SslInfo` getting
 * swapped between two concurrent exchanges to the same origin on different sockets.
 */
describe('TimingTracker TLS correlation', () => {
  it('keeps each concurrent exchange on its own socket when both share an origin, correlating by request identity', () => {
    const trackerA = new TimingTracker();
    const trackerB = new TimingTracker();
    try {
      // Two distinct undici `Request` objects — real undici fires `undici:request:create`
      // synchronously inside the call that starts an exchange (verified against the
      // installed undici version), so `captureRequestFor` below reflects exactly what
      // `client.ts` does for a real send.
      const requestA = { origin: 'https://same.example', path: '/a' };
      const requestB = { origin: 'https://same.example', path: '/b' };
      trackerA.setOrigin('https://same.example');
      trackerB.setOrigin('https://same.example');
      trackerA.captureRequestFor(() => {
        diagnosticsChannel.channel('undici:request:create').publish({ request: requestA });
      });
      trackerB.captureRequestFor(() => {
        diagnosticsChannel.channel('undici:request:create').publish({ request: requestB });
      });

      const socketA = fakeSocket('a'.repeat(64));
      const socketB = fakeSocket('b'.repeat(64));

      // Fire both `sendHeaders` events, interleaved and out of order — as they would be
      // for two concurrent sockets to the same origin. Before the fix, both trackers
      // matched on origin alone and both ended up with whichever socket fired last.
      diagnosticsChannel.channel('undici:client:sendHeaders').publish({ request: requestB, socket: socketB });
      diagnosticsChannel.channel('undici:client:sendHeaders').publish({ request: requestA, socket: socketA });

      expect(trackerA.tlsInfo()?.peerChain[0]?.fingerprint256).toBe('a'.repeat(64));
      expect(trackerB.tlsInfo()?.peerChain[0]?.fingerprint256).toBe('b'.repeat(64));
    } finally {
      trackerA.dispose();
      trackerB.dispose();
    }
  });

  it('falls back to origin matching when no request identity was ever captured', () => {
    const tracker = new TimingTracker();
    try {
      tracker.setOrigin('https://example.test');
      const socket = fakeSocket('c'.repeat(64));

      diagnosticsChannel
        .channel('undici:client:sendHeaders')
        .publish({ request: { origin: 'https://example.test' }, socket });

      expect(tracker.tlsInfo()?.peerChain[0]?.fingerprint256).toBe('c'.repeat(64));
    } finally {
      tracker.dispose();
    }
  });

  it('ignores a sendHeaders event for a different request once identity has been captured', () => {
    const tracker = new TimingTracker();
    try {
      const ownRequest = { origin: 'https://example.test', path: '/mine' };
      tracker.setOrigin('https://example.test');
      tracker.captureRequestFor(() => {
        diagnosticsChannel.channel('undici:request:create').publish({ request: ownRequest });
      });

      const otherSocket = fakeSocket('d'.repeat(64));
      diagnosticsChannel.channel('undici:client:sendHeaders').publish({
        request: { origin: 'https://example.test', path: '/not-mine' },
        socket: otherSocket,
      });

      expect(tracker.tlsInfo()).toBeUndefined();
    } finally {
      tracker.dispose();
    }
  });
});
