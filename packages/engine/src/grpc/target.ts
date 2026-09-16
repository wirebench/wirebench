/**
 * Reading a gRPC target as the user typed it. Pure, so the renderer can show the effective
 * authority beside the field through the browser-safe `@wirebench/engine/grpc` subpath and agree
 * with what the transport connects to.
 */

import { GrpcError } from '../errors.js';

/** A parsed `host:port` target. */
export interface GrpcTarget {
  readonly host: string;
  readonly port: number;
  /** `host:port`, brackets kept around an IPv6 literal. */
  readonly authority: string;
  readonly tls: boolean;
}

/**
 * Parses what the user typed as a target: `host:port`, `[::1]:50051`, or a URL whose scheme
 * (`grpc`, `grpcs`, `http`, `https`, `dns`) settles TLS. Without a port, TLS implies 443 and plain
 * implies 80, which is what an HTTP-shaped target means.
 *
 * @throws GrpcError `grpc-target-invalid`
 */
export function parseGrpcTarget(target: string, tls: boolean): GrpcTarget {
  const trimmed = target.trim();
  if (trimmed === '') {
    throw new GrpcError('grpc-target-invalid', 'The target is empty. Enter the server as host:port.');
  }
  let useTls = tls;
  let rest = trimmed;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed);
  if (scheme !== null) {
    const name = scheme[1]!.toLowerCase();
    if (name === 'grpcs' || name === 'https') {
      useTls = true;
    } else if (name === 'grpc' || name === 'http') {
      useTls = false;
    } else if (name !== 'dns') {
      throw new GrpcError('grpc-target-invalid', `"${scheme[1]!}" is not a scheme a gRPC target can use`, {
        details: { target },
      });
    }
    rest = trimmed.slice(scheme[0].length).replace(/^\/+/, '');
  }
  rest = rest.replace(/[/?#].*$/, '');
  let url: URL;
  try {
    url = new URL(`http://${rest}`);
  } catch (error) {
    throw new GrpcError('grpc-target-invalid', `"${target}" is not a host:port target`, {
      cause: error,
      details: { target },
    });
  }
  if (url.hostname === '' || url.username !== '' || url.password !== '') {
    throw new GrpcError('grpc-target-invalid', `"${target}" is not a host:port target`, { details: { target } });
  }
  const port = url.port === '' ? (useTls ? 443 : 80) : Number(url.port);
  return {
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port,
    authority: `${url.hostname}:${String(port)}`,
    tls: useTls,
  };
}
