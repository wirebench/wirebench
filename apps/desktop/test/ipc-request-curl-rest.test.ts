// @vitest-environment node
/**
 * `request.curl` and `request.importCurl` for a REST request.
 *
 * One channel serves both protocols, dispatching on what the id names, so these tests pin the two
 * things that could go wrong at that seam: a REST id must not reach the SOAP path, and a secret must
 * not reach the command unless the session's show-secrets switch is on.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthConfig, RestSendInput } from '@wirebench/engine';
import { EngineService } from '../src/main/engine-service.js';
import { registerRequestChannels, type RequestChannelDeps } from '../src/main/ipc/request.js';
import type { ProjectChange } from '../src/shared/wire-types.js';
import { NO_REST, PROJECT_SETTINGS, restApiWire } from './helpers/wire-defaults.js';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
}));

function invoke(channel: string, payload: unknown): Promise<unknown> {
  const handler = handlers.get(channel);
  if (handler === undefined) {
    throw new Error(`${channel} was never registered`);
  }
  return handler({ sender: {} }, payload);
}

function unwrap<T>(result: unknown): T {
  const envelope = result as { ok: boolean; value?: T; error?: { code: string; message: string } };
  if (!envelope.ok) {
    throw new Error(`ipc failed: ${envelope.error?.code} ${envelope.error?.message}`);
  }
  return envelope.value as T;
}

/** A resolved REST send, as `ProjectRouter.restSend` would answer it. */
function resolution(overrides: { readonly auth?: AuthConfig; readonly unresolved?: readonly { expr: string }[] } = {}) {
  const input: RestSendInput = {
    baseUrl: 'https://api.test',
    request: {
      method: 'POST',
      url: '/pets',
      pathParams: [],
      query: [{ name: 'dry', value: 'true', enabled: true }],
      headers: [{ name: 'Content-Type', value: 'application/json', enabled: true }],
      body: { kind: 'raw', language: 'json', text: '{"name":"Fido"}' },
    },
    settings: { timeoutMs: 30_000, followRedirects: true },
  };
  return {
    input,
    unresolved: overrides.unresolved ?? [],
    api: restApiWire(),
    request: {},
    baseUrlSource: 'api',
    auth: overrides.auth ?? { type: 'none' },
  };
}

/** The project surface these two channels touch, and nothing more. */
function project(
  options: { readonly rest?: ReturnType<typeof resolution> | undefined; readonly changes?: ProjectChange[] } = {},
) {
  const changes = options.changes ?? [];
  return {
    changes,
    scopesFor: () => ({ project: {}, global: {}, env: {} }),
    preflight: () => undefined as never,
    authFor: () => undefined,
    requestMeta: () => undefined,
    projectId: () => 'p1',
    requestSource: () => undefined as never,
    buildLiveSendInput: () => undefined,
    sendInputFor: () => undefined,
    dumpFileFor: () => undefined,
    restSend: (requestId: string) => (requestId.startsWith('rest-') ? options.rest : undefined),
    projectSnapshot: () => ({
      ...NO_REST,
      settings: PROJECT_SETTINGS,
      id: 'p1',
      name: 'Demo',
      dir: '/tmp/demo',
      dirty: false,
      interfaces: [],
      requests: [],
      properties: {},
      disabledProperties: [],
      environments: [],
      problems: [],
      keystores: [],
      wssOutgoing: [],
      wssIncoming: [],
      apis: [restApiWire({ id: 'api-1', baseUrl: 'https://api.test' })],
    }),
    projectMutate: (_projectId: string, change: ProjectChange) => {
      changes.push(change);
      return Promise.resolve(
        change.kind === 'add-rest-request' ? { project: null, createdId: 'rest-new' } : { project: null },
      );
    },
  } as unknown as RequestChannelDeps['project'];
}

/** Registers the channels with a stub project and an optional show-secrets flag. */
function setup(options: {
  readonly rest?: ReturnType<typeof resolution> | undefined;
  readonly show?: boolean;
  readonly changes?: ProjectChange[];
  readonly secrets?: Record<string, string>;
  readonly stored?: { value: string; label: string }[];
}): void {
  handlers.clear();
  registerRequestChannels(new EngineService(), {
    project: project({
      ...(options.rest !== undefined ? { rest: options.rest } : {}),
      ...(options.changes !== undefined ? { changes: options.changes } : {}),
    }),
    adHocScopes: () => ({ project: {}, global: {}, system: {} }),
    showSecrets: { get: () => options.show ?? false },
    getSecret: (ref: string) => Promise.resolve(options.secrets?.[ref]),
    ...(options.stored !== undefined
      ? {
          storeSecret: (value: string, label: string) => {
            options.stored?.push({ value, label });
            return Promise.resolve(`sec_${String(options.stored?.length ?? 0)}`);
          },
        }
      : {}),
  });
}

beforeEach(() => {
  handlers.clear();
});

describe('request.curl for a REST request', () => {
  it('builds the command from the resolved send, not from the saved request', async () => {
    setup({ rest: resolution() });

    const result = unwrap<{ command: string }>(await invoke('request.curl', { requestId: 'rest-1', shell: 'posix' }));

    expect(result.command).toContain("curl --request POST 'https://api.test/pets?dry=true'");
    expect(result.command).toContain("--header 'Content-Type: application/json'");
    expect(result.command).toContain('--location');
    expect(result.command).toContain('{"name":"Fido"}');
  });

  it('masks a credential with show-secrets off, and never reads the keychain for it', async () => {
    const getSecret = vi.fn().mockResolvedValue('tok-live');
    handlers.clear();
    registerRequestChannels(new EngineService(), {
      project: project({ rest: resolution({ auth: { type: 'bearer', tokenRef: 'sec_1' } }) }),
      adHocScopes: () => ({ project: {}, global: {}, system: {} }),
      showSecrets: { get: () => false },
      getSecret,
    });

    const result = unwrap<{ command: string }>(await invoke('request.curl', { requestId: 'rest-1', shell: 'posix' }));

    expect(result.command).toContain("--header 'Authorization: <redacted>'");
    expect(result.command).not.toContain('tok-live');
    // The value is never needed to show the shape of the credential, so it is never asked for.
    expect(getSecret).not.toHaveBeenCalled();
  });

  it('resolves the credential for real when show-secrets is on', async () => {
    setup({
      rest: resolution({ auth: { type: 'bearer', tokenRef: 'sec_1' } }),
      show: true,
      secrets: { sec_1: 'tok-live' },
    });

    const result = unwrap<{ command: string }>(await invoke('request.curl', { requestId: 'rest-1', shell: 'posix' }));

    expect(result.command).toContain("--header 'Authorization: Bearer tok-live'");
  });

  it('notes what the command does not carry rather than carrying it', async () => {
    setup({
      rest: resolution({
        auth: {
          type: 'oauth2',
          grant: 'client-credentials',
          tokenUrl: 't',
          clientId: 'c',
          scopes: [],
          clientAuth: 'basic',
          pkce: false,
        },
      }),
    });

    const result = unwrap<{ command: string; notes?: string[] }>(
      await invoke('request.curl', { requestId: 'rest-1', shell: 'posix' }),
    );

    // An access token lives in main's memory for the session; a pasted command must not outlive it.
    expect(result.notes?.join(' ')).toContain('OAuth2 access token is not included');
    expect(result.command).not.toContain('Authorization');
  });

  it('says which properties are unresolved instead of refusing to export', async () => {
    setup({ rest: resolution({ unresolved: [{ expr: '${#Project#missing}' }] }) });

    const result = unwrap<{ notes?: string[] }>(await invoke('request.curl', { requestId: 'rest-1', shell: 'posix' }));

    expect(result.notes?.join(' ')).toContain('${#Project#missing}');
  });

  it('still answers unknown-request for an id no project holds', async () => {
    setup({});

    const envelope = (await invoke('request.curl', { requestId: 'nope', shell: 'posix' })) as {
      ok: boolean;
      error?: { code: string };
    };

    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe('unknown-request');
  });
});

describe('request.importCurl into an API', () => {
  it('creates the request, then patches it with everything the command described', async () => {
    const changes: ProjectChange[] = [];
    setup({ changes });

    const result = unwrap<{ requestId: string; problems: string[] }>(
      await invoke('request.importCurl', {
        command: `curl -X PUT 'https://api.test/pets/7?dry=true' -H 'Accept: application/json' -d '{"a":1}'`,
        target: { kind: 'rest', apiId: 'api-1' },
        name: 'Update pet',
      }),
    );

    expect(result.requestId).toBe('rest-new');
    expect(changes[0]).toMatchObject({ kind: 'add-rest-request', apiId: 'api-1', name: 'Update pet' });
    expect(changes[1]).toMatchObject({
      kind: 'update-rest-request',
      requestId: 'rest-new',
      patch: {
        method: 'PUT',
        // Split against the API's base URL, so the request follows its environment overrides.
        url: '/pets/7',
        query: [{ name: 'dry', value: 'true', enabled: true }],
      },
    });
  });

  it('puts the request in a folder when the target names one', async () => {
    const changes: ProjectChange[] = [];
    setup({ changes });

    await invoke('request.importCurl', {
      command: `curl https://api.test/pets`,
      target: { kind: 'rest', apiId: 'api-1', folderId: 'folder-9' },
    });

    expect(changes[0]).toMatchObject({ kind: 'add-rest-request', apiId: 'api-1', parentId: 'folder-9' });
  });

  it('records a -u username as Basic auth, with the reference the caller stored', async () => {
    const changes: ProjectChange[] = [];
    setup({ changes });

    const result = unwrap<{ basicUsername?: string }>(
      await invoke('request.importCurl', {
        command: `curl https://api.test/pets -u 'ada:hunter2'`,
        target: { kind: 'rest', apiId: 'api-1' },
        passwordRef: 'sec_42',
      }),
    );

    expect(result.basicUsername).toBe('ada');
    expect(changes[1]).toMatchObject({
      patch: { auth: { type: 'basic', username: 'ada', passwordRef: 'sec_42', preemptive: true } },
    });
    // The password itself never crossed this channel, so it cannot appear in what was written.
    expect(JSON.stringify(changes)).not.toContain('hunter2');
  });

  it('stores a -u password in the keychain and writes only its reference', async () => {
    const changes: ProjectChange[] = [];
    const stored: { value: string; label: string }[] = [];
    setup({ changes, stored });

    const result = unwrap<{ basicUsername?: string; passwordStored?: boolean }>(
      await invoke('request.importCurl', {
        command: `curl https://api.test/pets -u 'ada:hunter2'`,
        target: { kind: 'rest', apiId: 'api-1' },
      }),
    );

    expect(stored).toEqual([{ value: 'hunter2', label: 'cURL import: ada' }]);
    expect(result).toMatchObject({ basicUsername: 'ada', passwordStored: true });
    expect(changes[1]).toMatchObject({
      patch: { auth: { type: 'basic', username: 'ada', passwordRef: 'sec_1', preemptive: true } },
    });
    expect(JSON.stringify(changes)).not.toContain('hunter2');
  });

  it('stores nothing for a -u with no password, and says the password is still needed', async () => {
    const changes: ProjectChange[] = [];
    const stored: { value: string; label: string }[] = [];
    setup({ changes, stored });

    const result = unwrap<{ basicUsername?: string; passwordStored?: boolean }>(
      await invoke('request.importCurl', {
        command: `curl https://api.test/pets -u ada`,
        target: { kind: 'rest', apiId: 'api-1' },
      }),
    );

    expect(stored).toEqual([]);
    expect(result.basicUsername).toBe('ada');
    expect(result.passwordStored).toBeUndefined();
    expect(changes[1]).toMatchObject({ patch: { auth: { type: 'basic', username: 'ada', preemptive: true } } });
  });

  it('reports the flags it could not use', async () => {
    setup({});

    const result = unwrap<{ problems: string[] }>(
      await invoke('request.importCurl', {
        command: `curl --retry 3 https://api.test/pets`,
        target: { kind: 'rest', apiId: 'api-1' },
      }),
    );

    expect(result.problems).toContain('Ignored --retry');
  });
});
