import { normalizeWsa } from '../../../src/wsa/model.js';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_PROJECT_SETTINGS,
  DEFAULT_REQUEST_PROPERTIES,
  FORMAT_VERSION,
  type Project,
} from '../../../src/project/model.js';
import { slugify } from '../../../src/project/paths.js';

/** Deterministic ids so the fixture project is byte-stable across runs. */
export function fixedIds(prefix = 'ID'): () => string {
  let n = 0;
  return () => `${prefix}${(n += 1).toString().padStart(4, '0')}`;
}

/** Creates an empty temporary directory for a project. */
export async function tempProjectDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'wirebench-project-'));
}

/** Every file below `dir`, as sorted `/`-separated relative paths. */
export async function listTree(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...(await listTree(join(dir, entry.name), relative)));
    } else {
      out.push(relative);
    }
  }
  return out.sort();
}

/** Reads a project file as raw bytes. */
export async function readBytes(root: string, relative: string): Promise<Buffer> {
  return readFile(join(root, ...relative.split('/')));
}

/** An envelope with CRLF line endings and a trailing space, to prove byte-exact storage. */
export const CRLF_ENVELOPE =
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">\r\n' +
  '  <soapenv:Body>\r\n' +
  '    <tns:Ping xmlns:tns="urn:demo">1</tns:Ping> \r\n' +
  '  </soapenv:Body>\r\n' +
  '</soapenv:Envelope>';

/**
 * A project exercising the interesting corners: two interfaces (one with a
 * name illegal as a Windows path), two operations, two requests each, headers,
 * auth by secretRef, environments, properties and WS-Security stubs.
 */
export function sampleProject(): Project {
  const nextId = fixedIds();
  const request = (name: string, order: number, envelopeXml: string, endpointId: string) => ({
    kind: 'soap' as const,
    id: nextId(),
    name,
    slug: slugify(name),
    order,
    soapVersion: '1.1' as const,
    soapAction: `urn:demo/${name}`,
    endpointId,
    headers: [
      { name: 'X-Trace', value: 'on' },
      { name: 'X-Trace', value: 'verbose' },
    ],
    attachments: [],
    properties: { ...DEFAULT_REQUEST_PROPERTIES, timeoutMs: 30_000 },
    envelopeXml,
  });

  const ordersEndpointId = 'EP-orders';
  const countryEndpointId = 'EP-country';

  return {
    formatVersion: FORMAT_VERSION,
    id: nextId(),
    name: 'Demo Project',
    description: 'Round-trip fixture',
    settings: { ...DEFAULT_PROJECT_SETTINGS, resourceRoot: './res' },
    properties: { region: 'eu-west-1', tier: 'gold' },
    interfaces: [
      {
        kind: 'soap',
        id: nextId(),
        name: 'CountryInfo',
        slug: 'CountryInfo',
        order: 0,
        definitionUrl: 'http://example.test/CountryInfo.wsdl',
        cacheDefinition: true,
        targetNamespace: 'urn:country',
        endpoints: [
          { id: countryEndpointId, name: 'prod', url: 'https://prod.example.test/country', authMode: 'complement' },
        ],
        defaultEndpointId: countryEndpointId,
        wsa: normalizeWsa({ enabled: false, version: '2005/08' }),
        operations: [
          {
            name: 'ListOfCountryNamesByCode',
            bindingName: '{urn:country}CountryInfoSoap',
            slug: 'ListOfCountryNamesByCode',
            order: 0,
            requests: [
              request('Request 1', 0, '<Envelope/>\n', countryEndpointId),
              request('Smoke test', 1, CRLF_ENVELOPE, countryEndpointId),
              {
                // Exercises every optional request field at once.
                ...request('Kitchen sink', 2, '<Envelope>all</Envelope>', countryEndpointId),
                description: 'uses every optional field',
                endpointUrl: 'https://override.example.test/country',
                auth: { type: 'basic', username: 'u', passwordRef: 'secret://country/basic' },
                wsa: normalizeWsa({ enabled: true, version: '2004/08' }),
                wssOutgoingRef: 'prod-signature',
                wssIncomingRef: 'default',
                attachments: [
                  {
                    id: 'AT1',
                    name: 'invoice.pdf',
                    contentType: 'application/pdf',
                    size: 1234,
                    part: 'file',
                    type: 'MIME' as const,
                    contentId: 'AT1@wirebench',
                    cached: true,
                    source: { kind: 'cache' as const, sha256: 'a'.repeat(64) },
                  },
                  {
                    id: 'AT2',
                    name: 'note.txt',
                    contentType: 'text/plain',
                    size: 6,
                    type: 'CONTENT' as const,
                    contentId: 'AT2@wirebench',
                    cached: false,
                    source: { kind: 'path' as const, path: 'notes/note.txt' },
                  },
                ],
                properties: {
                  ...DEFAULT_REQUEST_PROPERTIES,
                  bindAddress: '127.0.0.1',
                  dumpFile: './dump.xml',
                  maxSizeBytes: 1024,
                  wssPasswordType: 'digest' as const,
                  wssTimeToLive: 300,
                },
              },
            ],
          },
        ],
      },
      {
        kind: 'soap',
        id: nextId(),
        name: 'Orders: v2/legacy?',
        slug: slugify('Orders: v2/legacy?'),
        order: 1,
        definitionUrl: 'https://example.test/orders?wsdl',
        cacheDefinition: false,
        endpoints: [
          {
            id: ordersEndpointId,
            name: 'staging',
            url: 'https://staging.example.test/orders',
            authMode: 'override',
            auth: { type: 'basic', username: 'svc', passwordRef: 'secret://orders/staging', preemptive: true },
          },
        ],
        defaultEndpointId: ordersEndpointId,
        wsa: normalizeWsa({ enabled: true, version: '2004/08' }),
        auth: { type: 'ntlm', username: 'corp-svc', domain: 'CORP', passwordRef: 'secret://orders/ntlm' },
        operations: [
          {
            name: 'PlaceOrder',
            bindingName: '{urn:orders}OrdersSoap12',
            slug: 'PlaceOrder',
            order: 0,
            requests: [
              request('Request 1', 0, '<Envelope>place</Envelope>', ordersEndpointId),
              request('Bulk / batch', 1, '<Envelope>bulk</Envelope>', ordersEndpointId),
            ],
          },
        ],
      },
    ],
    environments: [
      {
        id: nextId(),
        name: 'dev',
        slug: 'dev',
        order: 0,
        endpoints: { CountryInfo: 'http://localhost:8080/country' },
        properties: { region: 'local' },
      },
      {
        id: nextId(),
        name: 'prod',
        slug: 'prod',
        order: 1,
        endpoints: {},
        properties: {},
      },
    ],
    wss: {
      outgoing: (() => {
        const id = nextId();
        return [
          {
            id,
            name: 'prod-signature',
            file: 'wss/outgoing/prod-signature.yaml',
            document: { id, name: 'prod-signature' },
          },
        ];
      })(),
      incoming: (() => {
        const id = nextId();
        return [{ id, name: 'default', file: 'wss/incoming/default.yaml', document: { id, name: 'default' } }];
      })(),
      keystores: (() => {
        const id = nextId();
        return [
          {
            id,
            name: 'corp-p12',
            document: { id, name: 'corp-p12', path: 'certs/corp.p12', type: 'pkcs12', passwordSecretRef: 'secret:1' },
          },
        ];
      })(),
    },
  };
}
