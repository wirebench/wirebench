/**
 * Reading the bytes of an XML document as text.
 *
 * In `xml/` because every definition fetcher decodes what it fetched, whatever the protocol, and
 * core imports no protocol folder (protocol modules spec §7.2).
 */

/**
 * Decodes bytes as UTF-8, honouring an `<?xml ... encoding="iso-8859-1" ?>`
 * declaration when present (single-byte, so it is safely sniffable by
 * decoding the head as UTF-8 first). A `utf-16` declaration would require a
 * BOM/byte-order sniff before the declaration itself is even legible, which
 * does not fit a small helper like this — such documents fall back to (and
 * garble under) UTF-8; use a pre-fetched `text` in that case instead.
 */
export function decodeXmlBytes(bytes: Uint8Array): string {
  const head = new TextDecoder('utf-8').decode(bytes.subarray(0, 200));
  const match = /^\s*<\?xml[^>]*\bencoding=["']([^"']+)["']/i.exec(head);
  if (match?.[1]?.toLowerCase() === 'iso-8859-1') {
    return new TextDecoder('iso-8859-1').decode(bytes);
  }
  return new TextDecoder('utf-8').decode(bytes);
}
