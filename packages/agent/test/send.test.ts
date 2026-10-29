/**
 * `agent.send`, `agent.cancel` and `agent.cookies.clear` over a real host (hosted edition spec §18.4): a
 * bundle is written to its own directory, loaded and sent through the host's send path to an echo server
 * on 127.0.0.1, its secrets resolved and masked by the host, and the directory is removed however the
 * send ends. The handlers are called as the agent's server calls them, and once over a paired socket.
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, readdir, symlink, utimes, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createApi,
  createFolder,
  createInterface,
  createProject,
  createRequest,
  createRestRequest,
  DEFAULT_OAUTH2_AUTH,
  entry,
  type Project,
  type RestFolder,
  type RestRequestDef,
} from '@wirebench/engine';
import {
  agentSecretLabel,
  createHost,
  createSendSession,
  serveCall,
  type Host,
  type HostPlatform,
} from '@wirebench/host';
import { AGENT_BUNDLE_MAX_BYTES, AGENT_BUNDLE_MAX_FILES, type SendBundle } from '@wirebench/wire/agent';
import { pair, type AgentFetch } from '../src/pair.js';
import { openPairingStore, type Pairing } from '../src/pairings.js';
import {
  AGENT_MAX_SENDS_PER_ORIGIN,
  AGENT_SENDS_DIR,
  AGENT_STALE_INSTANCE_MS,
  agentSendHandlers,
  PID_FILE,
  writeBundle,
} from '../src/send.js';
import { startAgent, type AgentHandler } from '../src/server.js';
import { cleanUp, onCleanUp, openSocket, startFakeServer } from './helpers.js';
import {
  bundleOf,
  hostPlatform,
  quietCaller,
  startEchoServer,
  startProxy,
  tempFolder,
  type EchoServer,
} from './send-helpers.js';

const SECRET = 'abc123def456ghi789';
const TEAM = 'https://team.example.test';
const OTHER = 'https://other.example.test';
const PROXY_PASSWORD = 'proxy-pass-0123456789';

let platform: HostPlatform;
let host: Host;
let echo: EchoServer;
let handlers: Map<string, AgentHandler>;

beforeEach(async () => {
  platform = hostPlatform();
  host = await createHost(platform);
  onCleanUp(() => host.shutdown());
  echo = await startEchoServer();
  handlers = agentSendHandlers({ platform });
});

afterEach(cleanUp);

function pairingOf(origin: string): Pairing {
  return {
    pairingId: `pairing-${origin}`,
    serverUrl: origin,
    origin,
    email: 'ada@example.test',
    sshOptIn: false,
    createdAt: new Date(0).toISOString(),
  };
}

/** Calls `channel` as the agent's server does, for a tab of `origin`. */
async function call(channel: string, request: unknown, origin = TEAM): Promise<unknown> {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`no handler for ${channel}`);
  return await handler(request, { caller: quietCaller(1_000_000), pairing: pairingOf(origin), host });
}

/** What `agent.send` threw, for a send that must fail. */
async function failure(request: unknown, origin = TEAM): Promise<{ code: string; message: string }> {
  try {
    await call('agent.send', request, origin);
  } catch (error) {
    return error as { code: string; message: string };
  }
  throw new Error('the send did not fail');
}

let sends = 0;
function sendId(): string {
  sends += 1;
  return `send-${String(sends)}`;
}

/** Stores `value` under `label` in the agent machine's secret store, as the Secrets page does. */
async function storeLabelled(label: string, value: string): Promise<void> {
  const caller = quietCaller(7);
  host.attach(caller);
  const reply = await serveCall(host, caller, { id: 1, channel: 'secrets.set', request: { value, label } });
  expect(reply).toMatchObject({ ok: true });
  await host.detach(caller.id);
}

/** Stores `value` as the agent's own secret `name` for `origin` and workspace `ws-1`. */
async function storeAgentSecret(name: string, value: string, origin = TEAM): Promise<void> {
  await storeLabelled(agentSecretLabel(origin, 'ws-1', name), value);
}

/** A project `p1` whose REST API points at the echo server, holding `requests` (and `folders`). */
function restProject(requests: readonly RestRequestDef[], folders: readonly RestFolder[] = []): Project {
  const api = createApi('Echo', { id: 'api-1', baseUrl: echo.url, requests, folders });
  return { ...createProject('Demo', { id: 'p1' }), containers: { rest: [api] } };
}

async function restBundle(request: Partial<Parameters<typeof createRestRequest>[1]> = {}): Promise<SendBundle> {
  return await bundleOf(restProject([createRestRequest('Echo', { id: 'req-1', url: '/echo', ...request })]), 'req-1');
}

/** The send directories left in every instance folder of the sends folder. */
async function sendsLeft(): Promise<string[]> {
  const root = join(platform.paths.temp(), AGENT_SENDS_DIR);
  if (!existsSync(root)) return [];
  const left: string[] = [];
  for (const instance of await readdir(root)) {
    left.push(...(await readdir(join(root, instance))).filter((name) => name !== PID_FILE));
  }
  return left;
}

describe('agent.send', () => {
  it('sends a REST bundle from this machine and masks the secret it resolved', async () => {
    await storeAgentSecret('api_token', SECRET);
    const bundle = await restBundle({ headers: [entry('Authorization', 'Bearer ${secret:api_token}')] });
    const result = (await call('agent.send', {
      sendId: sendId(),
      bundle: { ...bundle, secretNames: ['api_token'] },
    })) as {
      sentFrom: string;
      http: {
        status: number;
        request: { headers: Record<string, string> };
        rawRequestBase64: string;
        bodyBase64: string;
        rawResponseBase64: string;
      };
    };
    expect(result.sentFrom).toBe('agent');
    expect(result.http.status).toBe(200);
    // The server got the value; the answer, which leaves the agent, never holds it.
    expect(echo.received[0]?.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    for (const raw of [result.http.rawRequestBase64, result.http.bodyBase64, result.http.rawResponseBase64]) {
      expect(Buffer.from(raw, 'base64').toString('utf8')).not.toContain(SECRET);
    }
    const sentHeader = Object.entries(result.http.request.headers).find(
      ([name]) => name.toLowerCase() === 'authorization',
    );
    expect(sentHeader?.[1]).toBeDefined();
    expect(sentHeader?.[1]).not.toContain(SECRET);
    expect(await sendsLeft()).toEqual([]);
  });

  it('runs a pre-request script of the folder chain', { timeout: 60_000 }, async () => {
    const folder = createFolder('Orders', {
      id: 'folder-1',
      scripts: {
        pre: { text: "request.headers.set('x-folder', 'ran');" },
        api: 'wirebench',
        enabled: true,
        secrets: [],
      },
      requests: [createRestRequest('Echo', { id: 'req-1', url: '/echo' })],
    });
    const bundle = await bundleOf(restProject([], [folder]), 'req-1');
    await call('agent.send', { sendId: sendId(), bundle });
    expect(echo.received[0]?.headers['x-folder']).toBe('ran');
  });

  it("resolves ${#System#…} from this machine's environment", async () => {
    const name = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
    const bundle = await restBundle({ headers: [entry('x-home', `\${#System#${name}}`)] });
    await call('agent.send', { sendId: sendId(), bundle });
    expect(echo.received[0]?.headers['x-home']).toBe(process.env[name]);
  });

  it('answers secret-missing for a secret this machine does not have, and removes the directory', async () => {
    const bundle = await restBundle({ headers: [entry('Authorization', 'Bearer ${secret:nowhere}')] });
    expect((await failure({ sendId: sendId(), bundle })).code).toBe('secret-missing');
    expect(echo.received).toEqual([]);
    expect(await sendsLeft()).toEqual([]);
  });

  it.each(['../x', '/abs', 'a/../../b', 'a\\..\\b', 'C:/x', 'a//b', './a'])(
    'refuses the path %s as agent-bundle-invalid',
    async (path) => {
      const bundle = await restBundle();
      const bad = { ...bundle, files: [...bundle.files, { path, encoding: 'utf8', content: 'x' }] };
      expect((await failure({ sendId: sendId(), bundle: bad })).code).toBe('agent-bundle-invalid');
      expect(existsSync(join(platform.paths.temp(), 'x'))).toBe(false);
      expect(await sendsLeft()).toEqual([]);
    },
  );

  it('refuses a path given twice, a bundle that does not load and one without its item', async () => {
    const bundle = await restBundle();
    const twice = { ...bundle, files: [...bundle.files, bundle.files[0]] };
    expect((await failure({ sendId: sendId(), bundle: twice })).code).toBe('agent-bundle-invalid');
    const noManifest = { ...bundle, files: bundle.files.filter((file) => file.path !== 'wirebench.yaml') };
    expect((await failure({ sendId: sendId(), bundle: noManifest })).code).toBe('agent-bundle-invalid');
    expect((await failure({ sendId: sendId(), bundle: { ...bundle, itemId: 'nope' } })).code).toBe(
      'agent-bundle-invalid',
    );
    expect((await failure({ sendId: sendId(), bundle: { ...bundle, kind: 'soap' } })).code).toBe(
      'agent-bundle-invalid',
    );
    expect(await sendsLeft()).toEqual([]);
  });

  it('refuses a bundle over the size cap or the file cap', async () => {
    const bundle = await restBundle();
    const big = {
      ...bundle,
      files: [...bundle.files, { path: 'big.bin', encoding: 'utf8', content: 'x'.repeat(AGENT_BUNDLE_MAX_BYTES) }],
    };
    expect((await failure({ sendId: sendId(), bundle: big })).code).toBe('agent-bundle-too-large');
    const many = {
      ...bundle,
      files: Array.from({ length: AGENT_BUNDLE_MAX_FILES + 1 }, (_, index) => ({
        path: `f/${String(index)}`,
        encoding: 'utf8',
        content: '',
      })),
    };
    expect((await failure({ sendId: sendId(), bundle: many })).code).toBe('agent-bundle-too-large');
    expect(echo.received).toEqual([]);
  });

  it('sends a SOAP bundle', async () => {
    const request = {
      ...createRequest('Add', {
        id: 'soap-1',
        envelopeXml: '<soap:Envelope><soap:Body><who>${#Project#who}</who></soap:Body></soap:Envelope>',
        soapVersion: '1.1',
        soapAction: 'urn:calc:Add',
      }),
      endpointUrl: `${echo.url}/soap`,
    };
    const iface = createInterface('Calculator', {
      id: 'iface-1',
      definitionUrl: 'http://127.0.0.1:1/calc?wsdl',
      cacheDefinition: false,
      operations: [{ name: 'Add', bindingName: '{urn:calc}B', slug: 'add', order: 0, requests: [request] }],
    });
    const project: Project = {
      ...createProject('Demo', { id: 'p1' }),
      properties: { who: 'ada' },
      containers: { soap: [iface] },
    };
    const result = (await call('agent.send', {
      sendId: sendId(),
      bundle: await bundleOf(project, 'soap-1', 'soap'),
    })) as { sentFrom: string; status?: number; http?: { status: number } };
    expect(result.sentFrom).toBe('agent');
    expect(echo.received[0]?.body).toContain('<who>ada</who>');
    expect(echo.received[0]?.headers.soapaction).toBe('"urn:calc:Add"');
    expect(await sendsLeft()).toEqual([]);
  });

  it.each(['grpc', 'mcp', 'websocket'])('answers agent-kind-unsupported for a %s bundle', async (kind) => {
    const bundle = await restBundle();
    expect((await failure({ sendId: sendId(), bundle: { ...bundle, kind } })).code).toBe('agent-kind-unsupported');
  });

  it('keeps a cookie between two sends of one origin, keeps origins apart, and clears on request', async () => {
    // The request's own cookie policy rides in the bundle: it sends the jar's cookies.
    const bundle = await restBundle({ url: '/cookie', settings: { sendCookies: true } });
    await call('agent.send', { sendId: sendId(), bundle });
    await call('agent.send', { sendId: sendId(), bundle });
    expect(echo.received[0]?.headers.cookie).toBeUndefined();
    expect(echo.received[1]?.headers.cookie).toBe('sid=abc');

    await call('agent.send', { sendId: sendId(), bundle }, OTHER);
    expect(echo.received[2]?.headers.cookie).toBeUndefined();

    await call('agent.cookies.clear', undefined);
    await call('agent.send', { sendId: sendId(), bundle });
    expect(echo.received[3]?.headers.cookie).toBeUndefined();
    // The other origin's jar was not cleared.
    await call('agent.send', { sendId: sendId(), bundle }, OTHER);
    expect(echo.received[4]?.headers.cookie).toBe('sid=abc');
  });
});

describe("the agent's secrets", () => {
  it("never reads the desktop's own secrets or secret sources for the project a bundle names", async () => {
    // A desktop window has a workspace open, with a project, a stored project secret and a secret source.
    const caller = quietCaller(9);
    host.attach(caller);
    onCleanUp(() => host.detach(caller.id));
    const invoke = async (channel: string, request: unknown): Promise<unknown> => {
      const reply = await serveCall(host, caller, { id: 1, channel, request });
      expect(reply, channel).toMatchObject({ ok: true });
      return (reply as { value: unknown }).value;
    };
    await invoke('workspace.create', { name: 'Mine' });
    const { projectId } = (await invoke('workspace.addProject', { name: 'Local' })) as { projectId: string };
    await invoke('secrets.set', { value: SECRET, label: `wirebench-secret:${projectId}:local_secret` });
    await invoke('secretSources.setLocal', {
      name: 'from_source',
      entry: { kind: 'vault', path: 'kv/app', field: 'f' },
    });

    // A bundle naming that project's id asks for both, and declares them.
    for (const name of ['local_secret', 'from_source']) {
      const project = {
        ...restProject([
          createRestRequest('Echo', { id: 'req-1', url: '/echo', headers: [entry('x-leak', `\${secret:${name}}`)] }),
        ]),
        id: projectId,
      };
      const bundle = { ...(await bundleOf(project, 'req-1')), secretNames: [name] };
      expect((await failure({ sendId: sendId(), bundle })).code, name).toBe('secret-missing');
    }
    expect(echo.received).toEqual([]);
  });

  it('reads the agent namespace of the calling origin and workspace only', async () => {
    await storeAgentSecret('api_token', SECRET, OTHER);
    const bundle = {
      ...(await restBundle({ headers: [entry('x-token', '${secret:api_token}')] })),
      secretNames: ['api_token'],
    };
    expect((await failure({ sendId: sendId(), bundle })).code).toBe('secret-missing');
    expect((await failure({ sendId: sendId(), bundle: { ...bundle, workspaceId: 'ws-2' } }, OTHER)).code).toBe(
      'secret-missing',
    );
    expect(echo.received).toEqual([]);
    await call('agent.send', { sendId: sendId(), bundle }, OTHER);
    expect(echo.received[0]?.headers['x-token']).toBe(SECRET);
  });

  it('refuses a ref the bundle did not declare', async () => {
    await storeAgentSecret('api_token', SECRET);
    const bundle = await restBundle({ headers: [entry('x-token', '${secret:api_token}')] });
    expect((await failure({ sendId: sendId(), bundle })).code).toBe('secret-missing');
    expect((await failure({ sendId: sendId(), bundle: { ...bundle, secretNames: ['other'] } })).code).toBe(
      'secret-missing',
    );
    expect(echo.received).toEqual([]);
  });

  it('keeps OAuth2 tokens apart per origin', async () => {
    for (const origin of [TEAM, OTHER]) await storeAgentSecret('client_secret', 'client-pass-123456', origin);
    const auth = {
      ...DEFAULT_OAUTH2_AUTH,
      tokenUrl: `${echo.url}/token`,
      clientId: 'wirebench',
      clientSecretRef: 'secret:client_secret',
    };
    const api = createApi('Echo', {
      id: 'api-1',
      baseUrl: echo.url,
      auth,
      requests: [createRestRequest('Echo', { id: 'req-1', url: '/echo' })],
    });
    const project: Project = { ...createProject('Demo', { id: 'p1' }), containers: { rest: [api] } };
    const bundle = { ...(await bundleOf(project, 'req-1')), secretNames: ['client_secret'] };
    await call('agent.send', { sendId: sendId(), bundle });
    await call('agent.send', { sendId: sendId(), bundle });
    await call('agent.send', { sendId: sendId(), bundle }, OTHER);
    const sent = echo.received.filter((one) => one.url.startsWith('/echo')).map((one) => one.headers.authorization);
    expect(sent).toEqual(['Bearer tok-1', 'Bearer tok-1', 'Bearer tok-2']);
    expect(echo.received.filter((one) => one.url.startsWith('/token'))).toHaveLength(2);
  });
});

describe('the sends folder', () => {
  it('holds every written path inside the send directory, even one the schema would refuse', async () => {
    const dir = tempFolder('wb-agent-write-');
    const inner = join(dir, 'send');
    await mkdir(inner);
    for (const path of ['../escape', '.', 'a/../../escape2']) {
      await expect(
        writeBundle(inner, [{ path, encoding: 'utf8', content: 'x' }], new AbortController().signal),
      ).rejects.toMatchObject({ code: 'agent-bundle-invalid' });
    }
    expect(await readdir(dir)).toEqual(['send']);
  });

  it.skipIf(process.platform === 'win32')('refuses a sends folder others may open', async () => {
    const root = join(platform.paths.temp(), AGENT_SENDS_DIR);
    await mkdir(root, { mode: 0o755 });
    await chmod(root, 0o755);
    expect((await failure({ sendId: sendId(), bundle: await restBundle() })).code).toBe('agent-temp-unsafe');
    expect(echo.received).toEqual([]);
  });

  it("sweeps a dead or stale agent's folder at start, and keeps a live one's", async () => {
    const root = join(platform.paths.temp(), AGENT_SENDS_DIR);
    await mkdir(root, { mode: 0o700 });
    await chmod(root, 0o700);
    const sibling = async (name: string, pid: string): Promise<string> => {
      const folder = join(root, name);
      await mkdir(join(folder, 'send-x'), { recursive: true });
      await writeFile(join(folder, PID_FILE), pid);
      return folder;
    };
    // A process that has exited: its pid is free.
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    const live = await sibling('live', String(process.pid));
    await sibling('dead', String(dead));
    await sibling('no-pid', 'not a pid');
    const stale = await sibling('stale', String(process.pid));
    const old = new Date(Date.now() - AGENT_STALE_INSTANCE_MS - 60_000);
    await utimes(stale, old, old);

    handlers = agentSendHandlers({ platform });
    await call('agent.send', { sendId: sendId(), bundle: await restBundle() });
    const kept = await readdir(root);
    expect(kept).toContain('live');
    expect(kept.filter((name) => ['dead', 'no-pid', 'stale'].includes(name))).toEqual([]);
    expect(await readdir(live)).toEqual(expect.arrayContaining(['send-x', PID_FILE]));
    // This process's own folder is the one other entry, and it holds no send.
    const own = kept.filter((name) => name !== 'live');
    expect(own).toHaveLength(1);
    expect(await readdir(join(root, own[0] ?? ''))).toEqual([PID_FILE]);
  });

  it('runs a send under its own instance folder, so another process using the id does not collide', async () => {
    const root = join(platform.paths.temp(), AGENT_SENDS_DIR);
    const id = sendId();
    await mkdir(join(root, 'live', id), { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    await writeFile(join(root, 'live', PID_FILE), String(process.pid));
    handlers = agentSendHandlers({ platform });
    const result = (await call('agent.send', { sendId: id, bundle: await restBundle() })) as { sentFrom: string };
    expect(result.sentFrom).toBe('agent');
    expect(existsSync(join(root, 'live', id))).toBe(true);
  });

  it.skipIf(process.platform === 'win32')(
    'touches nothing when the sends folder is a link, and says so once',
    async () => {
      const victim = tempFolder('wb-agent-victim-');
      await mkdir(join(victim, 'precious'));
      await writeFile(join(victim, 'precious', 'file'), 'keep me');
      await writeFile(join(victim, PID_FILE), 'x');
      await symlink(victim, join(platform.paths.temp(), AGENT_SENDS_DIR));
      const lines: string[] = [];
      handlers = agentSendHandlers({ platform, log: (message) => lines.push(message) });
      expect((await failure({ sendId: sendId(), bundle: await restBundle() })).code).toBe('agent-temp-unsafe');
      expect((await failure({ sendId: sendId(), bundle: await restBundle() })).code).toBe('agent-temp-unsafe');
      expect((await readdir(victim)).sort()).toEqual(['pid', 'precious']);
      expect(await readdir(join(victim, 'precious'))).toEqual(['file']);
      expect(lines.filter((line) => line.includes('not swept'))).toHaveLength(1);
    },
  );
});

describe('the machine proxy', () => {
  it("carries this machine's proxy password for an agent send, which a bundle ref cannot read", async () => {
    const proxy = await startProxy();
    const caller = quietCaller(11);
    host.attach(caller);
    onCleanUp(() => host.detach(caller.id));
    const stored = (await serveCall(host, caller, {
      id: 1,
      channel: 'secrets.set',
      request: { value: PROXY_PASSWORD, label: 'proxy' },
    })) as { ok: true; value: { ref: string } };
    const updated = await serveCall(host, caller, {
      id: 2,
      channel: 'preferences.update',
      request: {
        patch: {
          proxy: {
            mode: 'manual',
            host: '127.0.0.1',
            port: proxy.port,
            username: 'agent',
            passwordRef: stored.value.ref,
            excludes: [],
          },
        },
      },
    });
    expect(updated).toMatchObject({ ok: true });

    await call('agent.send', { sendId: sendId(), bundle: await restBundle() });
    expect(echo.received).toHaveLength(1);
    expect(proxy.authorizations).toEqual([`Basic ${Buffer.from(`agent:${PROXY_PASSWORD}`).toString('base64')}`]);

    // The bundle cannot read that value, by its label or by its ref.
    for (const name of ['proxy', stored.value.ref.replace(/[^A-Za-z0-9_]/g, '_')]) {
      const bundle = {
        ...(await restBundle({ headers: [entry('x-leak', `\${secret:${name}}`)] })),
        secretNames: [name],
      };
      expect((await failure({ sendId: sendId(), bundle })).code, name).toBe('secret-missing');
    }
    expect(echo.received).toHaveLength(1);
  });
});

describe('createSendSession', () => {
  it("holds an agent's OAuth2 token requests to the host's egress rule", async () => {
    const config = { ...DEFAULT_OAUTH2_AUTH, tokenUrl: `${echo.url}/token`, clientId: 'wirebench' };
    const open = createSendSession(host, { egress: undefined });
    await expect(open.oauth2.accessToken(config, { credentials: { clientSecret: 'x' } })).resolves.toBe('tok-1');
    const held = createSendSession(host, { egress: { denyPrivate: true } });
    await expect(held.oauth2.accessToken(config, { credentials: { clientSecret: 'x' } })).rejects.toMatchObject({
      code: 'egress-refused',
    });
    expect(echo.received.filter((one) => one.url.startsWith('/token'))).toHaveLength(1);
  });
});

describe('agent.send concurrency', () => {
  it(`runs at most ${String(AGENT_MAX_SENDS_PER_ORIGIN)} sends per origin`, async () => {
    const bundle = await restBundle({ url: '/hold' });
    const held = (count: number) => async (): Promise<void> => {
      while (echo.received.filter((one) => one.url.startsWith('/hold')).length < count) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    const ids = Array.from({ length: AGENT_MAX_SENDS_PER_ORIGIN }, () => sendId());
    const running = ids.map((id) => failure({ sendId: id, bundle }));
    await held(AGENT_MAX_SENDS_PER_ORIGIN)();
    expect((await failure({ sendId: sendId(), bundle })).code).toBe('agent-busy');
    // Another origin has its own allowance.
    const other = sendId();
    const otherRunning = failure({ sendId: other, bundle }, OTHER);
    await held(AGENT_MAX_SENDS_PER_ORIGIN + 1)();
    for (const id of ids) await call('agent.cancel', { sendId: id });
    await call('agent.cancel', { sendId: other }, OTHER);
    for (const result of [...running, otherRunning]) expect((await result).code).toBe('aborted');
  });
});

describe('agent.cancel', () => {
  it("aborts a send of the tab's origin, and only that origin's, and removes its directory", async () => {
    const bundle = await restBundle({ url: '/hold' });
    const id = sendId();
    const held = echo.held();
    const sending = failure({ sendId: id, bundle });
    await held;
    expect(await sendsLeft()).toEqual([id]);
    expect(await call('agent.cancel', { sendId: id }, OTHER)).toEqual({ cancelled: false });
    expect(await call('agent.cancel', { sendId: id })).toEqual({ cancelled: true });
    expect((await sending).code).toBe('aborted');
    expect(await sendsLeft()).toEqual([]);
    expect(await call('agent.cancel', { sendId: id })).toEqual({ cancelled: false });
  });

  it('refuses a second send of an id that is running', async () => {
    const bundle = await restBundle({ url: '/hold' });
    const id = sendId();
    const held = echo.held();
    const sending = failure({ sendId: id, bundle });
    await held;
    expect((await failure({ sendId: id, bundle })).code).toBe('agent-send-exists');
    await call('agent.cancel', { sendId: id });
    expect((await sending).code).toBe('aborted');
  });
});

/** A port nothing listens on now. */
async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe('agent.send over a paired socket', () => {
  it('answers the result, and a refusal with its own code', async () => {
    const server = await startFakeServer();
    const store = await openPairingStore({
      ...platform,
      paths: { ...platform.paths, userData: () => tempFolder('wb-pairings-') },
    });
    const fetch: AgentFetch = (url, init) => globalThis.fetch(url, init);
    const port = await freePort();
    const { pairingId } = await pair({ code: server.code, serverUrl: server.url, sshOptIn: false, store, fetch, port });
    const agent = await startAgent({ host, platform, store, fetch, ports: [port], handlers });
    onCleanUp(() => agent.close());
    const socket = openSocket(agent.port, { origin: server.origin });
    socket.send({ type: 'auth', pairingId, nonce: server.nonce(pairingId) });
    await socket.next();

    const bundle = await restBundle();
    socket.send({ id: 1, channel: 'agent.send', request: { sendId: sendId(), bundle } });
    expect(await socket.next()).toMatchObject({ id: 1, ok: true, value: { sentFrom: 'agent', http: { status: 200 } } });
    socket.send({ id: 2, channel: 'agent.send', request: { sendId: sendId(), bundle: { ...bundle, kind: 'grpc' } } });
    expect(await socket.next()).toMatchObject({ id: 2, ok: false, error: { code: 'agent-kind-unsupported' } });
  });
});
