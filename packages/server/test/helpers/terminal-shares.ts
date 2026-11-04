/**
 * A terminal share's socket against a listening server (team session logs and sharing spec B1), and the Enterprise
 * license with terminal sharing that its routes need. Shared by the share relay's suite and the two-instance suite
 * (hosted edition spec §20.6, §20.11).
 */
import {
  TERMINAL_SHARE_PATH,
  terminalShareServerMessageSchema,
  type LicenseState,
  type TerminalShareServerMessage,
} from '@wirebench/engine';
import type { LicenseService, ServerModule } from '../../src/context.js';
import { requireFeature } from '../../src/licensing/gate.js';

const WAIT_MS = 5_000;

/** Enterprise with terminal sharing, as the licensing module would answer it. */
export function sharingLicenseService(): LicenseService {
  const state = (): Promise<LicenseState> =>
    Promise.resolve({
      edition: 'enterprise',
      status: 'active',
      seats: { used: 0, limit: null },
      features: ['terminal-sharing'],
    } as unknown as LicenseState);
  return {
    state,
    assertSeatAvailable: () => Promise.resolve(),
    requireFeature: (feature) => requireFeature(feature, async () => (await state()).features),
  };
}

/** A `licensing` module that installs {@link sharingLicenseService} and nothing else. */
export function sharingLicense(): ServerModule {
  const service = sharingLicenseService();
  return {
    name: 'licensing',
    register: (_app, ctx) => {
      ctx.license = service;
      return Promise.resolve();
    },
  };
}

export interface ShareClient {
  readonly texts: TerminalShareServerMessage[];
  readonly binaries: string[];
  next<T extends TerminalShareServerMessage['type']>(
    type: T,
  ): Promise<Extract<TerminalShareServerMessage, { type: T }>>;
  binary(count: number): Promise<string[]>;
  send(message: unknown): void;
  sendBinary(data: string): void;
  close(): void;
  readonly closed: Promise<{ code: number; reason: string }>;
}

export async function openShare(port: number, auth?: unknown): Promise<ShareClient> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${TERMINAL_SHARE_PATH}`);
  socket.binaryType = 'arraybuffer';
  const texts: TerminalShareServerMessage[] = [];
  const binaries: string[] = [];
  const taken = new Set<TerminalShareServerMessage>();
  const listeners: (() => void)[] = [];
  const changed = (): void => {
    for (const listener of listeners.splice(0)) listener();
  };
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.addEventListener('close', (event) => {
      resolve({ code: event.code, reason: event.reason });
      changed();
    });
  });
  socket.addEventListener('message', (event) => {
    const data: unknown = event.data;
    if (typeof data === 'string') texts.push(terminalShareServerMessageSchema.parse(JSON.parse(data)));
    else binaries.push(Buffer.from(data as ArrayBuffer).toString('utf8'));
    changed();
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('the share socket did not open')), { once: true });
  });
  const until = <T>(probe: () => T | undefined, what: string): Promise<T> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ${what}; saw ${JSON.stringify(texts)}`)), WAIT_MS);
      const check = (): void => {
        const found = probe();
        if (found !== undefined) {
          clearTimeout(timer);
          resolve(found);
        } else listeners.push(check);
      };
      check();
    });
  const client: ShareClient = {
    texts,
    binaries,
    next: (type) =>
      until(() => {
        const found = texts.find((m) => m.type === type && !taken.has(m));
        if (found !== undefined) taken.add(found);
        return found as Extract<TerminalShareServerMessage, { type: typeof type }> | undefined;
      }, type),
    binary: (count) => until(() => (binaries.length >= count ? binaries.slice(0, count) : undefined), 'binary'),
    send: (message) => {
      socket.send(JSON.stringify(message));
    },
    sendBinary: (data) => {
      socket.send(Buffer.from(data));
    },
    close: () => {
      socket.close();
    },
    closed,
  };
  if (auth !== undefined) client.send(auth);
  return client;
}
