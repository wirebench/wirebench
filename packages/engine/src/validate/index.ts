/**
 * Message validation: the SOAP structure checks and the XSD schema validation
 * behind one call.
 *
 * Structure runs first and schema only when the document is well formed —
 * validating the body of a document libxml2 cannot parse produces nothing but
 * noise, and the parse error is already reported with a position.
 */

import type { WsdlDefinition } from '../wsdl/model.js';
import { findBinding, findMessage, findPortType } from '../wsdl/model.js';
import type { DefinitionBundle } from '../wsdl/resolver.js';
import type { SchemaSet } from '../xsd/schema-set.js';
import type { OperationRef } from '../soap/request-builder.js';
import { checkSoapStructure } from './soap-structure.js';
import { validateAgainstSchemaSet } from './schema-validator.js';
import type { ValidationBinding, ValidationPart, ValidationProblem } from './types.js';

export type {
  ValidationBinding,
  ValidationPart,
  ValidationProblem,
  ValidationSeverity,
  ValidationSource,
} from './types.js';
export { checkSoapStructure, type SoapStructureOptions } from './soap-structure.js';
export {
  validateAgainstSchemaSet,
  DEFAULT_VALIDATION_TIMEOUT_MS,
  type SchemaValidationOptions,
  type SchemaValidationTarget,
} from './schema-validator.js';

/** Which half of an exchange is being validated. */
export type MessageDirection = 'request' | 'response';

/** Everything {@link validateMessage} needs. */
export interface ValidateMessageInput {
  /** The whole envelope text, as typed in the editor or as received. */
  readonly xml: string;
  readonly direction: MessageDirection;
  readonly schemaSet: SchemaSet;
  readonly bundle: DefinitionBundle;
  readonly binding: ValidationBinding;
  /** The transport metadata to cross-check against the envelope's SOAP version. */
  readonly http?: { readonly contentType?: string; readonly soapAction?: string };
  /** Wall-clock budget for the schema half; see `DEFAULT_VALIDATION_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}

/** What {@link validateMessage} reports. */
export interface ValidateMessageResult {
  readonly problems: readonly ValidationProblem[];
  /** How long the whole validation took, in milliseconds. */
  readonly durationMs: number;
}

/**
 * Validates one SOAP message against its interface: SOAP structure first,
 * then the XSD schema set (skipped when the message is not well formed).
 *
 * @param input the message, its binding context, and the schema set to validate against
 * @returns every finding plus the wall-clock duration
 */
export async function validateMessage(input: ValidateMessageInput): Promise<ValidateMessageResult> {
  const started = performance.now();
  const structure = checkSoapStructure(input.xml, {
    expectedVersion: input.binding.soapVersion,
    ...(input.http?.contentType !== undefined ? { contentType: input.http.contentType } : {}),
    ...(input.http?.soapAction !== undefined ? { soapAction: input.http.soapAction } : {}),
  });

  if (structure.some((problem) => problem.code === 'xml-not-well-formed')) {
    return { problems: structure, durationMs: performance.now() - started };
  }

  const schema = await validateAgainstSchemaSet(
    input.xml,
    { schemaSet: input.schemaSet, bundle: input.bundle },
    { binding: input.binding, ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}) },
  );

  return { problems: [...structure, ...schema], durationMs: performance.now() - started };
}

/**
 * Builds the {@link ValidationBinding} for one operation of a parsed
 * definition: the SOAP version and style the binding declares, plus the
 * `wsdl:part`s of the message on `direction`'s side.
 *
 * Returns `undefined` when the binding or operation is unknown, or when the
 * binding is not a SOAP binding (there is nothing to validate against).
 *
 * @param definition the parsed WSDL
 * @param op the binding operation the message belongs to
 * @param direction `request` reads the operation's input message, `response` its output
 */
export function bindingContextFor(
  definition: WsdlDefinition,
  op: OperationRef,
  direction: MessageDirection,
): ValidationBinding | undefined {
  const binding = findBinding(definition, op.bindingName);
  if (binding === undefined || binding.soapVersion === 'none') {
    return undefined;
  }
  const bindingOperation = binding.operations.find((candidate) => candidate.name === op.operationName);
  if (bindingOperation === undefined) {
    return undefined;
  }
  const abstract = findPortType(definition, binding.type)?.operations.find(
    (candidate) => candidate.name === op.operationName,
  );
  const reference = direction === 'request' ? abstract?.input : abstract?.output;
  const message = reference === undefined ? undefined : findMessage(definition, reference.message);
  const declared = direction === 'request' ? bindingOperation.input?.body.parts : bindingOperation.output?.body.parts;
  const parts: ValidationPart[] = (message?.parts ?? [])
    .filter((part) => declared === undefined || declared.includes(part.name))
    .map((part) => ({
      name: part.name,
      ...(part.element !== undefined ? { element: part.element } : {}),
      ...(part.type !== undefined ? { type: part.type } : {}),
    }));

  return {
    soapVersion: binding.soapVersion,
    operation: op.operationName,
    style: bindingOperation.style ?? binding.style,
    parts,
  };
}
