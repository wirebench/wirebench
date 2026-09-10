export {
  WirebenchError,
  WsdlParseError,
  SchemaError,
  HttpError,
  WssError,
  ProjectError,
  ValidationError,
  isWirebenchError,
} from './errors.js';
export type { WirebenchErrorOptions } from './errors.js';

export { parseXml, parseXmlDetailed, getPosition, classifyParseEvent } from './xml/parse.js';
export type { ParseXmlOptions, XmlProblem, ParseEventClassification } from './xml/parse.js';
export { serializeXml } from './xml/serialize.js';
export { NS, PREFIX } from './xml/namespaces.js';
export type { NamespaceUri } from './xml/namespaces.js';
export { LineIndex } from './xml/positions.js';
export type { LinePosition } from './xml/positions.js';

export { parseQName, qnameEquals, qnameToString } from './wsdl/qname.js';
export type { QName } from './wsdl/qname.js';
export { findBinding, findMessage, findPortType, findService } from './wsdl/model.js';
export type {
  Binding,
  BindingFault,
  BindingMessage,
  BindingOperation,
  Fault,
  Message,
  MessageRef,
  Operation,
  Part,
  Port,
  PortType,
  Service,
  SoapBody,
  SoapHeader,
  SoapHeaderFault,
  SoapUse,
  SoapVersion,
  WsdlDefinition,
  WsdlImport,
} from './wsdl/model.js';
export { parseWsdl, parseWsdlDocument } from './wsdl/parse-wsdl.js';
export type { ParseWsdlOptions, WsdlDocumentSource } from './wsdl/parse-wsdl.js';
