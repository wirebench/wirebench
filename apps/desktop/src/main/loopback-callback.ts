/**
 * The one loopback listener a browser hand-off answers to, shared by the OAuth2 request flow and
 * the server sign-in (identity spec §5.3). Security, stated once: it binds `127.0.0.1` only, on a
 * random port unless the caller pinned one, accepts exactly one callback whose `expected`
 * parameter matches, answers everything else with 400 without ending the flow, and gives up
 * after `timeoutMs` (RFC 8252 §8.3). The page it renders is plain HTML with every interpolated
 * value escaped: the `error` parameter is chosen by whoever drove the redirect.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WirebenchError } from '@wirebench/engine';

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escapes `text` for interpolation into HTML element content. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}

/** The one-page response the listener returns to the browser; `message` is escaped, not trusted. */
export function callbackPage(message: string): string {
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<title>Wirebench</title>',
    '<style>body{font:14px system-ui;margin:3rem;color:#222}</style>',
    '</head><body><h1>Wirebench</h1><p>',
    escapeHtml(message),
    '</p></body></html>',
  ].join('');
}

export interface LoopbackCallbackOptions {
  /**
   * The query parameter that ties a callback to this flow and the value it must carry. A
   * function, because the server sign-in learns its flow id only after it has told the server
   * the port; until it returns a value every callback is refused.
   */
  readonly expected: { readonly name: string; readonly value: () => string | undefined };
  /** A fixed port a provider demands; a random free one otherwise. */
  readonly port?: number;
  readonly timeoutMs: number;
  /** What the browser is told for the matching callback: `ok` picks 200 or 400. */
  readonly describe: (params: URLSearchParams) => { readonly ok: boolean; readonly message: string };
}

export interface LoopbackCallback {
  readonly redirectUri: string;
  readonly port: number;
  /** The matching callback's query; rejects `loopback-timeout` or `loopback-cancelled`. */
  readonly result: Promise<URLSearchParams>;
  cancel(): void;
}

export async function startLoopbackCallback(options: LoopbackCallbackOptions): Promise<LoopbackCallback> {
  const server: Server = createServer();
  let settle: { resolve: (params: URLSearchParams) => void; reject: (error: Error) => void } | undefined;
  let done = false;
  const finish = (outcome: { params: URLSearchParams } | { error: Error }): void => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    server.close();
    if ('params' in outcome) settle?.resolve(outcome.params);
    else settle?.reject(outcome.error);
  };
  const result = new Promise<URLSearchParams>((resolve, reject) => {
    settle = { resolve, reject };
  });
  const timer = setTimeout(() => {
    finish({ error: new WirebenchError('loopback-timeout', 'The sign-in was not completed in time') });
  }, options.timeoutMs);
  timer.unref?.();

  server.on('request', (request: IncomingMessage, response: ServerResponse) => {
    if (done) {
      response.writeHead(410).end();
      return;
    }
    const params = new URL(request.url ?? '/', 'http://127.0.0.1').searchParams;
    const expected = options.expected.value();
    if (expected === undefined || params.get(options.expected.name) !== expected) {
      // Not this flow's callback: answered, but neither accepted nor allowed to end the flow.
      response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
      response.end(callbackPage('This sign-in response did not match the request. You can close this tab.'));
      return;
    }
    const verdict = options.describe(params);
    response.writeHead(verdict.ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' });
    response.end(callbackPage(verdict.message));
    finish({ params });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return {
    redirectUri: `http://127.0.0.1:${String(port)}/callback`,
    port,
    result,
    cancel: () => finish({ error: new WirebenchError('loopback-cancelled', 'The sign-in was cancelled') }),
  };
}
