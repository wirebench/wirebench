/**
 * Reads the text of a legacy single-XML SOAP project file into a {@link LegacyProject}.
 *
 * Tolerant by design: every optional element may be missing, and anything unexpected is skipped
 * rather than fatal. Only a document that is not well-formed, is not this format, or is encrypted
 * is rejected, with a {@link LegacyProjectError}.
 */

import { gunzipSync } from 'node:zlib';
import type { Element, Node } from '@xmldom/xmldom';
import { LegacyProjectError, WirebenchError } from '../../errors.js';
import { parseXmlDetailed } from '../../xml/parse.js';
import { serializeXml } from '../../xml/serialize.js';
import { LEGACY_PROJECT_NAMESPACE, LEGACY_PROJECT_ROOT } from './format.js';
import type {
  LegacyCall,
  LegacyCredentials,
  LegacyDefinitionCache,
  LegacyEnvironment,
  LegacyInterface,
  LegacyOperation,
  LegacyProject,
  LegacyProperty,
  LegacyScript,
  LegacyUnmapped,
} from './model.js';

const NS = LEGACY_PROJECT_NAMESPACE;

/** The direct child elements of `parent` in the format's namespace, optionally only those called `localName`. */
function children(parent: Element, localName?: string): Element[] {
  const found: Element[] = [];
  for (let node: Node | null = parent.firstChild; node !== null; node = node.nextSibling) {
    if (node.nodeType !== 1) {
      continue;
    }
    const element = node as Element;
    if (element.namespaceURI === NS && (localName === undefined || element.localName === localName)) {
      found.push(element);
    }
  }
  return found;
}

function child(parent: Element, localName: string): Element | undefined {
  return children(parent, localName)[0];
}

/** The text of the named child, or `undefined` when the child is missing. */
function childText(parent: Element, localName: string): string | undefined {
  const element = child(parent, localName);
  return element === undefined ? undefined : (element.textContent ?? '');
}

/** An attribute's value, with an empty string treated as absent. */
function attr(element: Element, name: string): string | undefined {
  const value = element.getAttribute(name);
  return value === null || value === '' ? undefined : value;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value;
}

function readProperties(elements: readonly Element[]): LegacyProperty[] {
  const properties: LegacyProperty[] = [];
  for (const element of elements) {
    const name = nonEmpty(childText(element, 'name'))?.trim();
    if (name !== undefined) {
      properties.push({ name, value: childText(element, 'value') ?? '' });
    }
  }
  return properties;
}

/**
 * A cache part's document. It is held either as text (usually a CDATA section) or inline as the
 * content element's single child element, which is serialized back to text.
 */
function partContent(content: Element): string {
  for (let node: Node | null = content.firstChild; node !== null; node = node.nextSibling) {
    if (node.nodeType === 1) {
      return serializeXml(node);
    }
  }
  return (content.textContent ?? '').trim();
}

function readCache(iface: Element): LegacyDefinitionCache | undefined {
  const cache = child(iface, 'definitionCache');
  if (cache === undefined) {
    return undefined;
  }
  const parts = [];
  for (const part of children(cache, 'part')) {
    const url = nonEmpty(childText(part, 'url'))?.trim();
    const content = child(part, 'content');
    if (url !== undefined && content !== undefined) {
      parts.push({ url, content: partContent(content) });
    }
  }
  if (parts.length === 0) {
    return undefined;
  }
  const rootPart = attr(cache, 'rootPart');
  return { ...(rootPart !== undefined ? { rootPart } : {}), parts };
}

/** Decodes a `request` element: plain text, or base64 of a gzip stream when `compression` is set. */
function readEnvelope(request: Element | undefined): { envelope?: string; envelopeProblem?: string } {
  if (request === undefined) {
    return { envelopeProblem: 'it has no request body' };
  }
  const text = request.textContent ?? '';
  const compression = attr(request, 'compression');
  if (compression === undefined) {
    return { envelope: text };
  }
  try {
    return { envelope: gunzipSync(Buffer.from(text.trim(), 'base64')).toString('utf8') };
  } catch {
    return { envelopeProblem: `its body is compressed as "${compression}", which could not be decoded` };
  }
}

function readCredentials(call: Element): LegacyCredentials {
  const credentials = child(call, 'credentials');
  if (credentials === undefined) {
    return { hadPassword: false };
  }
  const username = nonEmpty(childText(credentials, 'username'));
  const domain = nonEmpty(childText(credentials, 'domain'));
  const authType = nonEmpty(childText(credentials, 'authType'));
  return {
    ...(username !== undefined ? { username } : {}),
    ...(domain !== undefined ? { domain } : {}),
    hadPassword: nonEmpty(childText(credentials, 'password')) !== undefined,
    ...(authType !== undefined ? { authType } : {}),
  };
}

function readCall(call: Element, index: number): LegacyCall {
  const endpoint = nonEmpty(childText(call, 'endpoint'))?.trim();
  const encoding = nonEmpty(childText(call, 'encoding'))?.trim();
  const timeout = attr(call, 'timeout');
  const timeoutMs = timeout !== undefined && /^\d+$/.test(timeout.trim()) ? Number(timeout.trim()) : undefined;
  const wssRefs = [attr(call, 'outgoingWss'), attr(call, 'incomingWss')].filter(
    (ref): ref is string => ref !== undefined,
  );
  return {
    name: attr(call, 'name') ?? `Request ${String(index + 1)}`,
    ...(endpoint !== undefined ? { endpoint } : {}),
    ...readEnvelope(child(call, 'request')),
    ...(encoding !== undefined ? { encoding } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    credentials: readCredentials(call),
    useWsAddressing: attr(call, 'useWsAddressing') === 'true',
    assertions: children(call, 'assertion').length,
    attachments: children(call, 'attachment').length,
    wssRefs,
  };
}

function readOperation(operation: Element, index: number): LegacyOperation {
  const name = attr(operation, 'name') ?? attr(operation, 'bindingOperationName') ?? `Operation ${String(index + 1)}`;
  const action = attr(operation, 'action');
  return {
    name,
    bindingOperationName: attr(operation, 'bindingOperationName') ?? name,
    ...(action !== undefined ? { action } : {}),
    calls: children(operation, 'call').map(readCall),
  };
}

function readInterface(iface: Element, index: number): LegacyInterface {
  const definitionUrl = attr(iface, 'definition');
  const bindingName = attr(iface, 'bindingName');
  const cache = readCache(iface);
  const endpointsElement = child(iface, 'endpoints');
  const endpoints =
    endpointsElement === undefined
      ? []
      : children(endpointsElement, 'endpoint')
          .map((endpoint) => (endpoint.textContent ?? '').trim())
          .filter((url) => url !== '');
  return {
    name: attr(iface, 'name') ?? `Interface ${String(index + 1)}`,
    ...(definitionUrl !== undefined ? { definitionUrl } : {}),
    ...(bindingName !== undefined ? { bindingName } : {}),
    soapVersion: attr(iface, 'soapVersion') === '1_2' ? '1.2' : '1.1',
    ...(cache !== undefined ? { cache } : {}),
    endpoints: [...new Set(endpoints)],
    operations: children(iface, 'operation').map(readOperation),
  };
}

function readEnvironment(environment: Element, index: number): LegacyEnvironment {
  const endpoints = [];
  for (const service of children(environment, 'service')) {
    const interfaceName = attr(service, 'name');
    const url = nonEmpty(childText(service, 'endpoint'))?.trim();
    if (interfaceName !== undefined && url !== undefined) {
      endpoints.push({ interfaceName, url });
    }
  }
  return {
    name: attr(environment, 'name') ?? `Environment ${String(index + 1)}`,
    properties: readProperties(children(environment, 'property')),
    endpoints,
  };
}

/** Names of the named elements from just below the root down to (and including) `element`. */
function ownerPathOf(element: Element, root: Element): string[] {
  const path: string[] = [];
  for (let node: Node | null = element; node !== null && node !== root; node = node.parentNode) {
    if (node.nodeType === 1) {
      const name = attr(node as Element, 'name');
      if (name !== undefined) {
        path.unshift(name);
      }
    }
  }
  return path;
}

/**
 * Every script in the document: each element in the format's namespace whose local name ends in
 * `Script` and has text, and the `script` body of each script test step.
 */
function collectScripts(root: Element): LegacyScript[] {
  const scripts: LegacyScript[] = [];
  const visit = (element: Element): void => {
    for (let node: Node | null = element.firstChild; node !== null; node = node.nextSibling) {
      if (node.nodeType !== 1) {
        continue;
      }
      const current = node as Element;
      const isHook = current.namespaceURI === NS && /Script$/.test(current.localName ?? '');
      const isStepScript =
        current.localName === 'script' &&
        current.parentNode?.nodeType === 1 &&
        (current.parentNode as Element).localName === 'config';
      if (isHook || isStepScript) {
        const source = current.textContent ?? '';
        if (source.trim() !== '') {
          const language = attr(current, 'language');
          const owner = current.parentNode as Element;
          scripts.push({
            ownerPath: ownerPathOf(isStepScript ? (owner.parentNode as Element) : owner, root),
            element: current.localName ?? 'script',
            ...(language !== undefined ? { language } : {}),
            source,
          });
        }
        continue;
      }
      visit(current);
    }
  };
  visit(root);
  return scripts;
}

function hasChildElements(element: Element | undefined): boolean {
  if (element === undefined) {
    return false;
  }
  for (let node: Node | null = element.firstChild; node !== null; node = node.nextSibling) {
    if (node.nodeType === 1) {
      return true;
    }
  }
  return false;
}

/** Everything under the root that holds user work v1 does not map, for the import report. */
function collectUnmapped(root: Element): LegacyUnmapped[] {
  const unmapped: LegacyUnmapped[] = [];
  for (const iface of children(root, 'interface')) {
    const type = attr(iface, 'type');
    if (type !== 'wsdl') {
      unmapped.push({
        ownerPath: [attr(iface, 'name') ?? 'Unnamed service'],
        message: `A ${type ?? 'non-SOAP'} service is not imported; only SOAP interfaces are.`,
      });
    }
  }
  for (const suite of children(root, 'testSuite')) {
    const cases = children(suite, 'testCase').length;
    unmapped.push({
      ownerPath: [attr(suite, 'name') ?? 'Unnamed test suite'],
      message: `Test suite with ${String(cases)} test case${cases === 1 ? '' : 's'} is not imported.`,
    });
  }
  for (const kind of ['mockService', 'restMockService']) {
    for (const mock of children(root, kind)) {
      unmapped.push({
        ownerPath: [attr(mock, 'name') ?? 'Unnamed mock service'],
        message: 'Mock service is not imported.',
      });
    }
  }
  const containers: readonly (readonly [string, string])[] = [
    ['wssContainer', 'WS-Security configurations and keystores are not imported; set them up under WS-Security.'],
    ['databaseConnectionContainer', 'Database connections are not imported.'],
    ['oAuth2ProfileContainer', 'OAuth 2.0 profiles are not imported.'],
    ['oAuth1ProfileContainer', 'OAuth 1.0 profiles are not imported.'],
    ['requirements', 'Requirements are not imported.'],
  ];
  for (const [localName, message] of containers) {
    if (hasChildElements(child(root, localName))) {
      unmapped.push({ ownerPath: [], message });
    }
  }
  return unmapped;
}

/**
 * Parses `text` as a legacy single-XML SOAP project.
 *
 * @throws LegacyProjectError `legacy-malformed` when the XML is not well-formed or declares a DTD,
 *   `legacy-not-a-project` when it is some other document, and `legacy-encrypted` when the project
 *   was saved encrypted.
 */
export function parseLegacyProject(text: string, location?: string): LegacyProject {
  if (/<!DOCTYPE/i.test(text)) {
    throw new LegacyProjectError('legacy-malformed', 'The project file declares a DTD, which is not accepted', {
      ...(location !== undefined ? { details: { location } } : {}),
    });
  }
  let root: Element | null;
  try {
    root = parseXmlDetailed(text, location !== undefined ? { location } : undefined).document.documentElement;
  } catch (cause) {
    const message = cause instanceof WirebenchError ? cause.message : 'The file is not well-formed XML';
    throw new LegacyProjectError('legacy-malformed', `The project file is not well-formed XML: ${message}`, {
      cause,
      ...(cause instanceof WirebenchError && cause.details !== undefined ? { details: cause.details } : {}),
    });
  }
  if (root === null || root.namespaceURI !== NS || root.localName !== LEGACY_PROJECT_ROOT) {
    throw new LegacyProjectError('legacy-not-a-project', 'The file is not a legacy SOAP project');
  }
  if (nonEmpty(childText(root, 'encryptedContent')) !== undefined) {
    throw new LegacyProjectError(
      'legacy-encrypted',
      'The project was saved encrypted. Open it in the tool that wrote it, save it without a password, and import that copy.',
    );
  }

  const description = nonEmpty(childText(root, 'description'));
  const propertiesElement = child(root, 'properties');
  return {
    name: attr(root, 'name') ?? 'Imported project',
    ...(description !== undefined ? { description } : {}),
    properties: propertiesElement === undefined ? [] : readProperties(children(propertiesElement, 'property')),
    interfaces: children(root, 'interface')
      .filter((iface) => attr(iface, 'type') === 'wsdl')
      .map(readInterface),
    environments: children(root, 'environment').map(readEnvironment),
    scripts: collectScripts(root),
    unmapped: collectUnmapped(root),
  };
}
