// @vitest-environment node
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PropertyScopes } from '@wirebench/engine';
import { EngineService } from '../src/main/engine-service.js';
import { registerRequestChannels, type RequestChannelDeps } from '../src/main/ipc/request.js';
import type { PreflightResult } from '../src/main/expansion-preflight.js';
import type { ProjectChange, SoapSendInputWire } from '../src/shared/wire-types.js';

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

const scopes: PropertyScopes = { project: {}, global: {}, env: {} };
const preflight: PreflightResult = {
  endpoint: 'http://dev.test/soap',
  endpointSource: 'request-custom',
  auth: { source: 'none', type: 'none' },
  wsa: { enabled: false },
  unresolved: [],
};

const TEM = 'http://tempuri.org/';

/** A minimal stand-in for the parts of `ProjectService` the `request.*` actions use. */
class FakeProject {
  envelopeXml = '';
  endpointUrl = 'http://dev.test/calc.asmx';
  headers: Record<string, string> = {};
  /** How many attachments the saved request carries; drives the cURL "not included" note. */
  attachmentCount = 0;
  /** When set, `buildLiveSendInput` carries this WS-Addressing config on the send input. */
  wsa: SoapSendInputWire['wsa'] = undefined;
  /** Drives the cURL "WS-Security is not included" note. */
  outgoingWss = false;
  /** What `proxyFor`/`tlsFor` answer, so the cURL export's network note can be driven. */
  proxy: { url: string } | undefined = undefined;
  tls: Record<string, unknown> | undefined = undefined;
  readonly changes: ProjectChange[] = [];
  auth: RequestChannelDeps['project'] extends never ? never : undefined = undefined;

  constructor(readonly interfaceId: string) {}

  scopesFor(): PropertyScopes {
    return scopes;
  }
  preflight(): PreflightResult {
    return preflight;
  }
  authFor(): undefined {
    return undefined;
  }
  requestMeta(): undefined {
    return undefined;
  }
  projectId(): string {
    return 'proj-1';
  }
  requestSource(requestId: string) {
    if (requestId !== 'req-1') {
      return undefined;
    }
    return {
      interfaceId: this.interfaceId,
      bindingName: `{${TEM}}CalculatorSoap`,
      operationName: 'Add',
      envelopeXml: this.envelopeXml,
    };
  }
  buildLiveSendInput(requestId: string): SoapSendInputWire | undefined {
    if (requestId !== 'req-1') {
      return undefined;
    }
    return {
      endpoint: this.endpointUrl,
      envelopeXml: this.envelopeXml,
      soapVersion: '1.1',
      soapAction: `${TEM}Add`,
      headers: this.headers,
      ...(this.wsa !== undefined ? { wsa: this.wsa } : {}),
    };
  }
  sendAttachmentsFor(requestId: string): { attachments: unknown[] } | undefined {
    if (requestId !== 'req-1' || this.attachmentCount === 0) {
      return undefined;
    }
    return { attachments: Array.from({ length: this.attachmentCount }, () => ({})) };
  }
  proxyFor(): Promise<{ url: string } | undefined> {
    return Promise.resolve(this.proxy);
  }
  tlsFor(requestId: string): Promise<Record<string, unknown> | undefined> {
    return Promise.resolve(requestId === 'req-1' ? this.tls : undefined);
  }
  hasOutgoingWss(requestId: string): boolean {
    return requestId === 'req-1' && this.outgoingWss;
  }
  mutate(change: ProjectChange): Promise<{ project: unknown; createdRequestId?: string }> {
    this.changes.push(change);
    if (change.kind === 'update-request') {
      const patch = change.patch;
      if (patch.envelopeXml !== undefined) {
        this.envelopeXml = patch.envelopeXml;
      }
      if (patch.endpointUrl !== undefined && patch.endpointUrl !== null) {
        this.endpointUrl = patch.endpointUrl;
      }
    }
    return Promise.resolve({ project: null, ...(change.kind === 'add-request' ? { createdRequestId: 'req-2' } : {}) });
  }
}

describe('request.recreate / curl / importCurl', () => {
  let engine: EngineService;
  let project: FakeProject;
  let showSecrets = false;

  beforeEach(async () => {
    handlers.clear();
    showSecrets = false;
    engine = new EngineService();
    const summary = await engine.importDefinition({
      source: {
        kind: 'text',
        text: readFileSync(`${process.cwd()}/fixtures/wsdl/public/calculator/service.wsdl`, 'utf-8'),
        location: 'inline://calculator.wsdl',
      },
    });
    project = new FakeProject(summary.id);
    const generated = engine.generate({
      interfaceId: summary.id,
      bindingName: `{${TEM}}CalculatorSoap`,
      operationName: 'Add',
    });
    project.envelopeXml = generated.envelopeXml.replace(/<tem:intA>[^<]*<\/tem:intA>/, '<tem:intA>5</tem:intA>');
    registerRequestChannels(engine, {
      project: project as unknown as RequestChannelDeps['project'],
      showSecrets: { get: () => showSecrets },
    });
  });

  it('recreate with keepValues keeps the edited intA', async () => {
    const result = unwrap<{ envelopeXml: string; kept: number }>(
      await invoke('request.recreate', { requestId: 'req-1', keepValues: true, keepHeaders: false, empty: false }),
    );

    expect(result.envelopeXml).toContain('<tem:intA>5</tem:intA>');
    expect(result.kept).toBeGreaterThan(0);
    // The merged envelope is saved through the project service, not just returned.
    expect(project.envelopeXml).toBe(result.envelopeXml);
    expect(project.changes.at(-1)).toMatchObject({ kind: 'update-request', requestId: 'req-1' });
  });

  it('recreate with keepValues: false discards the edit back to the placeholder', async () => {
    const result = unwrap<{ envelopeXml: string; kept: number }>(
      await invoke('request.recreate', { requestId: 'req-1', keepValues: false, keepHeaders: false, empty: false }),
    );

    expect(result.envelopeXml).not.toContain('<tem:intA>5</tem:intA>');
    expect(result.envelopeXml).toContain('<tem:intA>?</tem:intA>');
    expect(result.kept).toBe(0);
  });

  it('recreate with empty produces an envelope with an empty Body', async () => {
    const result = unwrap<{ envelopeXml: string; kept: number; added: number; removed: number }>(
      await invoke('request.recreate', { requestId: 'req-1', keepValues: true, keepHeaders: false, empty: true }),
    );

    expect(result.envelopeXml).not.toContain('tem:Add');
    expect(result).toMatchObject({ kept: 0, added: 0, removed: 0 });
  });

  it('recreate reports unknown-request for a request that does not exist', async () => {
    const result = (await invoke('request.recreate', {
      requestId: 'nope',
      keepValues: true,
      keepHeaders: false,
      empty: false,
    })) as { ok: boolean; error?: { code: string } };

    expect(result).toMatchObject({ ok: false, error: { code: 'unknown-request' } });
  });

  it('curl redacts Authorization by default and reveals it when show-secrets is on', async () => {
    project.headers = { Authorization: 'Basic c2VjcmV0', 'X-Trace': 'on' };

    const redacted = unwrap<{ command: string }>(await invoke('request.curl', { requestId: 'req-1', shell: 'posix' }));
    expect(redacted.command).toContain('curl');
    expect(redacted.command).toContain('Authorization: <redacted>');
    expect(redacted.command).not.toContain('c2VjcmV0');
    expect(redacted.command).toContain('X-Trace: on');

    showSecrets = true;
    const shown = unwrap<{ command: string }>(await invoke('request.curl', { requestId: 'req-1', shell: 'posix' }));
    expect(shown.command).toContain('Authorization: Basic c2VjcmV0');
  });

  it('curl redacts a WS-Security password in the envelope by default and reveals it when show-secrets is on', async () => {
    project.envelopeXml = project.envelopeXml.replace(
      '<soapenv:Header/>',
      '<soapenv:Header><wsse:Security xmlns:wsse="urn:x"><wsse:UsernameToken>' +
        '<wsse:Password>s3cret</wsse:Password></wsse:UsernameToken></wsse:Security></soapenv:Header>',
    );

    const redacted = unwrap<{ command: string }>(await invoke('request.curl', { requestId: 'req-1', shell: 'posix' }));
    expect(redacted.command).toContain('<redacted>');
    expect(redacted.command).not.toContain('s3cret');

    showSecrets = true;
    const shown = unwrap<{ command: string }>(await invoke('request.curl', { requestId: 'req-1', shell: 'posix' }));
    expect(shown.command).toContain('s3cret');
  });

  it('curl applies the effective WS-Addressing headers to the exported envelope', async () => {
    project.wsa = {
      config: {
        enabled: true,
        version: '2005/08',
        mustUnderstand: 'none',
        addDefaultAction: true,
        addDefaultTo: true,
        generateMessageId: true,
      },
      defaultAction: 'urn:default-action',
    };

    const result = unwrap<{ command: string }>(await invoke('request.curl', { requestId: 'req-1', shell: 'posix' }));
    expect(result.command).toContain('wsa:Action');
    expect(result.command).toContain('wsa:To');
    expect(result.command).toContain(project.endpointUrl);
  });

  it('curl notes when WS-Security is selected and is not included', async () => {
    project.outgoingWss = true;

    const result = unwrap<{ command: string; notes?: string[] }>(
      await invoke('request.curl', { requestId: 'req-1', shell: 'posix' }),
    );
    expect(result.notes).toContain('WS-Security is not included in the cURL command.');
  });

  it('curl reports no notes when the request has neither WS-Security nor attachments', async () => {
    const result = unwrap<{ notes?: string[] }>(await invoke('request.curl', { requestId: 'req-1', shell: 'posix' }));
    expect(result.notes).toBeUndefined();
  });

  it('curl notes the attachments it could not include, and says nothing when there are none', async () => {
    const without = unwrap<{ command: string }>(await invoke('request.curl', { requestId: 'req-1', shell: 'posix' }));
    expect(without.command).not.toContain('# note:');

    project.attachmentCount = 2;
    const withAttachments = unwrap<{ command: string }>(
      await invoke('request.curl', { requestId: 'req-1', shell: 'posix' }),
    );
    expect(withAttachments.command.split('\n')[0]).toBe('# note: 2 attachment(s) not included');
    expect(withAttachments.command).toContain('curl');
  });

  /**
   * The exported command carries none of the network setup a real send uses — no `--proxy`, no
   * `--cacert`, no `--insecure`, no `--cert` — so a command that "works here but not there" has
   * to say why in the text the user pastes, not only in a `notes` array a toast may drop.
   */
  it('curl notes the proxy, CA bundle, trustInvalid and client keystore it does not reproduce', async () => {
    project.proxy = { url: 'http://proxy.corp.test:8080' };
    project.tls = { ca: ['-----BEGIN CERTIFICATE-----'], cert: 'pem', key: 'pem', rejectUnauthorized: false };

    const result = unwrap<{ command: string; notes?: string[] }>(
      await invoke('request.curl', { requestId: 'req-1', shell: 'posix' }),
    );

    const first = result.command.split('\n')[0] ?? '';
    expect(first).toContain('# note:');
    expect(first).toContain('http://proxy.corp.test:8080');
    expect(first).toContain('custom trust');
    expect(first).toContain('certificate verification turned off');
    expect(first).toContain('client certificate');
    expect(first).toContain('not reproduced here');
    expect(result.notes?.some((note) => note.includes('proxy'))).toBe(true);
  });

  it('curl says nothing about the network when the send uses none of it', async () => {
    const result = unwrap<{ command: string; notes?: string[] }>(
      await invoke('request.curl', { requestId: 'req-1', shell: 'posix' }),
    );
    expect(result.command).not.toContain('# note:');
    expect(result.notes).toBeUndefined();
  });

  it('curl still exports when resolving the network setup fails', async () => {
    project.proxyFor = () => Promise.reject(new Error('SOCKS'));
    const result = unwrap<{ command: string }>(await invoke('request.curl', { requestId: 'req-1', shell: 'posix' }));
    expect(result.command).toContain('curl');
  });

  it('curl builds a PowerShell command for the powershell shell', async () => {
    const result = unwrap<{ command: string }>(
      await invoke('request.curl', { requestId: 'req-1', shell: 'powershell' }),
    );
    expect(result.command).toContain('curl.exe');
  });

  it('importCurl creates a request with the pasted endpoint and reports -u as a problem', async () => {
    const command = [
      "curl --request POST 'http://imported.test/calc.asmx' \\",
      "  --header 'Content-Type: text/xml; charset=utf-8' \\",
      '  --header \'SOAPAction: "http://tempuri.org/Add"\' \\',
      '  -u alice:s3cret \\',
      "  --data-binary @- <<'EOF'",
      '<Envelope><Body><Add/></Body></Envelope>',
      'EOF',
    ].join('\n');

    const result = unwrap<{ requestId: string; problems: string[] }>(
      await invoke('request.importCurl', {
        command,
        interfaceId: project.interfaceId,
        bindingName: `{${TEM}}CalculatorSoap`,
        operationName: 'Add',
      }),
    );

    expect(result.requestId).toBe('req-2');
    expect(result.problems).toContain('basic-auth-ignored');
    expect(result.problems.join(' ')).not.toContain('s3cret');
    expect(project.changes[0]).toMatchObject({ kind: 'add-request', operationName: 'Add' });
    expect(project.changes[1]).toMatchObject({
      kind: 'update-request',
      requestId: 'req-2',
      patch: { endpointUrl: 'http://imported.test/calc.asmx' },
    });
    expect(project.endpointUrl).toBe('http://imported.test/calc.asmx');
  });
});
