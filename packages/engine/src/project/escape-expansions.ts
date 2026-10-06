/**
 * The `$${` escape written over text. A module of its own, with no imports, so a small helper such
 * as `wsdl/contract-endpoints.ts` can use it without the expansion engine behind it.
 */

/**
 * `text` with every `${` written as the `$${` escape, so `expand` gives `text` back exactly and
 * resolves nothing in it. For text a request is generated from that the user did not write — a
 * contract's fixed value, SOAP action, path or address — whose `${…}` must reach the wire as written
 * rather than read a property, a secret or the sending process's environment (#223). A `$${` already
 * there becomes `$$${`, which the tokenizer reads back as `$${`.
 */
export function escapeExpansions(text: string): string {
  return text.replaceAll('${', () => '$${');
}
