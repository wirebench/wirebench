// @vitest-environment node
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EngineService } from '../src/main/engine-service.js';
import { registerDefinitionChannels } from '../src/main/ipc/definition.js';
import { MAX_ENVELOPE_XML_CHARS } from '../src/shared/wire-types.js';
import type {
  DefinitionDeclarationAtResponse,
  DefinitionDocumentsResponse,
  DefinitionDocumentTextResponse,
  DefinitionSchemaIndexResponse,
} from '../src/shared/wire-types.js';

function readPublicFixture(name: string): string {
  return readFileSync(`${process.cwd()}/fixtures/wsdl/public/${name}/service.wsdl`, 'utf-8');
}

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

async function ok<T>(channel: string, payload: unknown): Promise<T> {
  const result = (await invoke(channel, payload)) as { ok: boolean; value: T; error?: { message: string } };
  expect(result.ok, result.error?.message).toBe(true);
  return result.value;
}

const TEM = 'http://tempuri.org/';

const ENVELOPE = [
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/">',
  '  <soapenv:Body>',
  '    <tem:Add>',
  '      <tem:intA>1</tem:intA>',
  '    </tem:Add>',
  '  </soapenv:Body>',
  '</soapenv:Envelope>',
].join('\n');

describe('definition.* viewer IPC', () => {
  let service: EngineService;
  let interfaceId: string;

  beforeEach(async () => {
    handlers.clear();
    service = new EngineService();
    registerDefinitionChannels(service);
    const summary = await service.importDefinition({
      source: { kind: 'text', text: readPublicFixture('calculator'), location: 'inline://calculator.wsdl' },
    });
    interfaceId = summary.id;
  });

  it('definition.documents lists the cached bundle without any document text', async () => {
    const value = await ok<DefinitionDocumentsResponse>('definition.documents', { interfaceId });

    expect(value.documents.length).toBeGreaterThan(0);
    expect(value.documents[0]?.location).toBe('inline://calculator.wsdl');
    expect(value.documents[0]?.kind).toBe('wsdl');
    expect(value.documents[0]?.size).toBeGreaterThan(0);
    // The text is a separate, per-document call — listing a big import graph stays bounded.
    expect(value.documents[0]).not.toHaveProperty('text');
    expect(value.loadedAt).toBeGreaterThan(0);
  });

  it('definition.documentText returns one document of the bundle', async () => {
    const value = await ok<DefinitionDocumentTextResponse>('definition.documentText', {
      interfaceId,
      location: 'inline://calculator.wsdl',
    });

    expect(value.text).toContain('<');
    expect(value.text).toContain('Calculator');
  });

  it('definition.documentText rejects a location that is not in the bundle', async () => {
    const result = (await invoke('definition.documentText', {
      interfaceId,
      location: '/etc/passwd',
    })) as { ok: false; error: { code: string } };

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('unknown-document');
  });

  it('definition.declarationAt rejects an envelope over the 2 MiB cap', async () => {
    const result = (await invoke('definition.declarationAt', {
      interfaceId,
      envelopeXml: 'x'.repeat(MAX_ENVELOPE_XML_CHARS + 1),
      offset: 0,
    })) as { ok: false; error: { code: string } };

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('ipc-invalid-request');
  });

  it('definition.declarationAt rejects a negative or non-integer offset', async () => {
    for (const offset of [-1, 1.5]) {
      const result = (await invoke('definition.declarationAt', { interfaceId, envelopeXml: ENVELOPE, offset })) as {
        ok: false;
        error: { code: string };
      };
      expect(result.ok, `offset ${String(offset)}`).toBe(false);
    }
  });

  it('definition.declarationAt rejects an offset past the end of the envelope', async () => {
    const result = (await invoke('definition.declarationAt', {
      interfaceId,
      envelopeXml: ENVELOPE,
      offset: ENVELOPE.length + 1,
    })) as { ok: false; error: { code: string } };

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('invalid-offset');
  });

  it('definition.documents reports an unknown interface as an error', async () => {
    const result = (await invoke('definition.documents', { interfaceId: 'nope' })) as {
      ok: false;
      error: { code: string };
    };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('unknown-interface');
  });

  it('definition.schemaIndex groups global components by namespace', async () => {
    const value = await ok<DefinitionSchemaIndexResponse>('definition.schemaIndex', { interfaceId });

    const namespace = value.namespaces.find((ns) => ns.uri === TEM);
    expect(namespace).toBeDefined();
    expect(namespace?.elements.map((element) => element.name)).toContain('Add');
    const add = namespace?.elements.find((element) => element.name === 'Add');
    expect(add?.document).toBe('inline://calculator.wsdl');
    expect(add?.line).toBeGreaterThan(0);
    // Sorted by local name, so the browser never reshuffles between imports.
    const names = namespace?.elements.map((element) => element.name) ?? [];
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it('definition.declarationAt resolves the element under the caret inside an open tag', async () => {
    const offset = ENVELOPE.indexOf('tem:intA') + 'tem:in'.length;
    const value = await ok<DefinitionDeclarationAtResponse>('definition.declarationAt', {
      interfaceId,
      envelopeXml: ENVELOPE,
      offset,
    });

    expect(value).not.toBeNull();
    expect(value?.name).toBe('intA');
    expect(value?.namespace).toBe(TEM);
    expect(value?.kind).toBe('element');
    expect(value?.document).toBe('inline://calculator.wsdl');
    expect(value?.line).toBeGreaterThan(0);
  });

  it('definition.declarationAt resolves the operation element from its text content', async () => {
    const offset = ENVELOPE.indexOf('<tem:intA>') + '<tem:intA>'.length + 1;
    const value = await ok<DefinitionDeclarationAtResponse>('definition.declarationAt', {
      interfaceId,
      envelopeXml: ENVELOPE,
      offset,
    });

    expect(value?.name).toBe('intA');
  });

  it('definition.declarationAt returns null where nothing resolves', async () => {
    const value = await ok<DefinitionDeclarationAtResponse>('definition.declarationAt', {
      interfaceId,
      envelopeXml: ENVELOPE,
      offset: 3,
    });

    expect(value).toBeNull();
  });
});
