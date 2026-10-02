/**
 * Turns a saved gRPC request plus the settings around it into the transport input of one call,
 * everything but the encoded messages. The precedence between the layers of configuration is fixed
 * here rather than in the host: request, then API, then project, then the user's preference.
 */

import type { SendAuth } from '../http/auth/send-auth.js';
import type { KeyValueEntry } from '../http/entries.js';
import type { TlsOptions } from '../http/types.js';
import { inherited } from '../project/inherit.js';
import type { ProjectSettings } from '../project/model.js';
import { DEFAULT_PREFERENCES } from '../project/preferences.js';
import type { Preferences } from '../project/preferences.js';
import type { GrpcMethodKind, GrpcRequestSettings } from './model.js';
import type { GrpcSendInput } from './send.js';

/** The parts of a gRPC request {@link toGrpcSendInput} reads. */
export interface GrpcSendRequestInput {
  readonly service: string;
  readonly method: string;
  readonly methodKind: GrpcMethodKind;
  readonly metadata: readonly KeyValueEntry[];
  readonly settings: GrpcRequestSettings;
}

/** Everything {@link toGrpcSendInput} needs beyond the request itself. */
export interface ToGrpcSendInputArgs {
  readonly request: GrpcSendRequestInput;
  /** The API's effective target, environment override applied and properties expanded. */
  readonly target: string;
  readonly tls: boolean;
  /** The API's own metadata rows, which a request row of the same key overrides. */
  readonly apiMetadata?: readonly KeyValueEntry[];
  /** The API's own settings, which a request inherits where it sets nothing. */
  readonly apiSettings?: GrpcRequestSettings;
  readonly preferences?: Preferences;
  readonly projectSettings?: Pick<ProjectSettings, 'defaultTimeoutMs'>;
  /** Resolved credentials; the host turns `secretRef`s into values and tokens into `oauth2`. */
  readonly auth?: SendAuth;
  readonly tlsOptions?: TlsOptions;
  readonly signal?: AbortSignal;
}

/**
 * Builds the transport input for one gRPC call, everything but the encoded messages.
 *
 * The same request → API → project → preference ladder as a REST request, and the same TLS rule:
 * the floor comes from preferences, and the host merges trust anchors, the client identity and the
 * per-request trust decision on top. Metadata rows are the API's first and then the request's, so
 * a repeated key resolves to the request's value on the wire.
 */
export function toGrpcSendInput(args: ToGrpcSendInputArgs): Omit<GrpcSendInput, 'messages'> {
  const preferences = args.preferences ?? DEFAULT_PREFERENCES;
  const request = args.request;
  const api = args.apiSettings ?? {};

  const defaultMetadata: Record<string, string> = {};
  if (preferences.http.userAgent.length > 0) {
    defaultMetadata['user-agent'] = preferences.http.userAgent;
  }
  const timeoutMs =
    inherited(request.settings.timeoutMs, api.timeoutMs, args.projectSettings?.defaultTimeoutMs) ??
    preferences.http.socketTimeoutMs;
  const maxSizeBytes = inherited(request.settings.maxSizeBytes, api.maxSizeBytes);
  const bindAddress = inherited(request.settings.bindAddress, api.bindAddress);

  return {
    target: args.target,
    tls: args.tls,
    service: request.service,
    method: request.method,
    metadata: [...(args.apiMetadata ?? []), ...request.metadata],
    defaultMetadata,
    timeoutMs,
    ...(maxSizeBytes !== undefined ? { maxSizeBytes } : {}),
    ...(bindAddress !== undefined && bindAddress.length > 0 ? { localAddress: bindAddress } : {}),
    ...(args.auth !== undefined ? { auth: args.auth } : {}),
    tlsOptions: { minVersion: preferences.ssl.minVersion, ...args.tlsOptions },
    ...(args.signal !== undefined ? { signal: args.signal } : {}),
  };
}
