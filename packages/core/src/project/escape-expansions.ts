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

/**
 * The inverse of {@link escapeExpansions}: every `$${` escape read back as the literal `${` it
 * stands for, left to right as the tokenizer reads it, and nothing else touched — a live `${…}` stays
 * as it is. For a check of the text as it will be sent, such as validating an envelope against the
 * contract a generated `$${…}` value came from.
 */
export function unescapeExpansions(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text.startsWith('$${', i)) {
      out += '${';
      i += 3;
      continue;
    }
    out += text[i];
    i += 1;
  }
  return out;
}
