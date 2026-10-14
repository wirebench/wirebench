/**
 * The text of a session file from its bytes: UTF-16 when it starts with a byte order mark (the Windows
 * registry editor exports UTF-16 little-endian), UTF-8 otherwise, without the mark.
 */
export function decodeSessionFile(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  const text = new TextDecoder('utf-8').decode(bytes);
  return text.startsWith('﻿') ? text.slice(1) : text;
}
