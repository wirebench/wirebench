/**
 * The measurable bodies behind {@link BUDGETS_MS}.
 *
 * Each scenario is prepared once (fixtures written, servers started, payloads built — none of
 * that is timed) and then exposes a `run` that performs exactly the work the budget covers.
 * `test/bench/*.bench.ts` and `test/perf/budgets.test.ts` both drive these, so the number in
 * the bench report and the number the CI gate asserts on measure the same thing.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateRequest } from '../../src/generate.js';
import { importDefinition } from '../../src/import.js';
import type { ImportResult } from '../../src/types.js';
import { sendSoapRequest } from '../../src/send.js';
import { buildMultipartRelated } from '../../src/soap/mime/multipart.js';
import { prepareMtomRequest } from '../../src/soap/mime/mtom.js';
import type { Attachment } from '../../src/project/model.js';
import { evaluate } from '../../src/xpath/evaluate.js';
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

const REPO_ROOT = new URL('../../../../', import.meta.url).pathname;

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
 * Measures what `sendSoapRequest` adds on top of the network exchange itself: the same POST is
 * issued twice per sample — once through the engine, once through a bare `fetch` — and the
 * budget covers the difference. That keeps the number independent of how fast the loopback
 * test server happens to be on the machine running it.
 */
async function prepareSendOverhead(): Promise<PreparedScenario> {
  const server: TestSoapServer = await startTestSoapServer({ fixture: 'calculator' });
  const endpoint = `${server.url}/soap`;
  const send = async (): Promise<number> => {
    const exchange = await sendSoapRequest({
      endpoint,
      envelopeXml: ENVELOPE,
      soapVersion: '1.1',
      soapAction: 'urn:Ping',
    });
    return exchange.durationMs;
  };
  const bare = async (): Promise<number> => {
    const started = performance.now();
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'text/xml; charset=utf-8', soapaction: '"urn:Ping"' },
      body: ENVELOPE,
    });
    await response.text();
    return performance.now() - started;
  };

  // Warm both paths so neither pays for the first connection.
  await send();
  await bare();

  return {
    run: async () => {
      await send();
    },
    measure: async () => {
      const engineMs = await send();
      const bareMs = await bare();
      return engineMs - bareMs;
    },
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
