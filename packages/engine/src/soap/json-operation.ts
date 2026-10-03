/**
 * A SOAP operation's body as JSON (#33 spec §3.1, §4.1, §5). One document/literal element part is
 * that element's content; any other shape is one property per part, inside the rpc wrapper element
 * for rpc. The envelope's transport (version, action) is the one a new request of the operation has.
 */
import type { MessageDirection } from '../validate/index.js';
import { bindingContextFor } from '../validate/index.js';
import { findBinding, findMessage, findPortType } from '../wsdl/model.js';
import type { QName } from '../wsdl/qname.js';
import { qnameToString } from '../wsdl/qname.js';
import { NS } from '../xml/namespaces.js';
import { prefixForNamespace } from '../xml/prefixes.js';
import { createJsonSchemaWriter, freeKey, jsonFromXml, targetType, xmlFromJson } from '../xsd/json-bridge.js';
import type { BridgeTarget, JsonFromXmlResult, JsonSchemaObject } from '../xsd/json-bridge.js';
import { scanXml } from '../xsd/xml-scan.js';
import type { ScannedElement } from '../xsd/xml-scan.js';
import { escapeAttribute } from '../xsd/xml-writer.js';
import type { SchemaSet } from '../xsd/schema-set.js';
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

/**
 * Whether a body element's content is a value rather than an object (a simple type, `anyType`, a
 * SOAP-encoded array): its one argument is then `#text`. Decided by the resolved type, so the schema,
 * the writer and the reader agree whatever shape the generated schema takes.
 */
function textBodied(set: SchemaSet, target: BridgeTarget): boolean {
  const kind = targetType(set, target)?.kind;
  return kind !== undefined && kind !== 'complex';
}

const DEFS_REF = '#/$defs/';

/** A root that came out as a `$ref` (a type that refers back to itself), as the definition it names. */
function inlineRoot(content: JsonSchemaObject, defs: JsonSchemaObject | undefined): JsonSchemaObject {
  const ref = content['$ref'];
  if (typeof ref !== 'string' || !ref.startsWith(DEFS_REF) || defs === undefined) {
    return content;
  }
  const def = defs[ref.slice(DEFS_REF.length).replaceAll('~1', '/').replaceAll('~0', '~')];
  return typeof def === 'object' && def !== null && !Array.isArray(def) ? (def as JsonSchemaObject) : content;
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
    schema = textBodied(input.schemaSet, first.target)
      ? { type: 'object', properties: { '#text': content }, required: ['#text'], additionalProperties: false }
      : inlineRoot(content, writer.defs());
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
    bodyXml = write(first.target, textBodied(input.schemaSet, first.target) ? args['#text'] : args);
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

const nameOf = (element: ScannedElement): string =>
  qnameToString({ namespaceUri: element.namespaceUri, localName: element.localName });

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
  const slice = (element: ScannedElement): string => xml.slice(element.range.start, element.range.end);
  const read = (target: BridgeTarget, element: ScannedElement): JsonFromXmlResult =>
    jsonFromXml(input.schemaSet, target, slice(element), { inScope });
  const [first] = shape.parts;
  const [child, ...rest] = body.children;
  const notes = rest.map((extra) => `the SOAP Body holds ${nameOf(extra)} after the body element; not read`);
  /** The element the body should start with: the single part's (or a substitute), or the rpc wrapper. */
  const expected =
    shape.single && first !== undefined && 'element' in first.target ? first.target.element : shape.wrapper;
  if (expected === undefined) {
    return readParts(op, shape.parts, body.children, read, slice);
  }
  if (child === undefined) {
    return { value: undefined, notes: ['the SOAP Body is empty'] };
  }
  const named =
    matches(child, expected) ||
    (shape.single && input.schemaSet.substitutionsFor(expected).some((decl) => matches(child, decl.name)));
  if (!named) {
    return {
      value: slice(child),
      notes: [`the SOAP Body holds ${nameOf(child)}, not ${qnameToString(expected)}; kept as its XML`, ...notes],
    };
  }
  if (shape.single && first !== undefined) {
    const result = read(first.target, child);
    const value =
      textBodied(input.schemaSet, first.target) && result.value !== undefined
        ? { '#text': result.value }
        : result.value;
    return { value, notes: [...result.notes, ...notes] };
  }
  const parts = readParts(op, shape.parts, child.children, read, slice);
  return { value: parts.value, notes: [...parts.notes, ...notes] };
}

/**
 * One property per part, each read from the child of its element name (rpc: its part name); a part
 * with no child is noted, and a child no part names is kept under its local name as its XML (§5).
 */
function readParts(
  op: OperationRef,
  parts: readonly BodyPart[],
  children: readonly ScannedElement[],
  read: (target: BridgeTarget, element: ScannedElement) => JsonFromXmlResult,
  slice: (element: ScannedElement) => string,
): JsonFromXmlResult {
  const value: Record<string, unknown> = {};
  const notes: string[] = [];
  const unread = new Set(children);
  for (const part of parts) {
    const element = children.find(
      (candidate) =>
        unread.has(candidate) &&
        ('element' in part.target ? matches(candidate, part.target.element) : candidate.localName === part.name),
    );
    if (element === undefined) {
      notes.push(`${part.name}: the message has no element for this part`);
      continue;
    }
    unread.delete(element);
    const result = read(part.target, element);
    value[part.name] = result.value;
    notes.push(...result.notes);
  }
  for (const element of unread) {
    value[freeKey(value, element.localName)] = slice(element);
    notes.push(`${element.localName}: not a part of ${op.operationName}; kept as its XML`);
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
