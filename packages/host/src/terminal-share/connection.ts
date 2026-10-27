/**
 * One shared-terminal socket from the desktop (team sessions spec B2): opens it with the app's TLS and
 * proxy, sends `auth` first, and resolves once the server answered `ready` or `viewer-ready`. A refusal
 * before that becomes a problem the dialog can show. Output arrives as binary frames.
 */
import {
  TERMINAL_SHARE_CLOSE,
  TERMINAL_SHARE_PATH,
  terminalShareServerMessageSchema,
  WirebenchError,
  type ConnectedWebSocket,
  type TerminalShareClientMessage,
  type TerminalShareServerMessage,
} from '@wirebench/engine';

/** How long the server may take to answer `auth`. */
const READY_TIMEOUT_MS = 10_000;
const OPEN = 1;

export interface ShareHandlers {
  message(message: TerminalShareServerMessage): void;
  binary(data: Buffer): void;
  closed(code: number): void;
}

export interface ShareConnection {
  send(message: TerminalShareClientMessage): void;
  sendBinary(data: Uint8Array): void;
  close(): void;
}

export type ShareReady = Extract<TerminalShareServerMessage, { type: 'ready' | 'viewer-ready' }>;

/** The socket URL on a server origin. */
export function shareSocketUrl(origin: string): string {
  const url = new URL(TERMINAL_SHARE_PATH, origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

/** What a close before `ready` means to the person who asked. */
export function refusalOf(code: number): WirebenchError {
  switch (code) {
    case TERMINAL_SHARE_CLOSE.unauthenticated:
      return new WirebenchError('identity-unauthenticated', 'Sign in to the server again.');
    case TERMINAL_SHARE_CLOSE.forbidden:
      return new WirebenchError('terminal-share-forbidden', 'You cannot join this shared terminal.');
    case TERMINAL_SHARE_CLOSE.notFound:
    case TERMINAL_SHARE_CLOSE.ended:
      return new WirebenchError('terminal-share-not-found', 'That shared terminal has ended or does not exist.');
    case TERMINAL_SHARE_CLOSE.tooMany:
      return new WirebenchError('terminal-share-full', 'This shared terminal has as many viewers as it takes.');
    default:
      return new WirebenchError('terminal-share-unreachable', 'The server did not open the shared terminal.');
  }
}

function parse(text: string): TerminalShareServerMessage | undefined {
  try {
    const result = terminalShareServerMessageSchema.safeParse(JSON.parse(text));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

export function openShareConnection(
  connected: ConnectedWebSocket,
  auth: Extract<TerminalShareClientMessage, { type: 'auth' }>,
  handlers: ShareHandlers,
): Promise<{ connection: ShareConnection; ready: ShareReady }> {
  const { socket } = connected;
  socket.binaryType = 'arraybuffer';
  const connection: ShareConnection = {
    send: (message) => {
      if (socket.readyState === OPEN) socket.send(JSON.stringify(message));
    },
    sendBinary: (data) => {
      if (socket.readyState === OPEN) socket.send(data);
    },
    close: () => {
      void connected.dispose();
    },
  };
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void connected.dispose();
      reject(refusalOf(0));
    }, READY_TIMEOUT_MS);
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify(auth));
    });
    socket.addEventListener('message', (event) => {
      const data: unknown = event.data;
      if (typeof data !== 'string') {
        handlers.binary(Buffer.from(data as ArrayBuffer));
        return;
      }
      const message = parse(data);
      if (message === undefined) return;
      if (!settled && (message.type === 'ready' || message.type === 'viewer-ready')) {
        settled = true;
        clearTimeout(timer);
        resolve({ connection, ready: message });
        return;
      }
      handlers.message(message);
    });
    socket.addEventListener('close', (event) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        void connected.dispose();
        reject(refusalOf(event.code));
        return;
      }
      void connected.dispose();
      handlers.closed(event.code);
    });
  });
}
