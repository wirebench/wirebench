import { Writable } from 'node:stream';
import Fastify, { type FastifyBaseLogger } from 'fastify';
import { describe, expect, it } from 'vitest';
import { announce, serverHooks, type Announcement, type HeadMoved, type ServerModule } from '../../../src/context.js';

const EVENT: HeadMoved = {
  workspaceId: '01J8ZC5Q0V7R3T9XK2M4N6P8QA',
  head: 'a'.repeat(40),
  tokenId: '01J8ZC5Q0V7R3T9XK2M4N6P8QB',
};

interface LogLine {
  readonly level: number;
  readonly msg: string;
  readonly err?: { readonly message: string };
}

/**
 * A real Fastify logger at `warn`, writing its JSON lines into memory, so `announce` gets the same
 * logger shape `request.log` has, with no cast. pino writes to a plain `Writable` synchronously.
 */
function recordingLog(): { readonly log: FastifyBaseLogger; readonly lines: () => LogLine[] } {
  const written: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      written.push(chunk.toString('utf-8'));
      callback();
    },
  });
  const app = Fastify({ logger: { level: 'warn', stream } });
  return { log: app.log, lines: () => written.map((line) => JSON.parse(line) as LogLine) };
}

describe('announce (live-updates §3.2, R3)', () => {
  it('calls every listener in registration order with the same event, before it returns', () => {
    const seen: [string, HeadMoved][] = [];
    const listeners: Announcement<HeadMoved>[] = ['a', 'b', 'c'].map((name) => (event: HeadMoved) => {
      seen.push([name, event]);
    });
    announce(listeners, EVENT, recordingLog().log);
    expect(seen.map(([name]) => name)).toEqual(['a', 'b', 'c']);
    expect(seen.every(([, event]) => event === EVENT)).toBe(true);
  });

  it('logs a throwing listener at warn, still runs the ones after it, and never throws itself', () => {
    const { log, lines } = recordingLog();
    const calls: string[] = [];
    const listeners: Announcement<HeadMoved>[] = [
      () => {
        calls.push('first');
      },
      () => {
        throw new Error('boom');
      },
      () => {
        calls.push('third');
      },
    ];
    expect(() => announce(listeners, EVENT, log)).not.toThrow();
    expect(calls).toEqual(['first', 'third']);
    expect(lines()).toEqual([
      expect.objectContaining({
        level: 40,
        msg: 'an announcement listener failed',
        err: expect.objectContaining({ message: 'boom' }) as unknown,
      }),
    ]);
  });

  it('catches a listener that returns a rejected promise after returning, so it is never an unhandled rejection', async () => {
    const { log, lines } = recordingLog();
    // Typed as returning `unknown` so the lint rule against async void callbacks has nothing to see:
    // this stands in for a promise that slipped past it.
    const rejecting = (): unknown => Promise.reject(new Error('late'));
    announce([rejecting as Announcement<HeadMoved>], EVENT, log);
    expect(lines()).toEqual([]); // announce returned without waiting for the listener
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(lines()).toEqual([
      expect.objectContaining({
        level: 40,
        msg: 'an announcement listener failed',
        err: expect.objectContaining({ message: 'late' }) as unknown,
      }),
    ]);
  });
});

describe('serverHooks and ServerModule (live-updates §5.1, §14)', () => {
  it('starts every list empty, and each call gets lists of its own', () => {
    const one = serverHooks();
    expect(one).toEqual({ invitationAccepted: [], headMoved: [], accessChanged: [], sessionEnded: [] });
    one.headMoved.push(() => undefined);
    one.accessChanged.push(() => undefined);
    one.sessionEnded.push(() => undefined);
    const two = serverHooks();
    expect([two.headMoved, two.accessChanged, two.sessionEnded]).toEqual([[], [], []]);
    // The admin CLI builds its own serverHooks() with no hub: announcing there is a silent no-op.
    const { log, lines } = recordingLog();
    announce(two.headMoved, EVENT, log);
    expect(lines()).toEqual([]);
  });

  it('accepts a module named live-updates', () => {
    const live: ServerModule = { name: 'live-updates', register: () => Promise.resolve() };
    expect(live.name).toBe('live-updates');
  });
});
