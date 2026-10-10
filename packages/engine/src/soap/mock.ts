/**
 * SOAP's mock facet (spec §Validation → SOAP, §Generating a mock): routes a request to an operation of
 * the mock's binding by SOAPAction and Body element, checks it against the WSDL and XSDs, and answers
 * what it refuses with a fault in the binding's SOAP version.
 */

import type { Element } from '@xmldom/xmldom';
import { WirebenchError } from '../errors.js';
import type {
  GeneratedMock,
  MockContract,
  MockProblem,
  MockReply,
  MockRequest,
  MockRoute,
  MockStubInput,
  ProtocolMocking,
} from '../mock/contract.js';
import type { MockResponse, MockValidation } from '../mock/model.js';
import type { FsLike } from '../project/fs.js';
import type { Interface, Project } from '../project/model.js';
import { definitionCacheDir } from '../project/paths.js';
import type { HeaderPair } from '../script/model.js';
import { bindingContextFor, checkSoapStructure, validateMessage } from '../validate/index.js';
import type { ValidationBinding, ValidationProblem } from '../validate/types.js';
import { readDefinitionCache } from '../wsdl/cache.js';
import { parseWsdlBundle } from '../wsdl/merge.js';
import type { Binding, BindingOperation, WsdlDefinition } from '../wsdl/model.js';
import { findBinding, findPortType } from '../wsdl/model.js';
import type { DefinitionBundle } from '../wsdl/resolver.js';
import { parseXml } from '../xml/parse.js';
import { buildSchemaSet } from '../xsd/schema-set.js';
import type { SchemaSet } from '../xsd/schema-set.js';
import { definitionReply } from './mock-wsdl.js';
import { buildSampleMessage } from './request-builder.js';

const SOAP11_ENV = 'http://schemas.xmlsoap.org/soap/envelope/';
const SOAP12_ENV = 'http://www.w3.org/2003/05/soap-envelope';
/** The namespace of the problem list in a refusal's fault detail. */
export const MOCK_FAULT_NAMESPACE = 'urn:wirebench:mock';
/** Problems a fault detail lists, at most. */
const MAX_FAULT_PROBLEMS = 20;

interface Contract {
  readonly iface: Interface;
  readonly definition: WsdlDefinition;
  readonly bundle: DefinitionBundle;
  readonly schemaSet: SchemaSet;
  readonly binding: Binding & { readonly soapVersion: '1.1' | '1.2' };
}

function clark(namespaceUri: string, localName: string): string {
  return `{${namespaceUri}}${localName}`;
}

function fromClark(value: string): { namespaceUri: string; localName: string } {
  const match = /^\{([^}]*)\}(.*)$/.exec(value);
  return match === null
    ? { namespaceUri: '', localName: value }
    : { namespaceUri: match[1] ?? '', localName: match[2] ?? '' };
}

function definitionMissing(iface: Interface, reason: string): WirebenchError {
  return new WirebenchError(
    'mock-definition-missing',
    `The interface "${iface.name}" has no readable cached definition (${reason}); import it again with definitions cached`,
    { details: { interface: iface.name } },
  );
}

async function loadContract(
  project: Project,
  root: string,
  fs: FsLike,
  containerId: string,
  bindingName: string | undefined,
): Promise<Contract> {
  const iface = project.interfaces.find((candidate) => candidate.id === containerId);
  if (iface === undefined) {
    throw new WirebenchError('mock-container-missing', `The project has no interface with id ${containerId}`, {
      details: { containerId },
    });
  }
  if (!iface.cacheDefinition) {
    throw definitionMissing(iface, 'it does not cache its definition');
  }
  let bundle: DefinitionBundle;
  try {
    bundle = await readDefinitionCache(definitionCacheDir(root, iface.slug), { fs });
  } catch (error) {
    throw definitionMissing(iface, error instanceof Error ? error.message : String(error));
  }
  const definition = parseWsdlBundle(bundle);
  const binding = chooseBinding(definition, bindingName);
  if (binding === undefined) {
    throw new WirebenchError(
      'mock-binding-unknown',
      bindingName === undefined
        ? `The interface "${iface.name}" has no SOAP binding`
        : `The interface "${iface.name}" has no SOAP binding ${bindingName}`,
      { details: { interface: iface.name, ...(bindingName !== undefined ? { binding: bindingName } : {}) } },
    );
  }
  return { iface, definition, bundle, schemaSet: buildSchemaSet(bundle), binding };
}

function isSoapBinding(binding: Binding): binding is Binding & { readonly soapVersion: '1.1' | '1.2' } {
  return binding.soapVersion !== 'none';
}

/** The named binding, or the first SOAP 1.1 binding, or the first SOAP binding. */
function chooseBinding(
  definition: WsdlDefinition,
  name: string | undefined,
): (Binding & { readonly soapVersion: '1.1' | '1.2' }) | undefined {
  if (name !== undefined) {
    const found = findBinding(definition, fromClark(name));
    return found !== undefined && isSoapBinding(found) ? found : undefined;
  }
  const soap = definition.bindings.filter(isSoapBinding);
  return soap.find((binding) => binding.soapVersion === '1.1') ?? soap[0];
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function contentTypeFor(version: '1.1' | '1.2'): string {
  return version === '1.1' ? 'text/xml; charset=utf-8' : 'application/soap+xml; charset=utf-8';
}

/**
 * A fault in `version`: `Client`/`Sender` when the request is at fault, `Server`/`Receiver` when the
 * mock is. Problems are listed in the detail, in the {@link MOCK_FAULT_NAMESPACE} namespace.
 */
export function soapFault(
  version: '1.1' | '1.2',
  who: 'client' | 'server',
  reason: string,
  problems: readonly MockProblem[] = [],
  status = 500,
): MockReply {
  const listed = problems.slice(0, MAX_FAULT_PROBLEMS).map((problem) => {
    const attributes = [
      ` code="${escapeXml(problem.code)}"`,
      problem.line !== undefined ? ` line="${String(problem.line)}"` : '',
      problem.column !== undefined ? ` column="${String(problem.column)}"` : '',
    ].join('');
    return `<wb:problem${attributes}>${escapeXml(problem.message)}</wb:problem>`;
  });
  const detail =
    listed.length > 0 ? `<wb:problems xmlns:wb="${MOCK_FAULT_NAMESPACE}">${listed.join('')}</wb:problems>` : '';
  const body =
    version === '1.1'
      ? `<soap:Envelope xmlns:soap="${SOAP11_ENV}"><soap:Body><soap:Fault>` +
        `<faultcode>soap:${who === 'client' ? 'Client' : 'Server'}</faultcode>` +
        `<faultstring>${escapeXml(reason)}</faultstring>` +
        (detail !== '' ? `<detail>${detail}</detail>` : '') +
        `</soap:Fault></soap:Body></soap:Envelope>`
      : `<env:Envelope xmlns:env="${SOAP12_ENV}"><env:Body><env:Fault>` +
        `<env:Code><env:Value>env:${who === 'client' ? 'Sender' : 'Receiver'}</env:Value></env:Code>` +
        `<env:Reason><env:Text xml:lang="en">${escapeXml(reason)}</env:Text></env:Reason>` +
        (detail !== '' ? `<env:Detail>${detail}</env:Detail>` : '') +
        `</env:Fault></env:Body></env:Envelope>`;
  return { status, headers: [['Content-Type', contentTypeFor(version)]], body: `${body}\n` };
}

function header(request: MockRequest, name: string): string | undefined {
  const wanted = name.toLowerCase();
  return request.headers.find(([candidate]) => candidate.toLowerCase() === wanted)?.[1];
}

interface ContentType {
  readonly mediaType: string;
  readonly action?: string;
}

function parseContentType(value: string | undefined): ContentType | undefined {
  if (value === undefined) return undefined;
  const [type = '', ...params] = value.split(';');
  let action: string | undefined;
  for (const param of params) {
    const eq = param.indexOf('=');
    if (eq !== -1 && param.slice(0, eq).trim().toLowerCase() === 'action') {
      action = param
        .slice(eq + 1)
        .trim()
        .replace(/^"(.*)"$/, '$1');
    }
  }
  return { mediaType: type.trim().toLowerCase(), ...(action !== undefined ? { action } : {}) };
}

/** The first element child of the envelope's `Body`, as `{ns}local`, or undefined. */
function bodyElementOf(xml: string): { readonly element?: string; readonly malformed?: string } {
  let root: Element | null;
  try {
    root = parseXml(xml).documentElement;
  } catch (error) {
    return { malformed: error instanceof Error ? error.message : String(error) };
  }
  if (root === null || root.localName !== 'Envelope') {
    return { malformed: 'The body is not a SOAP envelope' };
  }
  for (let child = root.firstChild; child !== null; child = child.nextSibling) {
    if (child.nodeType === 1 && (child as Element).localName === 'Body') {
      for (let inner = child.firstChild; inner !== null; inner = inner.nextSibling) {
        if (inner.nodeType === 1) {
          const element = inner as Element;
          return { element: clark(element.namespaceURI ?? '', element.localName ?? '') };
        }
      }
      return {};
    }
  }
  return { malformed: 'The envelope has no Body' };
}

interface OperationInfo {
  readonly operation: BindingOperation;
  readonly validation?: ValidationBinding;
  /** The Body's first element a request for this operation carries. */
  readonly bodyElement?: string;
}

function operationInfo(contract: Contract): OperationInfo[] {
  const { definition, binding } = contract;
  return binding.operations.map((operation) => {
    const validation = bindingContextFor(
      definition,
      { bindingName: binding.name, operationName: operation.name },
      'request',
    );
    const style = operation.style ?? binding.style;
    const first = validation?.parts[0]?.element;
    const bodyElement =
      style === 'rpc'
        ? clark(operation.input?.body.namespace ?? '', operation.name)
        : first !== undefined
          ? clark(first.namespaceUri, first.localName)
          : undefined;
    return {
      operation,
      ...(validation !== undefined ? { validation } : {}),
      ...(bodyElement !== undefined ? { bodyElement } : {}),
    };
  });
}

function problem(code: string, message: string, extra: Partial<MockProblem> = {}): MockProblem {
  return { code, message, ...extra };
}

function stubProblem(message: string, extra: Partial<MockProblem> = {}): MockProblem {
  return { code: 'mock-stub-invalid', message, ...extra };
}

/**
 * What the contract does not allow of one stub (#325). The body gets the checks a received response
 * gets — the SOAP structure, the version against `Content-Type`, and the output message's schema; a
 * fault gets the structure checks only, since its detail is not the output message. The status must
 * be 200 for a reply, 500 for a SOAP 1.1 fault (400 or 500 for 1.2), and 200 or 202 for a one-way
 * operation's empty acknowledgement.
 */
async function checkStub(contract: Contract, input: MockStubInput): Promise<readonly MockProblem[]> {
  const { definition, binding } = contract;
  const { response, headers } = input;
  const name = input.operation;
  if (!binding.operations.some((operation) => operation.name === name)) return [];
  const abstract = findPortType(definition, binding.type)?.operations.find((candidate) => candidate.name === name);
  const oneWay = abstract !== undefined && abstract.output === undefined;
  const version = binding.soapVersion;
  const status = response.status;
  const text = response.body === 'none' ? '' : response.bodyText;
  if (text.trim() === '') {
    if (!oneWay) return [stubProblem(`${name} returns a message; this response has no body`, { in: 'body' })];
    return status === 200 || status === 202
      ? []
      : [stubProblem(`A one-way operation is acknowledged with 202 or 200, not ${String(status)}`, { in: 'status' })];
  }
  if (response.body !== 'xml') {
    return [stubProblem(`A SOAP response body is XML, not ${response.body}`, { in: 'body' })];
  }
  const problems: MockProblem[] = [];
  const element = bodyElementOf(text).element;
  const fault = element === clark(SOAP11_ENV, 'Fault') || element === clark(SOAP12_ENV, 'Fault');
  if (fault) {
    const allowed = version === '1.1' ? [500] : [400, 500];
    if (!allowed.includes(status)) {
      problems.push(
        stubProblem(`A SOAP ${version} fault is sent with ${allowed.join(' or ')}, not ${String(status)}`, {
          in: 'status',
        }),
      );
    }
  } else if (oneWay) {
    problems.push(stubProblem(`${name} is one-way: the contract declares no response message`, { in: 'body' }));
  } else if (status !== 200) {
    problems.push(
      stubProblem(`A SOAP reply that is not a fault is sent with 200, not ${String(status)}`, { in: 'status' }),
    );
  }
  const contentType = headers.find(([header]) => header.toLowerCase() === 'content-type')?.[1];
  const validation = bindingContextFor(definition, { bindingName: binding.name, operationName: name }, 'response');
  let found: readonly ValidationProblem[];
  if (fault || oneWay || validation === undefined) {
    found = checkSoapStructure(text, {
      expectedVersion: version,
      ...(contentType !== undefined ? { contentType } : {}),
    });
  } else {
    found = (
      await validateMessage({
        xml: text,
        direction: 'response',
        schemaSet: contract.schemaSet,
        bundle: contract.bundle,
        binding: validation,
        http: contentType !== undefined ? { contentType } : {},
      })
    ).problems;
  }
  for (const item of found) {
    // A received response with the wrong Content-Type is only a warning; a stub the mock sends with it is wrong.
    const header = item.code === 'content-type-mismatch';
    if (item.severity !== 'error' && !header) continue;
    problems.push(
      stubProblem(item.message, {
        ...(header ? { in: 'header', name: 'Content-Type' } : { in: 'body' }),
        ...(item.path !== undefined ? { path: item.path } : {}),
        ...(item.line !== undefined ? { line: item.line } : {}),
        ...(item.column !== undefined ? { column: item.column } : {}),
      }),
    );
  }
  return problems;
}

function createContract(contract: Contract): MockContract {
  const version = contract.binding.soapVersion;
  const operations = operationInfo(contract);
  const bindingLabel = contract.binding.name.localName;
  const refuse = (problems: readonly MockProblem[], reason: string, status = 500, operation?: string): MockRoute => ({
    kind: 'refused',
    ...(operation !== undefined ? { operation } : {}),
    problems,
    reply: soapFault(version, 'client', reason, problems, status),
  });

  return {
    operations: operations.map(({ operation }) => ({ key: operation.name, name: operation.name })),

    definition: (request, mockUrl) => definitionReply(contract.bundle, request, mockUrl),

    async route(request: MockRequest, mode: MockValidation): Promise<MockRoute> {
      if (request.method !== 'POST') {
        const refused = problem('mock-request-invalid', `A SOAP request is a POST, not a ${request.method}`);
        return {
          kind: 'refused',
          problems: [refused],
          reply: {
            ...soapFault(version, 'client', refused.message, [], 405),
            headers: [
              ['Content-Type', contentTypeFor(version)],
              ['Allow', 'POST'],
            ],
          },
        };
      }
      if (/<!DOCTYPE/i.test(request.bodyText)) {
        return refuse(
          [problem('mock-request-invalid', 'A SOAP message may not hold a document type declaration')],
          'The request does not conform to the contract',
        );
      }
      const problems: MockProblem[] = [];
      const contentType = parseContentType(header(request, 'content-type'));
      const wantedType = version === '1.1' ? 'text/xml' : 'application/soap+xml';
      const typeWrong = contentType?.mediaType !== wantedType;
      if (typeWrong && mode !== 'off') {
        problems.push(
          problem(
            'mock-request-invalid',
            `A SOAP ${version} request has Content-Type ${wantedType}, not ${contentType?.mediaType ?? 'none'}`,
            { in: 'header', name: 'Content-Type' },
          ),
        );
      }
      const rawAction =
        version === '1.1'
          ? header(request, 'soapaction')
              ?.trim()
              .replace(/^"(.*)"$/, '$1')
          : contentType?.action;
      const action = rawAction !== undefined && rawAction !== '' ? rawAction : undefined;

      const body = bodyElementOf(request.bodyText);
      if (body.malformed !== undefined) {
        return refuse(
          [problem('mock-request-invalid', `The request is not a well-formed SOAP envelope: ${body.malformed}`)],
          'The request does not conform to the contract',
        );
      }
      const byBody = operations.filter((info) => body.element !== undefined && info.bodyElement === body.element);
      const byAction = operations.filter(
        (info) =>
          action !== undefined && info.operation.soapAction !== undefined && info.operation.soapAction === action,
      );
      const chosen = (byBody.length === 1 ? byBody[0] : undefined) ?? (byAction.length === 1 ? byAction[0] : undefined);
      if (chosen === undefined) {
        return refuse(
          [problem('mock-operation-not-found', `No operation of ${bindingLabel} matches this request`)],
          `No operation of ${bindingLabel} matches this request`,
        );
      }
      const operation = chosen.operation.name;
      if (
        action !== undefined &&
        chosen.operation.soapAction !== undefined &&
        chosen.operation.soapAction !== '' &&
        chosen.operation.soapAction !== action &&
        mode !== 'off'
      ) {
        problems.push(
          problem(
            'mock-request-invalid',
            `The SOAPAction ${action} is not ${operation}'s (${chosen.operation.soapAction})`,
            {
              in: 'header',
              name: 'SOAPAction',
            },
          ),
        );
      }
      if (mode !== 'off' && chosen.validation !== undefined) {
        const checked = await validateMessage({
          xml: request.bodyText,
          direction: 'request',
          schemaSet: contract.schemaSet,
          bundle: contract.bundle,
          binding: chosen.validation,
          http: {
            ...(contentType !== undefined ? { contentType: header(request, 'content-type') ?? '' } : {}),
            ...(rawAction !== undefined ? { soapAction: rawAction } : {}),
          },
        });
        for (const found of checked.problems) {
          if (found.severity !== 'error') continue;
          problems.push(
            problem('mock-request-invalid', found.message, {
              ...(found.path !== undefined ? { path: found.path } : {}),
              ...(found.line !== undefined ? { line: found.line } : {}),
              ...(found.column !== undefined ? { column: found.column } : {}),
            }),
          );
        }
      }
      if (mode === 'reject' && problems.length > 0) {
        return refuse(problems, 'The request does not conform to the contract', typeWrong ? 415 : 500, operation);
      }
      return { kind: 'operation', operation, problems, view: { bodyKind: 'xml', pathParams: {} } };
    },

    fail(code: string, message: string): MockReply {
      return soapFault(
        version,
        'server',
        message,
        [{ code, message }],
        code === 'mock-operation-not-found' ? 404 : 500,
      );
    },

    defaults(response: MockResponse): readonly HeaderPair[] {
      switch (response.body) {
        case 'xml':
          return [['Content-Type', contentTypeFor(version)]];
        case 'json':
          return [['Content-Type', 'application/json']];
        case 'text':
          return [['Content-Type', 'text/plain; charset=utf-8']];
        case 'none':
          return [];
      }
    },

    async checkStubs(stubs: readonly MockStubInput[]): Promise<readonly (readonly MockProblem[])[]> {
      const results: (readonly MockProblem[])[] = [];
      for (const stub of stubs) results.push(await checkStub(contract, stub));
      return results;
    },
  };
}

/** SOAP's mock facet. */
export const soapMocking: ProtocolMocking = {
  async open({ project, root, fs, mock }) {
    return createContract(await loadContract(project, root, fs, mock.source.containerId, mock.source.binding));
  },

  async generate({ project, root, fs, containerId, binding: bindingName }): Promise<GeneratedMock> {
    const contract = await loadContract(project, root, fs, containerId, bindingName);
    const { definition, binding, schemaSet } = contract;
    const portType = findPortType(definition, binding.type);
    return {
      binding: clark(binding.name.namespaceUri, binding.name.localName),
      operations: binding.operations.map((operation) => {
        const abstract = portType?.operations.find((candidate) => candidate.name === operation.name);
        if (abstract !== undefined && abstract.output === undefined) {
          return { key: operation.name, name: operation.name, response: { status: 202, body: 'none', bodyText: '' } };
        }
        const sample = buildSampleMessage(
          { definition, schemaSet },
          { bindingName: binding.name, operationName: operation.name },
          'output',
        );
        return {
          key: operation.name,
          name: operation.name,
          response: { status: 200, body: 'xml', bodyText: sample.envelopeXml },
        };
      }),
    };
  },
};
