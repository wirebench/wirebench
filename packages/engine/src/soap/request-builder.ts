/**
 * Builds the complete sample SOAP request for one binding operation — the
 * envelope the user sees immediately after importing a WSDL.
 */

import type { Binding, BindingOperation, Operation, PortType, WsdlDefinition } from '../wsdl/model.js';
import { findBinding, findMessage, findPortType } from '../wsdl/model.js';
import type { QName } from '../wsdl/qname.js';
import { qnameToString } from '../wsdl/qname.js';
import type { GenerateOptions } from '../xsd/sample-generator.js';
import type { SchemaSet } from '../xsd/schema-set.js';
import type { BuildProblem } from './build-problems.js';
import type { BodyBuildContext } from './body-builder.js';
import { buildBody, buildHeaders } from './body-builder.js';
import type { SoapEnvelopeVersion } from './envelope.js';
import { createEnvelope } from './envelope.js';
import { NamespaceScope } from './namespace-scope.js';
import { soapActionHeaders } from './soap-action.js';
import type { SoapActionOptions } from './soap-action.js';
import { escapeExpansions } from '../project/properties.js';

/** Identifies one operation of one binding. */
export interface OperationRef {
  readonly bindingName: QName;
  readonly operationName: string;
}

/** The parsed WSDL and its compiled schemas — everything a request is built from. */
export interface RequestBuildInput {
  readonly definition: WsdlDefinition;
  readonly schemaSet: SchemaSet;
}

/** A generated request: the envelope plus the transport metadata that must accompany it. */
export interface GeneratedRequest {
  readonly envelopeXml: string;
  readonly soapVersion: SoapEnvelopeVersion;
  /** The binding's `soapAction`, when it declares one. */
  readonly soapAction?: string;
  readonly contentType: string;
  /** Action-carrying headers (SOAP 1.1's `SOAPAction`); never includes `Content-Type`. */
  readonly headers: Readonly<Record<string, string>>;
  /** Everything that could not be built; empty for a fully resolved operation. */
  readonly problems: readonly BuildProblem[];
}

/** What {@link resolveOperation} recovers from an {@link OperationRef}. */
interface ResolvedOperation {
  readonly binding?: Binding;
  readonly bindingOperation?: BindingOperation;
  readonly version: SoapEnvelopeVersion;
  readonly soapAction?: string;
  /** True when an envelope with real content can be built at all. */
  readonly buildable: boolean;
}

function resolveOperation(input: RequestBuildInput, op: OperationRef, problems: BuildProblem[]): ResolvedOperation {
  const binding = findBinding(input.definition, op.bindingName);
  if (binding === undefined) {
    problems.push({ code: 'unknown-binding', message: `No binding named ${qnameToString(op.bindingName)}` });
    return { version: '1.1', buildable: false };
  }
  const bindingOperation = binding.operations.find((candidate) => candidate.name === op.operationName);
  if (bindingOperation === undefined) {
    problems.push({
      code: 'unknown-operation',
      message: `Binding ${qnameToString(op.bindingName)} has no operation "${op.operationName}"`,
    });
    return { binding, version: binding.soapVersion === '1.2' ? '1.2' : '1.1', buildable: false };
  }
  if (binding.soapVersion === 'none') {
    problems.push({
      code: 'unsupported-binding',
      message: `Binding ${qnameToString(op.bindingName)} is not a SOAP binding`,
    });
    return { binding, bindingOperation, version: '1.1', buildable: false };
  }
  return {
    binding,
    bindingOperation,
    version: binding.soapVersion,
    ...(bindingOperation.soapAction !== undefined ? { soapAction: bindingOperation.soapAction } : {}),
    buildable: true,
  };
}

/** Assembles the transport half of a {@link GeneratedRequest}. */
function transport(
  version: SoapEnvelopeVersion,
  soapAction: string | undefined,
  actionOptions: SoapActionOptions | undefined,
): Pick<GeneratedRequest, 'contentType' | 'headers'> {
  const { contentType, headers } = soapActionHeaders(version, soapAction, actionOptions ?? {});
  return { contentType, headers };
}

/** The abstract operation behind a binding operation, reporting what is missing. */
function findAbstractOperation(
  definition: WsdlDefinition,
  binding: Binding,
  operationName: string,
  problems: BuildProblem[],
): Operation | undefined {
  const portType: PortType | undefined = findPortType(definition, binding.type);
  if (portType === undefined) {
    problems.push({
      code: 'missing-portType',
      message: `Binding ${qnameToString(binding.name)} refers to unknown portType ${qnameToString(binding.type)}`,
    });
    return undefined;
  }
  const operation = portType.operations.find((candidate) => candidate.name === operationName);
  if (operation === undefined) {
    problems.push({
      code: 'unknown-operation',
      message: `portType ${qnameToString(portType.name)} has no operation "${operationName}"`,
    });
  }
  return operation;
}

/** The seed namespaces a scope names up-front, in a stable order. */
function seedNamespaces(input: RequestBuildInput, bindingOperation: BindingOperation | undefined): string[] {
  const bodyNamespace = bindingOperation?.input?.body.namespace;
  return [
    input.definition.targetNamespace,
    ...(bodyNamespace !== undefined ? [bodyNamespace] : []),
    ...input.schemaSet.namespaces,
  ].filter((uri) => uri !== '');
}

/** Options accepted by {@link buildSampleRequest} beyond the generator's own. */
export interface RequestBuildOptions extends SoapActionOptions {
  /** Indent per level; three spaces by default. */
  readonly indent?: string;
}

/**
 * A generated request whose contract-originated text is held for a saved request: every `${` in the
 * envelope, the SOAP action and the action header written as `$${`, so expansion at send time puts
 * the contract's text on the wire as written and never resolves a reference from it (#223).
 */
function asStored(request: GeneratedRequest): GeneratedRequest {
  return {
    ...request,
    envelopeXml: escapeExpansions(request.envelopeXml),
    ...(request.soapAction !== undefined ? { soapAction: escapeExpansions(request.soapAction) } : {}),
    headers: Object.fromEntries(
      Object.entries(request.headers).map(([name, value]) => [name, escapeExpansions(value)]),
    ),
  };
}

/**
 * Builds the sample SOAP request for one binding operation.
 *
 * Everything in it comes from the contract, so a `${…}` there (an XSD `fixed` or `default` value, a
 * SOAP action) is escaped as `$${…}`: the request is saved and expanded at send time, and the
 * contract's text must be sent as written, not read as a property (#223).
 *
 * The builder never throws for a modelling problem: it always returns an
 * envelope (an empty one in the worst case) and reports what went wrong in
 * {@link GeneratedRequest.problems}, so the UI can show a partial request.
 *
 * Every namespace used anywhere in the envelope is declared once on the
 * `soapenv:Envelope` element with a short mnemonic prefix
 * (`http://tempuri.org/` → `tem`); the fragments inside carry none.
 *
 * Deterministic: identical inputs always produce byte-identical output.
 *
 * @param input the parsed WSDL definition and its compiled schema set
 * @param op which operation of which binding to build
 * @param genOptions sample-generator options (optional elements, sample values, depth, prefixes)
 * @param options indent plus SOAP action/`Content-Type` knobs
 */
export function buildSampleRequest(
  input: RequestBuildInput,
  op: OperationRef,
  genOptions?: Partial<GenerateOptions>,
  options?: RequestBuildOptions,
): GeneratedRequest {
  return asStored(literalSampleRequest(input, op, genOptions, options));
}

function literalSampleRequest(
  input: RequestBuildInput,
  op: OperationRef,
  genOptions?: Partial<GenerateOptions>,
  options?: RequestBuildOptions,
): GeneratedRequest {
  const problems: BuildProblem[] = [];
  const resolved = resolveOperation(input, op, problems);
  const indent = options?.indent ?? '   ';
  if (!resolved.buildable || resolved.binding === undefined || resolved.bindingOperation === undefined) {
    return {
      envelopeXml: createEnvelope(resolved.version, { bodyXml: '' }, { indent }),
      soapVersion: resolved.version,
      ...(resolved.soapAction !== undefined ? { soapAction: resolved.soapAction } : {}),
      ...transport(resolved.version, resolved.soapAction, options),
      problems,
    };
  }
  const { binding, bindingOperation } = resolved;
  const scope = new NamespaceScope(seedNamespaces(input, bindingOperation), genOptions?.prefixes ?? {});
  const ctx: BodyBuildContext = {
    definition: input.definition,
    schemaSet: input.schemaSet,
    scope,
    genOptions: genOptions ?? {},
    indent,
    problems,
  };

  const headerXml = buildHeaders(ctx, bindingOperation.input?.headers ?? []);

  let bodyXml = '';
  const abstract = findAbstractOperation(input.definition, binding, op.operationName, problems);
  const inputRef = abstract?.input;
  if (abstract !== undefined && inputRef === undefined) {
    problems.push({
      code: 'missing-message',
      message: `Operation "${op.operationName}" declares no input message`,
    });
  }
  if (inputRef !== undefined) {
    const message = findMessage(input.definition, inputRef.message);
    if (message === undefined) {
      problems.push({
        code: 'missing-message',
        message: `Operation "${op.operationName}" refers to unknown message ${qnameToString(inputRef.message)}`,
      });
    } else {
      const style = bindingOperation.style ?? binding.style;
      const body = bindingOperation.input?.body ?? { use: 'literal' as const };
      bodyXml = buildBody(ctx, op.operationName, style, body, message, abstract?.parameterOrder);
    }
  }

  return {
    envelopeXml: createEnvelope(resolved.version, { headerXml, bodyXml, namespaces: scope.declarations() }, { indent }),
    soapVersion: resolved.version,
    ...(resolved.soapAction !== undefined ? { soapAction: resolved.soapAction } : {}),
    ...transport(resolved.version, resolved.soapAction, options),
    problems,
  };
}

/**
 * Builds an empty envelope for one binding operation — the "Create Empty"
 * request. The envelope carries an empty `Header` and `Body`, while the SOAP
 * version, action and `Content-Type` are exactly those of a sample request,
 * the action's `${` escaped the same way.
 */
export function buildEmptyRequest(
  input: RequestBuildInput,
  op: OperationRef,
  options?: RequestBuildOptions,
): GeneratedRequest {
  return asStored(literalEmptyRequest(input, op, options));
}

/**
 * {@link buildEmptyRequest} with the contract's text as written, `${` unescaped: for a caller that
 * checks the text against the contract first and escapes it itself before saving or sending it.
 */
export function literalEmptyRequest(
  input: RequestBuildInput,
  op: OperationRef,
  options?: RequestBuildOptions,
): GeneratedRequest {
  const problems: BuildProblem[] = [];
  const resolved = resolveOperation(input, op, problems);
  return {
    envelopeXml: createEnvelope(resolved.version, { bodyXml: '' }, { indent: options?.indent ?? '   ' }),
    soapVersion: resolved.version,
    ...(resolved.soapAction !== undefined ? { soapAction: resolved.soapAction } : {}),
    ...transport(resolved.version, resolved.soapAction, options),
    problems,
  };
}
