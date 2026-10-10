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
import type { SoapOwnerAuth } from '../project/model.js';
import type { Attachment, Endpoint, Interface, OperationDef, RequestProperties, SoapRequestDef } from './model.js';
import { assertPathSegment, INTERFACES_DIR, OPERATIONS_DIR, REQUEST_SUFFIX } from '../project/paths.js';
import { assertSupportedKind, parseFile } from '../project/schema-parts.js';
import { authDocument, scriptsDocument, writeScriptFiles } from '../project/serialize-helpers.js';
import { compact, stringifyYaml } from '../project/yaml.js';
import type { ProtocolStorage } from '../protocol/module.js';
import { isScriptFileOf } from '../script/model.js';
import { normalizeWsa } from '../wsa/model.js';
import { interfaceFileSchema, requestFileSchema } from './files.js';
import { interfaceIds, withInterfaceIds } from './identity.js';
import { soapInterfacesOf, withSoapInterfaces } from './model.js';

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
      headers: parsed.headers.map((header) => ({
        name: header.name,
        value: header.value,
        ...(header.enabled === false ? { enabled: false } : {}),
        ...optional('description', header.description),
      })),
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

function requestDocument(request: SoapRequestDef): Record<string, unknown> {
  return compact({
    kind: request.kind,
    id: request.id,
    name: request.name,
    order: request.order,
    description: request.description,
    endpointId: request.endpointId,
    endpointUrl: request.endpointUrl,
    soapVersion: request.soapVersion,
    soapAction: request.soapAction,
    // `enabled` is written only when a row is off, so a file whose headers are all on reads as before.
    headers: request.headers.map((h) =>
      compact({
        name: h.name,
        value: h.value,
        enabled: h.enabled === false ? false : undefined,
        description: h.description,
      }),
    ),
    attachments: request.attachments.map((a) => compact({ ...a })),
    auth: request.auth === undefined ? undefined : authDocument(request.auth),
    wsa: request.wsa === undefined ? undefined : compact({ ...request.wsa }),
    wssOutgoingRef: request.wssOutgoingRef,
    wssIncomingRef: request.wssIncomingRef,
    properties: compact({ ...request.properties }),
    assertions: request.assertions.length > 0 ? request.assertions.map((a) => compact({ ...a })) : undefined,
    orphaned: request.orphaned === true ? true : undefined,
    scripts: scriptsDocument(request.scripts, request.slug).document,
  });
}

function interfaceDocument(iface: Interface): Record<string, unknown> {
  return compact({
    kind: iface.kind,
    id: iface.id,
    name: iface.name,
    order: iface.order,
    definitionUrl: iface.definitionUrl,
    cacheDefinition: iface.cacheDefinition,
    targetNamespace: iface.targetNamespace,
    endpoints: iface.endpoints.map((e) =>
      compact({ ...e, auth: e.auth === undefined ? undefined : authDocument(e.auth) }),
    ),
    defaultEndpointId: iface.defaultEndpointId,
    wsa: compact({ ...iface.wsa }),
    auth: iface.auth === undefined ? undefined : authDocument(iface.auth),
    operations: iface.operations.map((op) => ({
      name: op.name,
      bindingName: op.bindingName,
      slug: op.slug,
      order: op.order,
    })),
  });
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

  files(iface) {
    const files = new Map<string, string>();
    assertPathSegment(iface.slug);
    const base = `${INTERFACES_DIR}/${iface.slug}`;
    files.set(`${base}/interface.yaml`, stringifyYaml(interfaceDocument(iface)));
    for (const operation of iface.operations) {
      assertPathSegment(operation.slug);
      const dir = `${base}/${OPERATIONS_DIR}/${operation.slug}`;
      for (const request of operation.requests) {
        assertPathSegment(request.slug);
        files.set(`${dir}/${request.slug}${REQUEST_SUFFIX}`, stringifyYaml(requestDocument(request)));
        files.set(`${dir}/${request.slug}.xml`, request.envelopeXml);
        writeScriptFiles(files, dir, request.scripts, request.slug);
      }
    }
    return files;
  },

  /**
   * `interface.yaml`, every `operations/<slug>/*.request.yaml`, and the `.xml` and script files
   * that sit beside a request file of the same slug. An envelope with no request file, the
   * definition cache and anything else in the folder are not Wirebench's to delete.
   */
  async managed(fs, root, slug) {
    const managed: string[] = [];
    const base = `${INTERFACES_DIR}/${slug}`;
    const ifaceFile = `${base}/interface.yaml`;
    if ((await readFileIfExists(fs, abs(root, ifaceFile))) !== undefined) {
      managed.push(ifaceFile);
    }
    const opsDir = `${base}/${OPERATIONS_DIR}`;
    for (const opEntry of await readdirIfExists(fs, abs(root, opsDir))) {
      if (!opEntry.isDirectory) {
        continue;
      }
      const opDir = `${opsDir}/${opEntry.name}`;
      const requestSlugs = new Set<string>();
      const opFiles = await readdirIfExists(fs, abs(root, opDir));
      for (const fileEntry of opFiles) {
        if (fileEntry.isFile && fileEntry.name.endsWith(REQUEST_SUFFIX)) {
          requestSlugs.add(fileEntry.name.slice(0, -REQUEST_SUFFIX.length));
          managed.push(`${opDir}/${fileEntry.name}`);
        }
      }
      for (const fileEntry of opFiles) {
        if (fileEntry.isFile && fileEntry.name.endsWith('.xml')) {
          const requestSlug = fileEntry.name.slice(0, -'.xml'.length);
          if (requestSlugs.has(requestSlug)) {
            managed.push(`${opDir}/${fileEntry.name}`);
          }
        } else if (fileEntry.isFile && [...requestSlugs].some((known) => isScriptFileOf(fileEntry.name, known))) {
          managed.push(`${opDir}/${fileEntry.name}`);
        }
      }
    }
    return managed;
  },

  containers: (project) => soapInterfacesOf(project),
  withContainers: (project, interfaces) => withSoapInterfaces(project, interfaces),
  entityIds: interfaceIds,
  withEntityIds: withInterfaceIds,
  requestLocation: (iface, requestId) => {
    for (const operation of iface.operations) {
      const request = operation.requests.find((candidate) => candidate.id === requestId);
      if (request !== undefined) {
        return { dir: `${INTERFACES_DIR}/${iface.slug}/${OPERATIONS_DIR}/${operation.slug}`, slug: request.slug };
      }
    }
    return undefined;
  },
};
