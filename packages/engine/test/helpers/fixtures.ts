import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_PROJECT_SETTINGS, FORMAT_VERSION } from '../../src/project/model.js';
import { DEFAULT_REQUEST_PROPERTIES, withSoapInterfaces } from '../../src/soap/model.js';
import type { Project } from '../../src/project/model.js';
import { toKeystoreRef } from '../../src/project/keystores.js';
import { soapRun } from '../../src/soap/run.js';
import type { SoapSelected } from '../../src/soap/run.js';
import { normalizeWsa } from '../../src/wsa/model.js';
import { toWssOutgoingRef } from '../../src/wss/configs.js';
import type { WssEntry } from '../../src/wss/model.js';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

/**
 * A `file:` URL for `path`, which a test may write POSIX-style (`/tmp/x.wsdl`). The path is
 * resolved first, so on Windows it gains the current drive letter — `file:///tmp/x.wsdl` has
 * no drive and `fileURLToPath` rejects it there, which is not the thing under test.
 *
 * @param path the path, absolute or relative to the working directory
 */
export function fileUrl(path: string): string {
  return pathToFileURL(resolve(path)).href;
}

/** A `file:` URL for `fixtures/<relative>` in the repo, e.g. `wsdl/crafted/x/service.wsdl`. */
export function fixtureUrl(relative: string): string {
  return pathToFileURL(resolve(repoRoot, 'fixtures', relative)).href;
}

/** Reads a public WSDL fixture (`fixtures/wsdl/public/<name>/service.wsdl`) from the repo root. */
export function readPublicFixture(name: string): string {
  return readFileSync(`${repoRoot}fixtures/wsdl/public/${name}/service.wsdl`, 'utf-8');
}

/** Reads a crafted WSDL fixture (`fixtures/wsdl/crafted/<name>/service.wsdl`) from the repo root. */
export function readCraftedFixture(name: string): string {
  return readFileSync(`${repoRoot}fixtures/wsdl/crafted/${name}/service.wsdl`, 'utf-8');
}

/**
 * Reads a WSDL fixture by name, from `public/` when there is one there and from `crafted/`
 * otherwise — what the test SOAP server serves on `/service?wsdl`.
 */
export function readFixtureWsdl(name: string): string {
  try {
    return readPublicFixture(name);
  } catch {
    return readCraftedFixture(name);
  }
}

/**
 * A project with one SOAP request whose `wssOutgoingRef` is `w1`, an outgoing configuration `w1`
 * holding `entries`, and the PEM keystores `ks-proof`, `ks-tls` and `ks-issuer` (no password).
 * `selected` is the request the way the SOAP run facet takes it.
 */
export function projectWithWss(entries: readonly WssEntry[]): { project: Project; selected: SoapSelected } {
  const keystore = (id: string) => toKeystoreRef({ id, name: id, path: `${id}.pem`, type: 'pem' });
  const project: Project = withSoapInterfaces(
    {
      formatVersion: FORMAT_VERSION,
      id: 'proj-wss',
      name: 'WSS',
      settings: DEFAULT_PROJECT_SETTINGS,
      properties: {},
      disabledProperties: [],
      containers: {},

      sequences: [],
      mocks: [],
      environments: [],
      wss: {
        outgoing: [toWssOutgoingRef({ id: 'w1', name: 'w1', mustUnderstand: false, entries: [...entries] })],
        incoming: [],
        keystores: ['ks-proof', 'ks-tls', 'ks-issuer'].map(keystore),
      },
    },
    [
      {
        kind: 'soap',
        id: 'iface-1',
        name: 'Svc',
        slug: 'svc',
        order: 0,
        definitionUrl: 'http://example.test/def.wsdl',
        cacheDefinition: false,
        endpoints: [{ id: 'ep-1', name: 'default', url: 'https://soap.example.test/svc', authMode: 'override' }],
        wsa: normalizeWsa({ enabled: false, version: '2005/08' }),
        operations: [
          {
            name: 'Op',
            bindingName: '{urn:t}B',
            slug: 'op',
            order: 0,
            requests: [
              {
                kind: 'soap',
                id: 'req-1',
                name: 'Req',
                slug: 'req',
                order: 0,
                soapVersion: '1.1',
                headers: [],
                attachments: [],
                properties: DEFAULT_REQUEST_PROPERTIES,
                assertions: [],
                envelopeXml: '<Envelope/>',
                endpointId: 'ep-1',
                wssOutgoingRef: 'w1',
              },
            ],
          },
        ],
      },
    ],
  );
  const selected = soapRun.groups(project).flatMap((group) => group.candidates.map((candidate) => candidate.item))[0];
  if (selected === undefined) {
    throw new Error('projectWithWss: no request selected');
  }
  return { project, selected };
}
