// @vitest-environment node
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { importDefinition } from '@wirebench/engine';
import type { ImportResult, SoapExchange } from '@wirebench/engine';
import { ExchangeCache } from '../src/main/exchange-cache.js';
import { registerWsiChannels } from '../src/main/ipc/wsi.js';
import type { WsiChannelProject } from '../src/main/ipc/wsi.js';
import type { EngineService } from '../src/main/engine-service.js';
import type { WsiReportWire } from '../src/shared/wire-types.js';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
}));

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

function invoke(channel: string, payload: unknown): Promise<unknown> {
  const handler = handlers.get(channel);
  if (handler === undefined) {
    throw new Error(`${channel} was never registered`);
  }
  return handler({ sender: {} }, payload);
}

type Result<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };

const REQUEST_XML = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/">
  <soapenv:Body><tem:Add><tem:intA>1</tem:intA><tem:intB>2</tem:intB></tem:Add></soapenv:Body>
</soapenv:Envelope>`;

/** A SOAP 1.1 exchange with the wire fields the message assertions read. */
function exchange(requestHeaders: Record<string, string> = {}): SoapExchange {
  return {
    http: {
      request: {
        url: 'http://example.invalid/calc',
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset=UTF-8',
          SOAPAction: '"http://tempuri.org/Add"',
          ...requestHeaders,
        },
      },
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'text/xml; charset=UTF-8' },
      rawHeaders: [],
      body: new Uint8Array(),
      rawBody: new Uint8Array(),
      truncated: false,
      timings: { startedAt: '2026-01-01T00:00:00.000Z', totalMs: 1 },
      rawRequest: new Uint8Array(),
      rawResponse: new Uint8Array(),
      redirects: [],
    },
    response: { envelopeXml: REQUEST_XML, version: '1.1', isSoap: true },
    durationMs: 1,
    problems: [],
  };
}

const SAVED_TARGET = {
  interfaceId: 'iface-1',
  bindingName: '{http://tempuri.org/}CalculatorSoap',
  operationName: 'Add',
  envelopeXml: REQUEST_XML,
};

describe('wsi.* IPC', () => {
  let calculator: ImportResult;
  let cache: ExchangeCache;
  let picked: string[];
  let saveTo: string | undefined;

  beforeAll(async () => {
    calculator = await importDefinition({
      kind: 'file',
      path: `${repoRoot}fixtures/wsdl/public/calculator/service.wsdl`,
    });
  });

  /** A `ProjectService` stub answering with one saved request on one imported interface. */
  const project = (target: unknown = SAVED_TARGET): WsiChannelProject =>
    ({
      validationTargetFor: () => target,
      snapshot: () => ({ interfaces: [{ id: 'iface-1', name: 'Calculator' }] }),
    }) as unknown as WsiChannelProject;

  function register(projectStub: WsiChannelProject = project()): void {
    registerWsiChannels({ resultFor: () => calculator, exchanges: cache } as unknown as EngineService, {
      project: projectStub,
      picks: { rememberWrite: (path: string) => picked.push(path) },
      dialog: { showSave: () => Promise.resolve(saveTo) },
      now: () => new Date('2026-02-03T04:05:06.000Z'),
    });
  }

  beforeEach(() => {
    handlers.clear();
    cache = new ExchangeCache();
    picked = [];
    saveTo = undefined;
  });

  it('reports on a WSDL, labelled with the interface name', async () => {
    register();
    const result = (await invoke('wsi.checkWsdl', { interfaceId: 'iface-1' })) as Result<WsiReportWire>;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.scope).toBe('wsdl');
    expect(result.value.label).toBe('Calculator');
    expect(result.value.profile).toBe('BP1.1');
    // Verbose: every assertion that ran has a row, so the panel can offer "show all".
    expect(result.value.assertions.length).toBe(
      result.value.summary.passed +
        result.value.summary.failed +
        result.value.summary.warning +
        result.value.summary.notApplicable,
    );
  });

  it('falls back to the interface id when no project is open', async () => {
    register({ validationTargetFor: () => undefined, snapshot: () => null });
    const result = (await invoke('wsi.checkWsdl', { interfaceId: 'iface-1' })) as Result<WsiReportWire>;
    expect(result.ok && result.value.label).toBe('iface-1');
  });

  it('reports on a cached exchange', async () => {
    cache.put('send-1', {} as never, [], {
      exchange: exchange(),
      requestId: 'req-1',
      requestEnvelopeXml: REQUEST_XML,
    });
    register();
    const result = (await invoke('wsi.checkExchange', { sendId: 'send-1' })) as Result<WsiReportWire>;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.scope).toBe('message');
    expect(result.value.label).toBe('Add — last exchange');
    expect(result.value.summary.failed).toBe(0);
    expect(result.value.target).toBe('http://example.invalid/calc');
  });

  it('carries the findings of a non-conforming exchange', async () => {
    cache.put('send-2', {} as never, [], {
      exchange: exchange({ 'Content-Type': 'text/xml', SOAPAction: 'http://tempuri.org/Add' }),
      requestId: 'req-1',
      requestEnvelopeXml: REQUEST_XML,
    });
    register();
    const result = (await invoke('wsi.checkExchange', { sendId: 'send-2' })) as Result<WsiReportWire>;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const failed = result.value.assertions.filter((assertion) => assertion.result === 'failed').map((a) => a.id);
    expect(failed).toEqual(expect.arrayContaining(['R1109', 'R1141']));
    const soapAction = result.value.assertions.find((assertion) => assertion.id === 'R1109');
    expect(soapAction?.findings[0]?.location?.document).toBe('request');
  });

  it('fails cleanly for an evicted send and for an ad-hoc one', async () => {
    register();
    const gone = (await invoke('wsi.checkExchange', { sendId: 'nope' })) as Result<WsiReportWire>;
    expect(gone.ok).toBe(false);
    if (!gone.ok) expect(gone.error.code).toBe('unknown-exchange');

    cache.put('send-3', {} as never, [], { exchange: exchange() });
    const adhoc = (await invoke('wsi.checkExchange', { sendId: 'send-3' })) as Result<WsiReportWire>;
    expect(adhoc.ok).toBe(false);
    if (!adhoc.ok) expect(adhoc.error.code).toBe('unknown-request');
  });

  it('fails cleanly when the binding has no such operation', async () => {
    cache.put('send-4', {} as never, [], { exchange: exchange(), requestId: 'req-1' });
    register({
      validationTargetFor: () => ({ ...SAVED_TARGET, operationName: 'Nope' }),
      snapshot: () => null,
    });
    const result = (await invoke('wsi.checkExchange', { sendId: 'send-4' })) as Result<WsiReportWire>;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('unknown-operation');
  });

  it('writes the HTML export to the picked path and records the pick', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wirebench-wsi-'));
    saveTo = join(dir, 'report.html');
    register();
    const report = (await invoke('wsi.checkWsdl', { interfaceId: 'iface-1' })) as Result<WsiReportWire>;
    expect(report.ok).toBe(true);
    if (!report.ok) return;

    const result = (await invoke('wsi.exportHtml', {
      report: report.value,
      suggestedName: 'Calculator-ws-i.html',
      verbose: true,
    })) as Result<{ path?: string; cancelled: boolean }>;
    expect(result.ok && result.value).toEqual({ path: saveTo, cancelled: false });
    expect(picked).toEqual([saveTo]);

    const html = await readFile(saveTo, 'utf-8');
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('Calculator');
    expect(html).toContain('<table');
    expect(html).toContain('2026-02-03T04:05:06.000Z');
  });

  it('reports cancellation without writing anything', async () => {
    register();
    const report = (await invoke('wsi.checkWsdl', { interfaceId: 'iface-1' })) as Result<WsiReportWire>;
    if (!report.ok) throw new Error('expected a report');
    const result = (await invoke('wsi.exportHtml', {
      report: report.value,
      suggestedName: 'x.html',
    })) as Result<{ path?: string; cancelled: boolean }>;
    expect(result.ok && result.value).toEqual({ cancelled: true });
    expect(picked).toEqual([]);
  });
});
