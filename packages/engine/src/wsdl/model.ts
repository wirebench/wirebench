import type { Element } from '@xmldom/xmldom';
import type { QName } from './qname.js';
import { qnameEquals } from './qname.js';
import type { ResolveProblem } from './resolver.js';

/** A `wsdl:part` within a `wsdl:message`. Exactly one of `element`/`type` is normally present. */
export interface Part {
  readonly name: string;
  readonly element?: QName;
  readonly type?: QName;
}

/** A `wsdl:message` definition. */
export interface Message {
  readonly name: QName;
  readonly documentation?: string;
  readonly parts: readonly Part[];
}

/** Reference to a message from an operation's `wsdl:input`/`wsdl:output`. */
export interface MessageRef {
  readonly name?: string;
  readonly message: QName;
}

/** A `wsdl:fault` within a `wsdl:operation`. */
export interface Fault {
  readonly name: string;
  readonly message: QName;
  readonly documentation?: string;
}

/** A `wsdl:operation` within a `wsdl:portType`. */
export interface Operation {
  readonly name: string;
  readonly documentation?: string;
  readonly input?: MessageRef;
  readonly output?: MessageRef;
  readonly faults: readonly Fault[];
  readonly parameterOrder?: readonly string[];
}

/** A `wsdl:portType` definition (the abstract interface). */
export interface PortType {
  readonly name: QName;
  readonly documentation?: string;
  readonly operations: readonly Operation[];
}

/** `use` attribute of a `soap:body`/`soap:header`/`soap:fault`. */
export type SoapUse = 'literal' | 'encoded';

/** A `soap:body` element within a binding operation's input/output. */
export interface SoapBody {
  readonly use: SoapUse;
  readonly parts?: readonly string[];
  readonly namespace?: string;
  readonly encodingStyle?: string;
}

/** A `soap:headerfault` within a `soap:header`. */
export interface SoapHeaderFault {
  readonly message: QName;
  readonly part: string;
  readonly use: SoapUse;
}

/** A `soap:header` element within a binding operation's input/output. */
export interface SoapHeader {
  readonly message: QName;
  readonly part: string;
  readonly use: SoapUse;
  readonly namespace?: string;
  readonly encodingStyle?: string;
  readonly headerFaults: readonly SoapHeaderFault[];
}

/** The input or output side of a `wsdl:binding` operation. */
export interface BindingMessage {
  readonly body: SoapBody;
  readonly headers: readonly SoapHeader[];
}

/** A `wsdl:fault` within a `wsdl:binding` operation, carrying its `soap:fault` `use`. */
export interface BindingFault {
  readonly name: string;
  readonly use: SoapUse;
}

/** A `wsdl:operation` within a `wsdl:binding`. */
export interface BindingOperation {
  readonly name: string;
  readonly soapAction?: string;
  readonly style?: 'document' | 'rpc';
  readonly input?: BindingMessage;
  readonly output?: BindingMessage;
  readonly faults: readonly BindingFault[];
}

/** SOAP version bound by a `wsdl:binding`, or `'none'` for non-SOAP (e.g. HTTP GET/POST) bindings. */
export type SoapVersion = '1.1' | '1.2' | 'none';

/** A `wsdl:binding` definition. */
export interface Binding {
  readonly name: QName;
  readonly type: QName;
  readonly soapVersion: SoapVersion;
  readonly style: 'document' | 'rpc';
  readonly transport?: string;
  readonly operations: readonly BindingOperation[];
}

/** A `wsdl:port` within a `wsdl:service`. */
export interface Port {
  readonly name: string;
  readonly binding: QName;
  readonly address?: string;
}

/** A `wsdl:service` definition. */
export interface Service {
  readonly name: QName;
  readonly documentation?: string;
  readonly ports: readonly Port[];
}

/** A raw, unresolved `wsdl:import` (namespace/location pair); resolved by Task 6's resolver. */
export interface WsdlImport {
  readonly namespace?: string;
  readonly location: string;
}

/**
 * The parsed model of a single WSDL 1.1 document. `imports` and
 * `schemaElements` are left raw/unresolved for later tasks (import
 * resolution in Task 6, XSD compilation in Task 7).
 */
export interface WsdlDefinition {
  readonly location: string;
  readonly targetNamespace: string;
  readonly documentation?: string;
  readonly messages: readonly Message[];
  readonly portTypes: readonly PortType[];
  readonly bindings: readonly Binding[];
  readonly services: readonly Service[];
  /** Raw `xs:schema` elements found under `wsdl:types`, consumed by Task 7's schema set. */
  readonly schemaElements: readonly Element[];
  readonly imports: readonly WsdlImport[];
  /**
   * Prefix → namespace URI for every `xmlns:*` declared on the root
   * `wsdl:definitions` element. WSDL-scoped QName-valued *attribute values*
   * that no parser resolves (notably `wsdl:arrayType` on a SOAP-encoded array)
   * are resolved against these.
   */
  readonly namespaceDeclarations: Readonly<Record<string, string>>;
  /** Problems encountered resolving imports (empty for the single-document, `resolveImports: false` path). */
  readonly problems: readonly ResolveProblem[];
}

/** Finds a `wsdl:message` by expanded name, or `undefined` if not present in this document. */
export function findMessage(def: WsdlDefinition, qname: QName): Message | undefined {
  return def.messages.find((m) => qnameEquals(m.name, qname));
}

/** Finds a `wsdl:portType` by expanded name, or `undefined` if not present in this document. */
export function findPortType(def: WsdlDefinition, qname: QName): PortType | undefined {
  return def.portTypes.find((p) => qnameEquals(p.name, qname));
}

/** Finds a `wsdl:binding` by expanded name, or `undefined` if not present in this document. */
export function findBinding(def: WsdlDefinition, qname: QName): Binding | undefined {
  return def.bindings.find((b) => qnameEquals(b.name, qname));
}

/** Finds a `wsdl:service` by expanded name, or `undefined` if not present in this document. */
export function findService(def: WsdlDefinition, qname: QName): Service | undefined {
  return def.services.find((s) => qnameEquals(s.name, qname));
}
