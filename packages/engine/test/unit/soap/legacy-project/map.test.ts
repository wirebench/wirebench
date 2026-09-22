import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { importDefinition } from '../../../../src/import.js';
import { definitionRootOf, fetchDocumentFromCache } from '../../../../src/soap/legacy-project/definition-fetcher.js';
import type { LegacyMapContext, ResolvedLegacyInterface } from '../../../../src/soap/legacy-project/map.js';
import {
  formatLegacyImportReport,
  mapLegacyProject,
  resolvedOperationsOf,
} from '../../../../src/soap/legacy-project/map.js';
import type { LegacyProject } from '../../../../src/soap/legacy-project/model.js';
import { parseLegacyProject } from '../../../../src/soap/legacy-project/parse.js';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../../fixtures/legacy-soap-project');
const parsed = (name: string): LegacyProject => parseLegacyProject(readFileSync(resolve(FIXTURES, name), 'utf8'));

const EMPTY_CONTEXT: LegacyMapContext = {
  environmentNames: new Set(),
  environmentSlugs: new Set(),
  propertyNames: new Set(),
  firstInterfaceOrder: 0,
  firstEnvironmentOrder: 0,
};

function counter(): () => string {
  let n = 0;
  return () => `id-${String((n += 1))}`;
}

/** Resolves every interface of `project` from its own cache only, as the desktop does before mapping. */
async function resolveOffline(project: LegacyProject): Promise<ResolvedLegacyInterface[]> {
  return Promise.all(
    project.interfaces.map(async (legacy, index): Promise<ResolvedLegacyInterface> => {
      const base = { legacy, id: `iface-${String(index)}`, slug: `slug-${String(index)}` };
      const root = definitionRootOf(legacy.cache, legacy.definitionUrl);
      try {
        const result = await importDefinition(
          { kind: 'url', url: root! },
          { fetchDocument: fetchDocumentFromCache(legacy.cache) },
        );
        return {
          ...base,
          resolved: true,
          definitionUrl: root!,
          targetNamespace: result.definition.targetNamespace,
          operations: resolvedOperationsOf(result.operations),
          fetchedFromNetwork: [],
        };
      } catch (error) {
        return { ...base, resolved: false, problem: (error as Error).message };
      }
    }),
  );
}

describe('fetchDocumentFromCache', () => {
  it('serves cached parts by canonical URL and refuses anything else without a fallback', async () => {
    const fetch = fetchDocumentFromCache({ parts: [{ url: 'http://Example.invalid/a/../b.wsdl', content: '<b/>' }] });
    await expect(fetch('http://example.invalid/b.wsdl')).resolves.toMatchObject({ text: '<b/>' });
    await expect(fetch('http://example.invalid/c.wsdl')).rejects.toMatchObject({ code: 'legacy-cache-miss' });
  });

  it('asks the fallback for a miss and says so', async () => {
    const misses: string[] = [];
    const fetch = fetchDocumentFromCache(undefined, {
      fallback: (location) => Promise.resolve({ location, bytes: new Uint8Array(), text: '<x/>' }),
      onFallback: (location) => misses.push(location),
    });
    await expect(fetch('http://example.invalid/x')).resolves.toMatchObject({ text: '<x/>' });
    expect(misses).toEqual(['http://example.invalid/x']);
  });
});

describe('mapLegacyProject', () => {
  it('maps the minimal fixture offline into one interface with its request, envelope untouched', async () => {
    const project = parsed('minimal.xml');
    const mapped = mapLegacyProject(project, await resolveOffline(project), { ...EMPTY_CONTEXT, newId: counter() });

    expect(mapped.interfaces).toHaveLength(1);
    const iface = mapped.interfaces[0]!;
    expect(iface).toMatchObject({
      kind: 'soap',
      id: 'iface-0',
      slug: 'slug-0',
      name: 'EchoBinding',
      definitionUrl: 'http://example.invalid/nested/service.wsdl',
      targetNamespace: 'urn:wb:nested',
    });
    expect(iface.endpoints).toEqual([
      { id: 'id-1', name: 'http://example.invalid/echo', url: 'http://example.invalid/echo', authMode: 'complement' },
    ]);
    expect(iface.defaultEndpointId).toBe('id-1');
    expect(iface.operations).toHaveLength(1);
    const operation = iface.operations[0]!;
    expect(operation).toMatchObject({ name: 'Echo', bindingName: '{urn:wb:nested}EchoBinding', slug: 'Echo' });
    const request = operation.requests[0]!;
    expect(request).toMatchObject({
      kind: 'soap',
      name: 'Request 1',
      endpointId: 'id-1',
      soapVersion: '1.1',
      soapAction: 'urn:wb:nested/Echo',
    });
    expect(request.envelopeXml).toBe(project.interfaces[0]!.operations[0]!.calls[0]!.envelope);
    expect(request.orphaned).toBeUndefined();
    expect(mapped.report.counts).toEqual({
      interfaces: 1,
      operations: 1,
      requests: 1,
      environments: 0,
      properties: 0,
      scripts: 0,
    });
    expect(mapped.report.items).toEqual([]);
  });

  it('maps the full fixture: credentials, one-off URLs, timeouts, encodings, WS-A, orphans and empty operations', async () => {
    const project = parsed('full.xml');
    const mapped = mapLegacyProject(project, await resolveOffline(project), EMPTY_CONTEXT);

    expect(mapped.interfaces.map((iface) => iface.name)).toEqual(['EchoBinding', 'WsiEchoBinding']);
    const [echo, wsi] = mapped.interfaces;
    expect(echo!.operations.map((operation) => [operation.name, operation.requests.length])).toEqual([
      ['Echo', 4],
      ['Retired', 1],
    ]);
    const [plain, staging, ntlm, compressed] = echo!.operations[0]!.requests;
    expect(plain!.auth).toBeUndefined();
    expect(staging).toMatchObject({
      endpointId: echo!.endpoints[1]!.id,
      auth: { type: 'basic', username: 'alice', preemptive: true },
      properties: { timeoutMs: 15000, encoding: 'UTF-8' },
    });
    expect(ntlm).toMatchObject({
      endpointUrl: 'http://other.example.invalid:8080/echo',
      auth: { type: 'ntlm', username: 'bob', domain: 'CORP' },
      properties: { encoding: 'ISO-8859-1' },
    });
    expect(ntlm!.endpointId).toBeUndefined();
    expect(compressed!.envelopeXml).toContain('<com:EchoRequest>');
    expect(echo!.operations[1]!.requests[0]!.orphaned).toBe(true);

    expect(wsi!.operations.map((operation) => [operation.name, operation.requests.length])).toEqual([
      ['Echo', 1],
      ['Unused', 0],
    ]);
    expect(wsi!.operations[0]!.requests[0]!.wsa).toMatchObject({ enabled: true });

    expect(JSON.stringify(mapped)).not.toContain('not-a-real-password');
  });

  it('maps properties and environments, including endpoint overrides by interface slug', async () => {
    const project = parsed('full.xml');
    const mapped = mapLegacyProject(project, await resolveOffline(project), EMPTY_CONTEXT);
    expect(mapped.properties).toEqual({ greeting: 'Hello', tenant: 'acme', empty: '' });
    expect(mapped.environments.map((environment) => [environment.name, environment.slug, environment.order])).toEqual([
      ['Default', 'Default', 0],
      ['Staging', 'Staging', 1],
    ]);
    expect(mapped.environments[1]).toMatchObject({
      endpoints: { 'slug-0': 'https://staging.example.invalid/echo' },
      properties: { tenant: 'acme-staging' },
      disabledProperties: [],
    });
  });

  it('keeps existing property values, renames clashing environments and continues interface order', async () => {
    const project = parsed('full.xml');
    const mapped = mapLegacyProject(project, await resolveOffline(project), {
      environmentNames: new Set(['staging']),
      environmentSlugs: new Set(['Staging']),
      propertyNames: new Set(['tenant']),
      firstInterfaceOrder: 3,
      firstEnvironmentOrder: 2,
    });
    expect(mapped.properties).toEqual({ greeting: 'Hello', empty: '' });
    expect(mapped.environments.map((environment) => [environment.name, environment.slug, environment.order])).toEqual([
      ['Default', 'Default', 2],
      ['Staging 2', 'Staging 2', 3],
    ]);
    expect(mapped.interfaces.map((iface) => iface.order)).toEqual([3, 4]);
    expect(mapped.report.items).toEqual(
      expect.arrayContaining([
        {
          severity: 'info',
          path: '',
          message: 'The project property "tenant" already exists and kept its current value.',
        },
        {
          severity: 'info',
          path: 'Staging',
          message: 'An environment with this name already exists, so it was imported as "Staging 2".',
        },
      ]),
    );
  });

  it('rewrites ${#Project#name} to ${name} silently when an imported environment defines the name', () => {
    const project: LegacyProject = {
      name: 'P',
      properties: [],
      interfaces: [
        {
          name: 'Iface',
          soapVersion: '1.1',
          endpoints: [],
          operations: [
            {
              name: 'Op',
              bindingOperationName: 'Op',
              calls: [
                {
                  name: 'Call',
                  envelope: '<a>${#Project#greeting}</a>',
                  credentials: { hadPassword: false },
                  useWsAddressing: false,
                  assertions: 0,
                  attachments: 0,
                  wssRefs: [],
                },
              ],
            },
          ],
        },
      ],
      environments: [{ name: 'Staging', properties: [{ name: 'greeting', value: 'Hi' }], endpoints: [] }],
      scripts: [],
      unmapped: [],
    };
    const resolved: ResolvedLegacyInterface[] = [
      {
        legacy: project.interfaces[0]!,
        id: 'iface-0',
        slug: 'slug-0',
        resolved: true,
        definitionUrl: 'http://example.invalid/service.wsdl',
        operations: [],
        fetchedFromNetwork: [],
      },
    ];
    const mapped = mapLegacyProject(project, resolved, { ...EMPTY_CONTEXT, newId: counter() });
    const request = mapped.interfaces[0]!.operations[0]!.requests[0]!;
    expect(request.envelopeXml).toBe('<a>${greeting}</a>');
    expect(mapped.report.items.some((item) => item.message.includes('#Project#'))).toBe(false);
  });

  it('places each script under imported-scripts by its owners and reports it', async () => {
    const project = parsed('full.xml');
    const mapped = mapLegacyProject(project, await resolveOffline(project), EMPTY_CONTEXT);
    expect(mapped.scripts.map((script) => script.path)).toEqual([
      'imported-scripts/Smoke/Echo once/Prepare/script.groovy',
      'imported-scripts/Smoke/Echo once/setupScript.groovy',
      'imported-scripts/Smoke/setupScript.js',
      'imported-scripts/Echo mock/startScript.groovy',
      'imported-scripts/afterLoadScript.groovy',
    ]);
    expect(mapped.scripts[4]!.source).toBe("log.info('project loaded')\n// second line");
    expect(mapped.report.counts.scripts).toBe(5);
  });

  it('reports every loss: passwords, orphans, unmapped work', async () => {
    const project = parsed('full.xml');
    const { report } = mapLegacyProject(project, await resolveOffline(project), EMPTY_CONTEXT);
    const warnings = report.items.filter((item) => item.severity === 'warning');
    expect(warnings).toEqual([
      {
        severity: 'warning',
        path: 'EchoBinding › Echo › Staging with auth',
        message: 'The password was not imported. Enter it again under Auth.',
      },
      {
        severity: 'warning',
        path: 'EchoBinding › Echo › One-off URL, NTLM',
        message: 'The password was not imported. Enter it again under Auth.',
      },
      {
        severity: 'warning',
        path: 'Accounts REST',
        message: 'A rest service is not imported; only SOAP interfaces are.',
      },
      { severity: 'warning', path: 'Smoke', message: 'Test suite with 1 test case is not imported.' },
      { severity: 'warning', path: 'Echo mock', message: 'Mock service is not imported.' },
    ]);
    expect(report.items).toContainEqual({
      severity: 'info',
      path: 'EchoBinding › Retired',
      message: 'The definition no longer has this operation; its requests were kept and marked as orphaned.',
    });
    expect(report.counts).toMatchObject({ interfaces: 2, operations: 4, requests: 6, environments: 2, properties: 3 });
  });

  it('skips an interface that could not be resolved, and the environment overrides that pointed at it', async () => {
    const project = parsed('full.xml');
    const resolved = await resolveOffline(project);
    const failed: ResolvedLegacyInterface = {
      legacy: resolved[0]!.legacy,
      id: 'x',
      slug: 'x',
      resolved: false,
      problem: 'the definition could not be fetched',
    };
    const mapped = mapLegacyProject(project, [failed, resolved[1]!], EMPTY_CONTEXT);
    expect(mapped.interfaces.map((iface) => iface.name)).toEqual(['WsiEchoBinding']);
    expect(mapped.report.items).toEqual(
      expect.arrayContaining([
        {
          severity: 'warning',
          path: 'EchoBinding',
          message: 'The interface was not imported: the definition could not be fetched',
        },
        {
          severity: 'warning',
          path: 'Staging › EchoBinding',
          message: 'The endpoint override was not imported: its interface was not imported.',
        },
      ]),
    );
  });

  it('notes the locations that came from the network', async () => {
    const project = parsed('minimal.xml');
    const [entry] = await resolveOffline(project);
    const mapped = mapLegacyProject(
      project,
      [{ ...entry!, resolved: true, fetchedFromNetwork: ['http://example.invalid/x.xsd'] } as ResolvedLegacyInterface],
      EMPTY_CONTEXT,
    );
    expect(mapped.report.items[0]).toEqual({
      severity: 'info',
      path: 'EchoBinding',
      message: 'The project file held no copy of http://example.invalid/x.xsd, so it was fetched from the network.',
    });
  });

  it('fails to resolve a cache-less interface offline, which the desktop turns into a network fetch', async () => {
    const [entry] = await resolveOffline(parsed('no-cache.xml'));
    expect(entry).toMatchObject({ resolved: false });
  });
});

describe('formatLegacyImportReport', () => {
  it('renders counts and one line per item', () => {
    expect(
      formatLegacyImportReport({
        projectName: 'P',
        counts: { interfaces: 1, operations: 2, requests: 3, environments: 0, properties: 1, scripts: 0 },
        items: [
          { severity: 'warning', path: 'A › B', message: 'Lost.' },
          { severity: 'info', path: '', message: 'Kept.' },
        ],
      }),
    ).toBe(
      'Imported "P": 1 interfaces, 2 operations, 3 requests, 0 environments, 1 properties, 0 scripts.\n' +
        'Warning: A › B: Lost.\nNote: Kept.',
    );
  });
});
