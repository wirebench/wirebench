// @vitest-environment node
/**
 * `request.code`: a REST or SOAP request as code in another language, or as its `wirebench run` line.
 *
 * What must hold: the snippet is built from the resolved send (so it agrees with the wire), and with
 * show-secrets off no secret is read — each credential is an environment read of the variable the
 * CLI reads it from.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CODE_TARGETS,
  createApi,
  createInterface,
  createProject,
  createRequest,
  createRestRequest,
  DEFAULT_PREFERENCES,
} from '@wirebench/engine';
import type { AuthConfig, Project, SoapOwnerAuth } from '@wirebench/engine';
import { EngineService } from '../src/main/engine-service.js';
import { type RequestChannelDeps } from '../src/main/ipc/request.js';
import { GENERATED_CODE_TARGETS } from '@wirebench/wire/code-targets';
import { registerRequestChannelsWithKinds } from './helpers/kind-channels.js';
import { tableInto } from './helpers/ipc-table.js';
import { createHostState } from '../src/main/host/host-state.js';

const hostState = createHostState();

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
const table = tableInto(handlers, hostState.redactor);

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
}));

interface Answer {
  readonly command: string;
  readonly notes?: readonly string[];
}

async function code(payload: Record<string, unknown>): Promise<Answer> {
  const handler = handlers.get('request.code');
  if (handler === undefined) throw new Error('request.code was never registered');
  const result = (await handler({ sender: {} }, payload)) as {
    ok: boolean;
    value?: Answer;
    error?: { code: string; message: string };
  };
  if (!result.ok) throw Object.assign(new Error(result.error?.message), { code: result.error?.code });
  return result.value as Answer;
}

/** A project holding REST request `rest-1`: `POST https://api.test/pets/{id}` with a JSON body. */
function restProject(auth?: AuthConfig, url = '/pets'): Project {
  const request = createRestRequest('Create pet', {
    id: 'rest-1',
    slug: 'create-pet',
    method: 'POST',
    url,
    headers: [{ name: 'X-Trace', value: 'abc', enabled: true }],
    body: { kind: 'raw', language: 'json', text: '{"name":"Fido"}' },
    settings: { timeoutMs: 30_000, followRedirects: true },
    ...(auth !== undefined ? { auth } : {}),
  });
  const api = createApi('Petstore', {
    id: 'api-1',
    slug: 'petstore',
    baseUrl: 'https://api.test',
    requests: [request],
  });
  return {
    ...createProject('Demo', { id: 'p1' }),
    environments: [
      { id: 'env-dev', name: 'Dev', slug: 'dev', order: 0, endpoints: {}, properties: {}, disabledProperties: [] },
    ],
    containers: { rest: [api] },
  };
}

/** A project holding SOAP request `req-1` against `http://saved.test/calc`. */
function soapProject(auth?: SoapOwnerAuth): Project {
  const request = {
    ...createRequest('Add', {
      id: 'req-1',
      envelopeXml: '<e:Envelope xmlns:e="http://schemas.xmlsoap.org/soap/envelope/"><e:Body/></e:Envelope>',
      soapVersion: '1.1' as const,
      soapAction: 'urn:calc:Add',
    }),
    endpointUrl: 'http://saved.test/calc',
  };
  const created = createInterface('Calculator', {
    id: 'iface-1',
    slug: 'calculator',
    definitionUrl: 'http://127.0.0.1:1/calc?wsdl',
    cacheDefinition: false,
    operations: [{ name: 'Add', bindingName: '{urn:calc}B', slug: 'add', order: 0, requests: [request] }],
  });
  return {
    ...createProject('Demo', { id: 'p1' }),
    containers: { soap: [auth === undefined ? created : { ...created, auth }] },
  };
}

const getSecret = vi.fn((ref: string) =>
  Promise.resolve({ sec_tok: 'tok-live', sec_pw: 'pa55', sec_jwt: 'jwt-secret-0123456789-abcdefghijklmn' }[ref]),
);

function register(model: Project, options: { readonly show?: boolean; readonly environmentId?: string } = {}): void {
  handlers.clear();
  registerRequestChannelsWithKinds(table, new EngineService(getSecret), {
    hostState,
    project: {
      projectId: () => 'p1',
      requestMeta: () => undefined,
      scopesFor: () => ({ project: {}, global: {}, env: {} }),
      runContextFor: () => ({
        project: model,
        projectDir: '/work/demo project',
        ...(options.environmentId !== undefined ? { environmentId: options.environmentId } : {}),
      }),
      defaultWsaActionFor: () => undefined,
    } as unknown as RequestChannelDeps['project'],
    adHocScopes: () => ({ project: {}, global: {}, system: {} }),
    showSecrets: { get: () => options.show ?? false },
    getSecret,
    preferences: { get: () => DEFAULT_PREFERENCES },
  });
}

beforeEach(() => {
  getSecret.mockClear();
});

describe('request.code for a REST request', () => {
  it('builds the snippet from the resolved send', async () => {
    register(restProject());
    const { command } = await code({ requestId: 'rest-1', target: 'python-requests' });
    expect(command).toContain("'https://api.test/pets',");
    expect(command).toContain("'X-Trace': 'abc',");
    expect(command).toContain("'Content-Type': 'application/json',");
    expect(command).toContain('allow_redirects=True,');
    expect(command).toContain('timeout=30,');
  });

  it('reads a credential from the variable the CLI reads it from, never from the keychain', async () => {
    register(restProject({ type: 'bearer', tokenRef: 'sec_tok', tokenEnv: 'API_TOKEN' }));
    const { command } = await code({ requestId: 'rest-1', target: 'js-fetch' });
    expect(command).toContain("'Authorization': 'Bearer ' + process.env.WIREBENCH_SECRET_API_TOKEN,");
    expect(command).not.toContain('tok-live');
    expect(getSecret).not.toHaveBeenCalled();
  });

  it('carries the resolved value with show-secrets on', async () => {
    register(restProject({ type: 'bearer', tokenRef: 'sec_tok' }), { show: true });
    const { command } = await code({ requestId: 'rest-1', target: 'js-fetch' });
    expect(command).toContain("'Authorization': 'Bearer tok-live',");
  });

  it('turns a ${secret:name} token into an environment read', async () => {
    register(restProject(undefined, '/pets/${secret:petId}'));
    const { command, notes } = await code({ requestId: 'rest-1', target: 'go-net-http' });
    expect(command).toContain('"https://api.test/pets/" + os.Getenv("WIREBENCH_SECRET_PETID")');
    expect(notes ?? []).toEqual([]);
  });

  it('masks a value the masker has recorded unless show-secrets is on', async () => {
    hostState.redactor.recordSecretValue('rec-code-secret-337');
    register(restProject(undefined, '/pets/rec-code-secret-337'));
    expect((await code({ requestId: 'rest-1', target: 'httpie' })).command).not.toContain('rec-code-secret-337');
    register(restProject(undefined, '/pets/rec-code-secret-337'), { show: true });
    expect((await code({ requestId: 'rest-1', target: 'httpie' })).command).toContain('rec-code-secret-337');
  });

  it('applies the per-language settings', async () => {
    register(restProject());
    const { command } = await code({
      requestId: 'rest-1',
      target: 'python-requests',
      settings: { indent: 2, followRedirects: false, timeoutMs: 0 },
    });
    expect(command).toContain('\n  allow_redirects=False,');
    expect(command).not.toContain('timeout=');
  });

  it('notes a credential it does not carry', async () => {
    register(restProject({ type: 'kerberos', username: 'alice', domain: 'CORP' }));
    const { command, notes } = await code({ requestId: 'rest-1', target: 'csharp-httpclient' });
    expect(command).not.toContain('Authorization');
    expect(notes?.join(' ')).toContain('Kerberos is not included');
  });

  it('carries a JWT signed now with show-secrets on, and says when it expires', async () => {
    const jwt: AuthConfig = {
      type: 'jwt',
      algorithm: 'HS256',
      secretRef: 'sec_jwt',
      claims: '{"sub":"code-337"}',
      issuedAt: true,
      expiresInSeconds: 600,
      jwtId: false,
      in: 'header',
    };
    register(restProject(jwt), { show: true });
    const shown = await code({ requestId: 'rest-1', target: 'js-fetch' });
    const token = /'Authorization': 'Bearer ([\w-]+\.[\w-]+\.[\w-]+)'/u.exec(shown.command)?.[1] ?? '';
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as {
      sub?: string;
    };
    expect(payload.sub).toBe('code-337');
    expect(shown.notes?.join(' ')).toMatch(/signed now and expires at \d{4}-/u);

    getSecret.mockClear();
    register(restProject(jwt));
    const hidden = await code({ requestId: 'rest-1', target: 'js-fetch' });
    expect(hidden.command).not.toContain(token);
    expect(hidden.notes?.join(' ')).toContain('show secrets');
    expect(getSecret).not.toHaveBeenCalled();
  });

  it.each([
    [{ type: 'digest', username: 'admin', passwordRef: 'sec_pw' }, 'Digest is not included'],
    [
      { type: 'aws-sigv4', region: 'eu-west-1', service: 'execute-api', accessKeyIdRef: 'a', secretAccessKeyRef: 'b' },
      'AWS Signature v4 is not included',
    ],
  ] as const)('notes %o as not carried', async (auth, note) => {
    register(restProject(auth));
    const { command, notes } = await code({ requestId: 'rest-1', target: 'python-requests' });
    expect(command).not.toContain('Authorization');
    expect(notes?.join(' ')).toContain(note);
  });

  it('describes the unsaved draft, as the curl export does', async () => {
    register(restProject());
    const { command } = await code({ requestId: 'rest-1', target: 'node-axios', draft: { method: 'PUT' } });
    expect(command).toContain("method: 'put',");
  });
});

describe('request.code for a SOAP request', () => {
  it('posts the envelope with the SOAP headers and Basic read from the environment', async () => {
    register(soapProject({ type: 'basic', username: 'ada', passwordRef: 'sec_pw' }));
    const { command } = await code({ requestId: 'req-1', target: 'python-requests' });
    expect(command).toContain("'http://saved.test/calc',");
    expect(command).toContain("'SOAPAction': '\"urn:calc:Add\"',");
    expect(command).toContain("auth=('ada', os.environ['WIREBENCH_SECRET_SEC_PW']),");
    expect(command).toContain('<e:Body/>');
    expect(getSecret).not.toHaveBeenCalled();
  });
});

describe('request.code — wirebench run', () => {
  it('names the project, the request and the active environment', async () => {
    register(restProject(), { environmentId: 'env-dev' });
    const { command, notes } = await code({ requestId: 'rest-1', target: 'wirebench-run' });
    expect(command).toBe("wirebench run '/work/demo project' 'apis/petstore/requests/create-pet' --env 'dev'");
    expect(notes).toEqual(['Runs the request as saved; unsaved edits are not included.']);
  });

  it('leaves the environment out when none is active', async () => {
    register(restProject());
    expect((await code({ requestId: 'rest-1', target: 'wirebench-run' })).command).not.toContain('--env');
  });
});

describe('the shared target list', () => {
  it('matches the engine’s, id for id and in order', () => {
    expect(GENERATED_CODE_TARGETS.map((target) => [target.id, target.label])).toEqual(
      CODE_TARGETS.map((target) => [target.id, target.label]),
    );
  });
});
