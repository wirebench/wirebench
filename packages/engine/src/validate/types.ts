/**
 * The problem shape every message validator reports, shared by the XSD schema
 * validator (`schema-validator.ts`) and the SOAP structure checks
 * (`soap-structure.ts`). Positions are 1-based and refer to the *envelope*
 * text that was validated, so a UI can turn one straight into an editor
 * marker.
 */

/** How badly a validation finding matters. */
export type ValidationSeverity = 'error' | 'warning';

/** Which validator raised a finding. */
export type ValidationSource = 'schema' | 'structure';

/** One finding about a SOAP message. */
export interface ValidationProblem {
  readonly severity: ValidationSeverity;
  /** Stable, machine-readable code (e.g. `soap-version-mismatch`, `schema-invalid`). */
  readonly code: string;
  readonly message: string;
  /** 1-based line in the validated envelope text. */
  readonly line?: number;
  /** 1-based column in the validated envelope text. */
  readonly column?: number;
  readonly endLine?: number;
  readonly endColumn?: number;
  readonly source: ValidationSource;
  /** A human-readable element path (e.g. `/Envelope/Body/Add`), when one is known. */
  readonly path?: string;
}

/** One `wsdl:part` as the validator needs it: a name plus the element or type it carries. */
export interface ValidationPart {
  readonly name: string;
  readonly element?: { readonly namespaceUri: string; readonly localName: string };
  readonly type?: { readonly namespaceUri: string; readonly localName: string };
}

/** The binding context one message is validated in. */
export interface ValidationBinding {
  readonly soapVersion: '1.1' | '1.2';
  readonly operation: string;
  readonly style: 'document' | 'rpc';
  /** The parts of the message being validated (input for a request, output for a response). */
  readonly parts: readonly ValidationPart[];
}
