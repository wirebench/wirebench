/**
 * `isUpgradeHeadFor`, the `undici:client:sendHeaders` matcher `openWsSession` uses to tell its
 * own upgrade request apart from any other traffic on the same origin. Unit-tested directly
 * because ordering a real diagnostics-channel race between two in-flight requests reliably enough
 * for an integration test isn't possible.
 */
import { describe, expect, it } from 'vitest';
import { isUpgradeHeadFor } from '../../../src/ws/session.js';

const ORIGIN = 'http://127.0.0.1:4000';
const PATH = '/echo?room=1';

const upgradeHead = 'GET /echo?room=1 HTTP/1.1\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n';
const plainHead = 'GET /echo?room=1 HTTP/1.1\r\nAccept: */*\r\n\r\n';

function message(headers: unknown, path: string = PATH, origin: unknown = ORIGIN): unknown {
  return { headers, request: { origin, path } };
}

describe('isUpgradeHeadFor', () => {
  it('matches a same-origin, same-path request whose raw head carries Sec-WebSocket-Key', () => {
    expect(isUpgradeHeadFor(message(upgradeHead), ORIGIN, PATH)).toBe(true);
  });

  it('matches Sec-WebSocket-Key case-insensitively', () => {
    const head = 'GET /echo?room=1 HTTP/1.1\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n';
    expect(isUpgradeHeadFor(message(head), ORIGIN, PATH)).toBe(true);
  });

  it('rejects a same-origin, same-path request with no Sec-WebSocket-Key — a plain HTTP request', () => {
    expect(isUpgradeHeadFor(message(plainHead), ORIGIN, PATH)).toBe(false);
  });

  it('rejects a different path, even with the header', () => {
    expect(isUpgradeHeadFor(message(upgradeHead), ORIGIN, '/other')).toBe(false);
  });

  it('rejects a different origin, even with the header', () => {
    expect(isUpgradeHeadFor(message(upgradeHead), 'http://127.0.0.1:5000', PATH)).toBe(false);
  });

  it('accepts an origin carried as a URL instance', () => {
    expect(isUpgradeHeadFor(message(upgradeHead, PATH, new URL(ORIGIN)), ORIGIN, PATH)).toBe(true);
  });

  it('rejects a non-string headers field', () => {
    expect(isUpgradeHeadFor(message(undefined), ORIGIN, PATH)).toBe(false);
    expect(isUpgradeHeadFor(message(123), ORIGIN, PATH)).toBe(false);
  });
});
