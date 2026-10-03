/**
 * A SOAP operation's body as JSON (#33 spec §3.1, §4.1, §5). One document/literal element part is
 * that element's content; any other shape is one property per part, inside the rpc wrapper element
 * for rpc. The envelope's transport (version, action) is the one a new request of the operation has.
 */
import type { MessageDirection } from '../validate/index.js';
import { bindingContextFor } from '../validate/index.js';
import { findBinding, findMessage, findPortType } from '../wsdl/model.js';
import type { QName } from '../wsdl/qname.js';
import { NS } from '../xml/namespaces.js';
import { prefixForNamespace } from '../xml/prefixes.js';
import { createJsonSchemaWriter, jsonFromXml, xmlFromJson } from '../xsd/json-bridge.js';
import type { BridgeTarget, JsonFromXmlResult, JsonSchemaObject } from '../xsd/json-bridge.js';
import { scanXml } from '../xsd/xml-scan.js';
import type { ScannedElement } from '../xsd/xml-scan.js';
import { escapeAttribute } from '../xsd/xml-writer.js';
import { createEnvelope } from './envelope.js';
import type { SoapEnvelopeVersion } from './envelope.js';
import { findBody, namespacesInScope } from './form-request.js';
import { buildEmptyRequest } from './request-builder.js';
import type { OperationRef, RequestBuildInput } from './request-builder.js';

export interface OperationSchema {
  readonly schema: JsonSchemaObject;
  readonly notes: readonly string[];
}

export interface JsonEnvelope {
  readonly envelopeXml: string;
  readonly soapVersion: SoapEnvelopeVersion;
  readonly soapAction?: string;
  readonly notes: readonly string[];
  /** Why no body could be written; nothing may be sent when any. */
  readonly problems: readonly string[];
}

const ANY_TYPE: QName = { namespaceUri: NS.XSD, localName: 'anyType' };

interface BodyPart {
  readonly name: string;
  readonly target: BridgeTarget;
}

interface BodyShape {
  /** One document/literal element part: the arguments are its content. */
  readonly single: boolean;
  readonly parts: readonly BodyPart[];
  /** rpc: the element the parts sit in. */
  readonly wrapper?: QName;
}

function bodyShape(input: RequestBuildInput, op: OperationRef, direction: MessageDirection): BodyShape | undefined {
  const binding = bindingContextFor(input.definition, op, direction);
  if (binding === undefined) {
    return undefined;
  }
  const parts: BodyPart[] = binding.parts.map((part) => ({
    name: part.name,
    target:
      part.element !== undefined
        ? { element: part.element }
        : { name: { namespaceUri: '', localName: part.name }, type: part.type ?? ANY_TYPE },
  }));
  const [first] = parts;
  if (binding.style === 'document') {
    return { single: parts.length === 1 && first !== undefined && 'element' in first.target, parts };
  }
  const operation = findBinding(input.definition, op.bindingName)?.operations.find(
    (candidate) => candidate.name === op.operationName,
  );
  const body = direction === 'request' ? operation?.input?.body : operation?.output?.body;
  return {
    single: false,
    parts,
    wrapper: {
      namespaceUri: body?.namespace ?? input.definition.targetNamespace,
      localName: direction === 'request' ? op.operationName : `${op.operationName}Response`,
    },
  };
}

const OBJECT_OF_NOTHING: JsonSchemaObject = { type: 'object', properties: {}, additionalProperties: false };

/** The JSON Schema of an operation's input (or output) body, `$defs` shared across its parts. */
export function operationJsonSchema(
  input: RequestBuildInput,
  op: OperationRef,
  direction: MessageDirection = 'request',
): OperationSchema {
  const shape = bodyShape(input, op, direction);
  if (shape === undefined) {
    return {
      schema: OBJECT_OF_NOTHING,
      notes: [`${op.operationName}: the binding has no SOAP operation of that name`],
    };
  }
  const writer = createJsonSchemaWriter(input.schemaSet);
  let schema: JsonSchemaObject;
  const [first] = shape.parts;
  if (shape.single && first !== undefined) {
    const content = writer.schemaOf(first.target);
    // A body element of simple type takes its value as `#text`.
    schema =
      content['type'] === 'object'
        ? content
        : { type: 'object', properties: { '#text': content }, required: ['#text'], additionalProperties: false };
  } else {
    schema = {
      type: 'object',
      properties: Object.fromEntries(shape.parts.map((part) => [part.name, writer.schemaOf(part.target)])),
      ...(shape.parts.length > 0 ? { required: shape.parts.map((part) => part.name) } : {}),
      additionalProperties: false,
    };
  }
  const defs = writer.defs();
  return { schema: defs === undefined ? schema : { ...schema, $defs: defs }, notes: writer.notes() };
}

/**
 * The request envelope for `args`: the body written through the form model, in an envelope with no
 * indentation (`createEnvelope` indents every line of the body, which would change a multi-line value).
 */
export function envelopeFromJson(
  input: RequestBuildInput,
  op: OperationRef,
  args: Readonly<Record<string, unknown>>,
): JsonEnvelope {
  const empty = buildEmptyRequest(input, op);
  const notes = empty.problems.map((problem) => problem.message);
  const transport = {
    soapVersion: empty.soapVersion,
    ...(empty.soapAction !== undefined ? { soapAction: empty.soapAction } : {}),
  };
  const shape = bodyShape(input, op, 'request');
  if (shape === undefined) {
    return {
      envelopeXml: '',
      ...transport,
      notes,
      problems: [`${op.operationName}: the binding has no SOAP operation of that name`],
    };
  }
  const problems: string[] = [];
  const write = (target: BridgeTarget, value: unknown): string => {
    const written = xmlFromJson(input.schemaSet, target, value);
    notes.push(...written.notes);
    problems.push(...written.problems);
    return written.xml;
  };
  const [first] = shape.parts;
  let bodyXml: string;
  if (shape.single && first !== undefined) {
    bodyXml = write(first.target, args);
  } else {
    const pieces = shape.parts.map((part) => write(part.target, args[part.name])).filter((piece) => piece !== '');
    const wrapper = shape.wrapper;
    if (wrapper === undefined) {
      bodyXml = pieces.join('\n');
    } else if (wrapper.namespaceUri === '') {
      bodyXml = [`<${wrapper.localName}>`, ...pieces, `</${wrapper.localName}>`].join('\n');
    } else {
      const prefix = prefixForNamespace(wrapper.namespaceUri, new Set());
      const name = `${prefix}:${wrapper.localName}`;
      bodyXml = [`<${name} xmlns:${prefix}="${escapeAttribute(wrapper.namespaceUri)}">`, ...pieces, `</${name}>`].join(
        '\n',
      );
    }
  }
  if (problems.length > 0) {
    return { envelopeXml: '', ...transport, notes, problems };
  }
  return { envelopeXml: createEnvelope(empty.soapVersion, { bodyXml }, { indent: '' }), ...transport, notes, problems };
}

function matches(element: ScannedElement, name: QName): boolean {
  return element.localName === name.localName && element.namespaceUri === name.namespaceUri;
}

/** An envelope's body read back as the JSON {@link envelopeFromJson} takes. */
export function jsonFromEnvelope(
  input: RequestBuildInput,
  op: OperationRef,
  xml: string,
  direction: MessageDirection = 'response',
): JsonFromXmlResult {
  const shape = bodyShape(input, op, direction);
  const body = findBody(scanXml(xml).elements);
  if (shape === undefined || body === undefined) {
    return { value: undefined, notes: ['the message has no SOAP Body this operation describes'] };
  }
  const inScope = namespacesInScope(xml).byPrefix;
  const read = (target: BridgeTarget, element: ScannedElement): JsonFromXmlResult =>
    jsonFromXml(input.schemaSet, target, xml.slice(element.range.start, element.range.end), { inScope });
  const [first] = shape.parts;
  const [child] = body.children;
  if (shape.single && first !== undefined) {
    if (child === undefined) {
      return { value: undefined, notes: ['the SOAP Body is empty'] };
    }
    const result = read(first.target, child);
    const isObject = typeof result.value === 'object' && result.value !== null && !Array.isArray(result.value);
    return isObject || result.value === undefined ? result : { value: { '#text': result.value }, notes: result.notes };
  }
  const holder = shape.wrapper === undefined ? body : child;
  if (holder === undefined) {
    return { value: undefined, notes: ['the SOAP Body is empty'] };
  }
  const value: Record<string, unknown> = {};
  const notes: string[] = [];
  for (const part of shape.parts) {
    const element = holder.children.find((candidate) =>
      'element' in part.target ? matches(candidate, part.target.element) : candidate.localName === part.name,
    );
    if (element !== undefined) {
      const result = read(part.target, element);
      value[part.name] = result.value;
      notes.push(...result.notes);
    }
  }
  return { value, notes };
}

/**
 * A fault's `detail` as JSON, when its first element is the element of a fault message part the
 * operation declares; undefined otherwise (the caller keeps the XML).
 */
export function faultDetailJson(
  input: RequestBuildInput,
  op: OperationRef,
  detailXml: string,
): JsonFromXmlResult | undefined {
  const binding = findBinding(input.definition, op.bindingName);
  const operation =
    binding === undefined
      ? undefined
      : findPortType(input.definition, binding.type)?.operations.find(
          (candidate) => candidate.name === op.operationName,
        );
  const declared = (operation?.faults ?? []).flatMap(
    (fault) =>
      findMessage(input.definition, fault.message)?.parts.flatMap((part) =>
        part.element !== undefined ? [part.element] : [],
      ) ?? [],
  );
  const first = scanXml(detailXml).elements[0];
  const element = first === undefined ? undefined : declared.find((name) => matches(first, name));
  if (first === undefined || element === undefined) {
    return undefined;
  }
  return jsonFromXml(input.schemaSet, { element }, detailXml.slice(first.range.start, first.range.end));
}
