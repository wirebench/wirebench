/**
 * The measurable bodies behind {@link BUDGETS_MS}.
 *
 * Each scenario is prepared once (fixtures written, servers started, payloads built — none of
 * that is timed) and then exposes a `run` that performs exactly the work the budget covers.
 * `test/bench/*.bench.ts` and `test/perf/budgets.test.ts` both drive these, so the number in
 * the bench report and the number the CI gate asserts on measure the same thing.
 */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generateRequest } from '../../src/generate.js';
import { importDefinition } from '../../src/import.js';
import type { ImportResult } from '../../src/types.js';
import { sendSoapRequest } from '../../src/send.js';
import { buildMultipartRelated } from '../../src/soap/mime/multipart.js';
import { prepareMtomRequest } from '../../src/soap/mime/mtom.js';
import type { Attachment } from '../../src/project/model.js';
import { evaluate } from '../../src/xpath/evaluate.js';
import { importOpenApi, parseOpenApi } from '../../src/rest/openapi/import.js';
import type { JsonSchema } from '../../src/rest/openapi/model.js';
import { sampleFromSchema, sampleXml } from '../../src/rest/openapi/sample.js';
import { prettyBody } from '../../src/rest/response.js';
import { sendRest } from '../../src/rest/send.js';
import { createSseParser } from '../../src/rest/sse.js';
import type { FetchDocument } from '../../src/wsdl/resolver.js';
import { writeLargeOpenApiFixture } from '../helpers/large-openapi.js';
import { startTestRestServer } from '../helpers/test-rest-server.js';
import { readPublicFixture } from '../helpers/fixtures.js';
import { writeLargeSchemaFixture } from '../helpers/large-schema.js';
import { startTestSoapServer, type TestSoapServer } from '../helpers/test-soap-server.js';
import type { BudgetName } from './budgets.js';

/** A scenario that has been set up and is ready to be timed. */
export interface PreparedScenario {
  /** One iteration of the measured work. */
  readonly run: () => Promise<void>;
  /**
   * Optional custom measurement in milliseconds, for scenarios whose budget is not simply the
   * wall-clock time of `run` (the send-overhead budget subtracts the server's own latency).
   */
  readonly measure?: () => Promise<number>;
  readonly dispose?: () => Promise<void>;
}

// `fileURLToPath` rather than `URL.pathname`: the latter keeps percent-encoding, so a checkout
// under a path with a space (or any other escaped character) would produce a path that does not
// exist on disk.
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/** Imports a WSDL from disk and generates a sample request for its first operation. */
async function importAndGenerate(path: string): Promise<void> {
  const result: ImportResult = await importDefinition({ kind: 'file', path });
  const operation = result.operations[0];
  if (operation === undefined) {
    throw new Error(`no operations in ${path}`);
  }
  generateRequest(result, { bindingName: operation.bindingName, operationName: operation.operationName });
}

function fileScenario(path: string): PreparedScenario {
  return { run: () => importAndGenerate(path) };
}

/** Writes the ~5 MB generated fixture into a temp directory and imports it from there. */
async function prepareLargeSchema(): Promise<PreparedScenario> {
  const dir = await mkdtemp(join(tmpdir(), 'wirebench-large-schema-'));
  const written = await writeLargeSchemaFixture(dir);
  return {
    run: () => importAndGenerate(written.wsdlPath),
    dispose: () => rm(dir, { recursive: true, force: true }),
  };
}

const ENVELOPE = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body><Ping xmlns="urn:wirebench:perf"/></soap:Body>
</soap:Envelope>`;

/**
 * Measures what `sendSoapRequest` adds on top of the exchange itself.
 *
 * The whole call is timed with `performance.now()` — everything the engine does: building the
 * request, the HTTP client, decoding, parsing the response envelope — and the test server's own
 * handling time (reported per request in `x-server-ms`) is subtracted. Overhead is therefore
 * `wall − server`, which still includes the loopback transfer but nothing of how fast the
 * fixture server answers, and unlike the engine's self-reported `durationMs` it cannot miss a
 * regression that happens outside the client's own stopwatch.
 */
async function prepareSendOverhead(): Promise<PreparedScenario> {
  const server: TestSoapServer = await startTestSoapServer({ fixture: 'calculator' });
  const endpoint = `${server.url}/soap`;
  const sample = async (): Promise<number> => {
    const started = performance.now();
    const exchange = await sendSoapRequest({
      endpoint,
      envelopeXml: ENVELOPE,
      soapVersion: '1.1',
      soapAction: 'urn:Ping',
    });
    const wallMs = performance.now() - started;
    const serverMs = Number(exchange.http.headers['x-server-ms']);
    if (!Number.isFinite(serverMs)) {
      throw new Error('test server did not report x-server-ms; the send-overhead budget cannot be measured');
    }
    return wallMs - serverMs;
  };

  // Warm the path so the measured samples do not pay for the first connection.
  await sample();

  return {
    run: async () => {
      await sample();
    },
    measure: sample,
    dispose: () => server.close(),
  };
}

/** A 10 MB attachment packaged as MTOM — the largest thing the send path routinely copies. */
function prepareMtomPackage(): PreparedScenario {
  const bytes = new Uint8Array(10 * 1024 * 1024);
  for (let i = 0; i < bytes.length; i += 4096) {
    bytes[i] = i % 251;
  }
  const attachment: Attachment = {
    id: 'A1',
    name: 'big.bin',
    contentType: 'application/octet-stream',
    size: bytes.length,
    type: 'XOP',
    contentId: 'A1@wirebench',
    cached: true,
    source: { kind: 'cache', sha256: 'a'.repeat(64) },
  };
  const envelopeXml = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body><Upload xmlns="urn:wirebench:perf"><file>cid:A1@wirebench</file></Upload></soap:Body>
</soap:Envelope>`;

  return {
    run: async () => {
      const prepared = await prepareMtomRequest(envelopeXml, [attachment], {
        force: false,
        resolver: () => Promise.resolve(bytes),
      });
      buildMultipartRelated({
        root: { contentType: 'application/xop+xml', bytes: Buffer.from(prepared.envelopeXml, 'utf-8') },
        parts: prepared.parts,
        mtom: true,
      });
    },
  };
}

/** Builds a deterministic SOAP response of roughly `targetBytes` bytes of repeated rows. */
export function buildLargeResponse(targetBytes: number): string {
  const head =
    '<?xml version="1.0" encoding="UTF-8"?>\n<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">\n  <soap:Body>\n    <Rows xmlns="urn:wirebench:perf">\n';
  const tail = '    </Rows>\n  </soap:Body>\n</soap:Envelope>\n';
  const rows: string[] = [head];
  let size = head.length + tail.length;
  let index = 0;
  while (size < targetBytes) {
    const row = `      <Row id="${index}"><Name>Row ${index}</Name><Value>${(index * 37) % 100000}</Value></Row>\n`;
    rows.push(row);
    size += row.length;
    index++;
  }
  rows.push(tail);
  return rows.join('');
}

/**
 * XPath over a 1 MB response — the Query view's hot path, measured with a namespace-qualified
 * path expression (what the view's own prefix suggestions steer a user towards).
 *
 * Deliberately *not* an abbreviated `//name` descendant query: fontoxpath expands those to
 * `descendant-or-self::node()/child::name` and pays for a document-order union the explicit
 * step avoids (measured on this document: 199 ms for `//p:Row` against 142 ms for
 * `/descendant::p:Row`). That difference is a fontoxpath cost rather than a Wirebench one, so
 * budgeting it would make the gate track a dependency instead of our own code.
 */
function prepareXpath(): PreparedScenario {
  const xml = buildLargeResponse(1024 * 1024);
  const namespaces = { soap: 'http://schemas.xmlsoap.org/soap/envelope/', p: 'urn:wirebench:perf' };
  return {
    run: () => {
      const result = evaluate(xml, '/soap:Envelope/soap:Body/p:Rows/p:Row/p:Value', { language: 'xpath', namespaces });
      if (result.kind !== 'nodes') {
        throw new Error(`expected nodes, got ${result.kind}`);
      }
      return Promise.resolve();
    },
  };
}

/**
 * Parses, resolves and maps the generated ~1 MB / 300-operation OpenAPI document into an API.
 *
 * The whole import path a user waits on, minus the network: reading the text, following every
 * `$ref`, and building the tree of folders and requests with a sample body per operation. The
 * fixture is written to a temp directory first, because generating a megabyte of JSON is not what
 * the budget is about.
 */
async function prepareOpenApiImport(): Promise<PreparedScenario> {
  const dir = await mkdtemp(join(tmpdir(), 'wirebench-large-openapi-'));
  const written = await writeLargeOpenApiFixture(dir);
  const source = { kind: 'file' as const, path: pathToFileURL(written.file).href };
  const fetchDocument: FetchDocument = (location) => {
    const text = readFileSync(fileURLToPath(location), 'utf-8');
    return Promise.resolve({ location, bytes: new TextEncoder().encode(text), text });
  };
  return {
    run: async () => {
      const imported = await importOpenApi(source, { fetchDocument });
      if (imported.summary.requests !== written.operations) {
        throw new Error(`expected ${String(written.operations)} requests, got ${String(imported.summary.requests)}`);
      }
    },
    dispose: () => rm(dir, { recursive: true, force: true }),
  };
}

/**
 * Generates a body sample for every request-body schema of the generated ~1 MB document.
 *
 * Over the *large* fixture rather than the crafted ones: the crafted fixtures are a few properties
 * each and measure nothing, while this one's schemas reference each other, which is the shape that
 * makes sample generation expensive — and the shape a real description has. Both preference
 * combinations and the XML renderer are included, since an import runs whichever the user has set.
 */
async function prepareOpenApiSamples(): Promise<PreparedScenario> {
  const dir = await mkdtemp(join(tmpdir(), 'wirebench-openapi-samples-'));
  const written = await writeLargeOpenApiFixture(dir);
  const fetchDocument: FetchDocument = (location) => {
    const text = readFileSync(fileURLToPath(location), 'utf-8');
    return Promise.resolve({ location, bytes: new TextEncoder().encode(text), text });
  };
  const parsed = await parseOpenApi({ kind: 'file', path: pathToFileURL(written.file).href }, { fetchDocument });
  const schemas: JsonSchema[] = [];
  for (const operation of parsed.document.operations) {
    for (const media of Object.values(operation.requestBody?.content ?? {})) {
      if (media.schema !== undefined) {
        schemas.push(media.schema);
      }
    }
  }
  if (schemas.length === 0) {
    throw new Error('no request-body schemas in the generated OpenAPI fixture');
  }
  return {
    run: () => {
      for (const schema of schemas) {
        sampleFromSchema(schema, { includeOptional: true, sampleValues: true });
        sampleFromSchema(schema, {});
        sampleXml(schema, { includeOptional: true });
      }
      return Promise.resolve();
    },
    dispose: () => rm(dir, { recursive: true, force: true }),
  };
}

/** Pretty-prints a 5 MB JSON body, which is what the Pretty view does the moment one arrives. */
function prepareRestPretty(): PreparedScenario {
  // Sized so the minified body is ~5 MB, which is what the name claims and what the Pretty view has
  // to survive on arrival.
  const rows = Array.from({ length: 25_500 }, (_unused, index) => ({
    id: index,
    name: `row-${String(index)}`,
    status: index % 3 === 0 ? 'open' : 'shut',
    tags: [`t${String(index % 7)}`, `u${String(index % 11)}`],
    nested: { a: index, b: `value-${String(index)}`, c: index % 2 === 0, d: `detail-${String(index)}-padding` },
    note: `a note about row ${String(index)} long enough to be worth measuring`,
  }));
  // Minified on the way in: pretty-printing already-indented text is not the case that costs.
  const text = JSON.stringify({ rows });
  const megabytes = Buffer.byteLength(text, 'utf-8') / 1024 / 1024;
  if (megabytes < 4.5 || megabytes > 5.5) {
    throw new Error(`the pretty-print fixture is ${megabytes.toFixed(2)} MB; the budget expects ~5 MB`);
  }
  return {
    run: () => {
      const pretty = prettyBody(text, 'json');
      if (pretty.text.length <= text.length) {
        throw new Error('pretty-printing did not expand the body; the budget is measuring nothing');
      }
      return Promise.resolve();
    },
  };
}

/**
 * Measures what `sendRest` adds on top of the exchange itself.
 *
 * The REST counterpart of {@link prepareSendOverhead}, and measured the same way: the whole call is
 * timed and the test server's own handling time (`x-server-ms`) subtracted, so the number is the
 * engine's cost — composing the URL, encoding the body, decoding and detecting the response — and
 * not how fast the fixture answers.
 */
async function prepareRestSendOverhead(): Promise<PreparedScenario> {
  const server = await startTestRestServer();
  const input = {
    baseUrl: server.url,
    request: {
      method: 'POST',
      url: '/echo',
      pathParams: [],
      query: [],
      headers: [{ name: 'Content-Type', value: 'application/json', enabled: true }],
      body: { kind: 'raw' as const, language: 'json' as const, text: '{"ping":true}' },
    },
    settings: { timeoutMs: 30_000, followRedirects: false },
  };
  const sample = async (): Promise<number> => {
    const started = performance.now();
    const exchange = await sendRest(input);
    const wallMs = performance.now() - started;
    // A `RestExchange` *is* an `HttpExchange`, so its response headers are its own.
    const serverMs = Number(exchange.headers['x-server-ms']);
    if (!Number.isFinite(serverMs)) {
      throw new Error('test server did not report x-server-ms; the rest-send-overhead budget cannot be measured');
    }
    return wallMs - serverMs;
  };

  // Warm the path so the measured samples do not pay for the first connection.
  await sample();
  return {
    run: async () => {
      await sample();
    },
    measure: sample,
    dispose: () => server.close(),
  };
}

/**
 * Parses 100 000 small `text/event-stream` events, split into 4 KB chunks the way the transport
 * hands the parser its bytes — the cost of the row-by-row SSE decode itself, independent of any
 * network.
 */
function prepareSseParse(): PreparedScenario {
  const events = 100_000;
  let text = '';
  for (let i = 0; i < events; i++) {
    text += `id: ${String(i)}\ndata: {"tick":${String(i)}}\n\n`;
  }
  const bytes = new TextEncoder().encode(text);
  const chunkSize = 4096;
  return {
    run: () => {
      let rows = 0;
      const parser = createSseParser(() => {
        rows++;
      });
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        parser.push(bytes.subarray(offset, offset + chunkSize), offset);
      }
      parser.end();
      if (rows !== events) {
        throw new Error(`expected ${String(events)} rows, got ${String(rows)}`);
      }
      return Promise.resolve();
    },
  };
}

/** Every budgeted scenario, keyed exactly like {@link BUDGETS_MS}. */
export const SCENARIOS: Readonly<Record<BudgetName, () => Promise<PreparedScenario>>> = {
  'calculator-import-generate': () =>
    Promise.resolve(fileScenario(`${REPO_ROOT}fixtures/wsdl/public/calculator/service.wsdl`)),
  'countryinfo-import-generate': () =>
    Promise.resolve(fileScenario(`${REPO_ROOT}fixtures/wsdl/public/countryinfo/service.wsdl`)),
  'large-schema-import-generate': prepareLargeSchema,
  'send-overhead': prepareSendOverhead,
  'mtom-package-10mb': () => Promise.resolve(prepareMtomPackage()),
  'xpath-evaluate-1mb': () => Promise.resolve(prepareXpath()),
  'openapi-import-1mb': prepareOpenApiImport,
  'openapi-samples': prepareOpenApiSamples,
  'rest-pretty-5mb': () => Promise.resolve(prepareRestPretty()),
  'rest-send-overhead': prepareRestSendOverhead,
  'sse-parse-100k-events': () => Promise.resolve(prepareSseParse()),
};

/**
 * True when the public CountryInfo fixture is on disk. It is committed today, but the fixture
 * set is refreshed from the network, so the perf suite degrades to a skip rather than a
 * failure if a refresh ever leaves it empty.
 */
export function hasCountryInfoFixture(): boolean {
  try {
    return readPublicFixture('countryinfo').length > 0;
  } catch {
    return false;
  }
}
