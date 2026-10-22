/**
 * Reading a `Content-Type` header value.
 *
 * In `http/` because the SOAP multipart code and the REST body and response code both need the bare
 * media type, and a protocol folder imports core and itself, never another protocol (protocol
 * modules spec §7.2). `soap/mime/multipart.ts` re-exports the name.
 */

/** The media type of a `Content-Type` header value, without its parameters. */
export function mediaTypeOf(contentType: string): string {
  const semicolon = contentType.indexOf(';');
  return (semicolon === -1 ? contentType : contentType.slice(0, semicolon)).trim();
}
