// @vitest-environment node
/**
 * The rest of what a server embedder relies on (hosted edition spec §17.3–§17.5): every secret write and
 * every resolution reported by name, the egress rule on gRPC discovery, proto URL reads and MCP catalogue
 * refreshes, and the root holding dump files and relative proto paths.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createMcpServer,
  createProject,
  refreshMcpCatalogue,
  type EgressPolicy,
  type HttpExchange,
  type HttpRequest,
} from '@wirebench/engine';
import {
  startTestGrpcServer,
  startTestRestServer,
  type TestGrpcServer,
  type TestRestServer,
} from '@wirebench/engine/test-helpers';
import { EngineService } from '../../src/engine-service.js';
import { createHost, type Host, type HostOptions, type SecretEvent } from '../../src/host/create-host.js';
import { createHostState } from '../../src/host/host-state.js';
import type { HostPlatform } from '../../src/host/platform.js';
import { serveCall } from '../../src/host/serve-call.js';
import { toSendDeps, type RequestChannelDeps } from '../../src/ipc/request.js';
import { checkedProtoSource } from '../../src/kinds/grpc/ipc.js';
import { resolveDumpPath } from '../../src/kinds/soap/ipc.js';
import { runInPathRoot } from '../../src/path-access.js';
import { ProjectHost } from '../../src/project-host.js';
import { ProtoImportService } from '../../src/proto-import.js';
import { reportedSecretGetter } from '../../src/secret-resolver.js';
import { SecretStore } from '../../src/secrets.js';
import { appSendScope } from '../../src/send/exchange.js';
import { createFakePlatform, createHeadlessPlatform, fakeCaller } from '../helpers/fake-platform.js';
import { testHooks } from '../helpers/project-hooks.js';

const EGRESS: EgressPolicy = { denyPrivate: false };
const PLAIN = {
  available: true,
  encrypt: (text: string) => Buffer.from(text, 'utf8'),
  decrypt: (buffer: Buffer) => buffer.toString('utf8'),
};

const hosts: Host[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.shutdown();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

async function started(platform: HostPlatform, options: HostOptions = {}): Promise<Host> {
  const host = await createHost(platform, options);
  hosts.push(host);
  return host;
}

async function call(host: Host, channel: string, request: unknown): Promise<unknown> {
  const caller = fakeCaller(1);
  host.attach(caller);
  return await serveCall(host, caller, { id: 1, channel, request });
}

describe('every secret write is reported by name', () => {
  it("tells the store's listener of each write (set, replace, put, machine-only), never the value", async () => {
    const written: unknown[] = [];
    const store = new SecretStore(
      tempDir('wirebench-store-'),
      PLAIN,
      () => undefined,
      (entry) => written.push(entry),
    );
    const ref = await store.set('v-one', { label: 'wirebench-secret:p1:api_token' });
    await store.replace(ref, 'v-two');
    await store.put('sec_given', 'v-three', { label: 'from-tree' });
    await store.putMachineOnly('sec_key', 'v-four', { label: 'wirebench-team-key:me' });
    expect(written).toEqual([
      { ref, label: 'wirebench-secret:p1:api_token' },
      { ref, label: 'wirebench-secret:p1:api_token' },
      { ref: 'sec_given', label: 'from-tree' },
      { ref: 'sec_key', label: 'wirebench-team-key:me' },
    ]);
    expect(JSON.stringify(written)).not.toMatch(/v-(one|two|three|four)/);
  });

  it('reports a write the host makes for itself once, as the secrets channels do', async () => {
    const events: SecretEvent[] = [];
    const host = await started(createFakePlatform(), { onSecret: (event) => events.push(event) });
    await call(host, 'secrets.set', { value: 'abc-value', label: 'proxy password' });
    expect(events).toEqual([{ kind: 'written', name: 'proxy password' }]);
  });
});

describe('every resolution is reported by name', () => {
  it('reports a plain ref as well as a `${secret:…}` token, by the name the host gives it', async () => {
    const reported: string[] = [];
    const store: Record<string, string> = { 'secret:api_token': 'v1', sec_plain: 'v2' };
    const get = reportedSecretGetter(
      (ref) => Promise.resolve(store[ref]),
      (ref) => {
        reported.push(ref);
      },
    );
    await get('secret:api_token');
    await get('sec_plain');
    await get('sec_missing');
    expect(reported).toEqual(['secret:api_token', 'sec_plain']);
  });

  it('reports the proxy password a server call resolves, by its label', async () => {
    const events: SecretEvent[] = [];
    const send: (request: HttpRequest) => Promise<HttpExchange> = () => Promise.reject(new Error('no server here'));
    const host = await started(createHeadlessPlatform(), {
      onSecret: (event) => events.push(event),
      server: {
        url: 'https://wb.example.test',
        send,
        connectLive: () => {
          throw new Error('unused');
        },
        credential: () => undefined,
      },
    });
    const stored = (await call(host, 'secrets.set', { value: 'proxy-pass', label: 'corporate proxy' })) as {
      value: { ref: string };
    };
    await call(host, 'preferences.update', {
      patch: {
        proxy: {
          mode: 'manual',
          host: 'proxy.example.test',
          port: 3128,
          username: 'me',
          passwordRef: stored.value.ref,
        },
      },
    });
    await call(host, 'account.probe', { url: 'https://wb.example.test' });
    expect(events).toContainEqual({ kind: 'resolved', name: 'corporate proxy' });
    expect(JSON.stringify(events)).not.toContain('proxy-pass');
  });
});

describe('the egress rule on what discovers and lists', () => {
  let grpc: TestGrpcServer;
  let rest: TestRestServer;

  beforeAll(async () => {
    grpc = await startTestGrpcServer({ reflection: ['v1'] });
    rest = await startTestRestServer();
  });

  afterAll(async () => {
    await grpc.close();
    await rest.close();
  });

  it('refuses a reflection import from a loopback server', async () => {
    await expect(
      new ProtoImportService({ egress: EGRESS }).run({
        source: { kind: 'reflection', target: grpc.target, tls: false },
        target: grpc.target,
      }),
    ).rejects.toMatchObject({ code: 'egress-refused' });
  });

  it('refuses a proto read from a loopback URL', async () => {
    await expect(
      new ProtoImportService({ egress: EGRESS }).run({ source: { kind: 'url', url: `${rest.url}/greet.proto` } }),
    ).rejects.toMatchObject({ code: 'egress-refused' });
  });

  it("refuses a discovered API's refresh from a loopback server", async () => {
    const dir = join(tempDir('wirebench-grpc-egress-'), 'P');
    const open = new ProjectHost(new EngineService(), testHooks());
    await open.create({ dir, name: 'P' });
    const run = await new ProtoImportService().run({
      source: { kind: 'reflection', target: grpc.target, tls: false },
      target: grpc.target,
    });
    if (run.kind !== 'reflection') throw new Error('expected a reflection run');
    const { apiId } = await open.kind('grpc').addGrpcApi({
      api: run.imported.api,
      roots: run.roots,
      source: run.sourceLabel,
      kind: 'reflection',
      descriptors: run.descriptors,
      version: run.version,
      trustInvalid: run.trustInvalid,
    });
    await open.close();
    const guarded = new ProjectHost(new EngineService(), testHooks({ egress: EGRESS }));
    await guarded.openProject(dir);
    try {
      await expect(guarded.kind('grpc').refreshGrpcDefinition(apiId, { version: 'v1' })).rejects.toMatchObject({
        code: 'egress-refused',
      });
    } finally {
      await guarded.close();
    }
  });

  it('refuses an MCP catalogue refresh from a loopback server', async () => {
    const server = createMcpServer('Local', {
      id: 'mcp-1',
      transport: { type: 'http', url: `${rest.url}/mcp`, headers: [] },
    });
    const model = { ...createProject('P', { id: 'p1' }), containers: { mcp: [server] } };
    const deps: RequestChannelDeps = {
      hostState: createHostState(),
      project: {
        projectId: () => 'p1',
        runContextFor: () => ({ project: model, projectDir: tmpdir(), globals: {} }),
      } as unknown as RequestChannelDeps['project'],
      egress: EGRESS,
    };
    const located = await appSendScope(toSendDeps(new EngineService(), deps), 'mcp-1', { sendId: 'r1' });
    if (located === undefined) throw new Error('expected the server to be found');
    await expect(refreshMcpCatalogue(server, located.scope, located.host)).rejects.toMatchObject({
      code: 'egress-refused',
    });
  });
});

describe('the root on the remaining caller-named paths', () => {
  it('answers a dump file outside the root as host-path-outside-workspace', async () => {
    const root = tempDir('wirebench-dump-root-');
    const outcome = await runInPathRoot(root, () =>
      resolveDumpPath({ path: '/elsewhere/out.xml', projectDir: join(root, 'p') }, { hasWrite: () => true }),
    );
    expect(outcome).toMatchObject({ problem: { code: 'host-path-outside-workspace' } });
  });

  it("takes a relative proto path from the root, not the process's working directory", async () => {
    const root = tempDir('wirebench-proto-root-');
    mkdirSync(join(root, 'protos'));
    writeFileSync(join(root, 'protos', 'a.proto'), 'syntax = "proto3";\n');
    await expect(
      runInPathRoot(root, () => checkedProtoSource([root], undefined, { kind: 'folder', path: 'protos' })),
    ).resolves.toEqual({ kind: 'folder', path: join(root, 'protos') });
    await expect(
      runInPathRoot(root, () => checkedProtoSource([root], undefined, { kind: 'files', paths: ['protos/a.proto'] })),
    ).resolves.toEqual({ kind: 'files', paths: [join(root, 'protos', 'a.proto')] });
  });
});

describe('serveCall with an allowlist that throws', () => {
  it('answers an error rather than rejecting', async () => {
    const host = await started(createFakePlatform());
    await expect(
      serveCall(host, fakeCaller(1), { id: 9, channel: 'preferences.get', request: undefined }, () => {
        throw new Error('broken allowlist');
      }),
    ).resolves.toMatchObject({ id: 9, ok: false, error: { code: 'internal-error' } });
  });
});
