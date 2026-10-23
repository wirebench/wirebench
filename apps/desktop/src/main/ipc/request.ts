import type { McpApprovals } from '../mcp-approvals.js';
import {
  applySoapAuth,
  applyWsaHeaders,
  CURL_REDACTED,
  jwtSendAuth,
  envMarker,
  envVariablesFor,
  fromCurl,
  fromRestCurl,
  notCurlReason,
  createBuiltinRegistry,
  grpcToCommand,
  isWirebenchError,
  ProjectError,
  quoteForShell,
  restCodeRequest,
  restToCurl,
  runSelectorOf,
  secretNeedsOfAuth,
  secretTokensToEnv,
  soapCodeRequest,
  soapToCurl,
  toWsSessionOptions,
  wsToCommand,
} from '@wirebench/engine';
import { channels } from '../../shared/ipc.js';
import type { EngineService } from '../engine-service.js';
import type {
  AuthConfig,
  ExtensionRegistry,
  JwtAuth,
  CodeOptions,
  CodeRequest,
  DesktopAuditEvent,
  OAuth2Auth,
  RestBody,
  SendAuth,
  GetSecret,
  CookieJarHost,
  PropertyScopes,
  UnresolvedRef,
  WsSessionMaterial,
  SentScripts,
  SoapOwnerAuth,
  SoapSendInput,
} from '@wirebench/engine';
import type { ProjectRouter } from '../project-router.js';
import { isSecretTokenRef, resolveAuthConfig, resolveSoapAuth } from '../secret-resolver.js';
import type { HistoryService } from '../history-service.js';
import type { IssuedTokensService } from '../issued-tokens.js';
import type { OAuth2Service } from '../oauth2.js';
import type { PreferencesService } from '../preferences.js';
import { redactHeaders, redactSecretText, redactUrl, redactXml } from '../redact.js';
import {
  ExchangeRegistry,
  previewGrpc,
  previewRest,
  previewWs,
  type GrpcPreview,
  previewSoap,
  type RestPreview,
  type SoapPreview,
  type SendThroughEngineDeps,
  type WsPreview,
} from '../send/exchange.js';
import { type SendScripts } from '../script-send.js';
import type { PreflightResult } from '../expansion-preflight.js';
import { toUnresolvedRefWire } from '../engine-wire.js';
import { secretSourceContext, secretSourceRefCode } from '../expansion-preflight.js';
import type { SecretSourcesSnapshot } from '../secret-sources-service.js';
import type {
  HistoryEntryWire,
  RequestCodeRequest,
  RequestCurlRequest,
  LogEntryWire,
} from '../../shared/wire-types.js';
import type {
  RestRequestPatchWire,
  RequestImportCurlRequest,
  RequestImportCurlTarget,
  RequestImportCurlResponse,
} from '../../shared/kinds/rest/wire.js';
import type { RequestPatchWire } from '../../shared/kinds/soap/wire.js';
import type {
  UnresolvedRefWire,
  FailedExchangeWire,
  RequestCurlResponse,
  RequestVariablesResponse,
} from '../../shared/wire-base.js';
import { cancelEnvironmentBatch, sendToEnvironments } from '../multi-env-send.js';
import { toRestSettingsWire } from '../project-wire.js';
import { requestVariables } from '../request-variables.js';
import { registerHandler } from './register.js';

/** The `ProjectRouter` surface the `request.*` channels drive; a stub stands in for it in tests. */
export type RequestChannelProject = Pick<
  ProjectRouter,
  | 'scopesFor'
  | 'preflight'
  | 'requestMeta'
  | 'projectId'
  | 'projectMutate'
  | 'requestSource'
  | 'dumpFileFor'
  // Whether a SOAP request has an endpoint (under an environment, when one is named): the check a
  // SOAP Log resend, sequence step and multi-environment send make before sending.
  | 'endpointFor'
> &
  // Optional for the same reason as on `HistorySendProject`: a stub (or an ad-hoc send) that
  // has no saved request behind it has no attachments to carry either.
  // Optional for the same reason: an ad-hoc send has no saved request, and so no keystore.
  // ... and, for the same reason, no WS-Security configuration.
  Partial<
    Pick<
      ProjectRouter,
      | 'sendAttachmentsFor'
      | 'tlsFor'
      | 'hasOutgoingWss'
      | 'proxyFor'
      // Read to split an imported cURL URL against the API's own base URL.
      | 'projectSnapshot'
      // The GraphQL editor's schema, and where a fetched one is stored (#77).
      | 'graphqlSchemaFor'
      | 'setGraphqlSchema'
      // Read by *Send to environments…* to name and validate the environments asked for.
      | 'sendEnvironments'
      | 'restMeta'
      // What the send host (send/host.ts) lends the engine: the trust anchors, the client identity,
      // the WS-Security keystores, and the project and environment a send runs in.
      | 'trustAnchorsFor'
      | 'clientIdentityFor'
      | 'keystoreFor'
      | 'runContextFor'
      // The default `wsa:Action` of a SOAP request's operation, from the definition loaded in memory.
      | 'defaultWsaActionFor'
      // Read after a REST send, to check the response against its OpenAPI operation.
      | 'restContractFor'
      // Read by the body editor's form view.
      | 'restBodySchema'
      // The gRPC third, optional for the same reason.
      | 'grpcMeta'
      | 'grpcProtoSetFor'
      // The WebSocket fourth, optional for the same reason.
      | 'wsContractFor'
      | 'wsMeta'
    >
  >;

/**
 * The id of the project owning `entityId`, for the handful of calls that address the *project*
 * (a mutation, a proxy lookup) while the renderer only named an entity inside it. Throws rather
 * than guessing: with several projects open there is no "current" one to fall back to.
 */
export function ownerOf(project: Pick<RequestChannelProject, 'projectId'>, entityId: string): string {
  const projectId = project.projectId(entityId);
  if (projectId === undefined) {
    throw new ProjectError('unknown-entity', `No open project owns "${entityId}"`, { details: { entityId } });
  }
  return projectId;
}

/** What `request.*` needs beyond the engine: the property scopes a send expands against. */
export interface RequestChannelDeps {
  /** Supplies the scopes; `ProjectRouter` in the app, a stub in tests. */
  readonly project: RequestChannelProject;
  /**
   * The code generators the Code panel's languages are looked up in (phase 7): the start-up
   * registry's. Absent (a test), the built-in ones.
   */
  readonly extensions?: () => ExtensionRegistry;
  /**
   * This machine's MCP stdio approvals and their prompt (#79). Absent (a test, a headless caller),
   * every stdio send is refused, as the engine's gate refuses a host that lends no approver.
   */
  readonly mcpApprovals?: McpApprovals;
  /** Asks before a send under protected environments (#345); see `SendThroughEngineDeps.confirmProtected`. */
  readonly confirmProtected?: (environmentNames: readonly string[]) => Promise<boolean>;
  /**
   * The scopes an *ad-hoc* send expands against — one with no saved request behind it, and so
   * no project to resolve a chain from. Omitted in tests, which then expand against nothing.
   */
  readonly adHocScopes?: () => PropertyScopes;
  /**
   * The open workspace's secret sources, read afresh by a REST, gRPC or WebSocket preflight so a token
   * mapped to an invalid or unapproved source warns early. Omitted in tests that do not care.
   */
  readonly secretSources?: () => SecretSourcesSnapshot | undefined;
  /** The session "show secrets" flag; omitted defaults every send to redacted. */
  readonly showSecrets?: { get(): boolean };
  /** The open workspace's cookie jar, asked for once at the start of every REST send (cookie jar spec §2). */
  readonly cookies?: () => CookieJarHost;
  /** Records every completed/failed send to the open project's history. Omitted in tests that don't care. */
  readonly history?: HistoryService;
  /** Called with the entry a recorded send produced, so main can broadcast `history.appended`. */
  readonly onHistoryAppended?: (entry: HistoryEntryWire) => void;
  /**
   * Called with the failure row of a send that threw, after History has recorded it, so main can
   * broadcast `exchange.failed`.
   */
  readonly onSendFailed?: (failure: FailedExchangeWire) => void;
  /**
   * Called with a row for the HTTP Log that exists before its own send's invoke resolves —
   * currently only a WebSocket handshake, the moment it settles — so main can broadcast
   * `exchange.logged`. Omitted in tests that don't care.
   */
  readonly onExchange?: (entry: LogEntryWire) => void;
  /**
   * The user's preferences: the WSDL section supplies the generation defaults and the Editor
   * section the indent a recreated envelope is formatted with. Omitted in tests, which then get
   * the engine's own defaults.
   */
  readonly preferences?: Pick<PreferencesService, 'get'>;
  /**
   * Absolute paths the user has picked through a native Save-as dialog this session (see
   * `dialog-picks.ts`) — the escape hatch that lets a Dump File point outside the project
   * folder. Omitted in tests, which then get no exemptions at all.
   */
  readonly dialogPicks?: DumpFilePicks;
  /**
   * The app's OAuth2 token service, for a REST request whose credentials are an OAuth2
   * configuration. Omitted in tests that never send one, which then send no token at all rather
   * than quietly obtaining one.
   */
  readonly oauth2?: Pick<OAuth2Service, 'accessToken'> &
    // Read by the SOAP cURL export, which uses a cached token but never obtains one; and `clear`
    // by a send through the engine, which forgets a token the server refused.
    Partial<Pick<OAuth2Service, 'status' | 'clear'>>;
  /**
   * The session's issued SAML tokens (WS-Trust), which every send borrows and logs its token
   * service exchanges through. Omitted in tests, where each run fetches its own.
   */
  readonly issuedTokens?: Pick<IssuedTokensService, 'source'>;
  /**
   * Resolves one keychain reference, for the client secret and the remembered refresh token an
   * OAuth2 token request needs. The engine service resolves every *other* reference itself; this is
   * only for the material the token request consumes before a send exists.
   */
  readonly getSecret?: (ref: string) => Promise<string | undefined>;
  /**
   * Stores a credential a pasted command carried (`curl -u user:password`) and returns its ref, so
   * the imported request authenticates without the user typing the password again. Optional: without
   * it the password is dropped and the dialog asks for it, as before.
   */
  readonly storeSecret?: (value: string, label: string) => Promise<string>;
  /**
   * The getter a send of one project resolves its `${secret:name}` tokens through
   * (`projectSecretGetter`, which also records each value for the log's masking). Omitted in tests
   * that send no tokens, where a token then refuses the send as `secret-missing`.
   */
  readonly secretsFor?: (projectId: string | undefined) => GetSecret;
  /**
   * The `${secret:name}` names stored on this machine for one project — names only, never a value —
   * for the editor's completion and unresolved marks (#340). Omitted in tests, which then list none.
   */
  readonly secretNamesFor?: (projectId: string | undefined) => Promise<readonly string[]>;
  /**
   * The app's script host (#63). Omitted in tests that send no scripted request; such a request is
   * then sent as if it had none.
   */
  readonly scripts?: SendScripts;
  /** Told what a sequence step's scripts did; see `ScriptSendDeps.onScriptsRan`. */
  readonly onScriptsRan?: (sent: SentScripts) => void;
  /**
   * The app's exchanges in flight, which `request.cancel` and a project's close reach. Omitted in
   * tests, which then get one of their own per registration.
   */
  readonly registry?: ExchangeRegistry;
  /**
   * Told of each send and each finished run the audit log keeps (desktop audit events spec §2.2):
   * the reporter's queue in the app. Omitted in tests that don't care. `workspaceId` is
   * {@link auditWorkspace} as it was when the send or run started.
   */
  readonly audit?: (event: DesktopAuditEvent, workspaceId: string | undefined) => void;
  /** The server workspace audit events are queued for now; read when a send or run starts. */
  readonly auditWorkspace?: () => string | undefined;
}

/**
 * The dependencies a send through the engine (`send/exchange.ts`) takes, from the channels' own.
 * `registry` is the one the channels cancel through.
 */
export function toSendDeps(
  service: EngineService,
  deps: RequestChannelDeps,
  registry: ExchangeRegistry = deps.registry ?? new ExchangeRegistry(),
): SendThroughEngineDeps {
  const { oauth2, preferences, history } = deps;
  return {
    project: deps.project,
    service,
    registry,
    ...(oauth2 !== undefined
      ? {
          oauth2: {
            accessToken: (config, options) => oauth2.accessToken(config, options),
            clear: (config) => oauth2.clear?.(config),
          },
        }
      : {}),
    ...(deps.issuedTokens !== undefined ? { issuedTokens: deps.issuedTokens } : {}),
    ...(deps.getSecret !== undefined ? { getSecret: deps.getSecret } : {}),
    ...(deps.secretsFor !== undefined ? { secretsFor: deps.secretsFor } : {}),
    ...(preferences !== undefined ? { preferences: () => preferences.get() } : {}),
    ...(history !== undefined
      ? { history, newestHistory: (projectId, requestId) => history.newestFor(projectId, requestId) }
      : {}),
    ...(deps.onHistoryAppended !== undefined ? { onHistoryAppended: deps.onHistoryAppended } : {}),
    ...(deps.showSecrets !== undefined ? { showSecrets: deps.showSecrets } : {}),
    ...(deps.cookies !== undefined ? { cookies: deps.cookies } : {}),
    ...(deps.onSendFailed !== undefined ? { onSendFailed: deps.onSendFailed } : {}),
    ...(deps.onExchange !== undefined ? { onExchange: deps.onExchange } : {}),
    ...(deps.scripts !== undefined ? { scripts: deps.scripts } : {}),
    ...(deps.onScriptsRan !== undefined ? { onScriptsRan: deps.onScriptsRan } : {}),
    ...(deps.adHocScopes !== undefined ? { adHocScopes: deps.adHocScopes } : {}),
    ...(deps.audit !== undefined ? { audit: deps.audit } : {}),
    ...(deps.auditWorkspace !== undefined ? { auditWorkspace: deps.auditWorkspace } : {}),
    ...(deps.confirmProtected !== undefined ? { confirmProtected: deps.confirmProtected } : {}),
    ...(deps.mcpApprovals !== undefined ? { approveCommand: deps.mcpApprovals.approver() } : {}),
  };
}

/**
 * The subset of the session's picked-path memory the dump-file check needs — write picks only.
 * A path merely picked to *read* (the attachments "Add" dialog) must not qualify a Dump File
 * write target; only a path chosen through the Save-as "Browse…" picker does.
 */
export type DumpFilePicks = { hasWrite(path: string): boolean };

export function unknownRequest(requestId: string): ProjectError {
  return new ProjectError('unknown-request', `No saved request with id ${requestId}`, { details: { requestId } });
}

/** The note under a Kerberos export: the ticket is the OS's to supply, so none is in the command. */
/** curl signs a request's headers itself (`--aws-sigv4`) but cannot presign a URL. */
const SIGV4_PRESIGN_NOTE =
  "A presigned AWS Signature v4 URL is made at send time, so the command carries no signature; switch the placement to Header to export curl's --aws-sigv4 form.";

const KERBEROS_CURL_NOTE =
  'Kerberos: curl asks the operating system for the ticket (--negotiate); no password is in the command.';

/** The names a Kerberos configuration contributes to a cURL export: never a password. */
function kerberosNames(auth: { readonly username?: string | undefined; readonly domain?: string | undefined }): {
  readonly username?: string;
  readonly domain?: string;
} {
  return {
    ...(auth.username !== undefined ? { username: auth.username } : {}),
    ...(auth.domain !== undefined ? { domain: auth.domain } : {}),
  };
}

/**
 * A credential's shape with no value in it, for an export that will redact it anyway.
 *
 * Every arm carries the marker rather than a secret, so the command shows *which* credential a
 * request sends and where it goes without the keychain being touched.
 */
export function placeholderAuth(auth: AuthConfig): SendAuth | undefined {
  switch (auth.type) {
    case 'basic':
      return {
        type: 'basic',
        username: auth.username ?? '',
        password: CURL_REDACTED,
        preemptive: auth.preemptive ?? true,
      };
    case 'ntlm':
      return {
        type: 'ntlm',
        username: auth.username ?? '',
        password: CURL_REDACTED,
        ...(auth.domain !== undefined ? { domain: auth.domain } : {}),
        ...(auth.workstation !== undefined ? { workstation: auth.workstation } : {}),
      };
    case 'bearer':
      return { type: 'bearer', token: CURL_REDACTED, ...(auth.scheme !== undefined ? { scheme: auth.scheme } : {}) };
    case 'api-key':
      return { type: 'api-key', name: auth.name, value: CURL_REDACTED, in: auth.in };
    case 'jwt':
      return jwtSendAuth(auth, CURL_REDACTED);
    case 'digest':
      return { type: 'digest', username: auth.username ?? '', password: CURL_REDACTED };
    case 'aws-sigv4':
      return {
        type: 'aws-sigv4',
        region: auth.region,
        service: auth.service,
        accessKeyId: CURL_REDACTED,
        secretAccessKey: CURL_REDACTED,
        ...(auth.sessionTokenRef !== undefined && auth.sessionTokenRef !== '' ? { sessionToken: CURL_REDACTED } : {}),
        placement: auth.placement ?? 'header',
        ...(auth.expiresSeconds !== undefined ? { expiresSeconds: auth.expiresSeconds } : {}),
      };
    default:
      // `none`, `inherit` and `oauth2`: nothing to put on the command (the last is noted instead).
      return undefined;
  }
}

/**
 * A preview's credentials with their real values, for an export while the session shows secrets. A
 * JWT is signed through the app's source, so the export carries the token the next send would; any
 * other scheme is read from the keychain.
 */
export async function shownAuth(
  deps: RequestChannelDeps,
  resolved: { readonly auth: AuthConfig; readonly signJwt: (auth: JwtAuth) => Promise<SendAuth> },
): Promise<SendAuth | undefined> {
  return resolved.auth.type === 'jwt'
    ? await resolved.signJwt(resolved.auth)
    : await resolveAuthConfig(resolved.auth, (ref) => deps.getSecret?.(ref) ?? Promise.resolve(undefined));
}

/**
 * One REST request as a `curl` command.
 *
 * Exports what the send path would actually do — the same resolved input, credentials applied — so a
 * user comparing the two is comparing like with like. Secrets are masked unless the session's
 * show-secrets switch is on, and an unresolved property is a note rather than a refusal: the command
 * is a thing to read and edit, not a send.
 */
async function restCurl(
  deps: RequestChannelDeps,
  request: RequestCurlRequest,
  resolved: RestPreview,
): Promise<RequestCurlResponse> {
  const show = deps.showSecrets?.get() ?? false;
  // With show-secrets off no secret is read at all: the command needs the *shape* of the credential,
  // not its value, so a stand-in is both sufficient and the safer thing to ask the keychain for.
  // Kerberos is decided from the configuration, never from a resolved credential: the command only
  // asks curl for the OS ticket (`--negotiate`), so a keychain secret is not read in either mode.
  const kerberos = resolved.auth.type === 'kerberos';
  const auth = kerberos
    ? { type: 'kerberos' as const, ...kerberosNames(resolved.auth) }
    : show
      ? await shownAuth(deps, resolved)
      : placeholderAuth(resolved.auth);
  // The engine masks by header name; a value main recorded (a `${secret:…}` or secret-source value, a
  // long `${#System#…}` one) can sit in the URL, any header or the body, so the whole command is masked.
  const command = redactSecretText(
    restToCurl(
      { ...resolved.input, ...(auth !== undefined ? { auth } : {}) },
      { shell: request.shell, redactSecrets: !show },
    ),
    { show },
  );
  const notes: string[] = [];
  // A `${secret:name}` token stays in the command as written: it is resolved only by a send.
  const unresolved = resolved.unresolved.filter((reference) => !isSecretTokenRef(reference));
  if (unresolved.length > 0) {
    notes.push(
      `Unresolved propert${unresolved.length === 1 ? 'y' : 'ies'}: ${unresolved
        .map((reference) => reference.expr)
        .join(', ')}.`,
    );
  }
  if (kerberos) {
    notes.push(KERBEROS_CURL_NOTE);
  }
  if (resolved.auth.type === 'aws-sigv4' && resolved.auth.placement === 'query') {
    notes.push(SIGV4_PRESIGN_NOTE);
  }
  if (resolved.auth.type === 'oauth2') {
    // The access token lives in main's memory for the session and is never written into a command:
    // one pasted with a live token would keep working long after the user forgot they shared it.
    notes.push('The OAuth2 access token is not included; the command carries the configuration only.');
  }
  return { command, ...(notes.length > 0 ? { notes } : {}) };
}

/**
 * The `curl` command equivalent to sending this request today: the request resolved through the
 * engine as its send resolves it, with the effective auth applied and properties expanded — but
 * with secret-bearing headers masked unless the session's show-secrets flag is on, since the
 * command is about to land on a clipboard.
 */
async function curl(
  service: EngineService,
  deps: RequestChannelDeps,
  sendDeps: SendThroughEngineDeps,
  request: RequestCurlRequest,
): Promise<RequestCurlResponse> {
  // Dispatch on what the id names rather than on a flag the renderer sends: the Code panel asks about
  // whatever request is in front of the user, and only the model knows which protocol that is. A
  // REST request is resolved as its send resolves it, through the engine, with no secret read.
  const rest = await previewRest(sendDeps, request.requestId, request.draft);
  if (rest !== undefined) {
    return await restCurl(deps, request, rest);
  }
  // A gRPC request the same way: through the engine, with no secret read.
  const grpc = await previewGrpc(sendDeps, request.requestId, request.grpcDraft);
  if (grpc !== undefined) {
    return await grpcCommand(deps, request, grpc);
  }
  // And a WebSocket request the same way.
  const ws = await previewWs(sendDeps, request.requestId, request.wsDraft);
  if (ws !== undefined) {
    return await wsCommand(deps, request, ws);
  }
  // A SOAP request the same way, through the engine, its credentials applied as a send applies them:
  // read only while the session shows secrets, a stand-in otherwise, masked all the same. An OAuth2
  // token is never fetched for it: one already cached is used, otherwise `Authorization` is left out
  // and a note says so.
  const soap = await soapPreviewOrUnknown(sendDeps, request.requestId);
  const { auth } = soap;
  const show = deps.showSecrets?.get() ?? false;
  const accessToken = auth?.type === 'oauth2' ? cachedAccessToken(deps, auth) : undefined;
  const kerberos = auth?.type === 'kerberos';
  const effective = await soapCurlInput(deps, soap.input, auth, show, accessToken);
  const keyParams = auth?.type === 'api-key' && auth.in === 'query' ? [auth.name] : [];
  // A header API key may be called anything, so its header is masked by name as well.
  const keyHeaders = auth?.type === 'api-key' && auth.in === 'header' ? [auth.name] : [];
  const headers = redactHeaders(effective.headers ?? {}, { show, extraHeaders: keyHeaders });
  const envelopeXml = redactXml(effective.envelopeXml, { show });
  const command = soapToCurl(
    {
      endpoint: redactUrl(effective.endpoint, { show, extraParams: keyParams }),
      envelopeXml,
      soapVersion: effective.soapVersion,
      ...(effective.soapAction !== undefined ? { soapAction: effective.soapAction } : {}),
      headers,
      ...(effective.skipSoapAction !== undefined ? { skipSoapAction: effective.skipSoapAction } : {}),
      ...(kerberos ? { negotiate: kerberosNames(auth) } : {}),
    },
    { shell: request.shell },
  );
  // `soapToCurl` builds a single-part request and gains no multipart support here, so a request
  // with attachments would otherwise be silently exported as one without them. Saying so in a
  // leading comment keeps the command paste-able while making the difference impossible to miss.
  const count = deps.project.sendAttachmentsFor?.(request.requestId)?.attachments.length ?? 0;
  // WS-Security is deliberately never applied to this preview (it needs secrets and a keystore an
  // export never touches); a request that selects one would otherwise look, from the command alone,
  // like it sends unsecured when it does not.
  const notes: string[] = [];
  const comments: string[] = [];
  if (deps.project.hasOutgoingWss?.(request.requestId) === true) {
    notes.push('WS-Security is not included in the cURL command.');
  }
  if (kerberos) {
    notes.push(KERBEROS_CURL_NOTE);
  }
  if (auth?.type === 'digest' || auth?.type === 'aws-sigv4') {
    notes.push(
      `${auth.type === 'digest' ? 'Digest' : 'AWS Signature v4'} is not included in the cURL command for a SOAP request.`,
    );
  }
  if (auth?.type === 'oauth2' && accessToken === undefined) {
    notes.push('No OAuth2 access token is cached, so the Authorization header is not included; press Get new token.');
  }
  if (count > 0) {
    notes.push(`${String(count)} attachment(s) are not included in the cURL command.`);
    comments.push(`# note: ${String(count)} attachment(s) not included`);
  }
  const network = await networkNote(deps.project, request.requestId, effective.endpoint);
  if (network !== undefined) {
    notes.push(network);
    comments.push(`# note: ${network}`);
  }
  return {
    command: comments.length === 0 ? command : `${comments.join('\n')}\n${command}`,
    ...(notes.length > 0 ? { notes } : {}),
  };
}

/**
 * A credential's shape with each secret a read of the environment variable the CLI reads it from,
 * for code generation with show-secrets off: the snippet runs once that variable is set, and the
 * keychain is never touched. NTLM, Kerberos and OAuth2 have no arm; the caller notes them instead.
 */
function environmentAuth(auth: AuthConfig): SendAuth | undefined {
  const need = secretNeedsOfAuth(auth)[0];
  const variable = need === undefined ? undefined : envVariablesFor(need)[0];
  const value = variable === undefined ? '' : envMarker(variable);
  switch (auth.type) {
    case 'basic':
      return { type: 'basic', username: auth.username ?? '', password: value, preemptive: auth.preemptive ?? true };
    case 'bearer':
      return { type: 'bearer', token: value, ...(auth.scheme !== undefined ? { scheme: auth.scheme } : {}) };
    case 'api-key':
      return { type: 'api-key', name: auth.name, value, in: auth.in };
    default:
      return undefined;
  }
}

/** The note for a credential code generation does not carry, by its type. */
function uncarriedAuthNote(type: AuthConfig['type'], tokenIncluded: boolean): string | undefined {
  switch (type) {
    case 'ntlm':
      return 'NTLM is not included: it needs a challenge round trip the snippet does not make.';
    case 'kerberos':
      return 'Kerberos is not included: the snippet does not ask the operating system for a ticket.';
    case 'digest':
      return 'Digest is not included: it answers a challenge round trip the snippet does not make.';
    case 'aws-sigv4':
      return 'AWS Signature v4 is not included: the snippet does not sign the request.';
    case 'oauth2':
      return tokenIncluded
        ? undefined
        : 'The OAuth2 access token is not included; the snippet carries no Authorization.';
    default:
      return undefined;
  }
}

/** What a snippet says about the JWT it carries: when it stops working, or how to see it. */
function jwtCodeNote(auth: SendAuth | undefined, show: boolean): string {
  if (!show || auth?.type !== 'jwt') {
    return 'The JWT is masked: show secrets to include a token signed now.';
  }
  const exp = jwtExpiry(auth.token);
  return exp === undefined
    ? 'The JWT was signed now and has no expiry.'
    : `The JWT was signed now and expires at ${new Date(exp * 1000).toISOString()}.`;
}

/** A JWT's `exp`, read from its payload without verifying it; undefined when it has none. */
function jwtExpiry(token: string): number | undefined {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as unknown;
    const exp = typeof payload === 'object' && payload !== null ? (payload as { exp?: unknown }).exp : undefined;
    return typeof exp === 'number' ? exp : undefined;
  } catch {
    return undefined;
  }
}

/** The settings a `request.code` call asked for, in the engine's terms. */
function codeOptions(settings: RequestCodeRequest['settings']): CodeOptions {
  return {
    ...(settings?.indent !== undefined ? { indent: settings.indent } : {}),
    ...(settings?.followRedirects !== undefined ? { followRedirects: settings.followRedirects } : {}),
    ...(settings?.timeoutMs !== undefined ? { timeoutMs: settings.timeoutMs } : {}),
  };
}

/**
 * One REST or SOAP request as code in another language, built from the same resolved send the
 * `curl` export uses, so every language agrees with the wire. With show-secrets off no secret is
 * read: each credential is an environment read in the snippet, and a value the masker has recorded
 * is masked wherever it sits.
 */
async function code(
  deps: RequestChannelDeps,
  sendDeps: SendThroughEngineDeps,
  request: RequestCodeRequest,
): Promise<RequestCurlResponse> {
  const { target } = request;
  if (target === 'wirebench-run') {
    return runLine(deps, request.requestId);
  }
  const show = deps.showSecrets?.get() ?? false;
  const rest = await previewRest(sendDeps, request.requestId, request.draft);
  const built =
    rest !== undefined ? await restCode(deps, rest, show) : await soapCode(deps, sendDeps, request.requestId, show);
  const extensions = deps.extensions?.() ?? createBuiltinRegistry().extensions;
  const generated = await extensions.codeGenerator(target).generate(built.request, codeOptions(request.settings));
  const notes = [...built.notes, ...generated.notes];
  return { command: redactSecretText(generated.code, { show }), ...(notes.length > 0 ? { notes } : {}) };
}

/** A REST request as a {@link CodeRequest}, with what it does not carry. */
async function restCode(
  deps: RequestChannelDeps,
  resolved: RestPreview,
  show: boolean,
): Promise<{ readonly request: CodeRequest; readonly notes: readonly string[] }> {
  const { type } = resolved.auth;
  const carried = type === 'basic' || type === 'bearer' || type === 'api-key' || type === 'jwt';
  // A JWT has no environment variable to read: the snippet carries a token signed now, shown only
  // while the session shows secrets (owner's call, #348), and a masked stand-in otherwise.
  const auth = !carried
    ? undefined
    : show
      ? await shownAuth(deps, resolved)
      : resolved.auth.type === 'jwt'
        ? placeholderAuth(resolved.auth)
        : environmentAuth(resolved.auth);
  // The preview's own credentials are dropped: only the ones decided here may reach the snippet.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to omit it
  const { auth: _preview, ...input } = resolved.input;
  const notes: string[] = [];
  // A `${secret:name}` token is an environment read in the snippet, so only the others are unresolved.
  const unresolved = resolved.unresolved.filter((reference) => !isSecretTokenRef(reference));
  if (unresolved.length > 0) {
    notes.push(
      `Unresolved propert${unresolved.length === 1 ? 'y' : 'ies'}: ${unresolved
        .map((reference) => reference.expr)
        .join(', ')}.`,
    );
  }
  const uncarried = uncarriedAuthNote(type, false);
  if (uncarried !== undefined) notes.push(uncarried);
  if (type === 'jwt') notes.push(jwtCodeNote(auth, show));
  return {
    request: restCodeRequest(secretTokensToEnv({ ...input, ...(auth !== undefined ? { auth } : {}) })),
    notes,
  };
}

/** A SOAP request as a {@link CodeRequest}: its envelope with WS-Addressing baked in, its credentials applied. */
async function soapCode(
  deps: RequestChannelDeps,
  sendDeps: SendThroughEngineDeps,
  requestId: string,
  show: boolean,
): Promise<{ readonly request: CodeRequest; readonly notes: readonly string[] }> {
  const soap = await soapPreviewOrUnknown(sendDeps, requestId);
  const owner = soap.auth;
  const accessToken = owner?.type === 'oauth2' && show ? cachedAccessToken(deps, owner) : undefined;
  const auth =
    owner === undefined || owner.type === 'kerberos' || owner.type === 'ntlm'
      ? undefined
      : show
        ? await resolveSoapAuth(
            owner,
            (ref) => deps.getSecret?.(ref) ?? Promise.resolve(undefined),
            accessToken !== undefined ? { accessToken } : {},
          )
        : environmentAuth(owner);
  // Headers typed on the request are masked by name, as the `curl` export masks them.
  const typed = withWsaHeaders({
    ...soap.input,
    headers: redactHeaders(soap.input.headers ?? {}, { show }),
    envelopeXml: redactXml(soap.input.envelopeXml, { show }),
  });
  const applied =
    auth === undefined || auth.type === 'basic' || auth.type === 'ntlm'
      ? undefined
      : applySoapAuth(typed.endpoint, typed.headers, auth);
  const input = secretTokensToEnv(
    applied === undefined ? typed : { ...typed, endpoint: applied.endpoint, headers: { ...applied.headers } },
  );
  const basic = auth?.type === 'basic' ? { username: auth.username, password: auth.password } : undefined;
  const notes: string[] = [];
  if (deps.project.hasOutgoingWss?.(requestId) === true) {
    notes.push('WS-Security is not included in the snippet.');
  }
  const count = deps.project.sendAttachmentsFor?.(requestId)?.attachments.length ?? 0;
  if (count > 0) {
    notes.push(`${String(count)} attachment(s) are not included in the snippet.`);
  }
  const uncarried = owner === undefined ? undefined : uncarriedAuthNote(owner.type, accessToken !== undefined);
  if (uncarried !== undefined) notes.push(uncarried);
  const network = await networkNote(deps.project, requestId, input.endpoint);
  if (network !== undefined) notes.push(network);
  return { request: soapCodeRequest(input, basic), notes };
}

/**
 * The `wirebench run` line that sends the saved request from a terminal: the project folder, the
 * request's path in it, and the active environment. It runs what is saved, so unsaved edits are not in it.
 */
function runLine(deps: RequestChannelDeps, requestId: string): RequestCurlResponse {
  const located = deps.project.runContextFor?.(requestId);
  if (located === undefined) {
    throw unknownRequest(requestId);
  }
  const selector = runSelectorOf(located.project, requestId, located.registry);
  if (selector === undefined) {
    return {
      command: '# wirebench run cannot send this request (a streaming call, a webhook item, or an orphan).',
    };
  }
  const environments: readonly { readonly id: string; readonly slug: string }[] =
    located.workspace?.workspace.environments ?? located.project.environments;
  const environment = environments.find((candidate) => candidate.id === located.environmentId);
  const words = ['wirebench run', quoteForShell(located.projectDir, 'posix'), quoteForShell(selector, 'posix')];
  if (environment !== undefined) {
    words.push('--env', quoteForShell(environment.slug, 'posix'));
  }
  return { command: words.join(' '), notes: ['Runs the request as saved; unsaved edits are not included.'] };
}

/**
 * The saved SOAP request as its send would resolve it. One that no project holds, or that no
 * endpoint resolves for, is refused as `unknown-request`, as the export always has.
 */
async function soapPreviewOrUnknown(sendDeps: SendThroughEngineDeps, requestId: string): Promise<SoapPreview> {
  try {
    const preview = await previewSoap(sendDeps, requestId);
    if (preview !== undefined) {
      return preview;
    }
  } catch (error) {
    if (!isWirebenchError(error) || error.code !== 'endpoint-unresolved') {
      throw error;
    }
  }
  throw unknownRequest(requestId);
}

/**
 * The exported request: basic credentials baked into an `Authorization` header (the command has no
 * challenge loop), then WS-Addressing, then a token scheme through `applySoapAuth` — the send's own
 * order, so `wsa:To` is the endpoint as configured rather than the one carrying an API key. A
 * `messageId: 'auto'` mints a fresh UUID here, so the command carries a one-off MessageID.
 */
async function soapCurlInput(
  deps: RequestChannelDeps,
  input: SoapSendInput,
  owner: SoapOwnerAuth | undefined,
  show: boolean,
  accessToken: string | undefined,
): Promise<SoapSendInput> {
  // A Kerberos owner is exported as `--negotiate` from its configuration: no secret is read for it.
  const auth =
    owner?.type === 'kerberos'
      ? undefined
      : show
        ? await resolveSoapAuth(
            owner,
            (ref) => deps.getSecret?.(ref) ?? Promise.resolve(undefined),
            accessToken !== undefined ? { accessToken } : {},
          )
        : placeholderSoapAuth(owner, accessToken);
  const basic =
    auth?.type === 'basic' &&
    auth.preemptive !== false &&
    !Object.keys(input.headers ?? {}).some((name) => name.toLowerCase() === 'authorization')
      ? {
          headers: {
            ...input.headers,
            Authorization: `Basic ${Buffer.from(`${auth.username}:${auth.password}`, 'utf8').toString('base64')}`,
          },
        }
      : {};
  const addressed = withWsaHeaders({ ...input, ...basic });
  if (auth === undefined || auth.type === 'basic' || auth.type === 'ntlm') {
    return addressed;
  }
  const applied = applySoapAuth(addressed.endpoint, addressed.headers, auth);
  return { ...addressed, endpoint: applied.endpoint, headers: { ...applied.headers } };
}

/**
 * A SOAP owner's credentials with no value in them, for an export that will mask them anyway: the
 * command shows which credential a request sends and where it goes without the keychain being read.
 * A cached OAuth2 token is the one value the export may carry, and is masked like the rest.
 */
function placeholderSoapAuth(owner: SoapOwnerAuth | undefined, accessToken: string | undefined): SendAuth | undefined {
  if (owner?.type === 'oauth2') {
    return accessToken === undefined ? undefined : { type: 'bearer', token: CURL_REDACTED };
  }
  return owner === undefined ? undefined : placeholderAuth(owner);
}

/** Bakes the input's WS-Addressing headers into its envelope, as a send writes them on the wire. */
function withWsaHeaders(input: SoapSendInput): SoapSendInput {
  if (input.wsa === undefined || !input.wsa.config.enabled) {
    return input;
  }
  const envelopeXml = applyWsaHeaders(input.envelopeXml, input.wsa.config, {
    endpoint: input.endpoint,
    ...(input.soapAction !== undefined ? { soapAction: input.soapAction } : {}),
    defaultAction: input.wsa.defaultAction,
    uuid: () => crypto.randomUUID(),
    envelopeVersion: input.soapVersion,
  });
  return { ...input, envelopeXml };
}

/**
 * The one-line description of everything about a real send's *connection* the exported command
 * does not carry: the proxy it is dialled through, the extra trust anchors it verifies against,
 * an endpoint's `trustInvalid`, and a client certificate. `curl` can be told all four
 * (`--proxy`, `--cacert`, `--insecure`, `--cert`), but none of them can be reconstructed from
 * what is on the clipboard — and a command that silently fails against a server only reachable
 * through the corporate proxy is worse than one that says so.
 *
 * Key material is never named, only its presence; the CA bundle's *path* is left out too, since
 * the command may be pasted anywhere. Resolving any of this can fail (a keystore that will not
 * load, a SOCKS system proxy): the export is a preview, so a failure costs the note, not the
 * command.
 */
async function networkNote(
  project: RequestChannelProject,
  requestId: string,
  endpoint: string,
): Promise<string | undefined> {
  const parts: string[] = [];
  try {
    const proxy = await project.proxyFor?.(ownerOf(project, requestId), endpoint);
    if (proxy !== undefined) {
      parts.push(`through proxy ${proxy.url}`);
    }
  } catch {
    // The send itself will report it; the export stays usable.
  }
  try {
    const tls = await project.tlsFor?.(requestId);
    if (tls?.ca !== undefined && tls.ca.length > 0) {
      parts.push('with custom trust anchors');
    }
    if (tls?.rejectUnauthorized === false) {
      parts.push('with certificate verification turned off for this endpoint');
    }
    if (tls?.cert !== undefined) {
      parts.push('with a client certificate');
    }
  } catch {
    // As above.
  }
  return parts.length === 0 ? undefined : `sent ${parts.join(', ')}; not reproduced here`;
}

/**
 * Turns a pasted `curl` command into a new saved request against the given operation: a fresh
 * request is added first (so it starts from a valid generated envelope), then patched with
 * whatever the command actually carried. Anything the parse could not honour — `-u`, `@file`
 * bodies, unknown flags — comes back as `problems` for the UI to show; credentials are never
 * imported.
 */
async function importCurl(
  deps: Pick<RequestChannelDeps, 'project' | 'storeSecret'>,
  request: RequestImportCurlRequest,
): Promise<RequestImportCurlResponse> {
  // The dialog refuses this too; main checks again so no other caller can import `wget …` as a GET.
  const notCurl = notCurlReason(request.command);
  if (notCurl !== undefined) {
    throw new ProjectError('not-curl', notCurl);
  }
  return request.target.kind === 'rest'
    ? await importCurlAsRest(deps, request, request.target)
    : await importCurlAsSoap(deps.project, request, request.target);
}

/** The SOAP half: a new request under an operation, with the envelope the command carried. */
async function importCurlAsSoap(
  project: RequestChannelProject,
  request: RequestImportCurlRequest,
  target: Extract<RequestImportCurlTarget, { kind: 'soap' }>,
): Promise<RequestImportCurlResponse> {
  const parsed = fromCurl(request.command);
  const created = await project.projectMutate(ownerOf(project, target.interfaceId), {
    kind: 'add-request',
    interfaceId: target.interfaceId,
    bindingName: target.bindingName,
    operationName: target.operationName,
  });
  const requestId = created.createdRequestId;
  if (requestId === undefined) {
    throw new ProjectError('add-request-failed', 'The new request was not created');
  }
  const { endpoint, envelopeXml, soapAction, headers } = parsed.input;
  const patch: RequestPatchWire = {
    ...(request.name !== undefined ? { name: request.name } : {}),
    ...(envelopeXml !== undefined ? { envelopeXml } : {}),
    ...(endpoint !== undefined ? { endpointUrl: endpoint } : {}),
    ...(soapAction !== undefined ? { soapAction } : {}),
    ...(headers !== undefined ? { headers: Object.entries(headers).map(([name, value]) => ({ name, value })) } : {}),
  };
  await project.projectMutate(ownerOf(project, requestId), { kind: 'update-request', requestId, patch });
  return { requestId, problems: [...parsed.problems] };
}

/** The engine's body as the wire spells it: the same shape, with its arrays no longer readonly. */
function bodyToWire(body: RestBody): NonNullable<RestRequestPatchWire['body']> {
  switch (body.kind) {
    case 'raw':
      return {
        kind: 'raw',
        language: body.language,
        ...(body.contentType !== undefined ? { contentType: body.contentType } : {}),
        text: body.text,
      };
    case 'form':
      return { kind: 'form', fields: body.fields.map((field) => ({ ...field })) };
    case 'multipart':
      return { kind: 'multipart', parts: body.parts.map((part) => ({ ...part })) };
    case 'binary':
      return { kind: 'binary', source: { ...body.source }, contentType: body.contentType };
    case 'graphql':
      return {
        kind: 'graphql',
        query: body.query,
        variables: body.variables,
        ...(body.operationName !== undefined ? { operationName: body.operationName } : {}),
      };
    default:
      return { kind: 'none' };
  }
}

/**
 * What an imported REST request is called when the caller gives no name: its path (`/pets/{petId}`),
 * so a few imports in a row can be told apart in the explorer. The method is left out because every
 * list shows it in a badge beside the name. The path leaves out the query and, for a URL outside the
 * API's base, the scheme and host.
 */
export function importedRequestName(url: string | undefined): string | undefined {
  if (url === undefined || url === '') {
    return undefined;
  }
  const withoutQuery = url.split(/[?#]/, 1)[0] ?? '';
  const path = withoutQuery.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '');
  return path === '' ? '/' : path;
}

/**
 * The REST half: a new request in an API (or a folder of it), then one patch with everything the
 * command described.
 *
 * The URL is split against the API's own base URL, so an imported request keeps a relative path and
 * follows the API's environment overrides like every other request in it. A `-u` password is not in
 * the command as far as this channel is concerned: the dialog stores it and sends a reference.
 */
async function importCurlAsRest(
  deps: Pick<RequestChannelDeps, 'project' | 'storeSecret'>,
  request: RequestImportCurlRequest,
  target: Extract<RequestImportCurlTarget, { kind: 'rest' }>,
): Promise<RequestImportCurlResponse> {
  const { project } = deps;
  const owner = ownerOf(project, target.apiId);
  const api = project.projectSnapshot?.(owner)?.apis.find((candidate) => candidate.id === target.apiId);

  const parsed = fromRestCurl(request.command, api?.baseUrl !== undefined ? { baseUrl: api.baseUrl } : {});
  const name = request.name ?? importedRequestName(parsed.request.url);

  const created = await project.projectMutate(owner, {
    kind: 'add-rest-request',
    apiId: target.apiId,
    ...(target.folderId !== undefined ? { parentId: target.folderId } : {}),
    ...(name !== undefined ? { name } : {}),
  });
  const requestId = created.createdId;
  if (requestId === undefined) {
    throw new ProjectError('add-request-failed', 'The new REST request was not created');
  }

  const { method, url, pathParams, query, headers, body, settings } = parsed.request;
  // Every credential value in the command goes straight to the keychain; the model only holds refs.
  const store = async (value: string | undefined, label: string): Promise<string | undefined> =>
    value !== undefined && value !== '' && deps.storeSecret !== undefined
      ? await deps.storeSecret(value, `cURL import: ${label}`)
      : undefined;
  const user = parsed.basic ?? parsed.digest;
  const passwordRef =
    user === undefined ? undefined : (request.passwordRef ?? (await store(user.password, user.username)));
  const sigv4 = parsed.awsSigV4;
  const sigv4Refs =
    sigv4 === undefined
      ? undefined
      : {
          accessKeyIdRef: await store(sigv4.accessKeyId, 'AWS access key id'),
          secretAccessKeyRef: await store(sigv4.secretAccessKey, 'AWS secret access key'),
          sessionTokenRef: await store(sigv4.sessionToken, 'AWS session token'),
        };
  // `--negotiate` reads as Kerberos (the parser drops `basic` then): the ticket needs no password.
  // `--digest` and `--aws-sigv4` read as their own schemes the same way.
  const auth: AuthConfig | undefined =
    parsed.kerberos !== undefined
      ? parsed.kerberos
      : sigv4 !== undefined && sigv4Refs !== undefined
        ? {
            type: 'aws-sigv4',
            region: sigv4.region,
            service: sigv4.service,
            ...(sigv4Refs.accessKeyIdRef !== undefined ? { accessKeyIdRef: sigv4Refs.accessKeyIdRef } : {}),
            ...(sigv4Refs.secretAccessKeyRef !== undefined ? { secretAccessKeyRef: sigv4Refs.secretAccessKeyRef } : {}),
            ...(sigv4Refs.sessionTokenRef !== undefined ? { sessionTokenRef: sigv4Refs.sessionTokenRef } : {}),
          }
        : parsed.digest !== undefined
          ? { type: 'digest', username: parsed.digest.username, ...(passwordRef !== undefined ? { passwordRef } : {}) }
          : parsed.basic === undefined
            ? undefined
            : {
                type: 'basic' as const,
                username: parsed.basic.username,
                ...(passwordRef !== undefined ? { passwordRef } : {}),
                preemptive: true,
              };
  const stored =
    passwordRef !== undefined || (sigv4Refs !== undefined && Object.values(sigv4Refs).some((ref) => ref !== undefined));
  await project.projectMutate(owner, {
    kind: 'update-rest-request',
    requestId,
    patch: {
      ...(method !== undefined ? { method } : {}),
      ...(url !== undefined ? { url } : {}),
      ...(pathParams !== undefined ? { pathParams: [...pathParams] } : {}),
      ...(query !== undefined ? { query: [...query] } : {}),
      ...(headers !== undefined ? { headers: [...headers] } : {}),
      ...(body !== undefined ? { body: bodyToWire(body) } : {}),
      ...(settings !== undefined ? { settings: toRestSettingsWire(settings) } : {}),
      ...(auth !== undefined ? { auth } : {}),
    },
  });

  return {
    requestId,
    problems: [...parsed.problems],
    ...(user !== undefined ? { basicUsername: user.username } : {}),
    ...(stored ? { passwordStored: true } : {}),
  };
}

/**
 * The access token already cached for `config`, if one is still valid — never a new one. An export
 * must not open a browser or call a token endpoint behind the user's back.
 */
export function cachedAccessToken(deps: RequestChannelDeps, config: OAuth2Auth): string | undefined {
  const status = deps.oauth2?.status?.(config, { showSecrets: true });
  return status?.state === 'valid' ? status.token : undefined;
}

/**
 * A dry run's unresolved references onto the wire, without the `${secret:name}` tokens: a dry run
 * reads no secret, and a send resolves them (refusing as `secret-missing` when nothing is stored).
 */
export function preflightUnresolved(unresolved: readonly UnresolvedRef[]): UnresolvedRefWire[] {
  return unresolved.filter((ref) => !isSecretTokenRef(ref)).map(toUnresolvedRefWire);
}

/**
 * The early warnings for the `${secret:name}` tokens a preview reached: one whose name maps to an invalid
 * entry, or to a shared entry this machine has not approved. A preview resolves each token behind a
 * placeholder, so none of them is ever in its unresolved list; the names come from `secretNames`. Nothing is
 * fetched and no tool runs: only the mapping and the trust state are read.
 */
export function preflightSecretRefs(
  names: readonly string[],
  secretSources: SecretSourcesSnapshot | undefined,
): UnresolvedRefWire[] {
  if (secretSources === undefined) {
    return [];
  }
  const { sources, trusted } = secretSourceContext(secretSources);
  const wire: UnresolvedRefWire[] = [];
  for (const name of names) {
    const code = secretSourceRefCode({ scope: 'Secret', name, code: 'missing' }, sources, trusted);
    if (code !== undefined) {
      wire.push({ expr: `\${secret:${name}}`, scope: 'Secret', name, code, start: 0, end: 0 });
    }
  }
  return wire;
}

/**
 * True when a caller asked for the secret-source warnings only and no name is mapped: there is nothing
 * to warn about, so the request is not resolved at all (the send that runs beside it resolves it once).
 */
export function nothingToWarnAbout(
  secretsOnly: boolean | undefined,
  secretSources: SecretSourcesSnapshot | undefined,
): boolean {
  return secretsOnly === true && (secretSources === undefined || secretSourceContext(secretSources).sources.size === 0);
}

/**
 * `request.variables`: what `requestId` can reference, from the scopes its send expands against, and
 * the secret names it may read — those stored for its project and those mapped to a secret source.
 */
export async function variablesFor(deps: RequestChannelDeps, requestId: string): Promise<RequestVariablesResponse> {
  const projectId = deps.project.projectId(requestId);
  if (projectId === undefined) {
    return { entries: [], secretNames: [] };
  }
  const stored = (await deps.secretNamesFor?.(projectId)) ?? [];
  const snapshot = deps.secretSources?.();
  const mapped = snapshot === undefined ? [] : [...secretSourceContext(snapshot).sources.keys()];
  return requestVariables({
    scopes: deps.project.scopesFor(requestId),
    located: deps.project.runContextFor?.(requestId),
    secretNames: [...new Set([...stored, ...mapped])].sort(),
  });
}

/** What a preflight answers for a request no open project holds. */
export const NO_PREFLIGHT: PreflightResult = {
  endpointSource: 'none',
  unresolved: [],
  auth: { type: 'none', source: 'none' },
  wsa: { enabled: false },
};

/** The credentials a preflight names: their type, with an unresolved `inherit` as none. */
export function preflightAuth(auth: AuthConfig): PreflightResult['auth'] {
  return { type: auth.type === 'inherit' ? 'none' : auth.type, source: 'request' };
}

/**
 * The command-line form of a gRPC call: what a command-line gRPC client would be told to make the
 * same call, the `.proto` files named from the API's cached roots. Credentials are read only while
 * the session shows secrets; otherwise a stand-in takes their place, and is masked all the same.
 */
async function grpcCommand(
  deps: RequestChannelDeps,
  request: RequestCurlRequest,
  resolved: GrpcPreview,
): Promise<RequestCurlResponse> {
  const show = deps.showSecrets?.get() ?? false;
  // Kerberos has no grpcurl form (the token is made per call), so it is dropped, with no secret read.
  const kerberos = resolved.auth.type === 'kerberos';
  const auth = kerberos ? undefined : show ? await shownAuth(deps, resolved) : placeholderAuth(resolved.auth);
  // A definition discovered by reflection has no .proto files on disk to name, and grpcurl asks the
  // server itself when it is given none — so the flags are dropped rather than pointing at nothing.
  const { definition } = resolved.item.api;
  const fromFiles = definition !== undefined && definition.kind === 'proto';
  const command = grpcToCommand({ ...resolved.input, ...(auth !== undefined ? { auth } : {}) }, resolved.messageText, {
    redactSecrets: !show,
    shell: request.shell,
    ...(fromFiles ? { protoFiles: [...definition.roots] } : {}),
  });
  // A `${secret:name}` token is shown as typed too: an export never reads its value.
  const asTyped = resolved.unresolved.length > 0 || resolved.secretTokens;
  const notes = [
    fromFiles
      ? 'The .proto files are named by import path; pass their folder with -import-path.'
      : 'No .proto files are named: this API was discovered by server reflection, which grpcurl uses by default.',
    ...(kerberos ? ['Kerberos is not expressible in this command; no authorization is shown.'] : []),
    ...(asTyped ? ['Some ${…} references did not resolve; they are shown as typed.'] : []),
  ];
  return { command, notes };
}

/**
 * The command-line form of a WebSocket call: what `websocat` would be told to dial the same URL
 * with, credentials resolved and then masked unless the session shows secrets. Proxy, CA and
 * client certificate are not reconstructable in a command line, same as the other two protocols.
 */
async function wsCommand(
  deps: RequestChannelDeps,
  request: RequestCurlRequest,
  resolved: WsPreview,
): Promise<RequestCurlResponse> {
  const show = deps.showSecrets?.get() ?? false;
  // A Negotiate token is made per handshake and cannot be written into a command line, so a
  // Kerberos request is noted from its configuration, with no secret read for it.
  const kerberos = resolved.auth.type === 'kerberos';
  const auth = kerberos ? undefined : show ? await shownAuth(deps, resolved) : placeholderAuth(resolved.auth);
  const material: WsSessionMaterial = { ...(auth !== undefined ? { auth } : {}) };
  const options = toWsSessionOptions(resolved.input, material);
  const command = wsToCommand(options, { shell: request.shell });
  // A `${secret:name}` token is shown as typed too: an export never reads its value.
  const asTyped = resolved.unresolved.length > 0 || resolved.secretTokens;
  const notes = [
    'Proxy, CA and client certificate settings are not reconstructable in this command.',
    ...(kerberos ? ['Kerberos is not expressible in this command; the upgrade is shown without authorization.'] : []),
    ...(asTyped ? ['Some ${…} references did not resolve; they are shown as typed.'] : []),
  ];
  return { command, notes };
}

/**
 * The `request.openWs` sends still running: one per open session, each settling only once its
 * History entry has been written.
 *
 * A session's History entry is written by whoever awaits the session, which is the pending
 * `request.openWs` invoke — so closing a session is not the same as having recorded it. The two
 * moments that close sessions on the app's behalf (quitting, and closing a project) must wait for
 * the recording, or the entry is written into a history file that has already been closed, or not
 * at all because the process exited first. {@link whenWsSessionsRecorded} is that wait.
 */
export const openWsCalls = new Map<Promise<unknown>, string>();

/**
 * Resolves once every `request.openWs` in flight whose request `matches` — every one of them when
 * it is omitted — has finished recording its History entry, or after `timeoutMs`: a socket that
 * will not finish closing must never be the reason the app cannot quit.
 *
 * `matches` is what keeps a project close from waiting on another project's session, which is
 * still open and would hold it for the whole timeout.
 */
export async function whenWsSessionsRecorded(
  timeoutMs: number,
  matches?: (requestId: string) => boolean,
): Promise<void> {
  const waiting = [...openWsCalls]
    .filter(([, requestId]) => matches === undefined || matches(requestId))
    .map(([call]) => call);
  if (waiting.length === 0) {
    return;
  }
  const pending = Promise.all(waiting);
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      pending,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * The editor's `request.sendRest` calls still running, each settling only once its History entry
 * has been written — the REST twin of {@link openWsCalls}, for an event stream that stays open
 * until something stops it.
 */
export const openRestCalls = new Map<Promise<unknown>, string>();

/**
 * Resolves once every editor REST send in flight whose request `matches` has recorded its History
 * entry, or after `timeoutMs`. Paired with `ExchangeRegistry.endWhere(…, 'rest')` wherever
 * WebSocket sessions are closed on the app's behalf (quitting, closing a project).
 */
export async function whenRestSendsRecorded(
  timeoutMs: number,
  matches?: (requestId: string) => boolean,
): Promise<void> {
  const waiting = [...openRestCalls]
    .filter(([, requestId]) => matches === undefined || matches(requestId))
    .map(([call]) => call);
  if (waiting.length === 0) {
    return;
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.all(waiting),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * Registers the `request.*` IPC channels against a shared `EngineService` instance.
 *
 * Every send expands properties: the scopes come from the project service, which folds the
 * open project's properties, the active environment's, the user's globals and `process.env`
 * into one chain. `request.preflight` runs the same expansion as a dry run so the UI can list
 * unresolved references before anything leaves the machine.
 */
export function registerRequestChannels(service: EngineService, deps: RequestChannelDeps): void {
  const sendDeps = toSendDeps(service, deps);

  registerHandler(channels.request.sendToEnvironments, (request) => sendToEnvironments(sendDeps, deps, request));

  // Every send goes through the engine, so every one is cancelled through the registry.
  registerHandler(channels.request.cancel, ({ sendId }) =>
    Promise.resolve(cancelEnvironmentBatch(sendDeps.registry, sendId) ?? sendDeps.registry.cancel(sendId)),
  );

  registerHandler(channels.request.curl, (request) => curl(service, deps, sendDeps, request));
  registerHandler(channels.request.codeTargets, () => {
    const extensions = deps.extensions?.() ?? createBuiltinRegistry().extensions;
    // The built-in languages are the renderer's own list; only a plugin's generators are new to it.
    const targets = extensions.codeGenerators
      .filter((generator) => generator.origin.kind === 'plugin')
      .map((generator) => ({ id: generator.id, label: generator.title, language: generator.language }));
    return Promise.resolve({ targets });
  });
  registerHandler(channels.request.code, (request) => code(deps, sendDeps, request));

  registerHandler(channels.request.variables, (request) => variablesFor(deps, request.requestId));

  registerHandler(channels.request.importCurl, (request) => importCurl(deps, request));
}
