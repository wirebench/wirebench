// @vitest-environment node
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EngineService } from '../src/main/engine-service.js';
import { registerXmlChannels } from '../src/main/ipc/xml.js';

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

describe('xml.* IPC', () => {
  let service: EngineService;
  let interfaceId: string;
  const TEM = 'http://tempuri.org/';

  beforeEach(async () => {
    handlers.clear();
    service = new EngineService();
    registerXmlChannels(service);
    const summary = await service.importDefinition({
      source: { kind: 'text', text: readPublicFixture('calculator'), location: 'inline://calculator.wsdl' },
    });
    interfaceId = summary.id;
  });

  it('xml.completions lists intA/intB inside <tem:Add>', async () => {
    const result = (await invoke('xml.completions', {
      interfaceId,
      path: [`{${TEM}}Add`],
    })) as { ok: true; value: { items: { name: string; namespaceUri: string }[] } };

    expect(result.ok).toBe(true);
    expect(result.value.items.map((i) => i.name)).toEqual(['intA', 'intB']);
    expect(result.value.items[0]?.namespaceUri).toBe(TEM);
  });

  it('xml.completions filters by partial (case-insensitive prefix)', async () => {
    const result = (await invoke('xml.completions', {
      interfaceId,
      path: [`{${TEM}}Add`],
      partial: 'intB',
    })) as { ok: true; value: { items: { name: string }[] } };

    expect(result.value.items.map((i) => i.name)).toEqual(['intB']);
  });

  it('xml.declaration reports the source location of <tem:Add>', async () => {
    const result = (await invoke('xml.declaration', {
      interfaceId,
      path: [`{${TEM}}Add`],
    })) as { ok: true; value: { location: string; line?: number } | null };

    expect(result.ok).toBe(true);
    expect(result.value).not.toBeNull();
    expect(result.value?.location).toBe('inline://calculator.wsdl');
  });

  it('xml.declaration is null for an unresolvable path', async () => {
    const result = (await invoke('xml.declaration', {
      interfaceId,
      path: [`{${TEM}}DoesNotExist`],
    })) as { ok: true; value: null };

    expect(result.value).toBeNull();
  });

  it('answers unknown-interface for an unknown interfaceId', async () => {
    const result = await invoke('xml.completions', { interfaceId: 'nope', path: [] });
    expect(result).toMatchObject({ ok: false, error: { code: 'unknown-interface' } });
  });

  it('rejects a malformed payload', async () => {
    const result = await invoke('xml.completions', {});
    expect(result).toMatchObject({ ok: false, error: { code: 'ipc-invalid-request' } });
  });

  it('xml.describeMany resolves the builtin type of a leaf element (intA -> xs:int)', async () => {
    const result = (await invoke('xml.describeMany', {
      interfaceId,
      paths: [[`{${TEM}}Add`, `{${TEM}}intA`]],
    })) as { ok: true; value: { results: ({ typeName: string; kind: string } | null)[] } };

    expect(result.ok).toBe(true);
    expect(result.value.results).toEqual([
      { typeName: '{http://www.w3.org/2001/XMLSchema}int', kind: 'element', nillable: false },
    ]);
  });

  it('xml.describeMany reports an anonymous type as an empty typeName (Add)', async () => {
    const result = (await invoke('xml.describeMany', {
      interfaceId,
      paths: [[`{${TEM}}Add`]],
    })) as { ok: true; value: { results: ({ typeName: string } | null)[] } };

    expect(result.value.results).toEqual([{ typeName: '', kind: 'element', nillable: false }]);
  });

  it('xml.describeMany batches multiple paths in one call, preserving order and nulls', async () => {
    const result = (await invoke('xml.describeMany', {
      interfaceId,
      paths: [
        [`{${TEM}}Add`, `{${TEM}}intA`],
        [`{${TEM}}Add`, `{${TEM}}DoesNotExist`],
        [`{${TEM}}Add`, `{${TEM}}intB`],
      ],
    })) as { ok: true; value: { results: ({ typeName: string } | null)[] } };

    expect(result.value.results).toHaveLength(3);
    expect(result.value.results[0]?.typeName).toBe('{http://www.w3.org/2001/XMLSchema}int');
    expect(result.value.results[1]).toBeNull();
    expect(result.value.results[2]?.typeName).toBe('{http://www.w3.org/2001/XMLSchema}int');
  });
});
