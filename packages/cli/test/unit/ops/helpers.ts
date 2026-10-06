/**
 * Fixture projects for the op tests, built the way a user would: an empty project, then the
 * `import` op. Temp folders are removed by `removeTempDirs` in each file's `afterEach`.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createProject,
  loadProject,
  requestFileLocation,
  saveProject,
  selectRequests,
  upsertEnvironment,
} from '@wirebench/engine';
import type { Project, RestFolder, RestRequestDef } from '@wirebench/engine';
import { runOp } from '../../../src/ops/context.js';
import type { OpsBase } from '../../../src/ops/context.js';
import { importOp } from '../../../src/ops/import.js';
import { createSourceCache } from '@wirebench/engine';
import { DEFAULT_CLI_SECRET_SOURCES } from '../../../src/source-secrets.js';

const FIXTURES = join(import.meta.dirname, '..', '..', 'fixtures', 'mcp');
export const CALCULATOR_WSDL = join(FIXTURES, 'calculator.wsdl');
export const PETS_OPENAPI = join(FIXTURES, 'pets.openapi.yaml');
/** A neutral fake secret, long enough for the masker. */
export const SECRET = 'abc123def456ghi789';
/** The request the calculator import saves. */
export const SOAP_ITEM = 'CalculatorService/Add/Request 1';

const created: string[] = [];

export async function tempDir(prefix = 'wirebench-ops-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

export async function removeTempDirs(): Promise<void> {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}

export interface Fixture {
  readonly dir: string;
  readonly historyDir: string;
  /** Every warning an op wrote, in order. */
  readonly warnings: string[];
  /** An open-gated MCP base for this project; `overrides` narrows it. */
  base(overrides?: Partial<OpsBase>): OpsBase;
}

export async function emptyProject(): Promise<Fixture> {
  const dir = await tempDir();
  const historyDir = await tempDir('wirebench-history-');
  await saveProject(createProject('MCP fixture', { id: 'mcp-fixture' }), dir);
  const warnings: string[] = [];
  return {
    dir,
    historyDir,
    warnings,
    base: (overrides = {}) => ({
      projectDir: dir,
      historyDir,
      env: {},
      gates: { write: true, send: true },
      origin: 'mcp',
      warn: (line) => warnings.push(line),
      secretSources: DEFAULT_CLI_SECRET_SOURCES,
      secretSourceCache: createSourceCache(),
      secretSourceValues: new Set<string>(),
      ...overrides,
    }),
  };
}

export async function soapProject(): Promise<Fixture> {
  const fixture = await emptyProject();
  await runOp(importOp, { source: CALCULATOR_WSDL }, fixture.base());
  return fixture;
}

export async function restProject(): Promise<Fixture> {
  const fixture = await emptyProject();
  await runOp(importOp, { source: PETS_OPENAPI }, fixture.base());
  return fixture;
}

export async function updateProject(dir: string, change: (project: Project) => Project): Promise<void> {
  const { project } = await loadProject(dir);
  await saveProject(change(project), dir);
}

/**
 * Changes the REST request an import made for `method path`, wherever it sits: imported requests
 * are inside folders.
 *
 * @throws Error when no request matched, so a test can never silently change nothing
 */
export async function updateRestRequest(
  dir: string,
  method: string,
  path: string,
  change: (request: RestRequestDef) => RestRequestDef,
): Promise<void> {
  let matched = 0;
  const inRequests = (requests: readonly RestRequestDef[]): RestRequestDef[] =>
    requests.map((request) => {
      if (request.contract?.method.toLowerCase() !== method.toLowerCase() || request.contract.path !== path) {
        return request;
      }
      matched += 1;
      return change(request);
    });
  const inFolders = (folders: readonly RestFolder[]): RestFolder[] =>
    folders.map((folder) => ({
      ...folder,
      folders: inFolders(folder.folders),
      requests: inRequests(folder.requests),
    }));
  await updateProject(dir, (project) => {
    const changed = {
      ...project,
      apis: project.apis.map((api) => ({
        ...api,
        folders: inFolders(api.folders),
        requests: inRequests(api.requests),
      })),
    };
    if (matched === 0) {
      throw new Error(`no request for ${method} ${path}`);
    }
    return changed;
  });
}

/** Adds a project environment whose endpoints map interface and API slugs to URLs. */
export async function addEnvironment(
  dir: string,
  name: string,
  endpoints: Readonly<Record<string, string>>,
): Promise<void> {
  await updateProject(dir, (project) =>
    upsertEnvironment(project, {
      id: `env-${name}`,
      name,
      slug: name,
      order: project.environments.length,
      endpoints,
      properties: {},
      disabledProperties: [],
    }),
  );
}

/** The item path of the REST request an import made for `method path`. */
export async function restItem(dir: string, method: string, path: string): Promise<string> {
  const { project } = await loadProject(dir);
  const found = selectRequests(project, []).selected.find(
    (item) =>
      item.kind === 'rest' &&
      item.request.contract?.method.toLowerCase() === method.toLowerCase() &&
      item.request.contract.path === path,
  );
  if (found === undefined) {
    throw new Error(`no request for ${method} ${path}`);
  }
  return found.path;
}

export interface Received {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

export interface Reply {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface TestServer {
  readonly url: string;
  readonly received: Received[];
  close(): Promise<void>;
}

/** A local HTTP server that answers every request with `reply` and records what it received. */
export async function startServer(reply: (request: Received) => Reply | Promise<Reply>): Promise<TestServer> {
  const received: Received[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const request: Received = {
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      received.push(request);
      Promise.resolve()
        .then(() => reply(request))
        .then(
          (answer) => {
            res.writeHead(answer.status ?? 200, answer.headers ?? {});
            res.end(answer.body);
          },
          () => {
            res.writeHead(500);
            res.end();
          },
        );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    received,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

/** A copy of the calculator WSDL with a second, SOAP 1.2 binding: two operations named `Add`. */
export async function twoBindingWsdl(): Promise<string> {
  const original = await readFile(CALCULATOR_WSDL, 'utf8');
  const withNamespace = original.replace(
    'xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"',
    'xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"\n                  xmlns:soap12="http://schemas.xmlsoap.org/wsdl/soap12/"',
  );
  const binding = `  <wsdl:binding name="CalculatorSoap12" type="tns:CalculatorPort">
    <soap12:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>
    <wsdl:operation name="Add">
      <soap12:operation soapAction="urn:wirebench:calculator/Add"/>
      <wsdl:input><soap12:body use="literal"/></wsdl:input>
      <wsdl:output><soap12:body use="literal"/></wsdl:output>
    </wsdl:operation>
  </wsdl:binding>
`;
  const port = `    <wsdl:port name="CalculatorPort12" binding="tns:CalculatorSoap12">
      <soap12:address location="http://127.0.0.1:9/calculator12"/>
    </wsdl:port>
`;
  const file = join(await tempDir(), 'calculator-two.wsdl');
  await writeFile(
    file,
    withNamespace
      .replace('  <wsdl:service', `${binding}  <wsdl:service`)
      .replace('  </wsdl:service>', `${port}  </wsdl:service>`),
  );
  return file;
}

/** A one-endpoint OpenAPI file whose request body example carries a password and a literal `${secret}`. */
export async function exampleOpenApi(): Promise<string> {
  const file = join(await tempDir(), 'login.openapi.yaml');
  await writeFile(
    file,
    `openapi: 3.0.3
info:
  title: Login
  version: 1.0.0
servers:
  - url: http://127.0.0.1:9
paths:
  /login:
    post:
      operationId: login
      requestBody:
        content:
          application/json:
            schema:
              type: object
              required: [user]
              properties:
                user:
                  type: string
                note:
                  type: string
            example:
              user: alice
              password: ${SECRET}
              note: '\${secret}'
      responses:
        '200':
          description: ok
  /ping:
    post:
      operationId: ping
      requestBody:
        content:
          application/json: {}
      responses:
        '200':
          description: ok
`,
  );
  return file;
}

/** An OpenAPI file with `count` GET endpoints (`opN`), title `Many`: more than the tool cap allows. */
export async function manyOperationsOpenApi(count: number): Promise<string> {
  const paths = Array.from(
    { length: count },
    (_, index) => `  /r${String(index)}:
    get:
      operationId: op${String(index)}
      responses:
        '200':
          description: ok
`,
  ).join('');
  const file = join(await tempDir(), 'many.openapi.yaml');
  await writeFile(
    file,
    `openapi: 3.0.3
info:
  title: Many
  version: 1.0.0
servers:
  - url: http://127.0.0.1:9
paths:
${paths}`,
  );
  return file;
}

/**
 * Writes the golden sidecar the desktop's Snapshot tab would save beside the saved request at `item`
 * (its path as `operations` lists it). JSON is YAML, so no YAML dependency is needed here.
 *
 * @returns the sidecar's path
 */
export async function writeGolden(
  dir: string,
  item: string,
  golden: { readonly body: string; readonly ignore?: readonly string[]; readonly contentType?: string },
): Promise<string> {
  const { project } = await loadProject(dir);
  const found = selectRequests(project, []).selected.find((selected) => selected.path === item);
  if (found === undefined) {
    throw new Error(`no request at ${item}`);
  }
  const location = requestFileLocation(project, found.request.id);
  if (location === undefined) {
    throw new Error(`no file location for ${item}`);
  }
  const file = join(dir, ...location.dir.split('/'), `${location.slug}.golden.yaml`);
  await writeFile(
    file,
    JSON.stringify({
      savedAt: '2026-10-03T10:00:00.000Z',
      ignore: golden.ignore ?? [],
      body: golden.body,
      ...(golden.contentType !== undefined ? { contentType: golden.contentType } : {}),
    }),
  );
  return file;
}
