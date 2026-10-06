/**
 * The dry run behind `request.preflight`: resolves the URL a saved request would be sent to
 * under the active environment, and expands every part of its send input to find `${...}`
 * property references that would not resolve — *before* anything is put on the wire.
 *
 * The engine's `expandSendInput` expands the whole input at once and reports a flat list of
 * unresolved refs; the UI needs to say *where* each one sits, so this module expands one field
 * at a time and tags each ref with the field (and header) it came from.
 *
 * Pure: no `electron`, no `fs`, no network.
 */

import {
  effectiveAction,
  effectiveAuth,
  effectiveMessageId,
  effectiveTo,
  effectiveSecretSources,
  effectiveWsa,
  expand,
  ProjectError,
  resolveAuthEndpoint,
  resolveEndpoint,
  secretSourcesHash,
  sharedTrusted,
} from '@wirebench/engine';
import type {
  EffectiveSecretSources,
  Endpoint,
  Interface,
  Project,
  PropertyScopes,
  SoapRequestDef,
  SoapOwnerAuth,
  UnresolvedRef,
} from '@wirebench/engine';
import type {
  EndpointSourceWire,
  ExpansionField,
  RequestAuthSourceWire,
  RequestPreflightResponse,
  UnresolvedRefWire,
} from '../shared/wire-types.js';
import { findRequest } from './project-wire.js';
import { isSecretTokenRef } from './secret-resolver.js';
import type { SecretSourcesSnapshot } from './secret-sources-service.js';

/** What `request.preflight` answers: where the request would go, and what would not expand. */
export interface PreflightResult {
  readonly endpoint?: string;
  readonly endpointSource: EndpointSourceWire;
  readonly unresolved: UnresolvedRefWire[];
  readonly auth: RequestAuthSourceWire;
  /** The WS-Addressing this request would actually send; see {@link wsaSourceFor}. */
  readonly wsa: {
    readonly enabled: boolean;
    readonly action?: string;
    readonly to?: string;
    readonly messageId?: string;
  };
  /** A webhook item's URL source and its editor note; see `requestPreflightResponseSchema`. */
  readonly target?: RequestPreflightResponse['target'];
}

/**
 * What a send of `request` would actually put in its `wsa:*` headers, after the interface →
 * request merge and the Action/To/MessageID fallbacks. The MessageID is reported as the
 * literal `auto` rather than a minted UUID: the real one is generated per send, and showing a
 * value here that will never appear on the wire would be a lie.
 */
function wsaSourceFor(
  iface: Interface,
  request: SoapRequestDef,
  endpoint: string | undefined,
  defaultAction: string,
): PreflightResult['wsa'] {
  const config = effectiveWsa(iface.wsa, request.wsa);
  if (!config.enabled) {
    return { enabled: false };
  }
  const action = effectiveAction(config, {
    ...(request.soapAction !== undefined ? { soapAction: request.soapAction } : {}),
    defaultAction,
  });
  const to = effectiveTo(config, endpoint ?? '');
  const messageId = effectiveMessageId(config, () => 'auto');
  return {
    enabled: true,
    ...(action !== undefined ? { action } : {}),
    ...(to !== undefined ? { to } : {}),
    ...(messageId !== undefined ? { messageId: messageId === 'urn:uuid:auto' ? 'auto' : messageId } : {}),
  };
}

/**
 * Describes the credentials a send of `request` would use, and which level they came from, so
 * the Auth inspector can explain inheritance. Only non-secret fields travel: never a password,
 * and not even the `passwordRef`.
 */
function authSourceFor(
  iface: Interface,
  request: SoapRequestDef,
  endpoint: Endpoint | undefined,
): RequestAuthSourceWire {
  const authMode = endpoint?.authMode ?? 'override';
  const resolved: SoapOwnerAuth | undefined = effectiveAuth(request.auth, endpoint?.auth, authMode, iface.auth);
  // `username`/`preemptive` exist only on the Basic/NTLM arm; a token scheme reports its `type`
  // (below) with neither, same as `none` does today.
  const basicOrNtlm = resolved?.type === 'basic' || resolved?.type === 'ntlm' ? resolved : undefined;
  // Under `complement`, an explicit `{ type: 'none' }` on the request is exactly like leaving it
  // undefined: `effectiveAuth`'s `combine()` takes the endpoint's *type* too, so the endpoint is
  // where the resolved type actually came from and the source line should say so.
  const requestContributesNothing = request.auth === undefined || request.auth.type === 'none';
  const source: RequestAuthSourceWire['source'] =
    resolved === undefined
      ? 'none'
      : endpoint?.auth !== undefined && (authMode === 'override' || requestContributesNothing)
        ? 'endpoint'
        : request.auth !== undefined
          ? 'request'
          : iface.auth !== undefined
            ? 'interface'
            : 'none';
  return {
    source,
    type: resolved?.type ?? 'none',
    ...(basicOrNtlm?.username !== undefined ? { username: basicOrNtlm.username } : {}),
    ...(basicOrNtlm?.preemptive !== undefined ? { preemptive: basicOrNtlm.preemptive } : {}),
    ...(source === 'endpoint' && endpoint !== undefined ? { endpointName: endpoint.name, authMode } : {}),
  };
}

/** The two codes a preflight raises about a `${secret:name}` token's mapped source (secret sources spec D5). */
export type SecretSourceRefCode = 'secret-source-invalid' | 'secret-source-untrusted';

/** What a preflight reads of a {@link SecretSourcesSnapshot}: the effective mapping, and whether its shared entries are approved. */
export function secretSourceContext(snapshot: SecretSourcesSnapshot): {
  readonly sources: EffectiveSecretSources;
  readonly trusted: boolean;
} {
  return {
    sources: effectiveSecretSources(snapshot.shared, snapshot.local),
    trusted: sharedTrusted({ mode: 'approved', hash: snapshot.approvedHash }, secretSourcesHash(snapshot.shared)),
  };
}

/**
 * The warning a `${secret:name}` token earns before a send: its mapped entry is invalid, or it is a shared
 * entry this machine has not approved. Any other ref, and any token with no mapping or a usable one, earns
 * none. Reads no secret and runs no tool: it looks at the mapping and the trust state only.
 */
export function secretSourceRefCode(
  ref: Pick<UnresolvedRef, 'scope' | 'name' | 'code'>,
  sources: EffectiveSecretSources,
  trusted: boolean,
): SecretSourceRefCode | undefined {
  if (!isSecretTokenRef(ref) || ref.name === undefined) {
    return undefined;
  }
  const mapped = sources.get(ref.name);
  if (mapped === undefined) {
    return undefined;
  }
  if (mapped.source.kind === 'invalid') {
    return 'secret-source-invalid';
  }
  return mapped.origin === 'shared' && !trusted ? 'secret-source-untrusted' : undefined;
}

/** Copies an engine `UnresolvedRef` onto the wire, tagged with where in the request it was found. */
function toWire(ref: UnresolvedRef, field: ExpansionField, headerName?: string): UnresolvedRefWire {
  return {
    expr: ref.expr,
    ...(ref.scope !== undefined ? { scope: ref.scope } : {}),
    ...(ref.name !== undefined ? { name: ref.name } : {}),
    code: ref.code,
    start: ref.start,
    end: ref.end,
    ...(ref.via !== undefined ? { via: [...ref.via] } : {}),
    field,
    ...(headerName !== undefined ? { headerName } : {}),
  };
}

/**
 * How a caller resolves the URL a request would be sent to. The default is the project's own
 * {@link resolveEndpoint}; a project open inside a workspace passes the workspace resolution
 * instead, so the endpoint the preflight reports (and the badge it feeds) is the one a send
 * would really use.
 */
export type PreflightEndpointResolver = (
  iface: Interface,
  request: SoapRequestDef,
) => { url: string | undefined; source: EndpointSourceWire; endpoint?: Endpoint };

/**
 * Resolves `requestId`'s endpoint and expands its send input against `scopes`.
 *
 * `envId` selects the environment endpoint overrides are read from; pass the project's active
 * environment; `defaultAction` is the WSDL-derived `wsa:Action` for the request's operation.
 * `resolveUrl` overrides how the endpoint is resolved (see {@link PreflightEndpointResolver}).
 * `secretSources` lets a `${secret:name}` token mapped to an invalid or unapproved source warn early.
 * Throws `ProjectError('not-found')` when the project holds no such request.
 */
export function preflightRequest(
  project: Project,
  requestId: string,
  scopes: PropertyScopes,
  envId?: string,
  defaultAction = '',
  resolveUrl?: PreflightEndpointResolver,
  secretSources?: SecretSourcesSnapshot,
): PreflightResult {
  const location = findRequest(project, requestId);
  if (location === undefined) {
    throw new ProjectError('not-found', `No request with id "${requestId}"`, { details: { id: requestId } });
  }
  const { iface, request } = location;
  const resolved =
    resolveUrl !== undefined ? resolveUrl(iface, request) : resolveEndpoint(project, envId, iface, request);
  const endpoint = resolveAuthEndpoint(iface, request);

  const unresolved: UnresolvedRefWire[] = [];
  const secrets = secretSources !== undefined ? secretSourceContext(secretSources) : undefined;
  const check = (text: string, field: ExpansionField, headerName?: string): void => {
    for (const ref of expand(text, scopes).unresolved) {
      // A `${secret:name}` token resolves only at send, which refuses it there if nothing is stored.
      // Only one mapped to a broken or unapproved source is flagged early.
      if (!isSecretTokenRef(ref)) {
        unresolved.push(toWire(ref, field, headerName));
        continue;
      }
      const code = secrets !== undefined ? secretSourceRefCode(ref, secrets.sources, secrets.trusted) : undefined;
      if (code !== undefined) {
        unresolved.push({ ...toWire(ref, field, headerName), code });
      }
    }
  };

  if (resolved.url !== undefined) {
    check(resolved.url, 'endpoint');
  }
  check(request.envelopeXml, 'envelopeXml');
  if (request.soapAction !== undefined) {
    check(request.soapAction, 'soapAction');
  }
  for (const header of request.headers) {
    // The header's *name* can be an expansion too; both refs are attributed to the name the
    // user typed, since that is what the UI has to point at.
    check(header.name, 'header', header.name);
    check(header.value, 'header', header.name);
  }

  return {
    ...(resolved.url !== undefined ? { endpoint: resolved.url } : {}),
    endpointSource: resolved.source,
    unresolved,
    auth: authSourceFor(iface, request, endpoint),
    wsa: wsaSourceFor(iface, request, resolved.url, defaultAction),
  };
}
