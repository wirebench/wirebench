// @vitest-environment node
/**
 * `request.curl` for a SOAP request, pinned whole: the command a send of the saved request would
 * perform, its properties expanded, its WS-Addressing applied and its owner's credentials on it —
 * masked, with no secret read, unless the session shows secrets — and a `${secret:name}` token kept
 * as typed, since an export never reads one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInterface, createProject, createRequest, DEFAULT_PREFERENCES, soapItemFor } from '@wirebench/engine';
import type { Project, SoapOwnerAuth, SoapRequestDef } from '@wirebench/engine';
import { EngineService } from '../src/main/engine-service.js';
import { registerRequestChannels, type RequestChannelDeps } from '../src/main/ipc/request.js';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
}));

async function curl(requestId = 'req-1', shell = 'posix'): Promise<{ command: string; notes?: string[] }> {
  const result = (await handlers.get('request.curl')!({ sender: {} }, { requestId, shell })) as {
    ok: boolean;
    value?: { command: string; notes?: string[] };
    error?: { code: string; message: string };
  };
  if (!result.ok) {
    throw Object.assign(new Error(result.error?.message), { code: result.error?.code });
  }
  return result.value!;
}

const ENVELOPE =
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Header/>' +
  '<soapenv:Body><Add><who>${#Project#who}</who><key>${secret:apiKey}</key><x>${nothing}</x></Add></soapenv:Body>' +
  '</soapenv:Envelope>';

/** One interface holding `req-1`; the environment maps the interface to `http://dev.test`. */
function seeded(extra: Partial<SoapRequestDef> = {}, auth?: SoapOwnerAuth): Project {
  const request: SoapRequestDef = {
    ...createRequest('Add', {
      id: 'req-1',
      envelopeXml: ENVELOPE,
      soapVersion: '1.1',
      soapAction: 'urn:calc:Add',
      headers: [
        { name: 'X-Who', value: '${#Project#who}' },
        { name: 'X-Token', value: '${secret:apiKey}' },
      ],
    }),
    endpointUrl: 'http://saved.test/calc',
    ...extra,
  };
  const created = createInterface('Calculator', {
    id: 'iface-1',
    slug: 'calculator',
    definitionUrl: 'http://127.0.0.1:1/calc?wsdl',
    cacheDefinition: false,
    operations: [{ name: 'Add', bindingName: '{urn:calc}B', slug: 'add', order: 0, requests: [request] }],
  });
  const iface = auth === undefined ? created : { ...created, auth };
  return {
    ...createProject('Demo', { id: 'p1' }),
    properties: { who: 'ada' },
    environments: [
      {
        id: 'env-dev',
        name: 'dev',
        slug: 'dev',
        order: 0,
        endpoints: { calculator: 'http://dev.test/calc.asmx' },
        properties: {},
        disabledProperties: [],
      },
    ],
    activeEnvironmentId: 'env-dev',
    containers: { soap: [iface] },
  };
}

const secrets: Record<string, string> = { sec_pw: 'pa55', sec_token: 'tok-s3cret', sec_key: 'my key' };

/** The project surface `request.curl` reads, answering from `model` as the app's project does. */
function project(model: Project) {
  const item = (id: string) => soapItemFor(model, id);
  return {
    projectId: () => model.id,
    requestMeta: () => undefined,
    runContextFor: () => ({ project: model, projectDir: '/tmp/none', environmentId: model.activeEnvironmentId }),
    defaultWsaActionFor: () => 'urn:calc:DefaultAdd',
    hasOutgoingWss: (id: string) => (item(id)?.request.wssOutgoingRef ?? '') !== '',
  } as unknown as RequestChannelDeps['project'];
}

let showSecrets: boolean;
let cached: string | undefined;
const read = vi.fn((ref: string) => Promise.resolve(secrets[ref]));
const accessToken = vi.fn(() => Promise.resolve('fetched-token'));

function registerOver(model: Project): void {
  handlers.clear();
  registerRequestChannels(new EngineService(read), {
    project: project(model),
    showSecrets: { get: () => showSecrets },
    getSecret: read,
    preferences: { get: () => DEFAULT_PREFERENCES },
    oauth2: {
      accessToken,
      status: () => (cached === undefined ? { state: 'none' } : { state: 'valid', token: cached }),
    },
  });
}

/** A minted `wsa:MessageID` differs on every export. */
const steady = (command: string): string => command.replace(/urn:uuid:[0-9a-f-]{36}/g, 'urn:uuid:-');

beforeEach(() => {
  showSecrets = false;
  cached = undefined;
  read.mockClear();
  accessToken.mockClear();
});

describe('request.curl for a SOAP request', () => {
  it('pins the command: properties expanded, a secret token as typed, basic credentials masked, nothing read', async () => {
    registerOver(seeded({}, { type: 'basic', username: 'ada', passwordRef: 'sec_pw' }));
    expect(await curl()).toEqual({
      command: [
        "curl --request POST 'http://dev.test/calc.asmx' \\",
        "  --header 'Content-Type: text/xml;charset=UTF-8' \\",
        '  --header \'SOAPAction: "urn:calc:Add"\' \\',
        "  --header 'X-Who: ada' \\",
        "  --header 'X-Token: ${secret:apiKey}' \\",
        "  --header 'User-Agent: Wirebench/0.1' \\",
        "  --header 'Accept-Encoding: gzip, deflate' \\",
        "  --header 'Authorization: <redacted>' \\",
        "  --data-binary @- <<'EOF'",
        '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Header/><soapenv:Body><Add><who>ada</who><key>${secret:apiKey}</key><x>${nothing}</x></Add></soapenv:Body></soapenv:Envelope>',
        'EOF',
      ].join('\n'),
    });
    expect(read).not.toHaveBeenCalled();
  });

  it('pins the command with show-secrets: the credentials read and shown, the token still as typed', async () => {
    showSecrets = true;
    registerOver(seeded({}, { type: 'basic', username: 'ada', passwordRef: 'sec_pw' }));
    expect(await curl()).toEqual({
      command: [
        "curl --request POST 'http://dev.test/calc.asmx' \\",
        "  --header 'Content-Type: text/xml;charset=UTF-8' \\",
        '  --header \'SOAPAction: "urn:calc:Add"\' \\',
        "  --header 'X-Who: ada' \\",
        "  --header 'X-Token: ${secret:apiKey}' \\",
        "  --header 'User-Agent: Wirebench/0.1' \\",
        "  --header 'Accept-Encoding: gzip, deflate' \\",
        "  --header 'Authorization: Basic YWRhOnBhNTU=' \\",
        "  --data-binary @- <<'EOF'",
        '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Header/><soapenv:Body><Add><who>ada</who><key>${secret:apiKey}</key><x>${nothing}</x></Add></soapenv:Body></soapenv:Envelope>',
        'EOF',
      ].join('\n'),
    });
  });

  it('masks the credentials whether or not the keychain holds their secret, reading nothing, while secrets are hidden', async () => {
    // The export never reads a secret while they are hidden, so it cannot know one is missing: Basic
    // and a token scheme both go out masked, as the REST export's do. (The old export left a Basic
    // header out, and failed a token scheme with secret-missing.)
    for (const auth of [
      { type: 'basic', username: 'ada', passwordRef: 'sec_gone' },
      { type: 'bearer', tokenRef: 'sec_gone' },
    ] as const) {
      registerOver(seeded({}, auth));
      const { command } = await curl();
      expect(command.split('\n')).toContain("  --header 'Authorization: <redacted>' \\");
    }
    expect(read).not.toHaveBeenCalled();
  });

  it('pins a query API key, masked in the URL', async () => {
    registerOver(seeded({}, { type: 'api-key', name: 'api key', valueRef: 'sec_key', in: 'query' }));
    expect(await curl()).toEqual({
      command: [
        "curl --request POST 'http://dev.test/calc.asmx?api+key=%3Credacted%3E' \\",
        "  --header 'Content-Type: text/xml;charset=UTF-8' \\",
        '  --header \'SOAPAction: "urn:calc:Add"\' \\',
        "  --header 'X-Who: ada' \\",
        "  --header 'X-Token: ${secret:apiKey}' \\",
        "  --header 'User-Agent: Wirebench/0.1' \\",
        "  --header 'Accept-Encoding: gzip, deflate' \\",
        "  --data-binary @- <<'EOF'",
        '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Header/><soapenv:Body><Add><who>ada</who><key>${secret:apiKey}</key><x>${nothing}</x></Add></soapenv:Body></soapenv:Envelope>',
        'EOF',
      ].join('\n'),
    });
    expect(read).not.toHaveBeenCalled();
  });

  it('pins a bearer token with show-secrets', async () => {
    showSecrets = true;
    registerOver(seeded({}, { type: 'bearer', tokenRef: 'sec_token' }));
    expect(await curl()).toEqual({
      command: [
        "curl --request POST 'http://dev.test/calc.asmx' \\",
        "  --header 'Content-Type: text/xml;charset=UTF-8' \\",
        '  --header \'SOAPAction: "urn:calc:Add"\' \\',
        "  --header 'X-Who: ada' \\",
        "  --header 'X-Token: ${secret:apiKey}' \\",
        "  --header 'User-Agent: Wirebench/0.1' \\",
        "  --header 'Accept-Encoding: gzip, deflate' \\",
        "  --header 'Authorization: Bearer tok-s3cret' \\",
        "  --data-binary @- <<'EOF'",
        '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Header/><soapenv:Body><Add><who>ada</who><key>${secret:apiKey}</key><x>${nothing}</x></Add></soapenv:Body></soapenv:Envelope>',
        'EOF',
      ].join('\n'),
    });
  });

  it('pins the WS-Addressing headers a send would write, and the WS-Security note', async () => {
    registerOver(
      seeded({
        wsa: {
          enabled: true,
          version: '2005/08',
          mustUnderstand: 'none',
          addDefaultAction: true,
          addDefaultTo: true,
          generateMessageId: true,
        },
        wssOutgoingRef: 'wss-1',
      }),
    );
    const exported = await curl();
    expect({ ...exported, command: steady(exported.command) }).toEqual({
      command: [
        "curl --request POST 'http://dev.test/calc.asmx' \\",
        "  --header 'Content-Type: text/xml;charset=UTF-8' \\",
        '  --header \'SOAPAction: "urn:calc:Add"\' \\',
        "  --header 'X-Who: ada' \\",
        "  --header 'X-Token: ${secret:apiKey}' \\",
        "  --header 'User-Agent: Wirebench/0.1' \\",
        "  --header 'Accept-Encoding: gzip, deflate' \\",
        "  --data-binary @- <<'EOF'",
        '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Header><wsa:Action xmlns:wsa="http://www.w3.org/2005/08/addressing">urn:calc:Add</wsa:Action><wsa:To xmlns:wsa="http://www.w3.org/2005/08/addressing">http://dev.test/calc.asmx</wsa:To><wsa:MessageID xmlns:wsa="http://www.w3.org/2005/08/addressing">urn:uuid:-</wsa:MessageID></soapenv:Header><soapenv:Body><Add><who>ada</who><key>${secret:apiKey}</key><x>${nothing}</x></Add></soapenv:Body></soapenv:Envelope>',
        'EOF',
      ].join('\n'),
      notes: ['WS-Security is not included in the cURL command.'],
    });
  });

  it('pins an OAuth2 owner with no cached token, and one with', async () => {
    showSecrets = true;
    registerOver(
      seeded({}, {
        type: 'oauth2',
        grant: 'client-credentials',
        tokenUrl: 'https://auth.test/token',
        clientId: 'c',
      } as SoapOwnerAuth),
    );
    expect(await curl()).toEqual({
      command: [
        "curl --request POST 'http://dev.test/calc.asmx' \\",
        "  --header 'Content-Type: text/xml;charset=UTF-8' \\",
        '  --header \'SOAPAction: "urn:calc:Add"\' \\',
        "  --header 'X-Who: ada' \\",
        "  --header 'X-Token: ${secret:apiKey}' \\",
        "  --header 'User-Agent: Wirebench/0.1' \\",
        "  --header 'Accept-Encoding: gzip, deflate' \\",
        "  --data-binary @- <<'EOF'",
        '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Header/><soapenv:Body><Add><who>ada</who><key>${secret:apiKey}</key><x>${nothing}</x></Add></soapenv:Body></soapenv:Envelope>',
        'EOF',
      ].join('\n'),
      notes: ['No OAuth2 access token is cached, so the Authorization header is not included; press Get new token.'],
    });
    cached = 'cached-token';
    expect(await curl()).toEqual({
      command: [
        "curl --request POST 'http://dev.test/calc.asmx' \\",
        "  --header 'Content-Type: text/xml;charset=UTF-8' \\",
        '  --header \'SOAPAction: "urn:calc:Add"\' \\',
        "  --header 'X-Who: ada' \\",
        "  --header 'X-Token: ${secret:apiKey}' \\",
        "  --header 'User-Agent: Wirebench/0.1' \\",
        "  --header 'Accept-Encoding: gzip, deflate' \\",
        "  --header 'Authorization: Bearer cached-token' \\",
        "  --data-binary @- <<'EOF'",
        '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Header/><soapenv:Body><Add><who>ada</who><key>${secret:apiKey}</key><x>${nothing}</x></Add></soapenv:Body></soapenv:Envelope>',
        'EOF',
      ].join('\n'),
    });
    expect(accessToken).not.toHaveBeenCalled();
  });

  it('pins a PowerShell command', async () => {
    registerOver(seeded());
    expect(await curl('req-1', 'powershell')).toEqual({
      command: [
        "curl.exe --request POST 'http://dev.test/calc.asmx' `",
        "  --header 'Content-Type: text/xml;charset=UTF-8' `",
        '  --header \'SOAPAction: "urn:calc:Add"\' `',
        "  --header 'X-Who: ada' `",
        "  --header 'X-Token: ${secret:apiKey}' `",
        "  --header 'User-Agent: Wirebench/0.1' `",
        "  --header 'Accept-Encoding: gzip, deflate' `",
        "  --data-binary @'",
        '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Header/><soapenv:Body><Add><who>ada</who><key>${secret:apiKey}</key><x>${nothing}</x></Add></soapenv:Body></soapenv:Envelope>',
        "'@",
      ].join('\n'),
    });
  });

  it('refuses a request no project holds, and one no endpoint resolves for, as unknown-request', async () => {
    registerOver(seeded());
    await expect(curl('nope')).rejects.toMatchObject({ code: 'unknown-request' });
    const model = seeded({ endpointUrl: undefined } as unknown as Partial<SoapRequestDef>);
    registerOver({ ...model, environments: [], activeEnvironmentId: undefined } as unknown as Project);
    await expect(curl()).rejects.toMatchObject({ code: 'unknown-request' });
  });
});
