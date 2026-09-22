import type { WebContents } from 'electron';
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import {
  composeUrl,
  CURL_REDACTED,
  expandWsMessage,
  fromCurl,
  fromRestCurl,
  grpcToCommand,
  isWirebenchError,
  nodeFs,
  prettyPrint,
  ProjectError,
  recreateRequest,
  resolveWsUrl,
  restToCurl,
  soapToCurl,
  toWsSessionOptions,
  WirebenchError,
  writeFileAtomic,
  joinBase,
  failedRequestOf,
  grpcMethodPath,
  wsToCommand,
} from '@wirebench/engine';
import { channels, events } from '../../shared/ipc.js';
import type { EngineService } from '../engine-service.js';
import { generateOptionsFrom } from '../generate-options.js';
import type {
  AuthConfig,
  Cookie,
  OAuth2Auth,
  ProxyOptions,
  RestBody,
  SendAuth,
  TlsOptions,
  PropertyScopes,
  WsSessionMaterial,
  WsSessionOptions,
} from '@wirebench/engine';
import type { ProjectRouter } from '../project-router.js';
import { resolveAuthConfig } from '../secret-resolver.js';
import type { HistoryService } from '../history-service.js';
import type { OAuth2Service } from '../oauth2.js';
import type { PreferencesService } from '../preferences.js';
import { isInsideReal, realpathOfPrefix } from '../path-containment.js';
import { redactHeaders, redactXml } from '../redact.js';
import { failedExchangeOf } from '../failed-exchange.js';
import { reportSendFailed, sendAndRecordHistory } from '../send-with-history.js';
import type { RestSendResolution } from '../rest-send.js';
import type { GrpcSendResolution } from '../grpc-send.js';
import type { WsSendResolution } from '../ws-send.js';
import type { PreflightResult } from '../expansion-preflight.js';
import { toUnresolvedRefWire } from '../engine-wire.js';
import type {
  GrpcExchangeSummary,
  GrpcRequestPatchWire,
  RequestSendGrpcRequest,
  RestRequestPatchWire,
  UnresolvedRefWire,
  RequestSendRestRequest,
  RestExchangeSummary,
  ExchangeSummary,
  HistoryEntryWire,
  FailedExchangeWire,
  RequestSendRequest,
  ResolvedSendRequest,
  RequestCurlRequest,
  RequestCurlResponse,
  RequestImportCurlRequest,
  RequestImportCurlTarget,
  RequestImportCurlResponse,
  RequestPatchWire,
  RequestRecreateRequest,
  RequestRecreateResponse,
  RequestOpenWsRequest,
  RequestWsSendRequest,
  RequestWsCloseRequest,
  RequestWsCloseResponse,
  WsExchangeSummary,
  WsFrameWire,
  WsHandshakeWire,
  WsRequestPatchWire,
  LogEntryWire,
  RestLiveEvent,
} from '../../shared/wire-types.js';
import { cancelEnvironmentBatch, sendToEnvironments } from '../multi-env-send.js';
import { emitEvent } from './events.js';
import { registerHandler } from './register.js';

/** The `ProjectRouter` surface the `request.*` channels drive; a stub stands in for it in tests. */
export type RequestChannelProject = Pick<
  ProjectRouter,
  | 'scopesFor'
  | 'preflight'
  | 'authFor'
  | 'requestMeta'
  | 'projectId'
  | 'projectMutate'
  | 'requestSource'
  | 'buildLiveSendInput'
  | 'sendInputFor'
  | 'dumpFileFor'
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
      | 'wssFor'
      | 'hasOutgoingWss'
      | 'proxyFor'
      // The REST half, optional for the same reason: a stub that never sends a REST request needs
      // none of it.
      | 'restSend'
      // Read to split an imported cURL URL against the API's own base URL.
      | 'projectSnapshot'
      | 'restTlsFor'
      | 'rememberRestCookies'
      | 'restMeta'
      // Read after a REST send, to check the response against its OpenAPI operation.
      | 'restContractFor'
      // The gRPC third, optional for the same reason.
      | 'grpcSend'
      | 'grpcTlsFor'
      | 'grpcMeta'
      | 'grpcProtoSetFor'
      // The WebSocket fourth, optional for the same reason.
      | 'wsSend'
      | 'wsTlsFor'
      | 'wsContractFor'
      | 'wsMeta'
    >
  >;

/**
 * The id of the project owning `entityId`, for the handful of calls that address the *project*
 * (a mutation, a proxy lookup) while the renderer only named an entity inside it. Throws rather
 * than guessing: with several projects open there is no "current" one to fall back to.
 */
function ownerOf(project: Pick<RequestChannelProject, 'projectId'>, entityId: string): string {
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
   * The scopes an *ad-hoc* send expands against — one with no saved request behind it, and so
   * no project to resolve a chain from. Omitted in tests, which then expand against nothing.
   */
  readonly adHocScopes?: () => PropertyScopes;
  /** The session "show secrets" flag; omitted defaults every send to redacted. */
  readonly showSecrets?: { get(): boolean };
  /** Records every completed/failed send to the open project's history. Omitted in tests that don't care. */
  readonly history?: HistoryService;
  /** Called with the entry a recorded send produced, so main can broadcast `history.appended`. */
  readonly onHistoryAppended?: (entry: HistoryEntryWire) => void;
  /**
   * Called with the failure row of a send that threw, after History has recorded it, so main can
   * broadcast `exchange.failed`. Shared with `sendAndRecordHistory`, which reads it off this same
   * object for the SOAP path.
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
  readonly oauth2?: Pick<OAuth2Service, 'accessToken'>;
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
}

/**
 * The subset of the session's picked-path memory the dump-file check needs — write picks only.
 * A path merely picked to *read* (the attachments "Add" dialog) must not qualify a Dump File
 * write target; only a path chosen through the Save-as "Browse…" picker does.
 */
export type DumpFilePicks = { hasWrite(path: string): boolean };

/**
 * e2e-only: extra trust anchors for every send, as one PEM file named by
 * `WIREBENCH_E2E_EXTRA_CA_FILE`.
 *
 * Superseded, for real use, by the `ssl.caBundlePath` preference (see
 * `ProjectHost.trustAnchors`), which is how a user configures a private CA and which a spec
 * can now drive through the picker with `WIREBENCH_E2E_FILE_DIALOG_PATH`. This hook survives for
 * the specs that predate the preference and only need *some* anchor in place before the
 * Preferences UI exists in their flow; it adds to `tls.ca` exactly as the preference does.
 *
 * The Playwright suite talks to a TLS server signed by a CA it generates at run time, and
 * Wirebench must trust it *the way a user would* — by configuring trust, not by turning
 * verification off, and not by letting a client keystore double as a trust store (which is
 * exactly the confusion `toTlsClientIdentity` was changed to avoid). So a test build takes the
 * anchors from an env var no shipped build ever sets, alongside `WIREBENCH_E2E_OPEN_PATH`,
 * `WIREBENCH_E2E_SAVE_PATH`, `WIREBENCH_E2E_DIALOG_FOLDER`, `WIREBENCH_E2E_DIALOG_SAVE` and
 * `WIREBENCH_E2E_FILE_DIALOG_PATH`.
 *
 * TLS verification itself is untouched: these anchors are *added* to a send's `tls.ca`, and
 * `rejectUnauthorized` keeps its default. The file is read once and remembered; an unset or
 * unreadable variable simply yields no anchors, so an ordinary run pays nothing for it.
 */
let e2eTrustAnchors: readonly string[] | undefined;
function extraTrustAnchors(): readonly string[] {
  if (e2eTrustAnchors === undefined) {
    const path = process.env['WIREBENCH_E2E_EXTRA_CA_FILE'];
    try {
      e2eTrustAnchors = path === undefined || path.length === 0 ? [] : [readFileSync(path, 'utf-8')];
    } catch {
      e2eTrustAnchors = [];
    }
  }
  return e2eTrustAnchors;
}

/**
 * Applies the saved request's properties (and the user's preferences) to the input the
 * renderer sent. The renderer owns what is *in* the editor — the envelope being typed, the
 * endpoint it resolved — and the main process owns the knobs around it, so the two are folded
 * together here rather than duplicating the mapping in the renderer. An ad-hoc send, or one
 * whose request has since been deleted, goes out exactly as the renderer built it.
 */
export async function withRequestProperties(
  project: RequestChannelProject,
  request: RequestSendRequest,
  envId?: string,
): Promise<ResolvedSendRequest> {
  if (request.requestId === undefined) {
    return withExtraTrustAnchors(request);
  }
  const mapped = project.sendInputFor(
    request.requestId,
    {
      endpoint: request.input.endpoint,
      envelopeXml: request.input.envelopeXml,
      ...(request.input.headers !== undefined ? { headers: { ...request.input.headers } } : {}),
    },
    envId,
  );
  // The client identity is resolved separately (and asynchronously): it means reading a file
  // and decrypting a secret, and it must never reach the renderer or the cURL export — which
  // is exactly why `sendInputFor` stays synchronous and material-free. A selected keystore
  // that will not load throws here, failing the send loudly rather than quietly going out
  // without the certificate the user asked for.
  const tls = await project.tlsFor?.(request.requestId, envId);
  const input = mapped ?? request.input;
  return withExtraTrustAnchors({
    ...request,
    input: tls === undefined ? input : { ...input, tls: { ...input.tls, ...tls } },
  });
}

/** Appends {@link extraTrustAnchors} to a send's `tls.ca`; a no-op outside the e2e suite. */
function withExtraTrustAnchors(request: ResolvedSendRequest): ResolvedSendRequest {
  const anchors = extraTrustAnchors();
  if (anchors.length === 0) {
    return request;
  }
  const tls = request.input.tls;
  return { ...request, input: { ...request.input, tls: { ...tls, ca: [...(tls?.ca ?? []), ...anchors] } } };
}

/**
 * Resolves a dump-file target against the project folder and refuses one that would land
 * outside it, unless the exact path was chosen through the Dump File "Browse…" picker this
 * session — a dump file may point anywhere the *user* has explicitly picked, but a
 * relative path (or an absolute one merely typed into the property) must stay inside the
 * project.
 */
async function resolveDumpPath(
  target: { path: string; projectDir: string },
  picks: DumpFilePicks | undefined,
): Promise<{ path: string } | { problem: ExchangeSummary['problems'][number] }> {
  const resolved = isAbsolute(target.path) ? target.path : resolvePath(target.projectDir, target.path);
  if (picks?.hasWrite(resolved) === true) {
    return { path: resolved };
  }
  const [projectReal, candidateReal] = await Promise.all([
    realpathOfPrefix(target.projectDir),
    realpathOfPrefix(resolved),
  ]);
  if (!isInsideReal(projectReal, candidateReal)) {
    return {
      problem: {
        code: 'dump-outside-project',
        message: `The dump file "${target.path}" resolves outside the project folder`,
      },
    };
  }
  return { path: resolved };
}

/**
 * "Dump File": writes the response body of a completed send to the path the request
 * names, resolving a relative path against the project folder and refusing to write (or create
 * directories) anywhere outside it — see {@link resolveDumpPath}. A write failure (or the
 * refusal itself) is reported as a problem on the exchange rather than failing the send — the
 * response arrived, and losing it because a directory is read-only, or the path is untrusted,
 * would be the worse outcome.
 */
async function writeDumpFile(
  project: RequestChannelProject,
  requestId: string | undefined,
  summary: ExchangeSummary,
  picks?: DumpFilePicks,
): Promise<ExchangeSummary> {
  const target = requestId === undefined ? undefined : project.dumpFileFor(requestId);
  if (target === undefined) {
    return summary;
  }
  const resolved = await resolveDumpPath(target, picks);
  if ('problem' in resolved) {
    return { ...summary, problems: [...summary.problems, resolved.problem] };
  }
  try {
    await mkdir(dirname(resolved.path), { recursive: true });
    await writeFileAtomic(nodeFs, resolved.path, Buffer.from(summary.http.bodyBase64, 'base64'));
    return summary;
  } catch (error) {
    return {
      ...summary,
      problems: [
        ...summary.problems,
        {
          code: 'dump-failed',
          message: `Could not write the dump file "${resolved.path}": ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
}

function unknownRequest(requestId: string): ProjectError {
  return new ProjectError('unknown-request', `No saved request with id ${requestId}`, { details: { requestId } });
}

/**
 * "Recreate Request": regenerate the operation's envelope, merge the saved one into
 * it (unless `empty`, which starts from a bare envelope), then save the result through the
 * project service so the renderer's mirror and the folder on disk both follow.
 */
async function recreate(
  service: EngineService,
  deps: RequestChannelDeps,
  request: RequestRecreateRequest,
): Promise<RequestRecreateResponse> {
  const project = deps.project;
  const preferences = deps.preferences?.get();
  const source = project.requestSource(request.requestId);
  if (source === undefined) {
    throw unknownRequest(request.requestId);
  }
  const options = generateOptionsFrom(preferences);
  const generated = service.generate({
    interfaceId: source.interfaceId,
    bindingName: source.bindingName,
    operationName: source.operationName,
    ...(options !== undefined ? { options } : {}),
    ...(request.empty ? { empty: true } : {}),
  });
  // An empty request is a deliberate reset, so nothing is merged into it — the counts a merge
  // would report are all zero rather than describing what was thrown away.
  const merged = request.empty
    ? { xml: generated.envelopeXml, kept: 0, added: 0, removed: 0 }
    : recreateRequest(source.envelopeXml, generated.envelopeXml, {
        keepValues: request.keepValues,
        keepHeaders: request.keepHeaders,
      });
  // A recreate hands back a freshly built envelope, so it is formatted with the user's own
  // indent rather than whatever width the generator happened to use.
  const envelopeXml = prettyPrint(merged.xml, preferences?.editor.tabSize);
  await project.projectMutate(ownerOf(project, request.requestId), {
    kind: 'update-request',
    requestId: request.requestId,
    patch: { envelopeXml },
  });
  return { envelopeXml, kept: merged.kept, added: merged.added, removed: merged.removed };
}

/**
 * The `curl` command equivalent to sending this request today: the same live input
 * `request.send` builds, with the effective auth applied and properties expanded — but with
 * secret-bearing headers masked unless the session's show-secrets flag is on, since the
 * command is about to land on a clipboard.
 */
/**
 * A credential's shape with no value in it, for an export that will redact it anyway.
 *
 * Every arm carries the marker rather than a secret, so the command shows *which* credential a
 * request sends and where it goes without the keychain being touched.
 */
function placeholderAuth(auth: AuthConfig): SendAuth | undefined {
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
    default:
      // `none`, `inherit` and `oauth2`: nothing to put on the command (the last is noted instead).
      return undefined;
  }
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
  resolved: NonNullable<ReturnType<NonNullable<RequestChannelProject['restSend']>>>,
): Promise<RequestCurlResponse> {
  const show = deps.showSecrets?.get() ?? false;
  // With show-secrets off no secret is read at all: the command needs the *shape* of the credential,
  // not its value, so a stand-in is both sufficient and the safer thing to ask the keychain for.
  const auth = show
    ? await resolveAuthConfig(resolved.auth, (ref) => deps.getSecret?.(ref) ?? Promise.resolve(undefined))
    : placeholderAuth(resolved.auth);
  const command = restToCurl(
    { ...resolved.input, ...(auth !== undefined ? { auth } : {}) },
    { shell: request.shell, redactSecrets: !show },
  );
  const notes: string[] = [];
  if (resolved.unresolved.length > 0) {
    notes.push(
      `Unresolved propert${resolved.unresolved.length === 1 ? 'y' : 'ies'}: ${resolved.unresolved
        .map((reference) => reference.expr)
        .join(', ')}.`,
    );
  }
  if (resolved.auth.type === 'oauth2') {
    // The access token lives in main's memory for the session and is never written into a command:
    // one pasted with a live token would keep working long after the user forgot they shared it.
    notes.push('The OAuth2 access token is not included; the command carries the configuration only.');
  }
  return { command, ...(notes.length > 0 ? { notes } : {}) };
}

async function curl(
  service: EngineService,
  deps: RequestChannelDeps,
  request: RequestCurlRequest,
): Promise<RequestCurlResponse> {
  // Dispatch on what the id names rather than on a flag the renderer sends: the Code panel asks about
  // whatever request is in front of the user, and only the model knows which protocol that is.
  const rest = deps.project.restSend?.(request.requestId, request.draft);
  if (rest !== undefined) {
    return await restCurl(deps, request, rest);
  }
  const grpc = deps.project.grpcSend?.(request.requestId, request.grpcDraft);
  if (grpc !== undefined) {
    return await grpcCommand(deps, request, grpc);
  }
  const ws = deps.project.wsSend?.(request.requestId, request.wsDraft);
  if (ws !== undefined) {
    return await wsCommand(deps, request, ws);
  }
  const live = deps.project.buildLiveSendInput(request.requestId);
  if (live === undefined) {
    throw unknownRequest(request.requestId);
  }
  const auth = deps.project.authFor(request.requestId);
  const effective = await service.effectiveSendInput(live, {
    scopes: deps.project.scopesFor(request.requestId),
    ...(auth !== undefined ? { auth } : {}),
  });
  const show = deps.showSecrets?.get() ?? false;
  const headers = redactHeaders(effective.headers ?? {}, { show });
  const envelopeXml = redactXml(effective.envelopeXml, { show });
  const command = soapToCurl(
    {
      endpoint: effective.endpoint,
      envelopeXml,
      soapVersion: effective.soapVersion,
      ...(effective.soapAction !== undefined ? { soapAction: effective.soapAction } : {}),
      headers,
      ...(effective.skipSoapAction !== undefined ? { skipSoapAction: effective.skipSoapAction } : {}),
    },
    { shell: request.shell },
  );
  // `soapToCurl` builds a single-part request and gains no multipart support here, so a request
  // with attachments would otherwise be silently exported as one without them. Saying so in a
  // leading comment keeps the command paste-able while making the difference impossible to miss.
  const count = deps.project.sendAttachmentsFor?.(request.requestId)?.attachments.length ?? 0;
  // WS-Security is deliberately never applied to this preview (it needs secrets and a keystore
  // `effectiveSendInput` never touches); a request that selects one would otherwise look, from
  // the command alone, like it sends unsecured when it does not.
  const notes: string[] = [];
  const comments: string[] = [];
  if (deps.project.hasOutgoingWss?.(request.requestId) === true) {
    notes.push('WS-Security is not included in the cURL command.');
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
    default:
      return { kind: 'none' };
  }
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

  const created = await project.projectMutate(owner, {
    kind: 'add-rest-request',
    apiId: target.apiId,
    ...(target.folderId !== undefined ? { parentId: target.folderId } : {}),
    ...(request.name !== undefined ? { name: request.name } : {}),
  });
  const requestId = created.createdId;
  if (requestId === undefined) {
    throw new ProjectError('add-request-failed', 'The new REST request was not created');
  }

  const { method, url, pathParams, query, headers, body, settings } = parsed.request;
  // A password in the command goes straight to the keychain; the model only ever holds its ref.
  const password = parsed.basic?.password;
  const passwordRef =
    request.passwordRef ??
    (parsed.basic !== undefined && password !== undefined && password !== '' && deps.storeSecret !== undefined
      ? await deps.storeSecret(password, `cURL import: ${parsed.basic.username}`)
      : undefined);
  const auth =
    parsed.basic === undefined
      ? undefined
      : {
          type: 'basic' as const,
          username: parsed.basic.username,
          ...(passwordRef !== undefined ? { passwordRef } : {}),
          preemptive: true,
        };
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
      ...(settings !== undefined ? { settings } : {}),
      ...(auth !== undefined ? { auth } : {}),
    },
  });

  return {
    requestId,
    problems: [...parsed.problems],
    ...(parsed.basic !== undefined ? { basicUsername: parsed.basic.username } : {}),
    ...(passwordRef !== undefined ? { passwordStored: true } : {}),
  };
}

/**
 * Sends one REST request.
 *
 * Everything the renderer did not send is resolved here: the API's base URL under the active
 * environment, the properties, the credentials its folder chain lands on, its TLS identity. A send
 * whose URL is still incomplete — an unfilled `{param}`, an unresolved property — is refused before
 * it reaches the wire, with the problems that explain why.
 */
/**
 * Exported for `log.resend`, which replays a saved REST request through this same path.
 *
 * `onLive` is passed by the editor's send alone: it is what turns an event-stream response into a
 * live one the renderer shows and can Stop. A resend has no pane registered for its send id, so it
 * omits it and the response is read to its end like any other body.
 */
export async function sendRestRequest(
  service: EngineService,
  deps: RequestChannelDeps,
  request: RequestSendRestRequest,
  onLive?: (event: RestLiveEvent) => void,
  envId?: string,
): Promise<RestExchangeSummary> {
  const resolved = deps.project.restSend?.(request.requestId, request.draft, envId);
  if (resolved === undefined) {
    throw new ProjectError('unknown-entity', `No REST request with id "${request.requestId}"`, {
      details: { requestId: request.requestId },
    });
  }
  if (resolved.unresolved.length > 0) {
    throw new WirebenchError('rest-unresolved-properties', 'Some property references could not be resolved', {
      details: { unresolved: resolved.unresolved.map((ref) => ref.expr) },
    });
  }

  // The one query parameter an API key may be configured to travel in, so the URL is masked
  // wherever it is logged even when the key is called something this build has never heard of.
  const keyParams = resolved.auth.type === 'api-key' && resolved.auth.in === 'query' ? [resolved.auth.name] : undefined;
  const prepareStartedAt = Date.now(); // log-only: a prepare row's duration, never History's
  let input: typeof resolved.input;
  let accessToken: string | undefined;
  try {
    const tls = await deps.project.restTlsFor?.(request.requestId);
    const anchors = extraTrustAnchors();
    const baseCa = tls?.ca ?? resolved.input.tls?.ca ?? [];
    const mergedTls = withoutUndefined<TlsOptions>({
      ...resolved.input.tls,
      ...tls,
      ...(anchors.length > 0 ? { ca: [...baseCa, ...anchors] } : {}),
    });
    const owner = deps.project.projectId(request.requestId);
    const proxyTarget = resolved.input.baseUrl === '' ? resolved.input.request.url : resolved.input.baseUrl;
    const wireProxy = owner === undefined ? undefined : await deps.project.proxyFor?.(owner, proxyTarget);
    const proxy = wireProxy === undefined ? undefined : withoutUndefined<ProxyOptions>(wireProxy);
    input = { ...resolved.input, tls: mergedTls, ...(proxy !== undefined ? { proxy } : {}) };

    // The token is obtained here rather than inside the engine service: it needs a browser, a
    // loopback listener and a cache, none of which the engine may own. A grant that would have to
    // open a window refuses instead, and the user presses *Get new token*.
    accessToken =
      resolved.auth.type === 'oauth2' && deps.oauth2 !== undefined
        ? await deps.oauth2.accessToken(resolved.auth, {
            credentials: await oauth2Credentials(deps, resolved.auth),
            ...(mergedTls !== undefined ? { tls: mergedTls } : {}),
            ...(proxy !== undefined ? { proxy } : {}),
          })
        : undefined;
  } catch (error) {
    // Before the request was built: a bad URL, a proxy lookup, an OAuth2 token fetch. The row says
    // it never went on the wire; History is not written (nothing was sent).
    reportSendFailed(deps.onSendFailed, () =>
      failedExchangeOf({
        sendId: request.sendId,
        protocol: 'rest',
        requestId: request.requestId,
        url: joinedOrConcat(resolved.input.baseUrl, resolved.input.request.url),
        method: resolved.input.request.method,
        headers: {},
        startedAt: prepareStartedAt,
        durationMs: Date.now() - prepareStartedAt,
        error,
        stage: 'prepare',
        keyParams,
      }),
    );
    throw error;
  }

  // Asked before the send, so the definition cache is read while the request is on the wire.
  const contract = deps.project.restContractFor?.(request.requestId, {
    method: resolved.input.request.method,
    url: resolved.input.request.url,
  });
  // Handled here too: a cache that fails to read while the send itself fails is never awaited.
  contract?.catch(() => undefined);
  const startedAt = Date.now();
  try {
    const summary = await service.sendRestRequest(
      { sendId: request.sendId, requestId: request.requestId, input },
      {
        showSecrets: deps.showSecrets?.get() ?? false,
        auth: resolved.auth,
        ...(accessToken !== undefined ? { accessToken } : {}),
        ...(keyParams !== undefined ? { keyParams } : {}),
        ...(onLive !== undefined ? { onLive } : {}),
        ...(contract !== undefined ? { contract } : {}),
      },
    );
    deps.project.rememberRestCookies?.(
      request.requestId,
      summary.cookies.map((cookie) => withoutUndefined<Cookie>(cookie)),
    );
    await recordRest(deps, request.requestId, resolved, summary, Date.now() - startedAt);
    return summary;
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    await recordRest(deps, request.requestId, resolved, undefined, durationMs, error);
    // The failure row for the console's HTTP Log. When the transport got as far as building the
    // request, the error carries it (final URL with path params and query, auth applied) and the
    // row shows that; otherwise the base joined with the path and the enabled header rows. Either
    // way it is redacted for good; `keyParams` masks the query parameter an API key travels in.
    reportSendFailed(deps.onSendFailed, () =>
      failedExchangeOf({
        sendId: request.sendId,
        protocol: 'rest',
        requestId: request.requestId,
        url: joinBase(resolved.input.baseUrl, resolved.input.request.url),
        method: resolved.input.request.method,
        headers: Object.fromEntries(
          resolved.input.request.headers
            .filter((header) => header.enabled)
            .map((header) => [header.name, header.value]),
        ),
        startedAt,
        durationMs,
        error,
        captured: failedRequestOf(error),
        keyParams,
      }),
    );
    throw error;
  }
}

/** The base joined with the path, or the two texts side by side when the base does not parse. */
function joinedOrConcat(baseUrl: string, path: string): string {
  try {
    return joinBase(baseUrl, path);
  } catch {
    return `${baseUrl}${path}`;
  }
}

/** Appends one REST send's history entry, successful or not. A no-op without a history service. */
async function recordRest(
  deps: RequestChannelDeps,
  requestId: string,
  resolved: RestSendResolution,
  summary: RestExchangeSummary | undefined,
  durationMs: number,
  error?: unknown,
): Promise<void> {
  const projectId = deps.project.projectId(requestId);
  if (deps.history === undefined || projectId === undefined) {
    return;
  }
  const meta = deps.project.restMeta?.(requestId);
  const body = resolved.input.request.body;
  const entry = await deps.history.recordRestSend(projectId, {
    requestId,
    requestName: meta?.requestName ?? resolved.request.name,
    apiName: meta?.apiName ?? resolved.api.name,
    folderPath: meta?.folderPath ?? '',
    method: resolved.input.request.method,
    url: summary?.url ?? resolved.input.baseUrl,
    requestHeaders: Object.fromEntries(
      resolved.input.request.headers.filter((header) => header.enabled).map((header) => [header.name, header.value]),
    ),
    requestBody: body.kind === 'raw' ? body.text : '',
    ...(summary !== undefined ? { exchange: summary } : {}),
    ...(error !== undefined ? { error: restErrorDetail(error) } : {}),
    durationMs,
  });
  if (entry !== undefined) {
    deps.onHistoryAppended?.(entry);
  }
}

/** The client secret and remembered refresh token an OAuth2 token request needs, if any. */
async function oauth2Credentials(
  deps: RequestChannelDeps,
  config: OAuth2Auth,
): Promise<{ readonly clientSecret?: string; readonly refreshToken?: string }> {
  const read = async (ref: string | undefined): Promise<string | undefined> =>
    ref === undefined || ref === '' ? undefined : await deps.getSecret?.(ref);
  const clientSecret = await read(config.clientSecretRef);
  const refreshToken = await read(config.refreshTokenRef);
  return {
    ...(clientSecret !== undefined ? { clientSecret } : {}),
    ...(refreshToken !== undefined ? { refreshToken } : {}),
  };
}

/**
 * Drops the keys whose value came over as `undefined`.
 *
 * The wire's TLS shape has optional fields that may be present-and-undefined; the engine's has
 * fields that must be absent instead (`exactOptionalPropertyTypes`), and merging the two is exactly
 * where the difference bites.
 */
function withoutUndefined<T extends object>(value: { readonly [K in keyof T]: T[K] | undefined }): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

/**
 * The dry run of a REST send: where it would go, what would not expand, and which credentials it
 * would use. Nothing is sent, and no secret is touched — which is what lets the editor show the
 * badge while the user types.
 */
function preflightRest(
  deps: RequestChannelDeps,
  request: { readonly requestId: string; readonly draft?: RestRequestPatchWire | undefined },
): PreflightResult {
  const resolved = deps.project.restSend?.(request.requestId, request.draft);
  if (resolved === undefined) {
    return { endpointSource: 'none', unresolved: [], auth: { type: 'none', source: 'none' }, wsa: { enabled: false } };
  }
  const composed = composeUrl(
    resolved.input.baseUrl,
    resolved.input.request.url,
    resolved.input.request.pathParams,
    resolved.input.request.query,
    { encode: resolved.input.settings.encodeUrl ?? true },
  );
  // A `{param}` with no value is reported in the same list as an unresolved property: both are
  // "this request is not finished", and the console shows them together.
  const missing: UnresolvedRefWire[] = composed.problems
    .filter((problem) => problem.code === 'missing-path-param')
    .map((problem) => ({
      expr: `{${problem.name}}`,
      code: 'missing' as const,
      start: 0,
      end: 0,
      scope: 'path',
      name: problem.name,
    }));
  return {
    endpoint: composed.url,
    // The base URL's source uses the same vocabulary an interface endpoint's does, so the badge in
    // the editor reads identically for either protocol.
    endpointSource: resolved.baseUrlSource === 'api' ? 'interface-default' : resolved.baseUrlSource,
    unresolved: [...resolved.unresolved.map(toUnresolvedRefWire), ...missing],
    auth: { type: resolved.auth.type === 'inherit' ? 'none' : resolved.auth.type, source: 'request' },
    wsa: { enabled: false },
  };
}

/**
 * The command-line form of a gRPC call: what a command-line gRPC client would be told to make the
 * same call, credentials resolved and then masked unless the session shows secrets, the `.proto`
 * files named from the API's cached roots.
 */
async function grpcCommand(
  deps: RequestChannelDeps,
  request: RequestCurlRequest,
  resolved: GrpcSendResolution,
): Promise<RequestCurlResponse> {
  const show = deps.showSecrets?.get() ?? false;
  const auth = await resolveAuthConfig(resolved.auth, (ref) => deps.getSecret?.(ref) ?? Promise.resolve(undefined));
  // A definition discovered by reflection has no .proto files on disk to name, and grpcurl asks the
  // server itself when it is given none — so the flags are dropped rather than pointing at nothing.
  const fromFiles = resolved.api.definition !== undefined && resolved.api.definition.kind === 'proto';
  const command = grpcToCommand({ ...resolved.input, ...(auth !== undefined ? { auth } : {}) }, resolved.messageText, {
    redactSecrets: !show,
    shell: request.shell,
    ...(fromFiles ? { protoFiles: [...(resolved.api.definition?.roots ?? [])] } : {}),
  });
  const notes = [
    fromFiles
      ? 'The .proto files are named by import path; pass their folder with -import-path.'
      : 'No .proto files are named: this API was discovered by server reflection, which grpcurl uses by default.',
    ...(resolved.unresolved.length > 0 ? ['Some ${…} references did not resolve; they are shown as typed.'] : []),
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
  resolved: WsSendResolution,
): Promise<RequestCurlResponse> {
  const show = deps.showSecrets?.get() ?? false;
  const auth = show
    ? await resolveAuthConfig(resolved.auth, (ref) => deps.getSecret?.(ref) ?? Promise.resolve(undefined))
    : placeholderAuth(resolved.auth);
  const material: WsSessionMaterial = { ...(auth !== undefined ? { auth } : {}) };
  const options = toWsSessionOptions(resolved.input, material);
  const command = wsToCommand(options, { shell: request.shell });
  const notes = [
    'Proxy, CA and client certificate settings are not reconstructable in this command.',
    ...(resolved.unresolved.length > 0 ? ['Some ${…} references did not resolve; they are shown as typed.'] : []),
  ];
  return { command, notes };
}

/**
 * Makes one gRPC call.
 *
 * Everything the renderer did not send is resolved here: the API's target under the active
 * environment, the properties, the credentials the folder chain lands on, the TLS identity, and the
 * `.proto` set the message is encoded against. A call with an unresolved property is refused before
 * it reaches the wire.
 */
/** Exported for `log.resend`, which replays a saved unary gRPC request through this same path. */
export async function sendGrpcRequest(
  service: EngineService,
  deps: RequestChannelDeps,
  request: RequestSendGrpcRequest,
  sender: WebContents,
): Promise<GrpcExchangeSummary> {
  const resolved = deps.project.grpcSend?.(request.requestId, request.draft);
  if (resolved === undefined) {
    throw new ProjectError('unknown-entity', `No gRPC request with id "${request.requestId}"`, {
      details: { requestId: request.requestId },
    });
  }
  if (resolved.unresolved.length > 0) {
    throw new WirebenchError('grpc-unresolved-properties', 'Some property references could not be resolved', {
      details: { unresolved: resolved.unresolved.map((ref) => ref.expr) },
    });
  }
  if (resolved.request.service === '' || resolved.request.method === '') {
    throw new WirebenchError('grpc-method-unset', 'Choose the service and method this request calls first.', {
      details: { requestId: request.requestId },
    });
  }
  if (deps.project.grpcProtoSetFor === undefined) {
    throw new ProjectError('unknown-entity', `No gRPC API owns "${request.requestId}"`, {
      details: { requestId: request.requestId },
    });
  }
  const prepareStartedAt = Date.now(); // log-only: a prepare row's duration, never History's
  let set: Awaited<ReturnType<typeof deps.project.grpcProtoSetFor>>;
  let tlsOptions: TlsOptions;
  let accessToken: string | undefined;
  try {
    set = await deps.project.grpcProtoSetFor(request.requestId);

    const tls = await deps.project.grpcTlsFor?.(request.requestId);
    const anchors = extraTrustAnchors();
    const baseCa = tls?.ca ?? resolved.input.tlsOptions?.ca ?? [];
    tlsOptions = withoutUndefined<TlsOptions>({
      ...resolved.input.tlsOptions,
      ...tls,
      ...(anchors.length > 0 ? { ca: [...baseCa, ...anchors] } : {}),
    });
    accessToken =
      resolved.auth.type === 'oauth2' && deps.oauth2 !== undefined
        ? await deps.oauth2.accessToken(resolved.auth, {
            credentials: await oauth2Credentials(deps, resolved.auth),
            tls: tlsOptions,
          })
        : undefined;
  } catch (error) {
    // Before the call was built: the .proto set, the TLS identity, an OAuth2 token fetch.
    reportSendFailed(deps.onSendFailed, () =>
      failedExchangeOf({
        sendId: request.sendId,
        protocol: 'grpc',
        requestId: request.requestId,
        url: `${resolved.input.tls ? 'https' : 'http'}://${resolved.input.target}${grpcMethodPath(
          resolved.input.service,
          resolved.input.method,
        )}`,
        method: 'POST',
        headers: {},
        startedAt: prepareStartedAt,
        durationMs: Date.now() - prepareStartedAt,
        error,
        stage: 'prepare',
      }),
    );
    throw error;
  }

  const startedAt = Date.now();
  try {
    const summary = await service.sendGrpcRequest(
      {
        sendId: request.sendId,
        requestId: request.requestId,
        set,
        input: { ...resolved.input, tlsOptions },
        messageText: resolved.messageText,
      },
      {
        showSecrets: deps.showSecrets?.get() ?? false,
        auth: resolved.auth,
        ...(accessToken !== undefined ? { accessToken } : {}),
        ...(request.interactive === true ? { interactive: true } : {}),
        // The stream as it happens, alongside the invoke that is still open and will resolve with
        // the whole exchange. A window that has gone away swallows its own events.
        onLive: (event) => {
          emitEvent(sender, events.grpc.live, event);
        },
      },
    );
    await recordGrpc(deps, request.requestId, resolved, summary, Date.now() - startedAt);
    return summary;
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    await recordGrpc(deps, request.requestId, resolved, undefined, durationMs, error);
    // The failure row for the console's HTTP Log. A gRPC call is an HTTP/2 POST to
    // `/<service>/<method>`; when the transport built the request the error carries it and the row
    // shows that instead. Redacted for good, like every other failure row.
    reportSendFailed(deps.onSendFailed, () =>
      failedExchangeOf({
        sendId: request.sendId,
        protocol: 'grpc',
        requestId: request.requestId,
        url: `${resolved.input.tls ? 'https' : 'http'}://${resolved.input.target}${grpcMethodPath(
          resolved.input.service,
          resolved.input.method,
        )}`,
        method: 'POST',
        headers: Object.fromEntries(
          resolved.input.metadata.filter((row) => row.enabled).map((row) => [row.name, row.value]),
        ),
        startedAt,
        durationMs,
        error,
        captured: failedRequestOf(error),
      }),
    );
    throw error;
  }
}

/** Appends one gRPC send's history entry, successful or not. A no-op without a history service. */
async function recordGrpc(
  deps: RequestChannelDeps,
  requestId: string,
  resolved: GrpcSendResolution,
  summary: GrpcExchangeSummary | undefined,
  durationMs: number,
  error?: unknown,
): Promise<void> {
  const projectId = deps.project.projectId(requestId);
  if (deps.history === undefined || projectId === undefined) {
    return;
  }
  const meta = deps.project.grpcMeta?.(requestId);
  const entry = await deps.history.recordGrpcSend(projectId, {
    requestId,
    requestName: meta?.requestName ?? resolved.request.name,
    apiName: meta?.apiName ?? resolved.api.name,
    folderPath: meta?.folderPath ?? '',
    target: summary?.target ?? resolved.input.target,
    service: resolved.request.service,
    method: resolved.request.method,
    methodKind: resolved.request.methodKind,
    requestMetadata: Object.fromEntries(
      resolved.input.metadata.filter((row) => row.enabled).map((row) => [row.name, row.value]),
    ),
    requestMessage: resolved.messageText,
    ...(summary !== undefined ? { exchange: summary } : {}),
    ...(error !== undefined ? { error: restErrorDetail(error) } : {}),
    durationMs,
  });
  if (entry !== undefined) {
    deps.onHistoryAppended?.(entry);
  }
}

/**
 * The HTTP Log's row for a successful WebSocket handshake, written the moment it settles — not
 * when the session closes, since `request.openWs` stays pending for the whole session. Reported
 * through `deps.onExchange`, the live twin `onSendFailed` is for a send whose own invoke never
 * leaves main until long after the row should appear.
 *
 * Only ever called with a `status === 101` handshake: the engine's `onHandshake` hook (which this
 * is driven by, through `ws.live`'s `handshake` event) fires only for a handshake that actually
 * completed — a refused or failed one reaches `openWsRequest` solely through the settled
 * `summary` (see `reportWsHandshakeFailure`, called there instead).
 */
function reportWsHandshake(
  deps: RequestChannelDeps,
  sendId: string,
  requestId: string,
  handshake: WsHandshakeWire,
): void {
  if (deps.onExchange === undefined) {
    return;
  }
  const entry: LogEntryWire = {
    kind: 'exchange',
    requestId,
    exchange: {
      sendId,
      protocol: 'websocket',
      method: 'GET',
      // `http(s)://` so the row filters/searches like every other; `wsUrl` keeps `ws(s)://` for display.
      url: handshake.url.replace(/^ws/, 'http'),
      wsUrl: handshake.url,
      requestHeaders: handshake.requestHeaders,
      ...(handshake.rawRequestHead !== undefined ? { rawRequestHead: handshake.rawRequestHead } : {}),
      status: 101,
      responseHeaders: handshake.responseHeaders ?? {},
      startedAt: handshake.startedAt,
      durationMs: handshake.durationMs,
      ...(handshake.tls !== undefined ? { tls: handshake.tls } : {}),
    },
  };
  try {
    deps.onExchange(entry);
  } catch {
    // Deliberately ignored — a broadcast that fails must never affect the session, like `onSendFailed`'s own catch.
  }
}

/**
 * The HTTP Log's row for a handshake that never opened: a refusal (e.g. 401) or a transport
 * failure before any response. Checked against the *settled* `summary` rather than a live event —
 * `openWsSession`'s `done` never rejects for this, and the engine's `onHandshake` hook never fires
 * for it either (only a handshake that actually opened reaches it) — so this is the one place such
 * a failure can be seen and reported, exactly like a prepare/send-stage failure. `recordWs` still
 * writes History for it afterwards (`closedBy: 'error'`).
 *
 * Guarded by `handshakeLogged` — set only by that same live event — rather than by
 * `summary.handshake.status !== 101`: `status` is *optional* on the engine's handshake (e.g. absent
 * through a proxy tunnel, which never populates it even for a session that opened fine), so testing
 * it here could report a failure row for a session that already got a success row. The two rows
 * must stay provably exclusive.
 */
function reportWsHandshakeFailure(
  deps: RequestChannelDeps,
  sendId: string,
  requestId: string,
  summary: WsExchangeSummary,
  keyParams: readonly string[] | undefined,
  handshakeLogged: boolean,
): void {
  if (handshakeLogged) {
    return;
  }
  const { handshake } = summary;
  reportSendFailed(deps.onSendFailed, () =>
    failedExchangeOf({
      sendId,
      protocol: 'websocket',
      requestId,
      url: handshake.url,
      method: 'GET',
      headers: handshake.requestHeaders,
      startedAt: new Date(handshake.startedAt).getTime(),
      durationMs: handshake.durationMs,
      error:
        handshake.error !== undefined
          ? new WirebenchError('ws-handshake-failed', handshake.error)
          : new WirebenchError('ws-handshake-refused', 'The server refused the WebSocket handshake.'),
      keyParams,
    }),
  );
}

/**
 * Appends one WebSocket session's history entry, on close — successful or not. A no-op without a
 * history service. `handshakeOpened` is the same fact `reportWsHandshakeFailure` is guarded by
 * (the live `handshake` event actually fired), so History's `ok` follows it rather than
 * re-deriving from `summary.handshake.status`, which is optional and so cannot distinguish a
 * refusal from a session that opened but happens to carry no status (e.g. through a proxy tunnel).
 */
async function recordWs(
  deps: RequestChannelDeps,
  requestId: string,
  resolved: WsSendResolution,
  summary: WsExchangeSummary,
  keyParams: readonly string[] | undefined,
  handshakeOpened: boolean,
): Promise<void> {
  const projectId = deps.project.projectId(requestId);
  if (deps.history === undefined || projectId === undefined) {
    return;
  }
  const meta = deps.project.wsMeta?.(requestId);
  const entry = await deps.history.recordWsSession(projectId, {
    requestId,
    requestName: meta?.requestName ?? resolved.request.name,
    apiName: meta?.apiName ?? resolved.api.name,
    folderPath: meta?.folderPath ?? '',
    exchange: summary,
    handshakeOpened,
    ...(keyParams !== undefined ? { keyParams } : {}),
  });
  if (entry !== undefined) {
    deps.onHistoryAppended?.(entry);
  }
}

/**
 * The dry run of a gRPC call: the target it would go to and what would not expand. Nothing is sent
 * and no secret is touched, so the editor can show the badge while the user types.
 */
function preflightGrpc(
  deps: RequestChannelDeps,
  request: { readonly requestId: string; readonly draft?: GrpcRequestPatchWire | undefined },
): PreflightResult {
  const resolved = deps.project.grpcSend?.(request.requestId, request.draft);
  if (resolved === undefined) {
    return { endpointSource: 'none', unresolved: [], auth: { type: 'none', source: 'none' }, wsa: { enabled: false } };
  }
  return {
    endpoint: resolved.input.target,
    endpointSource: resolved.targetSource === 'api' ? 'interface-default' : resolved.targetSource,
    unresolved: resolved.unresolved.map(toUnresolvedRefWire),
    auth: { type: resolved.auth.type === 'inherit' ? 'none' : resolved.auth.type, source: 'request' },
    wsa: { enabled: false },
  };
}

/** The URL a WebSocket call's input resolves to, for display in a failure row — never sent anywhere. */
function wsDisplayUrl(input: {
  readonly serverUrl: string;
  readonly request: {
    readonly url: string;
    readonly query: readonly { readonly name: string; readonly value: string; readonly enabled: boolean }[];
  };
}): string {
  try {
    return resolveWsUrl(input.serverUrl, input.request.url, input.request.query);
  } catch {
    return `${input.serverUrl}${input.request.url}`;
  }
}

/**
 * The `openWsRequest` calls still running: one per open session, each settling only once its
 * History entry has been written.
 *
 * A session's History entry is written by whoever awaits `openWsSession`, which is the pending
 * `request.openWs` invoke — so closing a session is not the same as having recorded it. The two
 * moments that close sessions on the app's behalf (quitting, and closing a project) must wait for
 * the recording, or the entry is written into a history file that has already been closed, or not
 * at all because the process exited first. {@link whenWsSessionsRecorded} is that wait.
 */
const openWsCalls = new Map<Promise<unknown>, string>();

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
const openRestCalls = new Map<Promise<unknown>, string>();

/**
 * Resolves once every editor REST send in flight whose request `matches` has recorded its History
 * entry, or after `timeoutMs`. Paired with `EngineService.abortRestStreamsWhere` wherever
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

/** Registers one `request.openWs` call in {@link openWsCalls} for the life of its session. */
function trackOpenWs(requestId: string, call: Promise<WsExchangeSummary>): Promise<WsExchangeSummary> {
  // A rejection is a fact about that one session, not about the wait: `whenWsSessionsRecorded`
  // only cares that the call has *finished*, and the caller still gets the original promise.
  const settled = call.then(
    () => undefined,
    () => undefined,
  );
  openWsCalls.set(settled, requestId);
  void settled.finally(() => openWsCalls.delete(settled));
  return call;
}

/**
 * Opens one WebSocket session.
 *
 * Everything the renderer did not send is resolved here: the API's target under the active
 * environment, the properties, the credentials the folder chain lands on, the TLS identity and the
 * proxy (looked up against the resolved URL with `ws:`/`wss:` mapped to `http:`/`https:`, exactly as
 * REST looks its proxy up). A call with an unresolved property is refused before it reaches the wire.
 * The invoke stays pending for the life of the session — `service.openWsSession`'s `done` only
 * settles once the socket has closed — while `events.ws.live` reports the handshake and each frame
 * as they happen.
 */
export async function openWsRequest(
  service: EngineService,
  deps: RequestChannelDeps,
  request: RequestOpenWsRequest,
  sender: WebContents,
): Promise<WsExchangeSummary> {
  const resolved = deps.project.wsSend?.(request.requestId, request.draft);
  if (resolved === undefined) {
    throw new ProjectError('unknown-entity', `No WebSocket request with id "${request.requestId}"`, {
      details: { requestId: request.requestId },
    });
  }
  if (resolved.unresolved.length > 0) {
    throw new WirebenchError('ws-unresolved-properties', 'Some property references could not be resolved', {
      details: { unresolved: resolved.unresolved.map((ref) => ref.expr) },
    });
  }

  // The one query parameter an API key may be configured to travel in, so the URL is masked
  // wherever it is logged even when the key is called something this build has never heard of —
  // the same rule REST's `sendRestRequest` applies to its own `keyParams`.
  const keyParams = resolved.auth.type === 'api-key' && resolved.auth.in === 'query' ? [resolved.auth.name] : undefined;
  const prepareStartedAt = Date.now(); // log-only: a prepare row's duration, never History's
  let options: Omit<WsSessionOptions, 'signal'>;
  try {
    const tls = await deps.project.wsTlsFor?.(request.requestId);
    const anchors = extraTrustAnchors();
    const baseCa = tls?.ca ?? [];
    const mergedTls = withoutUndefined<TlsOptions>({
      ...tls,
      ...(anchors.length > 0 ? { ca: [...baseCa, ...anchors] } : {}),
    });
    const owner = deps.project.projectId(request.requestId);
    const resolvedUrl = wsDisplayUrl(resolved.input);
    const proxyTarget = resolvedUrl.replace(/^ws/, 'http');
    const wireProxy = owner === undefined ? undefined : await deps.project.proxyFor?.(owner, proxyTarget);
    const proxy = wireProxy === undefined ? undefined : withoutUndefined<ProxyOptions>(wireProxy);
    const accessToken =
      resolved.auth.type === 'oauth2' && deps.oauth2 !== undefined
        ? await deps.oauth2.accessToken(resolved.auth, {
            credentials: await oauth2Credentials(deps, resolved.auth),
            ...(mergedTls !== undefined ? { tls: mergedTls } : {}),
            ...(proxy !== undefined ? { proxy } : {}),
          })
        : undefined;
    const auth = await resolveAuthConfig(
      resolved.auth,
      (ref) => deps.getSecret?.(ref) ?? Promise.resolve(undefined),
      accessToken !== undefined ? { accessToken } : {},
    );
    const material: WsSessionMaterial = {
      ...(auth !== undefined ? { auth } : {}),
      ...(mergedTls !== undefined ? { tls: mergedTls } : {}),
      ...(proxy !== undefined ? { proxy } : {}),
    };
    options = toWsSessionOptions(resolved.input, material);
  } catch (error) {
    // Before the session was opened: the TLS identity, a proxy lookup, an OAuth2 token fetch.
    reportSendFailed(deps.onSendFailed, () =>
      failedExchangeOf({
        sendId: request.sendId,
        protocol: 'websocket',
        requestId: request.requestId,
        url: wsDisplayUrl(resolved.input),
        method: 'GET',
        headers: {},
        startedAt: prepareStartedAt,
        durationMs: Date.now() - prepareStartedAt,
        error,
        stage: 'prepare',
        keyParams,
      }),
    );
    throw error;
  }

  const startedAt = Date.now();
  // Set by the live `handshake` event, which only ever fires for one that actually opened (see
  // `reportWsHandshake`'s doc) — the one fact that decides which of the two rows below is written,
  // rather than re-deriving it from `summary.handshake.status`, which is *optional* (e.g. absent
  // through a proxy tunnel) and so cannot itself tell a success from a refusal.
  let handshakeLogged = false;
  // Asked for, never awaited: the contract loads while the handshake runs, and a session never
  // waits on it (see `openWsSession`'s `contract`).
  const contract = deps.project.wsContractFor?.(request.requestId);
  try {
    const summary = await service.openWsSession(
      { sendId: request.sendId, requestId: request.requestId, options },
      {
        showSecrets: deps.showSecrets?.get() ?? false,
        ...(contract !== undefined ? { contract } : {}),
        ...(keyParams !== undefined ? { keyParams } : {}),
        onLive: (event) => {
          if (event.kind === 'handshake') {
            // Only ever a `status === 101` handshake — see `reportWsHandshake`'s own doc.
            handshakeLogged = true;
            reportWsHandshake(deps, request.sendId, request.requestId, event.handshake);
          }
          emitEvent(sender, events.ws.live, event);
        },
      },
    );
    reportWsHandshakeFailure(deps, request.sendId, request.requestId, summary, keyParams, handshakeLogged);
    await recordWs(deps, request.requestId, resolved, summary, keyParams, handshakeLogged);
    return summary;
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    reportSendFailed(deps.onSendFailed, () =>
      failedExchangeOf({
        sendId: request.sendId,
        protocol: 'websocket',
        requestId: request.requestId,
        url: options.url,
        method: 'GET',
        headers: options.headers ?? {},
        startedAt,
        durationMs,
        error,
        keyParams,
      }),
    );
    throw error;
  }
}

/** `true` when `text` is strictly valid base64 (including the empty string). */
function isValidBase64(text: string): boolean {
  return text.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(text);
}

/**
 * One more message on an open WebSocket session.
 *
 * `format: 'text'` with `expand: true` property-expands `content` against the same scopes the
 * request resolves with, using its own `escapeProperties` setting, and refuses with
 * `ws-unresolved-properties` — sending nothing — rather than writing a literal `${…}` to the wire.
 * `format: 'binary'` never expands; `content` must be valid base64 or the send is refused with
 * `ws-bad-binary` before anything reaches the session.
 */
function sendWsMessage(service: EngineService, deps: RequestChannelDeps, request: RequestWsSendRequest): WsFrameWire {
  if (request.format === 'binary') {
    if (!isValidBase64(request.content)) {
      throw new WirebenchError('ws-bad-binary', 'The message is not valid base64.', {
        details: { sendId: request.sendId },
      });
    }
    return service.sendWsMessage(request.sendId, { base64: request.content });
  }
  let text = request.content;
  if (request.expand) {
    const resolved = deps.project.wsSend?.(request.requestId);
    const scopes = deps.project.scopesFor(request.requestId);
    const escape = resolved?.request.settings.escapeProperties === true;
    const expanded = expandWsMessage(text, scopes, { escape });
    if (expanded.unresolved.length > 0) {
      throw new WirebenchError('ws-unresolved-properties', 'Some property references could not be resolved', {
        details: { unresolved: expanded.unresolved.map((ref) => ref.expr) },
      });
    }
    text = expanded.text;
  }
  return service.sendWsMessage(request.sendId, { text });
}

/** Closes an open WebSocket session. `{ closed: false }` when no such session is open. */
function closeWsRequest(service: EngineService, request: RequestWsCloseRequest): RequestWsCloseResponse {
  return service.closeWs(request.sendId, request.code, request.reason);
}

/**
 * The dry run of opening a WebSocket session: where it would go and what would not expand. Nothing
 * is dialled and no secret is touched, so the editor can show the badge while the user types.
 */
function preflightWs(
  deps: RequestChannelDeps,
  request: { readonly requestId: string; readonly draft?: WsRequestPatchWire | undefined },
): PreflightResult {
  const resolved = deps.project.wsSend?.(request.requestId, request.draft);
  if (resolved === undefined) {
    return { endpointSource: 'none', unresolved: [], auth: { type: 'none', source: 'none' }, wsa: { enabled: false } };
  }
  return {
    endpoint: wsDisplayUrl(resolved.input),
    endpointSource: resolved.urlSource === 'api' ? 'interface-default' : resolved.urlSource,
    unresolved: resolved.unresolved.map(toUnresolvedRefWire),
    auth: { type: resolved.auth.type === 'inherit' ? 'none' : resolved.auth.type, source: 'request' },
    wsa: { enabled: false },
  };
}

/** One failure, as a history line records it. */
function restErrorDetail(error: unknown): { code: string; message: string } {
  if (isWirebenchError(error)) {
    return { code: error.code, message: error.message };
  }
  return { code: 'internal-error', message: error instanceof Error ? error.message : String(error) };
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
  registerHandler(channels.request.generate, (request) => {
    const options = request.options ?? generateOptionsFrom(deps.preferences?.get());
    return Promise.resolve(service.generate({ ...request, ...(options !== undefined ? { options } : {}) }));
  });

  registerHandler(channels.request.send, async (request) => {
    const effective = await withRequestProperties(deps.project, request);
    const summary = await sendAndRecordHistory(service, deps, effective);
    return writeDumpFile(deps.project, request.requestId, summary, deps.dialogPicks);
  });

  registerHandler(channels.request.sendRest, (request, sender) => {
    // The stream as it happens, alongside the invoke that is still open and will resolve with the
    // whole exchange. A window that has gone away swallows its own events.
    const call = sendRestRequest(service, deps, request, (event) => {
      emitEvent(sender, events.rest.live, event);
    });
    const settled = call.then(
      () => undefined,
      () => undefined,
    );
    openRestCalls.set(settled, request.requestId);
    void settled.finally(() => openRestCalls.delete(settled));
    return call;
  });

  registerHandler(channels.request.preflightRest, (request) => Promise.resolve(preflightRest(deps, request)));

  registerHandler(channels.request.sendGrpc, (request, sender) => sendGrpcRequest(service, deps, request, sender));
  registerHandler(channels.request.grpcPush, (request) =>
    Promise.resolve(service.pushGrpcMessage(request.sendId, request.messageText)),
  );
  registerHandler(channels.request.grpcHalfClose, (request, sender) => {
    const closed = service.halfCloseGrpc(request.sendId);
    if (closed.closed) {
      emitEvent(sender, events.grpc.live, { kind: 'closed', sendId: request.sendId });
    }
    return Promise.resolve(closed);
  });

  registerHandler(channels.request.preflightGrpc, (request) => Promise.resolve(preflightGrpc(deps, request)));

  registerHandler(channels.request.openWs, (request, sender) =>
    trackOpenWs(request.requestId, openWsRequest(service, deps, request, sender)),
  );
  registerHandler(channels.request.wsSend, (request) => Promise.resolve(sendWsMessage(service, deps, request)));
  registerHandler(channels.request.wsClose, (request) => Promise.resolve(closeWsRequest(service, request)));
  registerHandler(channels.request.preflightWs, (request) => Promise.resolve(preflightWs(deps, request)));

  registerHandler(channels.request.sendToEnvironments, (request) => sendToEnvironments(service, deps, request));

  registerHandler(channels.request.cancel, (request) =>
    Promise.resolve(cancelEnvironmentBatch(service, request.sendId) ?? service.cancel(request.sendId)),
  );

  registerHandler(channels.request.preflight, (request) => Promise.resolve(deps.project.preflight(request.requestId)));

  registerHandler(channels.request.recreate, (request) => recreate(service, deps, request));

  registerHandler(channels.request.curl, (request) => curl(service, deps, request));

  registerHandler(channels.request.importCurl, (request) => importCurl(deps, request));
}
