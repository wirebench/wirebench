/**
 * The bytes of a SOCKS5 handshake (RFC 1928), as far as a dynamic forward needs them: method "no
 * authentication" only, command CONNECT only, destination as IPv4, IPv6 or an unresolved domain name.
 */
export type Socks5Step =
  | { readonly kind: 'need-more' }
  | { readonly kind: 'reply'; readonly bytes: Uint8Array; readonly close: boolean }
  | { readonly kind: 'connect'; readonly host: string; readonly port: number; readonly rest: Uint8Array };

const VERSION = 0x05;
const NO_AUTH = 0x00;
const NO_ACCEPTABLE_METHOD = 0xff;
const CONNECT = 0x01;

/** A reply with BND.ADDR 0.0.0.0:0. 0x07 command not supported, 0x08 address type not supported. */
export function socks5Reply(code: 0x00 | 0x04 | 0x05 | 0x07 | 0x08): Uint8Array {
  return Uint8Array.of(VERSION, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0);
}

const NEED_MORE: Socks5Step = { kind: 'need-more' };
const reply = (bytes: Uint8Array, close: boolean): Socks5Step => ({ kind: 'reply', bytes, close });
const closeSilently = (): Socks5Step => reply(new Uint8Array(0), true);

function ipv6(bytes: Uint8Array): string {
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push((((bytes[i] as number) << 8) | (bytes[i + 1] as number)).toString(16));
  // The URL parser writes the canonical, compressed form.
  return new URL(`http://[${groups.join(':')}]/`).hostname.slice(1, -1);
}

/**
 * A pure state machine over the bytes a client sent: greeting, then request. After a reply that does not
 * close, push an empty chunk to read a request that arrived in the same chunk as the greeting.
 */
export function createSocks5Parser(): { push(chunk: Uint8Array): Socks5Step } {
  let buffer = new Uint8Array(0);
  let stage: 'greeting' | 'request' | 'done' = 'greeting';

  const greeting = (): Socks5Step => {
    if (buffer.length < 1) return NEED_MORE;
    if (buffer[0] !== VERSION) return closeSilently();
    if (buffer.length < 2) return NEED_MORE;
    const count = buffer[1] as number;
    if (buffer.length < 2 + count) return NEED_MORE;
    const methods = buffer.subarray(2, 2 + count);
    buffer = buffer.slice(2 + count);
    if (!methods.includes(NO_AUTH)) return reply(Uint8Array.of(VERSION, NO_ACCEPTABLE_METHOD), true);
    stage = 'request';
    return reply(Uint8Array.of(VERSION, NO_AUTH), false);
  };

  const request = (): Socks5Step => {
    if (buffer.length < 4) return NEED_MORE;
    if (buffer[0] !== VERSION) return closeSilently();
    if (buffer[1] !== CONNECT) return reply(socks5Reply(0x07), true);
    const type = buffer[3];
    let host: string;
    let end: number;
    if (type === 0x01) {
      end = 4 + 4;
      if (buffer.length < end + 2) return NEED_MORE;
      host = Array.from(buffer.subarray(4, end)).join('.');
    } else if (type === 0x03) {
      if (buffer.length < 5) return NEED_MORE;
      end = 5 + (buffer[4] as number);
      if (buffer.length < end + 2) return NEED_MORE;
      host = new TextDecoder().decode(buffer.subarray(5, end));
    } else if (type === 0x04) {
      end = 4 + 16;
      if (buffer.length < end + 2) return NEED_MORE;
      host = ipv6(buffer.subarray(4, end));
    } else {
      return reply(socks5Reply(0x08), true);
    }
    const port = ((buffer[end] as number) << 8) | (buffer[end + 1] as number);
    const rest = buffer.slice(end + 2);
    buffer = new Uint8Array(0);
    stage = 'done';
    return { kind: 'connect', host, port, rest };
  };

  return {
    push(chunk) {
      if (stage === 'done') return NEED_MORE;
      const next = new Uint8Array(buffer.length + chunk.length);
      next.set(buffer);
      next.set(chunk, buffer.length);
      buffer = next;
      return stage === 'greeting' ? greeting() : request();
    },
  };
}
