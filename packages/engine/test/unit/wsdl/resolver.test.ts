import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createDefaultFetchDocument } from '../../../src/wsdl/fetch.js';
import { parseWsdl } from '../../../src/wsdl/parse-wsdl.js';
import type { FetchDocument, FetchedDocument } from '../../../src/wsdl/resolver.js';
import { resolveDefinition } from '../../../src/wsdl/resolver.js';
import { readPublicFixture } from '../../helpers/fixtures.js';

const craftedRoot = fileURLToPath(new URL('../../../../../fixtures/wsdl/crafted/', import.meta.url));

function readCrafted(fixture: string, file: string): string {
  return readFileSync(`${craftedRoot}${fixture}/${file}`, 'utf-8');
}

/** Builds an in-memory `FetchDocument` over a location->text map, tracking call counts. */
function makeFakeFetcher(
  docs: Record<string, string>,
  redirects: Record<string, string> = {},
): { fetch: FetchDocument; calls: Map<string, number> } {
  const calls = new Map<string, number>();
  const fetch: FetchDocument = (location: string): Promise<FetchedDocument> => {
    calls.set(location, (calls.get(location) ?? 0) + 1);
    const finalLocation = redirects[location] ?? location;
    const text = docs[finalLocation];
    if (text === undefined) {
      return Promise.reject(new Error(`no fixture for "${location}"`));
    }
    return Promise.resolve({ location: finalLocation, bytes: new TextEncoder().encode(text), text });
  };
  return { fetch, calls };
}

describe('resolveDefinition — nested-imports (wsdl -> wsdl -> xsd -> xsd)', () => {
  const base = 'mem://nested-imports/';
  const docs: Record<string, string> = {
    [`${base}service.wsdl`]: readCrafted('nested-imports', 'service.wsdl'),
    [`${base}types.wsdl`]: readCrafted('nested-imports', 'types.wsdl'),
    [`${base}schemas/common.xsd`]: readCrafted('nested-imports', 'schemas/common.xsd'),
    [`${base}schemas/base.xsd`]: readCrafted('nested-imports', 'schemas/base.xsd'),
  };

  it('resolves all 4 documents in discovery order with correct kind/importedBy/namespace', async () => {
    const { fetch } = makeFakeFetcher(docs);
    const bundle = await resolveDefinition({ location: `${base}service.wsdl` }, { fetchDocument: fetch });

    expect(bundle.problems).toEqual([]);
    expect(bundle.documents.map((d) => d.location)).toEqual([
      `${base}service.wsdl`,
      `${base}types.wsdl`,
      `${base}schemas/common.xsd`,
      `${base}schemas/base.xsd`,
    ]);

    const [service, types, common, baseXsd] = bundle.documents;
    expect(service?.kind).toBe('wsdl');
    expect(service?.importedBy).toBeUndefined();
    expect(service?.namespace).toBe('urn:wb:nested');

    expect(types?.kind).toBe('wsdl');
    expect(types?.importedBy).toBe(`${base}service.wsdl`);
    expect(types?.namespace).toBe('urn:wb:nested-types');

    expect(common?.kind).toBe('xsd');
    expect(common?.importedBy).toBe(`${base}types.wsdl`);
    expect(common?.namespace).toBe('urn:wb:common');

    expect(baseXsd?.kind).toBe('xsd');
    expect(baseXsd?.importedBy).toBe(`${base}schemas/common.xsd`);
    expect(baseXsd?.namespace).toBe('urn:wb:common');
    expect(baseXsd?.chameleonFor).toBeUndefined();
  });

  it('merges via parseWsdl into a single Echo operation with 2 xsd schemaElements', async () => {
    const { fetch } = makeFakeFetcher(docs);
    const def = await parseWsdl({ location: `${base}service.wsdl` }, { fetchDocument: fetch, resolveImports: true });
    expect(def.problems).toEqual([]);
    expect(def.schemaElements).toHaveLength(2);
    const portType = def.portTypes.find((p) => p.name.localName === 'EchoPortType');
    expect(portType?.operations.map((o) => o.name)).toEqual(['Echo']);
    expect(def.bindings.map((b) => b.name.localName)).toEqual(['EchoBinding']);
  });
});

describe('resolveDefinition — chameleon-include', () => {
  const base = 'mem://chameleon-include/';
  const docs: Record<string, string> = {
    [`${base}service.wsdl`]: readCrafted('chameleon-include', 'service.wsdl'),
    [`${base}chameleon.xsd`]: readCrafted('chameleon-include', 'chameleon.xsd'),
  };

  it('adopts the including schema namespace and records chameleonFor', async () => {
    const { fetch } = makeFakeFetcher(docs);
    const bundle = await resolveDefinition({ location: `${base}service.wsdl` }, { fetchDocument: fetch });

    expect(bundle.problems).toEqual([]);
    expect(bundle.documents).toHaveLength(2);
    const chameleon = bundle.documents[1];
    expect(chameleon?.location).toBe(`${base}chameleon.xsd`);
    expect(chameleon?.namespace).toBe('urn:wb:chameleon');
    expect(chameleon?.chameleonFor).toBe(`${base}service.wsdl`);
  });
});

describe('resolveDefinition — cycle', () => {
  const base = 'mem://cycle/';
  const docs: Record<string, string> = {
    [`${base}a.wsdl`]: readCrafted('cycle', 'a.wsdl'),
    [`${base}b.wsdl`]: readCrafted('cycle', 'b.wsdl'),
  };

  it('fetches each document exactly once and merges both messages', async () => {
    const { fetch, calls } = makeFakeFetcher(docs);
    const bundle = await resolveDefinition({ location: `${base}a.wsdl` }, { fetchDocument: fetch });

    expect(bundle.problems).toEqual([]);
    expect(bundle.documents).toHaveLength(2);
    expect(calls.get(`${base}b.wsdl`)).toBe(1);
    // a.wsdl is the root: it is provided as `source.text`-less root, so it is fetched once too.
    expect(calls.get(`${base}a.wsdl`)).toBe(1);

    const def = await parseWsdl({ location: `${base}a.wsdl` }, { fetchDocument: fetch, resolveImports: true });
    expect(def.messages.map((m) => m.name.localName).sort()).toEqual(['MessageA', 'MessageB']);
  });
});

describe('resolveDefinition — relative and query-string locations', () => {
  it('resolves "../" and "?query" schemaLocations against the current document', async () => {
    const rootXsd = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:wb:rel">
  <xs:include schemaLocation="../shared/inc.xsd?v=2"/>
</xs:schema>`;
    const incXsd = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:wb:rel-shared"/>`;

    const docs: Record<string, string> = {
      'mem://project/sub/root.xsd': rootXsd,
      'mem://project/shared/inc.xsd?v=2': incXsd,
    };
    const { fetch } = makeFakeFetcher(docs);
    const bundle = await resolveDefinition({ location: 'mem://project/sub/root.xsd' }, { fetchDocument: fetch });

    expect(bundle.problems).toEqual([]);
    expect(bundle.documents).toHaveLength(2);
    expect(bundle.documents[1]?.location).toBe('mem://project/shared/inc.xsd?v=2');
  });
});

describe('resolveDefinition — redirect-aware canonical location', () => {
  it('dedupes by the canonical (post-redirect) location', async () => {
    const schema = `<?xml version="1.0"?><xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:wb:target"/>`;
    const rootWsdl = `<?xml version="1.0"?>
<definitions xmlns="http://schemas.xmlsoap.org/wsdl/" xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:wb:redir">
  <types>
    <xs:schema targetNamespace="urn:wb:redir">
      <xs:import namespace="urn:wb:target" schemaLocation="one.xsd"/>
      <xs:import namespace="urn:wb:target" schemaLocation="two.xsd"/>
    </xs:schema>
  </types>
</definitions>`;
    const docs: Record<string, string> = {
      'mem://redir/root.wsdl': rootWsdl,
      'mem://redir/canonical.xsd': schema,
    };
    const redirects: Record<string, string> = {
      'mem://redir/one.xsd': 'mem://redir/canonical.xsd',
      'mem://redir/two.xsd': 'mem://redir/canonical.xsd',
    };
    const { fetch, calls } = makeFakeFetcher(docs, redirects);
    const bundle = await resolveDefinition({ location: 'mem://redir/root.wsdl' }, { fetchDocument: fetch });

    expect(bundle.problems).toEqual([]);
    // Both requests are dispatched (redirects aren't known in advance)...
    expect(calls.get('mem://redir/one.xsd')).toBe(1);
    expect(calls.get('mem://redir/two.xsd')).toBe(1);
    // ...but only one BundledDocument survives, keyed by the canonical post-redirect location.
    expect(bundle.documents).toHaveLength(2);
    expect(bundle.documents[1]?.location).toBe('mem://redir/canonical.xsd');
  });
});

describe('resolveDefinition — xs:import without schemaLocation', () => {
  it('produces no fetch and no problem for a namespace-only import', async () => {
    const rootXsd = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:wb:ns-only">
  <xs:import namespace="urn:wb:elsewhere"/>
</xs:schema>`;
    const docs: Record<string, string> = { 'mem://ns-only/root.xsd': rootXsd };
    const { fetch, calls } = makeFakeFetcher(docs);
    const bundle = await resolveDefinition({ location: 'mem://ns-only/root.xsd' }, { fetchDocument: fetch });

    expect(bundle.problems).toEqual([]);
    expect(bundle.documents).toHaveLength(1);
    expect(calls.size).toBe(1); // only the root itself
  });
});

describe('resolveDefinition — xs:redefine', () => {
  it('yields an unsupported-redefine problem with line/col and still fetches the target', async () => {
    const rootXsd = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:wb:redefine">
  <xs:redefine schemaLocation="old.xsd">
    <xs:simpleType name="Foo">
      <xs:restriction base="xs:string"/>
    </xs:simpleType>
  </xs:redefine>
</xs:schema>`;
    const oldXsd = `<?xml version="1.0"?><xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:wb:redefine"/>`;
    const docs: Record<string, string> = {
      'mem://redefine/root.xsd': rootXsd,
      'mem://redefine/old.xsd': oldXsd,
    };
    const { fetch } = makeFakeFetcher(docs);
    const bundle = await resolveDefinition({ location: 'mem://redefine/root.xsd' }, { fetchDocument: fetch });

    expect(bundle.documents).toHaveLength(2);
    expect(bundle.documents[1]?.location).toBe('mem://redefine/old.xsd');
    expect(bundle.problems).toHaveLength(1);
    const problem = bundle.problems[0];
    expect(problem?.code).toBe('unsupported-redefine');
    expect(problem?.location).toBe('mem://redefine/root.xsd');
    expect(problem?.line).toBeGreaterThan(0);
    expect(problem?.column).toBeGreaterThan(0);
  });
});

describe('resolveDefinition — not-xml / unrecognized roots', () => {
  it('accepts an unrecognized root document (defers to parseWsdlDocument for validation)', async () => {
    const notWsdl = `<?xml version="1.0"?><foo/>`;
    const { fetch } = makeFakeFetcher({ 'mem://unrecognized/root.xml': notWsdl });
    const bundle = await resolveDefinition({ location: 'mem://unrecognized/root.xml' }, { fetchDocument: fetch });
    expect(bundle.root.kind).toBe('wsdl');
    expect(bundle.documents).toHaveLength(1);
  });

  it('records a not-xml problem for an imported document with an unrecognized root', async () => {
    const rootWsdl = `<?xml version="1.0"?>
<definitions xmlns="http://schemas.xmlsoap.org/wsdl/" targetNamespace="urn:wb:bad-import">
  <import namespace="urn:wb:bad" location="bad.wsdl"/>
</definitions>`;
    const badDoc = `<?xml version="1.0"?><notAWsdl/>`;
    const docs: Record<string, string> = {
      'mem://bad-import/root.wsdl': rootWsdl,
      'mem://bad-import/bad.wsdl': badDoc,
    };
    const { fetch } = makeFakeFetcher(docs);
    const bundle = await resolveDefinition({ location: 'mem://bad-import/root.wsdl' }, { fetchDocument: fetch });

    expect(bundle.documents).toHaveLength(1);
    expect(bundle.problems).toHaveLength(1);
    expect(bundle.problems[0]?.code).toBe('not-xml');
    expect(bundle.problems[0]?.location).toBe('mem://bad-import/bad.wsdl');
  });
});

describe('resolveDefinition — xs:include without schemaLocation', () => {
  it('is skipped without a fetch or a problem', async () => {
    const rootXsd = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:wb:no-loc">
  <xs:include/>
</xs:schema>`;
    const { fetch, calls } = makeFakeFetcher({ 'mem://no-loc/root.xsd': rootXsd });
    const bundle = await resolveDefinition({ location: 'mem://no-loc/root.xsd' }, { fetchDocument: fetch });
    expect(bundle.problems).toEqual([]);
    expect(bundle.documents).toHaveLength(1);
    expect(calls.size).toBe(1);
  });
});

describe('resolveDefinition — failing import', () => {
  it('records a fetch-failed problem and resolves the rest of the graph', async () => {
    const rootWsdl = `<?xml version="1.0"?>
<definitions xmlns="http://schemas.xmlsoap.org/wsdl/" targetNamespace="urn:wb:partial">
  <import namespace="urn:wb:missing" location="missing.wsdl"/>
</definitions>`;
    const docs: Record<string, string> = { 'mem://partial/root.wsdl': rootWsdl };
    const { fetch } = makeFakeFetcher(docs);
    const bundle = await resolveDefinition({ location: 'mem://partial/root.wsdl' }, { fetchDocument: fetch });

    expect(bundle.documents).toHaveLength(1);
    expect(bundle.problems).toHaveLength(1);
    expect(bundle.problems[0]?.code).toBe('fetch-failed');
    expect(bundle.problems[0]?.location).toBe('mem://partial/missing.wsdl');
  });
});

describe('resolveDefinition — failing root', () => {
  it('throws when the root document cannot be fetched', async () => {
    const { fetch } = makeFakeFetcher({});
    await expect(
      resolveDefinition({ location: 'mem://absent/root.wsdl' }, { fetchDocument: fetch }),
    ).rejects.toMatchObject({
      code: 'fetch-failed',
    });
  });
});

describe('resolveDefinition — AbortSignal', () => {
  it('rejects immediately when the signal is already aborted', async () => {
    const { fetch } = makeFakeFetcher({});
    const controller = new AbortController();
    controller.abort();
    await expect(
      resolveDefinition({ location: 'mem://x/root.wsdl' }, { fetchDocument: fetch, signal: controller.signal }),
    ).rejects.toBeDefined();
  });
});

describe('resolveDefinition — CountryInfo public fixture via parseWsdl', () => {
  it('resolves to a single document with no problems', async () => {
    const text = readPublicFixture('countryinfo');
    const fetchDocument: FetchDocument = () => Promise.reject(new Error('should not fetch for a single-document WSDL'));
    const def = await parseWsdl(
      { location: 'countryinfo/service.wsdl', text },
      { fetchDocument, resolveImports: true },
    );
    expect(def.problems).toEqual([]);
    expect(def.services.length).toBeGreaterThan(0);
  });
});

describe('createDefaultFetchDocument — file: fixtures', () => {
  it('resolves the nested-imports fixture chain from disk', async () => {
    const fetchDocument = createDefaultFetchDocument();
    const rootUrl = new URL('service.wsdl', `file://${craftedRoot}nested-imports/`).toString();
    const bundle = await resolveDefinition({ location: rootUrl }, { fetchDocument });

    expect(bundle.problems).toEqual([]);
    expect(bundle.documents).toHaveLength(4);
    expect(bundle.documents.map((d) => d.kind)).toEqual(['wsdl', 'wsdl', 'xsd', 'xsd']);
  });
});
