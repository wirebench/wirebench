/**
 * SOAP's run facet (spec §3.3): which saved requests a run can send, how one is prepared and sent
 * with and without scripts, its script types, and the secrets its configuration needs. The steps of
 * a send are in the order they have always been: the definition, the request's TLS identity, its
 * credentials (an OAuth2 token included), its secret tokens, then the wire.
 */
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import type { AssertionSubject } from '../assert/model.js';
import { WirebenchError } from '../errors.js';
import { createFileAttachmentResolver } from '../project/attachments-cache.js';
import { effectiveAuth } from '../project/endpoints.js';
import { resolveAuthEndpoint, resolveEndpoint } from '../project/environments.js';
import type { EndpointSource } from '../project/environments.js';
import type {
  Attachment,
  Endpoint,
  Interface,
  OperationDef,
  Project,
  SoapOwnerAuth,
  SoapRequestDef,
} from '../project/model.js';
import { definitionCacheDir } from '../project/paths.js';
import { expandSendInput } from './expand.js';
import type { PropertyScopes } from '../project/properties.js';
import { toWssIncomingConfig, toWssOutgoingConfig } from '../wss/configs.js';
import type { ProtocolRun, RunScope, ScriptedSend } from '../protocol/module.js';
import { scopesFor } from '../run/context.js';
import type { RunContext } from '../run/context.js';
import { exchangeController } from '../run/exchange.js';
import { requiredSecret } from '../run/oauth2-token.js';
import type { SentRequest } from '../run/run.js';
import {
  authFor,
  dropRefusedToken,
  insideProject,
  keystoreNeeds,
  loadKeystoreById,
  originOf,
  present,
  tlsFor,
  unresolvedError,
  withSecrets,
} from '../run/send-helpers.js';
import { ORPHANED_STEP_REASON, byOrder } from '../run/tree.js';
import { applySoapSnapshot, soapRequestSnapshot, soapResponseSnapshot } from './scripting.js';
import { soapOperationElements, soapScriptTypes } from './script-types.js';
import { secretNeedsOfAuth } from '../secrets/env-names.js';
import type { SecretNeed } from '../secrets/env-names.js';
import { resolveSoapAuth } from '../secrets/resolve.js';
import { toSoapSendInput } from './send-input.js';
import type { AttachmentResolvers } from './send-input.js';
import { sendSoapRequest } from './send.js';
import type { SoapExchange, SoapSendInput, SoapSendWss } from './types.js';
import { bindingContextFor, validateMessage } from '../validate/index.js';
import { resolveWorkspaceEndpoint, withActiveEnvironment } from '../workspace/environments.js';
import { effectiveWsa } from '../wsa/model.js';
import { summarizeWsa } from '../wsa/policy-detect.js';
import { readDefinitionCache } from '../wsdl/cache.js';
import { parseWsdlBundle } from '../wsdl/merge.js';
import type { WsdlDefinition } from '../wsdl/model.js';
import type { DefinitionBundle } from '../wsdl/resolver.js';
import { createWssContext } from '../wss/model.js';
import type { WssIncomingConfig, WssOutgoingConfig } from '../wss/model.js';
import { buildSchemaSet } from '../xsd/schema-set.js';
import type { SchemaSet } from '../xsd/schema-set.js';

/** One saved SOAP request selected for a run, with enough context to send and report it. */
export interface SoapSelected {
  readonly kind: 'soap';
  readonly path: string;
  readonly group: string;
  readonly iface: Interface;
  readonly operation: OperationDef;
  readonly request: SoapRequestDef;
}

/** A SOAP request ready for `sendSoapRequest`, with the scopes its text expands against. */
export interface PreparedSoap {
  readonly kind: 'soap';
  readonly input: SoapSendInput;
  readonly scopes: PropertyScopes;
}

/** A SOAP request's own auth, combined with its endpoint's, falling back to the interface's. */
export function soapEffectiveAuth(selected: SoapSelected): SoapOwnerAuth | undefined {
  const { iface, request } = selected;
  const endpoint = resolveAuthEndpoint(iface, request);
  return effectiveAuth(request.auth, endpoint?.auth, endpoint?.authMode ?? 'override', iface.auth);
}

/** A SOAP request's endpoint, through the workspace's environment when the run has a workspace. */
function endpointFor(
  context: RunContext,
  iface: Interface,
  request: Pick<SoapRequestDef, 'endpointId' | 'endpointUrl'>,
): { url: string | undefined; source: EndpointSource; endpoint?: Endpoint } {
  const { project, environmentId, workspace } = context;
  return workspace === undefined
    ? resolveEndpoint(project, environmentId, iface, request)
    : resolveWorkspaceEndpoint({
        workspace: withActiveEnvironment(workspace.workspace, environmentId),
        project,
        projectSlug: workspace.projectSlug,
        iface,
        request,
      });
}

/**
 * WS-Addressing as the app's `wsaFor` builds it. The WSDL-derived default action comes from the
 * host's `defaultWsaActionFor`; without one it is empty, as it is in the app for an interface not
 * yet hydrated, and an explicit `wsa:Action` or the request's SOAPAction still applies.
 */
function wsaFor(selected: SoapSelected, context: RunContext): SoapSendInput['wsa'] {
  const config = effectiveWsa(selected.iface.wsa, selected.request.wsa);
  return config.enabled ? { config, defaultAction: context.defaultWsaActionFor?.(selected) ?? '' } : undefined;
}

/** The app's `wssFor`: a selected configuration the project no longer has refuses the send. */
function wssFor(selected: SoapSelected, context: RunContext): SoapSendWss | undefined {
  const { request } = selected;
  const pick = (id: string | undefined): string | undefined => (id === undefined || id.length === 0 ? undefined : id);
  const outgoingId = pick(request.wssOutgoingRef);
  const incomingId = pick(request.wssIncomingRef);
  if (outgoingId === undefined && incomingId === undefined) {
    return undefined;
  }
  const find = <T>(refs: Project['wss']['outgoing'], id: string, convert: (ref: (typeof refs)[number]) => T): T => {
    const ref = refs.find((candidate) => candidate.id === id);
    if (ref !== undefined) {
      try {
        return convert(ref);
      } catch {
        // An unreadable configuration is treated as the app treats it: as missing.
      }
    }
    throw new WirebenchError(
      'wss-config-missing',
      'This request selects a WS-Security configuration the project no longer has.',
      { details: { configId: id } },
    );
  };
  const outgoing =
    outgoingId === undefined ? undefined : find(context.project.wss.outgoing, outgoingId, toWssOutgoingConfig);
  const incoming =
    incomingId === undefined ? undefined : find(context.project.wss.incoming, incomingId, toWssIncomingConfig);
  const { properties } = request;
  return {
    ...(outgoing !== undefined ? { outgoing } : {}),
    ...(incoming !== undefined ? { incoming } : {}),
    ctx: createWssContext({
      keystores: (ref) => loadKeystoreById(context, ref),
      secrets: (ref) => requiredSecret(ref, context.host.getSecret),
    }),
    requestProperties: {
      ...(properties.wssPasswordType !== undefined ? { wssPasswordType: properties.wssPasswordType } : {}),
      ...(properties.wssTimeToLive !== undefined ? { wssTimeToLive: properties.wssTimeToLive } : {}),
    },
  };
}

/**
 * The app's `attachmentResolvers`, with the project folder as the only read boundary: a `cache`
 * attachment comes out of `attachments/`, a `path` one from its first existing candidate (resource
 * root, then the project), and an inline `file:` reference from the project folder.
 */
function attachmentResolvers(context: RunContext): AttachmentResolvers {
  const { projectDir } = context;
  const resourceRoot = context.project.settings.resourceRoot;
  const read = createFileAttachmentResolver(projectDir, resourceRoot);
  return {
    resolver: async (attachment: Attachment): Promise<Uint8Array> => {
      if (attachment.source.kind === 'path') {
        const { path } = attachment.source;
        const candidates = isAbsolute(path)
          ? [path]
          : [...(resourceRoot !== undefined ? [resolvePath(resourceRoot, path)] : []), resolvePath(projectDir, path)];
        for (const candidate of candidates) {
          const exists = await stat(candidate).then(
            () => true,
            () => false,
          );
          if (exists) {
            await insideProject(context, candidate, 'attachment-outside-project', attachment.name);
            return new Uint8Array(await readFile(candidate));
          }
        }
      }
      return read(attachment);
    },
    resolveFile: async (path: string): Promise<Uint8Array> =>
      new Uint8Array(await readFile(await insideProject(context, path, 'inline-file-outside-project', path))),
    resourceRoot: projectDir,
  };
}

/**
 * One SOAP request as a send input, with its secrets resolved (or behind `context.secretPlaceholders`).
 * Exported for this module's tests; not part of the run facet.
 *
 * @throws WirebenchError `unresolved-properties` | `endpoint-unresolved` | `secret-missing` |
 * `auth-grant-unsupported` | `wss-config-missing` | `keystore-missing`
 */
export async function prepareSoap(selected: SoapSelected, context: RunContext): Promise<PreparedSoap> {
  const { iface, request } = selected;
  const resolved = endpointFor(context, iface, request);
  if (resolved.url === undefined) {
    throw new WirebenchError('endpoint-unresolved', `No endpoint resolves for "${selected.path}"`, {
      details: { path: selected.path },
    });
  }
  const owner = soapEffectiveAuth(selected);
  const base = toSoapSendInput({
    request: {
      properties: request.properties,
      soapVersion: request.soapVersion,
      ...(request.soapAction !== undefined ? { soapAction: request.soapAction } : {}),
      headers: request.headers,
      envelopeXml: request.envelopeXml,
    },
    endpoint: resolved.url,
    projectSettings: context.project.settings,
    attachments: request.attachments,
    attachmentResolvers: attachmentResolvers(context),
  });
  const scopes = scopesFor(context);
  const tls = await tlsFor(context, request.properties.sslKeystoreRef, resolved.endpoint?.trustInvalid === true);
  const proxy = await context.host.proxyFor?.(resolved.url);
  const wsa = wsaFor(selected, context);
  const wss = wssFor(selected, context);
  // An owner's OAuth2 gets its token as a REST one does (client credentials; the browser grant is
  // refused); the endpoint schemes resolve through the SOAP path.
  const sendAuth =
    owner !== undefined && owner.type === 'oauth2'
      ? await authFor(owner, selected.path, context, tls)
      : await resolveSoapAuth(owner, context.host.getSecret);
  // The attachments and MTOM options ride on `base`, as the app's `sendAttachmentsFor` builds them.
  const input: SoapSendInput = {
    ...base,
    ...(sendAuth !== undefined ? { auth: sendAuth } : {}),
    ...(context.timeoutMs !== undefined ? { timeoutMs: context.timeoutMs } : {}),
    ...(tls !== undefined ? { tls: { ...base.tls, ...tls } } : {}),
    ...(proxy !== undefined ? { proxy } : {}),
    ...(wsa !== undefined ? { wsa } : {}),
    ...(wss !== undefined ? { wss } : {}),
    ...(context.signal !== undefined ? { signal: context.signal } : {}),
  };
  const withTokens = await withSecrets(input, scopes, context.host.getSecret, context.secretPlaceholders);
  // Refused here, before the wire: the engine would report the same refs on the exchange, but by
  // then a half-expanded envelope has already been sent to somebody's service.
  const { unresolved } = expandSendInput(input, withTokens);
  if (unresolved.length > 0) {
    throw unresolvedError(selected.path, unresolved);
  }
  return { kind: 'soap', input, scopes: withTokens };
}

/** An interface's cached definition, compiled once per run. */
interface LoadedDefinition {
  readonly definition: WsdlDefinition;
  readonly bundle: DefinitionBundle;
  readonly schemaSet: SchemaSet;
  readonly defaultActionByOperation: Readonly<Record<string, string>>;
}

function parseClark(clark: string): { namespaceUri: string; localName: string } {
  const match = /^\{([^}]*)\}(.*)$/.exec(clark);
  return match === null
    ? { namespaceUri: '', localName: clark }
    : { namespaceUri: match[1] ?? '', localName: match[2] ?? '' };
}

/**
 * Reads the interface's definition from `interfaces/<slug>/definition/`, as the app hydrates it
 * with `prefer-cache` — minus the network fallback: a run never fetches a WSDL. An interface that
 * does not cache its definition, or whose cache is absent or unreadable, has no contract here.
 */
async function loadDefinition(projectDir: string, iface: Interface): Promise<LoadedDefinition | undefined> {
  if (!iface.cacheDefinition) {
    return undefined;
  }
  try {
    const bundle = await readDefinitionCache(definitionCacheDir(projectDir, iface.slug));
    const definition = parseWsdlBundle(bundle);
    return {
      definition,
      bundle,
      schemaSet: buildSchemaSet(bundle),
      defaultActionByOperation: summarizeWsa(definition).defaultActionByOperation,
    };
  } catch {
    return undefined;
  }
}

/**
 * A SOAP response as assertions and sequence transfers see it, without contract validation: what a
 * host that has no compiled definition at hand (the desktop's sequence runner) can build from the
 * exchange alone.
 */
export function soapResponseSubject(exchange: SoapExchange): AssertionSubject {
  const fault = exchange.response?.fault;
  return {
    protocol: 'soap',
    status: exchange.http.status,
    durationMs: exchange.durationMs,
    bodyText: exchange.response?.envelopeXml ?? new TextDecoder().decode(exchange.http.body),
    bodyKind: exchange.response?.isSoap === true ? 'xml' : 'other',
    headers: exchange.http.rawHeaders,
    fault: {
      present: fault !== undefined,
      ...(fault !== undefined ? { summary: [fault.code, fault.reason].filter((s) => s.length > 0).join(' — ') } : {}),
    },
  };
}

/** A SOAP response as assertions see it, validated against the contract when the run has the definition. */
function soapSubject(
  exchange: SoapExchange,
  loaded: LoadedDefinition | undefined,
  item: SoapSelected,
): AssertionSubject {
  const base = soapResponseSubject(exchange);
  const bodyText = base.bodyText;
  const binding =
    loaded === undefined
      ? undefined
      : bindingContextFor(
          loaded.definition,
          { bindingName: parseClark(item.operation.bindingName), operationName: item.operation.name },
          'response',
        );
  const contentType = exchange.http.headers['content-type'];
  return {
    ...base,
    ...(loaded !== undefined && binding !== undefined
      ? {
          validateContract: () =>
            validateMessage({
              xml: bodyText,
              direction: 'response',
              schemaSet: loaded.schemaSet,
              bundle: loaded.bundle,
              binding,
              http: { ...(contentType !== undefined ? { contentType } : {}) },
            }).then((r) => r.problems),
        }
      : {}),
  };
}

/** Parses a WS-Security configuration by id; missing or unreadable is prepare's error, not a need. */
function findConfig<T>(
  refs: Project['wss']['outgoing'],
  id: string | undefined,
  convert: (ref: (typeof refs)[number]) => T,
): T | undefined {
  if (!present(id)) {
    return undefined;
  }
  const ref = refs.find((candidate) => candidate.id === id);
  if (ref === undefined) {
    return undefined;
  }
  try {
    return convert(ref);
  } catch {
    return undefined;
  }
}

/** WS-Security passwords carry no `…Env` name: they resolve through their ref-derived variable. */
function outgoingNeeds(project: Project, config: WssOutgoingConfig): SecretNeed[] {
  const needs: SecretNeed[] = [];
  for (const entry of config.entries) {
    if (entry.kind === 'username-token') {
      const ref = entry.passwordRef ?? config.defaultPasswordRef;
      if (entry.passwordType !== 'none' && present(ref)) {
        needs.push({ ref, purpose: `WS-Security password for "${entry.username}"` });
      }
    } else if (entry.kind === 'signature') {
      needs.push(...keystoreNeeds(project, entry.keystoreRef));
      if (present(entry.keyPasswordRef)) {
        needs.push({ ref: entry.keyPasswordRef, purpose: `WS-Security signing key password ("${config.name}")` });
      }
    } else if (entry.kind === 'encryption') {
      needs.push(...keystoreNeeds(project, entry.keystoreRef));
    }
  }
  return needs;
}

function incomingNeeds(project: Project, config: WssIncomingConfig): SecretNeed[] {
  return [
    ...keystoreNeeds(project, config.decryptKeystoreRef),
    ...(present(config.decryptKeyPasswordRef)
      ? [{ ref: config.decryptKeyPasswordRef, purpose: `WS-Security decryption key password ("${config.name}")` }]
      : []),
    ...keystoreNeeds(project, config.signatureKeystoreRef),
  ];
}

function definitionFor(iface: Interface, scope: RunScope): Promise<LoadedDefinition | undefined> {
  return scope.memo(`soap:${iface.id}:definition`, () => loadDefinition(scope.context.projectDir, iface));
}

/** The run's context for one SOAP item: the WSDL's default `wsa:Action`, when the run has the definition. */
async function soapContextFor(
  selected: SoapSelected,
  scope: RunScope,
  base: RunContext,
): Promise<{ context: RunContext; loaded: Awaited<ReturnType<typeof definitionFor>> }> {
  const loaded = await definitionFor(selected.iface, scope);
  const context: RunContext = {
    ...base,
    ...(loaded !== undefined
      ? {
          defaultWsaActionFor: (s: SoapSelected) =>
            loaded.defaultActionByOperation[`${s.operation.bindingName}|${s.operation.name}`] ?? '',
        }
      : {}),
  };
  return { context, loaded };
}

/** One SOAP request as a run sends it: prepare, run its scripts when `scripts` is given, send. */
async function sendSoapItem(
  selected: SoapSelected,
  scope: RunScope,
  base: RunContext,
  scripts: ScriptedSend | undefined,
): Promise<SentRequest> {
  const { context, loaded } = await soapContextFor(selected, scope, base);
  if (scripts === undefined) {
    const prepared = await prepareSoap(selected, context);
    const exchange = await sendSoapRequest(prepared.input, { scopes: prepared.scopes });
    dropRefusedToken(context, prepared.input.auth, exchange.http.status === 401);
    return {
      subject: soapSubject(exchange, loaded, selected),
      raw: exchange.http,
      exchange: { kind: 'soap', soap: exchange },
      ...originOf(exchange.http.request.url),
    };
  }

  // Prepared with its secrets behind placeholders; the pre-request script runs on the expanded
  // request, the secrets are put back, and the post-response script sees what the script left.
  const prepared = await prepareSoap(selected, { ...context, secretPlaceholders: scripts.placeholders });
  const expanded = expandSendInput(prepared.input, prepared.scopes, {
    entitize: prepared.input.entitize ?? false,
  }).input;
  const before = soapRequestSnapshot(expanded);
  const sent = await scripts.session.pre(before);
  const changed = applySoapSnapshot(expanded, sent);
  const restored = await scripts.placeholders.restore(
    {
      endpoint: changed.endpoint,
      headers: changed.headers ?? {},
      envelopeXml: changed.envelopeXml,
      ...(changed.soapAction !== undefined ? { soapAction: changed.soapAction } : {}),
    },
    context.host.getSecret,
  );
  // Already expanded: sent without scopes, so nothing the script wrote is expanded again.
  const exchange = await sendSoapRequest({ ...changed, ...restored });
  dropRefusedToken(context, prepared.input.auth, exchange.http.status === 401);
  return {
    subject: soapSubject(exchange, loaded, selected),
    raw: exchange.http,
    exchange: { kind: 'soap', soap: exchange },
    ...originOf(exchange.http.request.url),
    script: await scripts.session.post(sent, soapResponseSnapshot(exchange)),
  };
}

/** SOAP's run facet. */
export const soapRun: ProtocolRun<SoapSelected> = {
  groups(project) {
    return project.interfaces.map((iface) => ({
      order: iface.order,
      name: iface.name,
      candidates: [...iface.operations].sort(byOrder).flatMap((operation) => {
        const group = `${iface.name}/${operation.name}`;
        return [...operation.requests]
          .sort(byOrder)
          .filter((request) => request.orphaned !== true)
          .map((request) => ({
            item: { kind: 'soap' as const, path: `${group}/${request.name}`, group, iface, operation, request },
            diskPath: `interfaces/${iface.slug}/operations/${operation.slug}/${request.slug}`,
          }));
      }),
    }));
  },

  whyNotRunnable(project, requestId) {
    for (const iface of project.interfaces) {
      for (const operation of iface.operations) {
        const request = operation.requests.find((candidate) => candidate.id === requestId);
        if (request !== undefined) {
          return request.orphaned === true ? ORPHANED_STEP_REASON : undefined;
        }
      }
    }
    return undefined;
  },

  open(selected, scope, host, options) {
    const controller = exchangeController('soap', options);
    const context: RunContext = { ...scope.context, host, signal: controller.signal };
    return controller.handle(() => sendSoapItem(selected, scope, context, options.scripts));
  },

  async resolve(selected, scope, host) {
    const { context } = await soapContextFor(selected, scope, { ...scope.context, host });
    return (await prepareSoap(selected, context)).input;
  },

  async scriptTypes(selected, scope) {
    const loaded = await definitionFor(selected.iface, scope);
    if (loaded === undefined) {
      return { generated: soapScriptTypes(undefined) };
    }
    const elements = soapOperationElements(loaded.definition, selected.operation.bindingName, selected.operation.name);
    return {
      generated: soapScriptTypes(loaded.schemaSet, elements.input, elements.output),
      binding: {
        schemas: loaded.schemaSet,
        ...(elements.input !== undefined ? { input: elements.input } : {}),
        ...(elements.output !== undefined ? { output: elements.output } : {}),
      },
    };
  },

  secretNeeds(selected, project) {
    const { request } = selected;
    const outgoing = findConfig(project.wss.outgoing, request.wssOutgoingRef, toWssOutgoingConfig);
    const incoming = findConfig(project.wss.incoming, request.wssIncomingRef, toWssIncomingConfig);
    return [
      ...secretNeedsOfAuth(soapEffectiveAuth(selected)),
      ...keystoreNeeds(project, request.properties.sslKeystoreRef),
      ...(outgoing !== undefined ? outgoingNeeds(project, outgoing) : []),
      ...(incoming !== undefined ? incomingNeeds(project, incoming) : []),
    ];
  },
};
