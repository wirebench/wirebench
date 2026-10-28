// @vitest-environment node
/**
 * What a second embedder (the Wirebench Server, hosted edition spec §17.3) needs from the host: its
 * capabilities decide the areas and channels, a host without `files` opens server workspaces only, a
 * root holds every caller-named path inside it, a host without machine values reads nothing from the
 * process environment, the egress rule reaches the host's own connections, and `HostOptions` carries the
 * in-process server transport and a by-name secret hook.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startTestRestServer, type TestRestServer } from '@wirebench/engine/test-helpers';
import {
  createApi,
  createProject,
  createRestRequest,
  DEFAULT_PREFERENCES,
  expand,
  probeTlsChain,
  type EgressPolicy,
  type GetSecret,
  type HttpExchange,
  type HttpRequest,
  type OAuth2Auth,
  type Project,
} from '@wirebench/engine';
import { DialogPicks } from '../../src/dialog-picks.js';
import { EngineService } from '../../src/engine-service.js';
import { createHost, type Host, type HostOptions, type SecretEvent } from '../../src/host/create-host.js';
import { createHostState } from '../../src/host/host-state.js';
import { ALL_CAPABILITIES, type Capability, type HostPlatform } from '../../src/host/platform.js';
import { toSendDeps, type RequestChannelDeps } from '../../src/ipc/request.js';
import { createNativeDialogs } from '../../src/native-dialogs.js';
import { mainHttpOptions } from '../../src/network-options.js';
import { OAuth2Service } from '../../src/oauth2.js';
import { allowsReadPath, checkedImportSource, resolveInside, runInPathRoot } from '../../src/path-access.js';
import { ProjectHost } from '../../src/project-host.js';
import { sendThroughEngine } from '../../src/send/exchange.js';
import { extraTrustAnchors } from '../../src/send/host.js';
import { serveCall } from '../../src/host/serve-call.js';
import { createFakePlatform, createHeadlessPlatform, fakeCaller } from '../helpers/fake-platform.js';

const EGRESS: EgressPolicy = { denyPrivate: false };

const hosts: Host[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.shutdown();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function started(platform: HostPlatform, options: HostOptions = {}): Promise<Host> {
  const host = await createHost(platform, options);
  hosts.push(host);
  return host;
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** Every capability but `missing`. */
function capabilitiesWithout(...missing: Capability[]): ReadonlySet<Capability> {
  return new Set(ALL_CAPABILITIES.filter((capability) => !missing.includes(capability)));
}

/** Runs `channel` as `caller`, attaching it first if this host has not seen it. */
async function call(host: Host, channel: string, request: unknown, id = 1): Promise<unknown> {
  const caller = fakeCaller(id);
  host.attach(caller);
  return await serveCall(host, caller, { id: 1, channel, request });
}

/** Sets environment variables for one test, putting the old values back after. */
function withEnv(values: Readonly<Record<string, string>>): () => void {
  const saved = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  Object.assign(process.env, values);
  return () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

describe('capabilities decide the areas', () => {
  it('turns the SSH area and the local terminal off without `ssh`, and registers none of their channels', async () => {
    const host = await started(createHeadlessPlatform());
    const areas = (await call(host, 'app.areas', undefined)) as {
      value: { enabled: string[]; localTerminal: boolean };
    };
    expect(areas.value.enabled).not.toContain('ssh');
    expect(areas.value.localTerminal).toBe(false);
    for (const channel of ['ssh.connect', 'sftp.list', 'localTerminal.open', 'terminalShare.start']) {
      expect(host.handlers.has(channel), channel).toBe(false);
    }
  });

  it('turns only the local terminal off without `pty`', async () => {
    const host = await started(createFakePlatform({ capabilities: capabilitiesWithout('pty') }));
    const areas = (await call(host, 'app.areas', undefined)) as {
      value: { enabled: string[]; localTerminal: boolean };
    };
    expect(areas.value.enabled).toContain('ssh');
    expect(areas.value.localTerminal).toBe(false);
    expect(host.handlers.has('ssh.connect')).toBe(true);
    expect(host.handlers.has('localTerminal.open')).toBe(false);
  });
});

describe('a host without `files`', () => {
  it('registers no fs, git or secret-source channels, even with dialogs', async () => {
    const full = await started(createFakePlatform());
    const noFiles = await started(createFakePlatform({ capabilities: capabilitiesWithout('files') }));
    const missing = [...full.handlers.keys()].filter((name) => !noFiles.handlers.has(name));
    expect(missing.filter((name) => !/^(fs|git|secretSources)\./.test(name))).toEqual([]);
    expect(missing).toEqual(expect.arrayContaining(['fs.openText', 'git.detect', 'secretSources.get']));
    expect(noFiles.handlers.has('dialogs.openFile')).toBe(true);
  });

  it('refuses to create a workspace: a new one is local', async () => {
    const host = await started(createHeadlessPlatform());
    await expect(call(host, 'workspace.create', { name: 'Mine' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'host-capability-missing', details: { capability: 'files' } },
    });
  });

  it('refuses to open a local workspace and leaves nothing open', async () => {
    const userData = tempDir('wirebench-headless-');
    const desktop = await started(createFakePlatform({ userData }));
    const created = (await call(desktop, 'workspace.create', { name: 'Local' })) as {
      value: { workspace: { id: string } };
    };
    await desktop.shutdown();
    hosts.splice(hosts.indexOf(desktop), 1);

    const host = await started(createHeadlessPlatform({ userData }));
    await expect(call(host, 'workspace.open', { workspaceId: created.value.workspace.id })).resolves.toMatchObject({
      ok: false,
      error: { code: 'host-capability-missing', details: { capability: 'files' } },
    });
    await expect(call(host, 'workspace.snapshot', undefined)).resolves.toEqual({
      id: 1,
      ok: true,
      value: { workspace: null },
    });
  });
});

describe('the path root', () => {
  let root: string;
  let outside: string;

  beforeAll(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'wirebench-root-')));
    outside = realpathSync.native(mkdtempSync(join(tmpdir(), 'wirebench-outside-')));
    mkdirSync(join(root, 'inner'));
    writeFileSync(join(root, 'inner', 'schema.graphql'), 'type Query { a: Int }\n');
    writeFileSync(join(outside, 'secret.txt'), 'not yours\n');
    symlinkSync(outside, join(root, 'out-link'));
    symlinkSync(join(root, 'inner'), join(root, 'in-link'));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('resolves a path inside the root, relative or absolute, and a missing tail', async () => {
    await expect(resolveInside(root, 'inner/schema.graphql')).resolves.toBe(join(root, 'inner', 'schema.graphql'));
    await expect(resolveInside(root, join(root, 'inner'))).resolves.toBe(join(root, 'inner'));
    await expect(resolveInside(root, 'in-link/schema.graphql')).resolves.toBe(join(root, 'inner', 'schema.graphql'));
    await expect(resolveInside(root, 'inner/new/file.txt')).resolves.toBe(join(root, 'inner', 'new', 'file.txt'));
  });

  it('refuses `..`, an absolute path elsewhere and a symbolic link out', async () => {
    for (const path of ['../x', 'inner/../../x', join(outside, 'secret.txt'), 'out-link/secret.txt', '/etc/hosts']) {
      await expect(resolveInside(root, path), path).rejects.toMatchObject({
        code: 'host-path-outside-workspace',
        details: { path },
      });
    }
  });

  it('never names where a link led in the refusal', async () => {
    const refusal = await resolveInside(root, 'out-link/secret.txt').catch((error: unknown) => error as Error);
    expect(refusal.message).not.toContain(outside);
  });

  it('holds the read checks to the root, picks included, and a `file:` URL with them', async () => {
    const picks = new DialogPicks();
    picks.rememberRead(join(outside, 'secret.txt'));
    await runInPathRoot(root, async () => {
      await expect(allowsReadPath([], picks, join(outside, 'secret.txt'))).rejects.toMatchObject({
        code: 'host-path-outside-workspace',
      });
      await expect(
        checkedImportSource([], picks, { kind: 'url', url: pathToFileURL(join(outside, 'secret.txt')).href }),
      ).rejects.toMatchObject({ code: 'host-path-outside-workspace' });
      // Inside the root a path still needs a project folder or a pick, as on the desktop.
      await expect(
        checkedImportSource([], picks, { kind: 'file', path: 'inner/schema.graphql' }),
      ).rejects.toMatchObject({ code: 'import-path-refused' });
      await expect(checkedImportSource([root], picks, { kind: 'file', path: 'inner/schema.graphql' })).resolves.toEqual(
        {
          kind: 'file',
          path: join(root, 'inner', 'schema.graphql'),
        },
      );
    });
    // Without a root the pick is evidence enough, as it always was.
    await expect(allowsReadPath([], picks, join(outside, 'secret.txt'))).resolves.toBe(true);
  });

  it("refuses a caller's path outside the host's root before anything reads it", async () => {
    const host = await started(
      createHeadlessPlatform({ paths: { userData: () => root, temp: tmpdir, logs: tmpdir, root: () => root } }),
    );
    for (const path of [join(outside, 'secret.txt'), join(root, 'out-link', 'secret.txt'), '../x']) {
      await expect(call(host, 'api.importGraphqlSchema', { apiId: 'a', path }), path).resolves.toMatchObject({
        ok: false,
        error: { code: 'host-path-outside-workspace' },
      });
    }
    // One inside passes the root, and is then refused as on the desktop: no project holds it.
    await expect(
      call(host, 'api.importGraphqlSchema', { apiId: 'a', path: join(root, 'inner', 'schema.graphql') }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'import-path-refused' } });
  });

  it('leaves a desktop host, which has no root, as it was', async () => {
    const host = await started(createFakePlatform());
    await expect(
      call(host, 'api.importGraphqlSchema', { apiId: 'a', path: join(outside, 'secret.txt') }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'import-path-refused' } });
  });
});

describe('a host without machine values', () => {
  it('expands `${#System#HOME}` to nothing and hands a send an empty system scope', async () => {
    const dir = tempDir('wirebench-system-');
    const project = new ProjectHost(new EngineService(), { hostState: createHostState({ machineValues: false }) });
    await project.create({ dir: join(dir, 'p'), name: 'P' });
    try {
      const text = expand('[${#System#HOME}]', project.scopesFor()).text;
      expect(text).not.toContain(homedir());
      expect(project.runContextFor('any')?.system).toEqual({});
    } finally {
      await project.close();
    }
  });

  it('starts with no e2e trust anchors, whatever the environment says', () => {
    const restore = withEnv({ WIREBENCH_E2E_EXTRA_CA_FILE: __filename });
    try {
      expect(extraTrustAnchors(createHostState({ machineValues: false }))).toEqual([]);
    } finally {
      restore();
    }
  });

  it('reads neither `WIREBENCH_AREAS` nor a policy file the environment names', async () => {
    const dir = tempDir('wirebench-policy-');
    const policy = join(dir, 'policy.yaml');
    writeFileSync(policy, 'areas:\n  serial: false\n', 'utf8');
    const restore = withEnv({ WIREBENCH_AREAS: 'ssh=off', WIREBENCH_POLICY_FILE: policy });
    try {
      const desktop = await started(createFakePlatform());
      expect(desktop.handlers.has('ssh.connect')).toBe(false);
      const server = await started(createFakePlatform({ machineValues: false }));
      expect(server.handlers.has('ssh.connect')).toBe(true);
      const areas = (await call(server, 'app.areas', undefined)) as { value: { serial?: boolean } };
      expect(areas.value.serial).toBe(true);
    } finally {
      restore();
    }
  });

  it('answers no native dialog from the e2e overrides', () => {
    const restore = withEnv({ WIREBENCH_E2E_DIALOG_SAVE: '/tmp/anywhere.xml' });
    try {
      expect(createNativeDialogs(createFakePlatform()).saveOverride()).toBe('/tmp/anywhere.xml');
      expect(createNativeDialogs(createFakePlatform({ machineValues: false })).saveOverride()).toBeUndefined();
    } finally {
      restore();
    }
  });
});

describe('the egress rule reaches what the host connects to', () => {
  let server: TestRestServer;

  beforeAll(async () => {
    server = await startTestRestServer();
  });

  afterAll(async () => {
    await server.close();
  });

  /** A project with one REST request at the test server, which is on loopback. */
  function seeded(): Project {
    const api = createApi('Local', {
      id: 'api-1',
      baseUrl: server.url,
      requests: [createRestRequest('Echo', { id: 'req-1', url: '/echo?k=${secret:api_token}' })],
    });
    return { ...createProject('Demo', { id: 'p1' }), containers: { rest: [api] } };
  }

  function sendDeps(extra: Partial<RequestChannelDeps>) {
    const model = seeded();
    const deps: RequestChannelDeps = {
      hostState: createHostState(),
      project: {
        projectId: () => 'p1',
        restMeta: () => undefined,
        runContextFor: () => ({ project: model, projectDir: tmpdir(), globals: {} }),
      } as unknown as RequestChannelDeps['project'],
      ...extra,
    };
    return toSendDeps(new EngineService(), deps);
  }

  it('refuses a send to a loopback address, and names the request host to the secret getter', async () => {
    const targets: (string | undefined)[] = [];
    const getter: GetSecret = () => Promise.resolve('k-value');
    const deps = sendDeps({
      egress: EGRESS,
      secretsFor: (_projectId, target) => {
        targets.push(target);
        return getter;
      },
    });
    await expect(sendThroughEngine(deps, 's1', 'req-1', { draft: { kind: 'rest' } })).rejects.toMatchObject({
      code: 'egress-refused',
    });
    expect(targets).toContain(new URL(server.url).hostname);
  });

  it('sends as before without a rule', async () => {
    const deps = sendDeps({ secretsFor: () => () => Promise.resolve('k-value') });
    await expect(sendThroughEngine(deps, 's2', 'req-1', { draft: { kind: 'rest' } })).resolves.toBeDefined();
  });

  it('refuses an OAuth2 token request to a loopback address', async () => {
    const config: OAuth2Auth = {
      type: 'oauth2',
      grant: 'client-credentials',
      tokenUrl: `${server.url}/oauth2/token`,
      clientId: 'app',
      clientSecretRef: 'sec_client',
      scopes: ['read'],
      clientAuth: 'basic',
      pkce: false,
    };
    const oauth2 = new OAuth2Service({ openExternal: () => Promise.resolve(), egress: EGRESS });
    await expect(oauth2.accessToken(config, { credentials: { clientSecret: 's' } })).rejects.toMatchObject({
      code: 'egress-refused',
    });
  });

  it("puts the rule in main's own send options, for the server client and definition fetches", async () => {
    const preferences = DEFAULT_PREFERENCES;
    await expect(
      mainHttpOptions('https://example.test', {
        preferences: () => preferences,
        getSecret: () => Promise.resolve(undefined),
        egress: EGRESS,
      }),
    ).resolves.toEqual({ egress: EGRESS });
    await expect(
      mainHttpOptions('https://example.test', {
        preferences: () => preferences,
        getSecret: () => Promise.resolve(undefined),
      }),
    ).resolves.toEqual({});
  });

  it('refuses a certificate probe of a loopback endpoint, by address or by name', async () => {
    const { port } = new URL(server.url);
    await expect(probeTlsChain({ host: '127.0.0.1', port: Number(port) }, { egress: EGRESS })).rejects.toMatchObject({
      code: 'egress-refused',
    });
    await expect(probeTlsChain({ host: 'localhost', port: Number(port) }, { egress: EGRESS })).rejects.toMatchObject({
      code: 'egress-refused',
    });
  });
});

describe('HostOptions for an embedder inside a server', () => {
  it("sends the host's server calls through `server.send`, and none to another server", async () => {
    const sent: HttpRequest[] = [];
    const send = (request: HttpRequest): Promise<HttpExchange> => {
      sent.push(request);
      return Promise.reject(new Error('no server here'));
    };
    const host = await started(createHeadlessPlatform(), {
      server: {
        url: 'https://wb.example.test',
        send,
        connectLive: () => {
          throw new Error('unused');
        },
        credential: () => undefined,
      },
    });
    await call(host, 'account.probe', { url: 'https://wb.example.test' });
    await expect(call(host, 'account.probe', { url: 'https://elsewhere.example.test' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'server-unreachable' },
    });
    expect(sent.map((request) => request.url)).toEqual(['https://wb.example.test/api/v1/meta']);
  });

  it('tells `onSecret` the name of each stored value, never the value', async () => {
    const events: SecretEvent[] = [];
    const host = await started(createFakePlatform(), { onSecret: (event) => events.push(event) });
    const set = (await call(host, 'secrets.set', {
      value: 'hunter2-value',
      label: 'wirebench-secret:p1:api_token',
    })) as { value: { ref: string } };
    await call(host, 'secrets.replace', { ref: set.value.ref, value: 'hunter3-value' });
    expect(events).toEqual([
      { kind: 'written', name: 'api_token' },
      { kind: 'written', name: 'api_token' },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/hunter/);
  });

  it('keeps the desktop as it is: no root, machine values, every capability', () => {
    const platform = createFakePlatform();
    expect('root' in platform.paths).toBe(false);
    expect(platform.machineValues).toBeUndefined();
    expect([...platform.capabilities].sort()).toEqual([...ALL_CAPABILITIES].sort());
  });
});
