/**
 * Facade-level types tying Tasks 5-10 together: importing a WSDL definition
 * and sending a SOAP request. These are the shapes the desktop app (Task 13)
 * consumes directly.
 */

import type { FetchDocument } from './wsdl/resolver.js';
import type { QName } from './wsdl/qname.js';
import type { DefinitionBundle } from './wsdl/resolver.js';
import type { MimePartInfo, WsdlDefinition } from './wsdl/model.js';
import type { SchemaSet } from './xsd/schema-set.js';
import type { HttpExchange, ProxyOptions, TlsOptions } from './http/types.js';
import type { SoapEnvelopeVersion } from './soap/envelope.js';
import type { SoapFault } from './soap/fault.js';
import type { UnresolvedRef } from './project/properties.js';
import type { Attachment } from './project/model.js';
import type { AttachmentResolver, ResponseAttachment } from './soap/mime/types.js';

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

/**
 * Definition-cache behaviour for `importDefinition`: `'prefer-cache'` resolves
 * entirely from a valid cache with no network access (falling back to the
 * network, with a problem reported, if the cache is missing or corrupt);
 * `'refresh'` always resolves from the network and then (re)writes the
 * cache; `'none'` ignores the cache entirely.
 */
export interface ImportCacheOptions {
  /** Absolute path of the interface's `definition/` directory (see `definitionCacheDir`). */
  readonly dir: string;
  readonly mode: 'prefer-cache' | 'refresh' | 'none';
}

/** Options accepted by `importDefinition`. */
export interface ImportOptions {
  /** Overrides the default `file://`/`http(s)://` fetcher, e.g. for tests. */
  readonly fetchDocument?: FetchDocument;
  /** Basic auth credentials added to every `http(s)://` fetch made while importing. */
  readonly auth?: { readonly username: string; readonly password: string };
  readonly signal?: AbortSignal;
  readonly onProgress?: (event: ImportProgress) => void;
  /** Definition-cache behaviour; see {@link ImportCacheOptions}. Omitted/absent means no caching. */
  readonly cache?: ImportCacheOptions;
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
  /**
   * The `mime:multipartRelated` attachment parts declared for this operation's input, in document
   * order; empty when the input is a plain `soap:body`. Drives the request editor's "Part" column.
   */
  readonly inputMimeParts: readonly MimePartInfo[];
}

/** The full result of importing a WSDL definition: parsed model, schema set, problems and an operation picker list. */
export interface ImportResult {
  readonly definition: WsdlDefinition;
  readonly bundle: DefinitionBundle;
  readonly schemaSet: SchemaSet;
  readonly problems: readonly ImportProblem[];
  readonly operations: readonly OperationSummary[];
  /** True when this result was resolved entirely from the definition cache, with no network access. */
  readonly fromCache?: boolean;
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
  /** Local network interface address to bind the outgoing socket to (SoapUI's "Bind Address"). */
  readonly localAddress?: string;
  /** Compress the request body and set `Content-Encoding` accordingly. Default: uncompressed. */
  readonly compressBody?: 'gzip';
  /**
   * XML-escape every property value substituted into `envelopeXml` (SoapUI's "Entitize
   * Properties"). Only meaningful when the send is given property scopes to expand against.
   */
  readonly entitize?: boolean;
  readonly tls?: TlsOptions;
  readonly proxy?: ProxyOptions;
  readonly signal?: AbortSignal;
  /** Attachments to send; only acted on when {@link attachmentOptions} says how. */
  readonly attachments?: readonly Attachment[];
  /** MTOM/SwA/inline-file behaviour plus the resolvers that turn references into bytes. */
  readonly attachmentOptions?: SendAttachmentOptions;
}

/**
 * How one send treats attachments: the request's own MTOM/SwA properties, plus the
 * resolvers that read bytes (the engine never touches the file system on its own —
 * see `createFileAttachmentResolver`).
 *
 * `expandMtomAttachments` and `inlineResponseAttachments` are separate knobs, as in
 * SoapUI: the first replaces each `xop:Include` in the response envelope with the
 * referenced part's base64, the second keeps those parts listed as attachments even
 * once they have been expanded into the envelope.
 */
export interface SendAttachmentOptions {
  /** Rewrite `cid:` references as `xop:Include` and send an MTOM package. */
  readonly enableMtom: boolean;
  /** Send an MTOM package even when nothing was optimised. */
  readonly forceMtom: boolean;
  /** Send the envelope alone; attachments (and MTOM) are skipped entirely. */
  readonly disableMultiparts: boolean;
  /** Base64 transfer encoding for SwA parts instead of binary. */
  readonly encodeAttachments: boolean;
  /** Replace `file:<path>` element text with the file's base64 before sending. */
  readonly enableInlineFiles: boolean;
  /** Keep response parts listed as attachments even when they were expanded into the envelope. */
  readonly inlineResponseAttachments: boolean;
  /** Replace `xop:Include` in the response envelope with the referenced part's base64. */
  readonly expandMtomAttachments: boolean;
  readonly resolver: AttachmentResolver;
  /** Reads one file for `enableInlineFiles`; without it, inline files are left alone. */
  readonly resolveFile?: (path: string) => Promise<Uint8Array>;
  /** Base directory for relative inline-file references. */
  readonly resourceRoot?: string;
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
    /** Parts of a `multipart/related` response other than the envelope. */
    readonly attachments?: readonly ResponseAttachment[];
  };
  readonly durationMs: number;
  readonly problems: readonly {
    readonly code: 'not-soap' | 'xml-parse-error' | 'decode-error' | 'mime-parse' | 'inline-file-missing';
    readonly message: string;
  }[];
  /** Property expansions in the request that could not be resolved (set only when `options.scopes` was given). */
  readonly unresolved?: readonly UnresolvedRef[];
}
