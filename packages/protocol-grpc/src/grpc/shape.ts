/**
 * The pure shape rules of a gRPC method and target: what a kind means, how a method's `:path` is
 * spelled, and whether an address implies TLS.
 *
 * A leaf on purpose. `model.ts` needs `project/paths.js` for its slugs, and that reaches
 * `node:path`, which a renderer bundle cannot have — so the handful of rules the editor also needs
 * live here, with no imports at all, and `model.ts` re-exports them so nothing else moved.
 */

/**
 * The four shapes a gRPC method can take, as the `.proto` declares them with the `stream` keyword.
 * Recorded on the request so the editor knows how many messages to expect on each side even when
 * the definition is not to hand.
 */
export type GrpcMethodKind = 'unary' | 'server-streaming' | 'client-streaming' | 'bidi-streaming';

/** Which server-reflection protocol to speak; `auto` tries v1 and falls back to v1alpha. */
export type GrpcReflectionVersion = 'auto' | 'v1' | 'v1alpha';

/** The versions a user can pick, in the order the selector offers them. */
export const GRPC_REFLECTION_VERSIONS: readonly GrpcReflectionVersion[] = ['auto', 'v1', 'v1alpha'];

/** The HTTP/2 `:path` of a method call: `/<service>/<method>`. */
export function grpcMethodPath(service: string, method: string): string {
  return `/${service}/${method}`;
}

/** Whether the client side of a method sends a stream, so the message text is an array. */
export function clientStreams(kind: GrpcMethodKind): boolean {
  return kind === 'client-streaming' || kind === 'bidi-streaming';
}

/** Whether the server side of a method answers with a stream. */
export function serverStreams(kind: GrpcMethodKind): boolean {
  return kind === 'server-streaming' || kind === 'bidi-streaming';
}

/**
 * Whether a target implies TLS when the API has not said: an explicit `grpcs://`/`https://` scheme,
 * or port 443. Anything else defaults to plaintext, as `grpcurl` does.
 */
export function defaultTlsFor(target: string): boolean {
  const trimmed = target.trim().toLowerCase();
  if (trimmed.startsWith('grpcs://') || trimmed.startsWith('https://')) {
    return true;
  }
  if (trimmed.startsWith('grpc://') || trimmed.startsWith('http://')) {
    return false;
  }
  return /:443$/.test(trimmed);
}
