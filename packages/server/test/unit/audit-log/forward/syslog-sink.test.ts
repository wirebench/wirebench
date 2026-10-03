import { afterEach, describe, expect, it, vi } from 'vitest';
import { frame, SyslogSink, syslogMessage } from '../../../../src/audit-log/forward/syslog-sink.js';
import {
  generateSecondTestCa,
  generateServerCert,
  generateTestCa,
} from '../../../../../engine/test/helpers/test-certs.js';
import { silentListener, syslogReceiver, type SyslogReceiver } from '../../../helpers/forward-receivers.js';
import { freePort } from '../../../helpers/net.js';
import { auditEvent } from './fixtures.js';

const SHORT = { connectTimeoutMs: 300, writeTimeoutMs: 300 } as const;

describe('syslogMessage and frame', () => {
  it('builds the RFC 5424 line: PRI 110, version 1, timestamp, host, app, no procid, action, no SD', () => {
    const event = auditEvent();
    expect(syslogMessage(event, 'wb-1')).toBe(
      `<110>1 2026-10-03T12:00:00.000Z wb-1 wirebench-server - team.created - ${JSON.stringify(event)}`,
    );
  });

  it('uses - for an empty hostname', () => {
    expect(syslogMessage(auditEvent(), '')).toMatch(/^<110>1 2026-10-03T12:00:00.000Z - wirebench-server - /);
  });

  it('frames a message with its octet count (RFC 6587)', () => {
    expect(frame('<110>1 abc').toString('utf8')).toBe('10 <110>1 abc');
  });

  it('counts multi-byte UTF-8 in bytes, not characters', () => {
    const message = 'é€😀';
    expect(message.length).toBe(4);
    expect(frame(message).toString('utf8')).toBe(`9 ${message}`);
  });
});

describe('SyslogSink', () => {
  const cleanup: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn();
  });
  const track = <T extends { close(): Promise<void> }>(thing: T): T => {
    cleanup.push(() => thing.close());
    return thing;
  };

  it('sends framed messages in order over TCP, on one connection', async () => {
    const receiver = track(await syslogReceiver());
    const sink = track(new SyslogSink({ host: '127.0.0.1', port: receiver.port, hostname: 'wb-1', ...SHORT }));
    const events = [auditEvent({ id: 'e1' }), auditEvent({ id: 'e2', details: { name: 'Zürich ✓' } })];
    await sink.send(events);
    await sink.send([auditEvent({ id: 'e3' })]);
    await receiver.received(3);
    expect(receiver.messages).toEqual([...events, auditEvent({ id: 'e3' })].map((e) => syslogMessage(e, 'wb-1')));
    expect(receiver.sockets).toHaveLength(1);
  });

  it('verifies a TLS server against the CA it is given, and sends over it', async () => {
    const ca = generateTestCa();
    const receiver = track(await syslogReceiver({ tls: generateServerCert(ca) }));
    const sink = track(
      new SyslogSink({ host: '127.0.0.1', port: receiver.port, tls: { ca: ca.certPem }, hostname: 'wb-1', ...SHORT }),
    );
    await sink.send([auditEvent()]);
    await receiver.received(1);
    expect(receiver.messages).toEqual([syslogMessage(auditEvent(), 'wb-1')]);
  });

  it('refuses a TLS server whose certificate the CA does not vouch for', async () => {
    const receiver = track(await syslogReceiver({ tls: generateServerCert(generateTestCa()) }));
    const sink = track(
      new SyslogSink({ host: '127.0.0.1', port: receiver.port, tls: { ca: generateSecondTestCa().certPem }, ...SHORT }),
    );
    await expect(sink.send([auditEvent()])).rejects.toThrow(/127\.0\.0\.1/);
    expect(receiver.messages).toEqual([]);
  });

  it('refuses a TLS server signed by a private CA when no CA is given', async () => {
    const receiver = track(await syslogReceiver({ tls: generateServerCert(generateTestCa()) }));
    const sink = track(new SyslogSink({ host: '127.0.0.1', port: receiver.port, tls: {}, ...SHORT }));
    await expect(sink.send([auditEvent()])).rejects.toThrow();
  });

  it('rejects when nothing listens on the port', async () => {
    const sink = track(new SyslogSink({ host: '127.0.0.1', port: await freePort(), ...SHORT }));
    await expect(sink.send([auditEvent()])).rejects.toThrow(/127\.0\.0\.1/);
  });

  it('rejects when a TLS handshake does not finish within the connect timeout', async () => {
    const peer = track(await silentListener());
    const sink = track(new SyslogSink({ host: '127.0.0.1', port: peer.port, tls: {}, ...SHORT }));
    const started = Date.now();
    await expect(sink.send([auditEvent()])).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('rejects when a stalled peer never takes the batch, within the write timeout', async () => {
    const peer = track(await silentListener());
    const sink = track(new SyslogSink({ host: '127.0.0.1', port: peer.port, ...SHORT }));
    // Far more than the loopback socket buffers hold, so the write cannot flush while the peer stalls.
    const big = auditEvent({ details: { blob: 'x'.repeat(64 * 1024 * 1024) } });
    const started = Date.now();
    await expect(sink.send([big])).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('reconnects on the next send after the receiver drops the connection', async () => {
    const receiver: SyslogReceiver = track(await syslogReceiver());
    const sink = track(new SyslogSink({ host: '127.0.0.1', port: receiver.port, hostname: 'wb-1', ...SHORT }));
    await sink.send([auditEvent({ id: 'e1' })]);
    await receiver.received(1);
    receiver.sockets[0]!.destroy();
    await vi.waitFor(() => expect(sink.connected).toBe(false));
    await sink.send([auditEvent({ id: 'e2' })]);
    await receiver.received(2);
    expect(receiver.sockets).toHaveLength(2);
    expect(receiver.messages[1]).toBe(syslogMessage(auditEvent({ id: 'e2' }), 'wb-1'));
  });

  it('reconnects after a failed send once the receiver is back', async () => {
    const port = await freePort();
    const sink = track(new SyslogSink({ host: '127.0.0.1', port, hostname: 'wb-1', ...SHORT }));
    await expect(sink.send([auditEvent()])).rejects.toThrow();
    const receiver = track(await syslogReceiver({ port }));
    await sink.send([auditEvent()]);
    await receiver.received(1);
  });

  it('close ends the connection, and a closed sink does not send', async () => {
    const receiver = track(await syslogReceiver());
    const sink = new SyslogSink({ host: '127.0.0.1', port: receiver.port, ...SHORT });
    await sink.send([auditEvent()]);
    await sink.close();
    expect(sink.connected).toBe(false);
    await expect(sink.send([auditEvent()])).rejects.toThrow(/closed/);
  });

  it('sends nothing and connects nowhere for an empty batch', async () => {
    const sink = track(new SyslogSink({ host: '127.0.0.1', port: await freePort(), ...SHORT }));
    await expect(sink.send([])).resolves.toBeUndefined();
  });
});
