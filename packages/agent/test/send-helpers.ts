/**
 * Helpers for the send-bundle tests: a whole `HostPlatform` over temporary folders (a real `createHost`
 * runs on it), an echo server on 127.0.0.1, and a bundle made the way a server host makes one, by saving
 * a project and reading back every file it wrote.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { saveProject, type Project } from '@wirebench/engine';
import type { Caller, HostPlatform } from '@wirebench/host';
import type { SendBundle, SendBundleFile } from '@wirebench/wire/agent';
import { onCleanUp } from './helpers.js';

/** A temporary folder, removed at clean-up. */
export function tempFolder(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  onCleanUp(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A platform shaped like the headless agent's: no dialogs, shell or power; its temp folder its own. */
export function hostPlatform(): HostPlatform {
  const userData = tempFolder('wb-agent-host-');
  const temp = tempFolder('wb-agent-temp-');
  return {
    paths: { userData: () => userData, temp: () => temp, logs: () => join(userData, 'logs') },
    secrets: {
      available: () => true,
      encrypt: (plain) => Buffer.from(`sealed:${plain}`, 'utf8'),
      decrypt: (sealed) => sealed.toString('utf8').replace(/^sealed:/, ''),
    },
    app: {
      version: () => '9.9.9-test',
      runtimeVersion: () => '0.0.0-test',
      packaged: () => false,
      quit: () => undefined,
      osTheme: () => 'light',
      onOsThemeChanged: () => () => undefined,
    },
    proxy: { resolve: () => Promise.resolve('DIRECT') },
    capabilities: new Set(['send:public', 'send:private', 'files', 'secret-sources', 'kerberos']),
  };
}

/** A caller that hears nothing: the agent's handlers are given one, and the tests attach one to seed secrets. */
export function quietCaller(id: number): Caller {
  return {
    id,
    send: () => undefined,
    isClosed: () => false,
    onReset: () => () => undefined,
    onClosed: () => () => undefined,
  };
}

export interface Received {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

export interface EchoServer {
  readonly url: string;
  readonly received: Received[];
  /** Resolves once the next request reaches `/hold`, which is never answered. */
  held(): Promise<void>;
}

/**
 * Answers every request with what it received, as JSON; `/cookie` also sets `sid=abc`; `/hold` never
 * answers; `/token` hands out `tok-1`, `tok-2`, … as an OAuth2 token endpoint; a `text/xml` request gets
 * its own body back.
 */
export async function startEchoServer(): Promise<EchoServer> {
  const received: Received[] = [];
  let tokens = 0;
  let onHeld: (() => void) | undefined;
  const open = new Set<ServerResponse>();
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks).toString('utf8');
      received.push({ method: request.method ?? '', url: request.url ?? '', headers: request.headers, body });
      if (request.url?.startsWith('/hold') === true) {
        open.add(response);
        onHeld?.();
        return;
      }
      if (request.headers['content-type']?.includes('xml') === true) {
        response.writeHead(200, { 'content-type': 'text/xml' });
        response.end(body);
        return;
      }
      if (request.url?.startsWith('/token') === true) {
        tokens += 1;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ access_token: `tok-${String(tokens)}`, token_type: 'Bearer', expires_in: 3600 }));
        return;
      }
      response.writeHead(200, {
        'content-type': 'application/json',
        ...(request.url?.startsWith('/cookie') === true ? { 'set-cookie': 'sid=abc; Path=/' } : {}),
      });
      response.end(JSON.stringify({ method: request.method, url: request.url, headers: request.headers }));
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  onCleanUp(
    () =>
      new Promise<void>((resolve) => {
        for (const response of open) response.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    received,
    held: () =>
      new Promise<void>((resolve) => {
        onHeld = resolve;
      }),
  };
}

async function filesUnder(root: string, dir = root): Promise<SendBundleFile[]> {
  const files: SendBundleFile[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(root, path)));
    else
      files.push({
        path: relative(root, path).split(sep).join('/'),
        encoding: 'base64',
        content: (await readFile(path)).toString('base64'),
      });
  }
  return files;
}

/** `project` saved and read back as a bundle for `itemId`. */
export async function bundleOf(
  project: Project,
  itemId: string,
  kind: SendBundle['kind'] = 'rest',
  extra: Partial<SendBundle> = {},
): Promise<SendBundle> {
  const dir = tempFolder('wb-agent-project-');
  await saveProject(project, dir);
  return {
    version: 1,
    kind,
    workspaceId: 'ws-1',
    itemId,
    files: await filesUnder(dir),
    secretNames: [],
    systemNames: [],
    ...extra,
  };
}

export interface ProxyServer {
  readonly port: number;
  /** The `Proxy-Authorization` of every request and tunnel, in order. */
  readonly authorizations: (string | undefined)[];
}

/**
 * A forward proxy on 127.0.0.1 that wants a `Proxy-Authorization` (else `407`): it forwards a plain request
 * and tunnels a `CONNECT`.
 */
export async function startProxy(): Promise<ProxyServer> {
  const authorizations: (string | undefined)[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    authorizations.push(request.headers['proxy-authorization']);
    if (request.headers['proxy-authorization'] === undefined) {
      response.writeHead(407, { 'proxy-authenticate': 'Basic' });
      response.end();
      return;
    }
    const target = new URL(request.url ?? '');
    const headers = { ...request.headers };
    delete headers['proxy-authorization'];
    const upstream = httpRequest(
      {
        host: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: request.method,
        headers,
      },
      (answer) => {
        response.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(response);
      },
    );
    request.pipe(upstream);
  });
  server.on('connect', (request: IncomingMessage, client: Socket, head: Buffer) => {
    authorizations.push(request.headers['proxy-authorization']);
    sockets.add(client);
    if (request.headers['proxy-authorization'] === undefined) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic\r\n\r\n');
      return;
    }
    const [host, port] = (request.url ?? '').split(':');
    const upstream = connect(Number(port), host ?? '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    sockets.add(upstream);
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  onCleanUp(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { port: (server.address() as AddressInfo).port, authorizations };
}
