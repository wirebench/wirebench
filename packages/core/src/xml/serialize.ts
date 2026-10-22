import { XMLSerializer } from '@xmldom/xmldom';
import type { Node } from '@xmldom/xmldom';

/**
 * Serializes a DOM node (typically a `Document` or `Element`) back to an XML
 * string using `@xmldom/xmldom`'s `XMLSerializer`.
 */
export function serializeXml(node: Node): string {
  return new XMLSerializer().serializeToString(node);
}
