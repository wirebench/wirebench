/**
 * Helpers for the send-bundle tests: a whole `HostPlatform` over temporary folders (a real `createHost`
 * runs on it), an echo server on 127.0.0.1, and a bundle made the way a server host makes one, by saving
 * a project and reading back every file it wrote.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
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
 * answers; a `text/xml` request gets its own body back.
 */
export async function startEchoServer(): Promise<EchoServer> {
  const received: Received[] = [];
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
  return { version: 1, kind, itemId, files: await filesUnder(dir), secretNames: [], ...extra };
}
