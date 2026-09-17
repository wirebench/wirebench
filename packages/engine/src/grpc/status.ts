/**
 * gRPC status codes, as the protocol's status specification numbers and names them, and the
 * `grpc-message` percent-encoding that carries a status message in an HTTP/2 trailer.
 */

/** The seventeen status codes. `0` is the only success. */
export const GRPC_STATUS_NAMES: Readonly<Record<number, string>> = Object.freeze({
  0: 'OK',
  1: 'CANCELLED',
  2: 'UNKNOWN',
  3: 'INVALID_ARGUMENT',
  4: 'DEADLINE_EXCEEDED',
  5: 'NOT_FOUND',
  6: 'ALREADY_EXISTS',
  7: 'PERMISSION_DENIED',
  8: 'RESOURCE_EXHAUSTED',
  9: 'FAILED_PRECONDITION',
  10: 'ABORTED',
  11: 'OUT_OF_RANGE',
  12: 'UNIMPLEMENTED',
  13: 'INTERNAL',
  14: 'UNAVAILABLE',
  15: 'DATA_LOSS',
  16: 'UNAUTHENTICATED',
});

/** The name of a status code, or `UNKNOWN (n)` for a number the specification does not define. */
export function grpcStatusName(code: number): string {
  return GRPC_STATUS_NAMES[code] ?? `UNKNOWN (${String(code)})`;
}

/**
 * Decodes a `grpc-message` trailer value. The specification percent-encodes anything outside
 * printable ASCII; a malformed sequence is kept as-is rather than failing the whole response, since
 * the message is for a person to read.
 */
export function decodeGrpcMessage(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Percent-encodes a status message for a `grpc-message` trailer, as a server would. */
export function encodeGrpcMessage(value: string): string {
  return Array.from(new TextEncoder().encode(value), (byte) =>
    byte >= 0x20 && byte <= 0x7e && byte !== 0x25
      ? String.fromCharCode(byte)
      : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`,
  ).join('');
}

/**
 * Formats a deadline as a `grpc-timeout` header value: the largest unit that keeps the number to
 * at most eight digits, as the specification requires.
 */
export function formatGrpcTimeout(timeoutMs: number): string {
  const ms = Math.max(1, Math.round(timeoutMs));
  if (ms < 100_000_000) {
    return `${String(ms)}m`;
  }
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 100_000_000) {
    return `${String(seconds)}S`;
  }
  return `${String(Math.ceil(seconds / 3600))}H`;
}
