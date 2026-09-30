/**
 * How SOAP interfaces are stored in a project folder (spec §3.2): `interfaces/<slug>/interface.yaml`,
 * and under `operations/<operation slug>/` one `<slug>.request.yaml` with its envelope in the sibling
 * `<slug>.xml` and its scripts beside it.
 */

import type { Assertion } from '../assert/model.js';
import { toCallbackAssertion } from '../assert/schema.js';
import type { FsLike } from '../project/fs.js';
import { readFileIfExists, readdirIfExists } from '../project/fs.js';
import { abs, authConfig, byOrder, exact, loadScripts, optional, readYaml } from '../project/load-helpers.js';
import type { ProjectProblem } from '../project/load.js';
import type {
  Attachment,
  Endpoint,
  Interface,
  OperationDef,
  RequestProperties,
  SoapOwnerAuth,
  SoapRequestDef,
} from '../project/model.js';
import { INTERFACES_DIR, OPERATIONS_DIR, REQUEST_SUFFIX } from '../project/paths.js';
import { assertSupportedKind, parseFile } from '../project/schema-parts.js';
import type { ProtocolStorage } from '../protocol/module.js';
import { normalizeWsa } from '../wsa/model.js';
import { interfaceFileSchema, requestFileSchema } from './files.js';

/**
 * Authentication at one of the three SOAP owner sites (interface, endpoint, request), loaded
 * through {@link authConfig} so OAuth2 defaults (`scopes`, `clientAuth`, `pkce`) are filled
 * exactly as for REST, then narrowed to {@link SoapOwnerAuth}: the schema (`soapOwnerAuthSchema`)
 * already refuses `inherit` at these sites, so the narrowing cast only restates what parsing
 * proved.
 */
function soapOwnerAuth(parsed: Record<string, unknown> | undefined): SoapOwnerAuth | undefined {
  return parsed === undefined ? undefined : (authConfig(parsed) as unknown as SoapOwnerAuth);
}

async function loadRequests(
  fs: FsLike,
  root: string,
  dir: string,
  problems: ProjectProblem[],
): Promise<SoapRequestDef[]> {
  const requests: SoapRequestDef[] = [];
  const entries = await readdirIfExists(fs, abs(root, dir));
  const names = new Set(entries.filter((e) => e.isFile).map((e) => e.name));
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile || !entry.name.endsWith(REQUEST_SUFFIX)) {
      continue;
    }
    const slug = entry.name.slice(0, -REQUEST_SUFFIX.length);
    const relative = `${dir}/${entry.name}`;
    const document = await readYaml(fs, root, relative);
    assertSupportedKind(document, relative);
    const parsed = parseFile(requestFileSchema, document, relative);
    const xmlRelative = `${dir}/${slug}.xml`;
    const envelope = await readFileIfExists(fs, abs(root, xmlRelative));
    if (envelope === undefined) {
      problems.push({
        code: 'missing-envelope',
        message: `Request "${parsed.name}" has no envelope file; loaded with an empty body`,
        file: xmlRelative,
      });
    }
    names.delete(entry.name);
    names.delete(`${slug}.xml`);
    const scripts = await loadScripts(fs, root, dir, slug, parsed.scripts, parsed.name, problems, (name) =>
      names.delete(name),
    );
    requests.push({
      kind: 'soap',
      id: parsed.id,
      name: parsed.name,
      slug,
      order: parsed.order,
      ...optional('description', parsed.description),
      ...optional('endpointId', parsed.endpointId),
      ...optional('endpointUrl', parsed.endpointUrl),
      soapVersion: parsed.soapVersion,
      ...optional('soapAction', parsed.soapAction),
      headers: parsed.headers,
      attachments: parsed.attachments.map((a) => exact<Attachment>(a)),
      ...optional('auth', soapOwnerAuth(parsed.auth)),
      ...(parsed.wsa !== undefined ? { wsa: normalizeWsa(parsed.wsa) } : {}),
      ...optional('wssOutgoingRef', parsed.wssOutgoingRef),
      ...optional('wssIncomingRef', parsed.wssIncomingRef),
      properties: exact<RequestProperties>(parsed.properties),
      assertions: parsed.assertions.map((a) => (a.type === 'callback' ? toCallbackAssertion(a) : exact<Assertion>(a))),
      ...(parsed.orphaned === true ? { orphaned: true } : {}),
      ...(scripts !== undefined ? { scripts } : {}),
      envelopeXml: envelope === undefined ? '' : envelope.toString('utf8'),
    });
  }
  for (const orphan of [...names].sort()) {
    problems.push({
      code: 'orphan-request-file',
      message: `"${orphan}" does not belong to any request`,
      file: `${dir}/${orphan}`,
    });
  }
  return requests.sort(byOrder);
}

/** SOAP's storage facet. */
export const soapStorage: ProtocolStorage<Interface> = {
  dir: INTERFACES_DIR,

  async load(ctx, slug, document) {
    const { fs, root, problems } = ctx;
    const relative = `${INTERFACES_DIR}/${slug}/interface.yaml`;
    const parsed = parseFile(interfaceFileSchema, document, relative);
    const operationsDir = `${INTERFACES_DIR}/${slug}/${OPERATIONS_DIR}`;
    const folders = new Set(
      (await readdirIfExists(fs, abs(root, operationsDir))).filter((e) => e.isDirectory).map((e) => e.name),
    );
    const operations: OperationDef[] = [];
    for (const entry of parsed.operations) {
      folders.delete(entry.slug);
      operations.push({
        name: entry.name,
        bindingName: entry.bindingName,
        slug: entry.slug,
        order: entry.order,
        requests: await loadRequests(fs, root, `${operationsDir}/${entry.slug}`, problems),
      });
    }
    for (const orphan of [...folders].sort()) {
      problems.push({
        code: 'orphan-operation-folder',
        message: `Operation folder "${orphan}" is not listed in interface.yaml`,
        file: `${operationsDir}/${orphan}`,
      });
    }
    const endpoints: readonly Endpoint[] = parsed.endpoints.map((e) => ({
      id: e.id,
      name: e.name,
      url: e.url,
      ...optional('auth', soapOwnerAuth(e.auth)),
      authMode: e.authMode,
    }));
    return {
      kind: 'soap',
      id: parsed.id,
      name: parsed.name,
      slug,
      order: parsed.order,
      definitionUrl: parsed.definitionUrl,
      cacheDefinition: parsed.cacheDefinition,
      ...optional('targetNamespace', parsed.targetNamespace),
      endpoints,
      ...optional('defaultEndpointId', parsed.defaultEndpointId),
      wsa: normalizeWsa(parsed.wsa),
      ...optional('auth', soapOwnerAuth(parsed.auth)),
      operations: operations.sort(byOrder),
    };
  },

  // Task 3.3 moves the writer here. Until then core writes this protocol's files itself.
  files() {
    throw new Error('soapStorage.files is not implemented yet');
  },
  managed() {
    return Promise.reject(new Error('soapStorage.managed is not implemented yet'));
  },

  containers: (project) => project.interfaces,
  withContainers: (project, interfaces) => ({ ...project, interfaces }),
};
