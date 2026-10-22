/**
 * A namespace-qualified name.
 *
 * In `xml/` because the text helpers beside it (`locate.ts`) speak of element names without
 * knowing WSDL or XSD, and core imports no protocol folder (protocol modules spec §7.2).
 * `wsdl/qname.ts` re-exports the type and keeps everything that resolves or compares one.
 */

/** A namespace-qualified name: an expanded `{namespaceUri}localName` pair. */
export interface QName {
  readonly namespaceUri: string;
  readonly localName: string;
}
