/**
 * Facade-level types tying Tasks 5-10 together: importing a WSDL definition
 * and sending a SOAP request. These are the shapes the desktop app (Task 13)
 * consumes directly.
 */

import type { FetchDocument } from './wsdl/resolver.js';
import type { QName } from './wsdl/qname.js';
import type { DefinitionBundle } from './wsdl/resolver.js';
import type { WsdlDefinition } from './wsdl/model.js';
import type { SchemaSet } from './xsd/schema-set.js';
import type { HttpExchange, ProxyOptions, TlsOptions } from './http/types.js';
import type { SoapEnvelopeVersion } from './soap/envelope.js';
import type { SoapFault } from './soap/fault.js';

/** Where a WSDL definition comes from. */
export type ImportSource =
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'file'; readonly path: string }
  | {
      readonly kind: 'text';
      readonly text: string;
      /** Base location for resolving relative imports; defaults to `inline:wsdl`. */
      readonly location?: string;
    };

/** One phase of an in-progress {@link ImportSource} import. */
export type ImportProgress =
  | { readonly phase: 'fetch'; readonly location: string }
  | { readonly phase: 'parse' }
  | { readonly phase: 'schema' }
  | { readonly phase: 'done' };

/** Options accepted by `importDefinition`. */
export interface ImportOptions {
  /** Overrides the default `file://`/`http(s)://` fetcher, e.g. for tests. */
  readonly fetchDocument?: FetchDocument;
  /** Basic auth credentials added to every `http(s)://` fetch made while importing. */
  readonly auth?: { readonly username: string; readonly password: string };
  readonly signal?: AbortSignal;
  readonly onProgress?: (event: ImportProgress) => void;
}

/** A non-fatal problem encountered while importing a definition, tagged by the stage that raised it. */
export interface ImportProblem {
  readonly source: 'resolve' | 'wsdl' | 'schema';
  readonly code: string;
  readonly message: string;
  readonly location?: string;
  readonly line?: number;
  readonly column?: number;
}

/** One binding operation's port bindings, as summarized for a picker UI. */
export interface OperationSummary {
  readonly bindingName: QName;
  readonly operationName: string;
  readonly soapVersion: '1.1' | '1.2' | 'none';
  readonly soapAction?: string;
  readonly style: 'document' | 'rpc';
  readonly documentation?: string;
  readonly ports: readonly { readonly serviceName: QName; readonly portName: string; readonly address?: string }[];
}

/** The full result of importing a WSDL definition: parsed model, schema set, problems and an operation picker list. */
export interface ImportResult {
  readonly definition: WsdlDefinition;
  readonly bundle: DefinitionBundle;
  readonly schemaSet: SchemaSet;
  readonly problems: readonly ImportProblem[];
  readonly operations: readonly OperationSummary[];
}

/** Input to `sendSoapRequest`: an already-built envelope plus transport knobs. */
export interface SoapSendInput {
  readonly endpoint: string;
  readonly envelopeXml: string;
  readonly soapVersion: '1.1' | '1.2';
  readonly soapAction?: string;
  /** Extra/override HTTP headers; a caller-provided Content-Type or SOAPAction overrides the computed ones. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Milliseconds before the request is aborted. Default 60000. */
  readonly timeoutMs?: number;
  /** Default 'utf-8'; charset in Content-Type and body encoding. Other encodings use node Buffer when supported. */
  readonly encoding?: string;
  /** Default false (SoapUI default). */
  readonly followRedirects?: boolean;
  readonly maxSizeBytes?: number;
  readonly skipSoapAction?: boolean;
  readonly tls?: TlsOptions;
  readonly proxy?: ProxyOptions;
  readonly signal?: AbortSignal;
}

/** The result of sending a SOAP request: the raw HTTP exchange plus a structural read of the response. */
export interface SoapExchange {
  readonly http: HttpExchange;
  readonly response?: {
    /** Decoded body as text. */
    readonly envelopeXml: string;
    readonly version?: SoapEnvelopeVersion;
    readonly fault?: SoapFault;
    /** False when the body is not a SOAP envelope (an HTML error page, etc.). */
    readonly isSoap: boolean;
  };
  readonly durationMs: number;
  readonly problems: readonly {
    readonly code: 'not-soap' | 'xml-parse-error' | 'decode-error';
    readonly message: string;
  }[];
}
