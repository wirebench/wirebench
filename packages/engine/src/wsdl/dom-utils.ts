import type { Document, Element, Node } from '@xmldom/xmldom';
import { WsdlParseError } from '../errors.js';
import { getPosition } from '../xml/parse.js';

/** Returns the direct child elements of `parent` matching `namespaceUri`/`localName`. */
export function childElements(parent: Element | Document, namespaceUri: string, localName: string): Element[] {
  const result: Element[] = [];
  let child: Node | null = parent.firstChild;
  while (child !== null) {
    if (child.nodeType === 1) {
      const el = child as Element;
      if (el.namespaceURI === namespaceUri && el.localName === localName) {
        result.push(el);
      }
    }
    child = child.nextSibling;
  }
  return result;
}

/** Returns the first direct child element of `parent` matching `namespaceUri`/`localName`, if any. */
export function firstChildElement(
  parent: Element | Document,
  namespaceUri: string,
  localName: string,
): Element | undefined {
  return childElements(parent, namespaceUri, localName)[0];
}

/**
 * Reads a `wsdl:documentation` child of `element` (any namespace's `documentation`
 * local-name is not sufficient; callers pass the WSDL namespace), trims its text,
 * and returns `undefined` for a missing or empty element.
 */
export function readDocumentation(element: Element, wsdlNamespaceUri: string): string | undefined {
  const docEl = firstChildElement(element, wsdlNamespaceUri, 'documentation');
  if (docEl === undefined) {
    return undefined;
  }
  const text = (docEl.textContent ?? '').trim();
  return text.length > 0 ? text : undefined;
}

/** Reads a required attribute, throwing `WsdlParseError('wsdl-invalid')` with position details if absent. */
export function requireAttribute(element: Element, name: string, location: string): string {
  const value = element.getAttribute(name);
  if (value === null || value === '') {
    const pos = getPosition(element);
    throw new WsdlParseError('wsdl-invalid', `Element <${element.tagName}> is missing required attribute "${name}"`, {
      details: { location, element: element.tagName, attribute: name, ...pos },
    });
  }
  return value;
}

/** Reads an optional attribute, returning `undefined` when absent (rather than xmldom's `null`). */
export function optionalAttribute(element: Element, name: string): string | undefined {
  const value = element.getAttribute(name);
  return value === null || value === '' ? undefined : value;
}
