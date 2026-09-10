/**
 * Turns WSDL message parts into the XML that goes inside `soapenv:Body` and
 * `soapenv:Header`, following the WSDL 1.1 SOAP binding and the WS-I Basic
 * Profile conventions for `document`/`rpc` × `literal`/`encoded`.
 */

import { SchemaError } from '../errors.js';
import { NS } from '../xml/namespaces.js';
import type { Message, Part, SoapBody, SoapHeader, WsdlDefinition } from '../wsdl/model.js';
import { findMessage } from '../wsdl/model.js';
import type { QName } from '../wsdl/qname.js';
import { qnameToString } from '../wsdl/qname.js';
import type { GeneratedFragment, GenerateOptions } from '../xsd/sample-generator.js';
import { generateElement, generateSoapEncArray, generateType } from '../xsd/sample-generator.js';
import { arrayTypeOf } from '../xsd/sample-types.js';
import type { SchemaSet } from '../xsd/schema-set.js';
import type { BuildProblem } from './build-problems.js';
import { escapeAttribute } from '../xsd/xml-writer.js';
import type { NamespaceScope } from './namespace-scope.js';
import { SOAP_ENVELOPE_PREFIX } from './envelope.js';

/** Everything the body/header builders need, plus the problem sink they append to. */
export interface BodyBuildContext {
  readonly definition: WsdlDefinition;
  readonly schemaSet: SchemaSet;
  readonly scope: NamespaceScope;
  readonly genOptions: Partial<GenerateOptions>;
  readonly indent: string;
  readonly problems: BuildProblem[];
}

/** Inserts attributes into a fragment's root start tag. */
function addRootAttributes(xml: string, attributes: readonly (readonly [string, string])[]): string {
  if (attributes.length === 0) {
    return xml;
  }
  const rendered = attributes.map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`).join('');
  // Attribute values are `>`-escaped by the writer, so the first `>` on the
  // first line always terminates the start tag.
  const close = xml.indexOf('>');
  if (close === -1) {
    return xml;
  }
  const insertAt = xml[close - 1] === '/' ? close - 1 : close;
  return `${xml.slice(0, insertAt)}${rendered}${xml.slice(insertAt)}`;
}

/**
 * Removes the `xmlns:*` declarations a fragment put on its own root, for every
 * prefix the envelope now declares with the same URI. A declaration the
 * envelope does not carry is left alone rather than silently dropped.
 */
function stripHoistedNamespaces(xml: string, scope: NamespaceScope): string {
  const close = xml.indexOf('>');
  if (close === -1) {
    return xml;
  }
  const startTag = xml.slice(0, close);
  const stripped = startTag.replace(/ xmlns:([A-Za-z_][\w.-]*)="([^"]*)"/g, (match, prefix: string, uri: string) =>
    scope.declares(prefix, uri) ? '' : match,
  );
  return `${stripped}${xml.slice(close)}`;
}

/** Prepends `pad` to every non-empty line. */
function indentLines(xml: string, pad: string): string {
  return xml
    .split('\n')
    .map((line) => (line.length === 0 ? line : `${pad}${line}`))
    .join('\n');
}

/** Registers a fragment's namespaces on the envelope and drops its own declarations. */
function hoist(ctx: BodyBuildContext, fragment: GeneratedFragment): string {
  ctx.scope.markUsed(fragment.namespaces);
  return stripHoistedNamespaces(fragment.xml, ctx.scope);
}

function generateOptions(ctx: BodyBuildContext): Partial<GenerateOptions> {
  return { ...ctx.genOptions, indent: ctx.indent, prefixes: ctx.scope.prefixes() };
}

/** True when `type` is neither a built-in nor a global type in the schema set. */
function isUnknownType(ctx: BodyBuildContext, type: QName): boolean {
  return ctx.schemaSet.builtin(type) === undefined && ctx.schemaSet.lookupType(type) === undefined;
}

/**
 * Generates the fragment for one part in `document` style (and for header
 * parts, which are always element-like whatever the body style is).
 *
 * A part declaring a `type` rather than an `element` is not WS-I conformant,
 * but is common in the wild; like SoapUI, the part's own name is used as the
 * (unqualified) element name and no problem is reported.
 */
export function buildDocumentPart(ctx: BodyBuildContext, part: Part): string | undefined {
  if (part.element !== undefined) {
    try {
      return hoist(ctx, generateElement(ctx.schemaSet, part.element, generateOptions(ctx)));
    } catch (error) {
      if (error instanceof SchemaError) {
        ctx.problems.push({
          code: 'unknown-element',
          message: `Part "${part.name}" references undeclared element ${qnameToString(part.element)}`,
        });
        return undefined;
      }
      throw error;
    }
  }
  if (part.type !== undefined) {
    if (isUnknownType(ctx, part.type)) {
      ctx.problems.push({
        code: 'unknown-type',
        message: `Part "${part.name}" references undeclared type ${qnameToString(part.type)}`,
      });
    }
    const name: QName = { namespaceUri: '', localName: part.name };
    return hoist(ctx, generateType(ctx.schemaSet, name, part.type, generateOptions(ctx)));
  }
  ctx.problems.push({ code: 'missing-part', message: `Part "${part.name}" declares neither an element nor a type` });
  return undefined;
}

/** The SOAP-encoded array item type a part's type declares, if it is one. */
function soapEncItemType(ctx: BodyBuildContext, type: QName): QName | undefined {
  const definition = ctx.schemaSet.lookupType(type);
  if (
    definition === undefined ||
    definition.kind !== 'complexType' ||
    definition.content.kind !== 'complexContent' ||
    ctx.schemaSet.builtin(definition.content.base)?.soapEncArray !== true
  ) {
    return undefined;
  }
  const raw = arrayTypeOf(ctx.schemaSet.resolveContent(definition).attributes);
  if (raw === undefined) {
    return { namespaceUri: NS.XSD, localName: 'anyType' };
  }
  // `wsdl:arrayType` is a QName-plus-bounds, e.g. `xsd:int[]` or `tns:Item[,]`.
  const withoutBounds = raw.replace(/(\[[^\]]*\])+\s*$/, '').trim();
  const colon = withoutBounds.indexOf(':');
  if (colon === -1) {
    return { namespaceUri: NS.XSD, localName: 'anyType' };
  }
  const prefix = withoutBounds.slice(0, colon);
  const localName = withoutBounds.slice(colon + 1);
  // The prefix was in scope on the schema element, whose declarations are not
  // kept; the root `wsdl:definitions` declarations are the practical stand-in.
  const namespaceUri = ctx.definition.namespaceDeclarations[prefix];
  return namespaceUri === undefined || localName === ''
    ? { namespaceUri: NS.XSD, localName: 'anyType' }
    : { namespaceUri, localName };
}

/** Builds one rpc accessor: an unqualified element named after the part. */
function buildRpcAccessor(ctx: BodyBuildContext, part: Part, use: SoapBody['use']): string | undefined {
  const name: QName = { namespaceUri: '', localName: part.name };
  if (part.element !== undefined) {
    // A part with an `element` is non-WS-I for rpc (R2203); emit the element
    // itself as the accessor rather than inventing a wrapper around it.
    return buildDocumentPart(ctx, part);
  }
  if (part.type === undefined) {
    ctx.problems.push({ code: 'missing-part', message: `Part "${part.name}" declares neither an element nor a type` });
    return undefined;
  }
  if (isUnknownType(ctx, part.type)) {
    ctx.problems.push({
      code: 'unknown-type',
      message: `Part "${part.name}" references undeclared type ${qnameToString(part.type)}`,
    });
  }
  const itemType = soapEncItemType(ctx, part.type);
  const fragment =
    itemType !== undefined
      ? generateSoapEncArray(ctx.schemaSet, name, itemType, generateOptions(ctx))
      : generateType(ctx.schemaSet, name, part.type, generateOptions(ctx));
  const xml = hoist(ctx, fragment);
  if (use !== 'encoded' || itemType !== undefined) {
    return xml;
  }
  // SOAP encoding wants every simple-typed accessor self-describing.
  const builtin = ctx.schemaSet.builtin(part.type);
  const resolved = ctx.schemaSet.lookupType(part.type);
  if (builtin === undefined && resolved?.kind !== 'simpleType') {
    return xml;
  }
  const typeLabel = `${ctx.scope.use(part.type.namespaceUri)}:${part.type.localName}`;
  return addRootAttributes(xml, [[`${ctx.scope.use(NS.XSI)}:type`, typeLabel]]);
}

/** Selects and orders the parts a body carries: `soap:body/@parts` first, then `parameterOrder`. */
export function orderParts(
  parts: readonly Part[],
  bodyParts: readonly string[] | undefined,
  parameterOrder: readonly string[] | undefined,
): readonly Part[] {
  const selected =
    bodyParts === undefined
      ? [...parts]
      : bodyParts.flatMap((name) => {
          const match = parts.find((part) => part.name === name);
          return match === undefined ? [] : [match];
        });
  if (parameterOrder === undefined) {
    return selected;
  }
  const ordered = parameterOrder.flatMap((name) => {
    const match = selected.find((part) => part.name === name);
    return match === undefined ? [] : [match];
  });
  // Parts the port type did not name (typically the return part) keep their
  // message order and follow the named ones, per WSDL 1.1 §2.4.5.
  return [...ordered, ...selected.filter((part) => !ordered.includes(part))];
}

/** Builds the `soapenv:Body` content for a `document`-style operation. */
function buildDocumentBody(ctx: BodyBuildContext, parts: readonly Part[]): string {
  return parts
    .map((part) => buildDocumentPart(ctx, part))
    .filter((xml): xml is string => xml !== undefined)
    .join('\n');
}

/** Builds the `soapenv:Body` content for an `rpc`-style operation: one wrapper, one child per part. */
function buildRpcBody(ctx: BodyBuildContext, operationName: string, body: SoapBody, parts: readonly Part[]): string {
  const wrapperNamespace = body.namespace ?? ctx.definition.targetNamespace;
  const prefix = ctx.scope.use(wrapperNamespace);
  const tag = prefix === '' ? operationName : `${prefix}:${operationName}`;
  const attributes =
    body.use === 'encoded'
      ? ` ${SOAP_ENVELOPE_PREFIX}:encodingStyle="${escapeAttribute(body.encodingStyle ?? NS.SOAP11_ENC)}"`
      : '';
  const accessors = parts
    .map((part) => buildRpcAccessor(ctx, part, body.use))
    .filter((xml): xml is string => xml !== undefined);
  if (accessors.length === 0) {
    return `<${tag}${attributes}/>`;
  }
  return [`<${tag}${attributes}>`, ...accessors.map((xml) => indentLines(xml, ctx.indent)), `</${tag}>`].join('\n');
}

/**
 * Builds the content of `soapenv:Body` for one binding operation.
 *
 * @param style the effective operation style (`soap:operation/@style` falling back to `soap:binding/@style`)
 */
export function buildBody(
  ctx: BodyBuildContext,
  operationName: string,
  style: 'document' | 'rpc',
  body: SoapBody,
  message: Message,
  parameterOrder: readonly string[] | undefined,
): string {
  const parts = orderParts(message.parts, body.parts, style === 'rpc' ? parameterOrder : undefined);
  for (const name of body.parts ?? []) {
    if (!message.parts.some((part) => part.name === name)) {
      ctx.problems.push({
        code: 'missing-part',
        message: `soap:body names part "${name}", which message ${qnameToString(message.name)} does not declare`,
      });
    }
  }
  return style === 'rpc' ? buildRpcBody(ctx, operationName, body, parts) : buildDocumentBody(ctx, parts);
}

/** Builds the content of `soapenv:Header` from a binding operation's `soap:header` elements. */
export function buildHeaders(ctx: BodyBuildContext, headers: readonly SoapHeader[]): string {
  const fragments: string[] = [];
  for (const header of headers) {
    const message = findMessage(ctx.definition, header.message);
    if (message === undefined) {
      ctx.problems.push({
        code: 'missing-message',
        message: `soap:header references unknown message ${qnameToString(header.message)}`,
      });
      continue;
    }
    const part = message.parts.find((candidate) => candidate.name === header.part);
    if (part === undefined) {
      ctx.problems.push({
        code: 'missing-part',
        message: `soap:header references part "${header.part}", which message ${qnameToString(
          message.name,
        )} does not declare`,
      });
      continue;
    }
    const xml = buildDocumentPart(ctx, part);
    if (xml === undefined) {
      continue;
    }
    fragments.push(
      header.use === 'encoded'
        ? addRootAttributes(xml, [[`${SOAP_ENVELOPE_PREFIX}:encodingStyle`, header.encodingStyle ?? NS.SOAP11_ENC]])
        : xml,
    );
  }
  return fragments.join('\n');
}
