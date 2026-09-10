import type { Element } from '@xmldom/xmldom';
import { NS } from '../xml/namespaces.js';
import {
  childElements,
  firstChildElement,
  optionalAttribute,
  readDocumentation,
  requireAttribute,
} from './dom-utils.js';
import type {
  Binding,
  BindingFault,
  BindingMessage,
  BindingOperation,
  Port,
  Service,
  SoapBody,
  SoapHeader,
  SoapHeaderFault,
  SoapUse,
} from './model.js';
import type { QName } from './qname.js';
import { parseQName } from './qname.js';

const SOAP_NAMESPACES = [NS.WSDL_SOAP11, NS.WSDL_SOAP12] as const;

function soapNs(binding: Element): (typeof SOAP_NAMESPACES)[number] | undefined {
  return SOAP_NAMESPACES.find((ns) => firstChildElement(binding, ns, 'binding') !== undefined);
}

function readUse(element: Element | undefined): SoapUse {
  const use = element !== undefined ? optionalAttribute(element, 'use') : undefined;
  return use === 'encoded' ? 'encoded' : 'literal';
}

function parseSoapBody(element: Element): SoapBody {
  const parts = optionalAttribute(element, 'parts');
  const namespace = optionalAttribute(element, 'namespace');
  const encodingStyle = optionalAttribute(element, 'encodingStyle');
  return {
    use: readUse(element),
    ...(parts !== undefined ? { parts: parts.split(/\s+/).filter((p) => p.length > 0) } : {}),
    ...(namespace !== undefined ? { namespace } : {}),
    ...(encodingStyle !== undefined ? { encodingStyle } : {}),
  };
}

function parseHeaderFault(element: Element, location: string, defaultNamespace: string): SoapHeaderFault {
  return {
    message: parseQName(requireAttribute(element, 'message', location), element, defaultNamespace),
    part: requireAttribute(element, 'part', location),
    use: readUse(element),
  };
}

function parseSoapHeader(element: Element, ns: string, location: string, defaultNamespace: string): SoapHeader {
  const headerFaults = childElements(element, ns, 'headerfault').map((hf) =>
    parseHeaderFault(hf, location, defaultNamespace),
  );
  const namespace = optionalAttribute(element, 'namespace');
  const encodingStyle = optionalAttribute(element, 'encodingStyle');
  return {
    message: parseQName(requireAttribute(element, 'message', location), element, defaultNamespace),
    part: requireAttribute(element, 'part', location),
    use: readUse(element),
    ...(namespace !== undefined ? { namespace } : {}),
    ...(encodingStyle !== undefined ? { encodingStyle } : {}),
    headerFaults,
  };
}

function parseBindingMessage(
  wsdlMessageEl: Element | undefined,
  ns: string | undefined,
  location: string,
  defaultNamespace: string,
): BindingMessage | undefined {
  if (wsdlMessageEl === undefined || ns === undefined) {
    return undefined;
  }
  const bodyEl = firstChildElement(wsdlMessageEl, ns, 'body');
  const body: SoapBody = bodyEl !== undefined ? parseSoapBody(bodyEl) : { use: 'literal' };
  const headers = childElements(wsdlMessageEl, ns, 'header').map((h) =>
    parseSoapHeader(h, ns, location, defaultNamespace),
  );
  return { body, headers };
}

function parseBindingFault(element: Element, ns: string | undefined, location: string): BindingFault {
  const soapFault = ns !== undefined ? firstChildElement(element, ns, 'fault') : undefined;
  return { name: requireAttribute(element, 'name', location), use: readUse(soapFault) };
}

function parseBindingOperation(
  opEl: Element,
  ns: string | undefined,
  location: string,
  defaultNamespace: string,
): BindingOperation {
  const soapOp = ns !== undefined ? firstChildElement(opEl, ns, 'operation') : undefined;
  const styleAttr = soapOp !== undefined ? optionalAttribute(soapOp, 'style') : undefined;
  const soapAction = soapOp !== undefined ? optionalAttribute(soapOp, 'soapAction') : undefined;
  const inputEl = firstChildElement(opEl, NS.WSDL, 'input');
  const outputEl = firstChildElement(opEl, NS.WSDL, 'output');
  const input = parseBindingMessage(inputEl, ns, location, defaultNamespace);
  const output = parseBindingMessage(outputEl, ns, location, defaultNamespace);
  const faults = childElements(opEl, NS.WSDL, 'fault').map((f) => parseBindingFault(f, ns, location));
  return {
    name: requireAttribute(opEl, 'name', location),
    ...(soapAction !== undefined ? { soapAction } : {}),
    ...(styleAttr === 'rpc' || styleAttr === 'document' ? { style: styleAttr } : {}),
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    faults,
  };
}

/** Parses a single `wsdl:binding` element into a {@link Binding}. */
export function parseBinding(bindingEl: Element, location: string, defaultNamespace: string): Binding {
  const ns = soapNs(bindingEl);
  const soapBindingEl = ns !== undefined ? firstChildElement(bindingEl, ns, 'binding') : undefined;
  const soapVersion = ns === NS.WSDL_SOAP11 ? '1.1' : ns === NS.WSDL_SOAP12 ? '1.2' : 'none';
  const styleAttr = soapBindingEl !== undefined ? optionalAttribute(soapBindingEl, 'style') : undefined;
  const transport = soapBindingEl !== undefined ? optionalAttribute(soapBindingEl, 'transport') : undefined;
  const operations = childElements(bindingEl, NS.WSDL, 'operation').map((op) =>
    parseBindingOperation(op, ns, location, defaultNamespace),
  );
  return {
    name: { namespaceUri: defaultNamespace, localName: requireAttribute(bindingEl, 'name', location) },
    type: parseQName(requireAttribute(bindingEl, 'type', location), bindingEl, defaultNamespace),
    soapVersion,
    style: styleAttr === 'rpc' ? 'rpc' : 'document',
    ...(transport !== undefined ? { transport } : {}),
    operations,
  };
}

function readAddress(portEl: Element): string | undefined {
  for (const ns of [NS.WSDL_SOAP11, NS.WSDL_SOAP12, NS.WSDL_HTTP]) {
    const addressEl = firstChildElement(portEl, ns, 'address');
    if (addressEl !== undefined) {
      return optionalAttribute(addressEl, 'location');
    }
  }
  return undefined;
}

function parsePort(portEl: Element, location: string, defaultNamespace: string): Port {
  const address = readAddress(portEl);
  return {
    name: requireAttribute(portEl, 'name', location),
    binding: parseQName(requireAttribute(portEl, 'binding', location), portEl, defaultNamespace),
    ...(address !== undefined ? { address } : {}),
  };
}

/** Parses a single `wsdl:service` element into a {@link Service}. */
export function parseService(serviceEl: Element, location: string, defaultNamespace: string): Service {
  const documentation = readDocumentation(serviceEl, NS.WSDL);
  const ports = childElements(serviceEl, NS.WSDL, 'port').map((p) => parsePort(p, location, defaultNamespace));
  const name: QName = { namespaceUri: defaultNamespace, localName: requireAttribute(serviceEl, 'name', location) };
  return {
    name,
    ...(documentation !== undefined ? { documentation } : {}),
    ports,
  };
}
