import { dirname, isAbsolute, resolve as resolvePath } from 'node:path';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { fromCurl, prettyPrint, ProjectError, recreateRequest, toCurl } from '@wirebench/engine';
import { channels } from '../../shared/ipc.js';
import type { EngineService } from '../engine-service.js';
import { generateOptionsFrom } from '../generate-options.js';
import type { ProjectService } from '../project-service.js';
import type { HistoryService } from '../history-service.js';
import type { PreferencesService } from '../preferences.js';
import { isInsideReal, realpathOfPrefix } from '../path-containment.js';
import { redactHeaders, redactXml } from '../redact.js';
import { sendAndRecordHistory } from '../send-with-history.js';
import type {
  ExchangeSummary,
  HistoryEntryWire,
  RequestSendRequest,
  ResolvedSendRequest,
  RequestCurlRequest,
  RequestCurlResponse,
  RequestImportCurlRequest,
  RequestImportCurlResponse,
  RequestPatchWire,
  RequestRecreateRequest,
  RequestRecreateResponse,
} from '../../shared/wire-types.js';
import { registerHandler } from './register.js';

/** The `ProjectService` surface the `request.*` channels drive; a stub stands in for it in tests. */
export type RequestChannelProject = Pick<
  ProjectService,
  | 'scopesFor'
  | 'preflight'
  | 'authFor'
  | 'requestMeta'
  | 'projectId'
  | 'requestSource'
  | 'buildLiveSendInput'
  | 'sendInputFor'
  | 'dumpFileFor'
  | 'mutate'
> &
  // Optional for the same reason as on `HistorySendProject`: a stub (or an ad-hoc send) that
  // has no saved request behind it has no attachments to carry either.
  // Optional for the same reason: an ad-hoc send has no saved request, and so no keystore.
  // ... and, for the same reason, no WS-Security configuration.
  Partial<Pick<ProjectService, 'sendAttachmentsFor' | 'tlsFor' | 'wssFor' | 'hasOutgoingWss' | 'proxyFor'>>;

/** What `request.*` needs beyond the engine: the property scopes a send expands against. */
export interface RequestChannelDeps {
  /** Supplies the scopes; `ProjectService` in the app, a stub in tests. */
  readonly project: RequestChannelProject;
  /** The session "show secrets" flag; omitted defaults every send to redacted. */
  readonly showSecrets?: { get(): boolean };
  /** Records every completed/failed send to the open project's history. Omitted in tests that don't care. */
  readonly history?: HistoryService;
  /** Called with the entry a recorded send produced, so main can broadcast `history.appended`. */
  readonly onHistoryAppended?: (entry: HistoryEntryWire) => void;
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
 * `ProjectService.trustAnchors`), which is how a user configures a private CA and which a spec
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
async function withRequestProperties(
  project: RequestChannelProject,
  request: RequestSendRequest,
): Promise<ResolvedSendRequest> {
  if (request.requestId === undefined) {
    return withExtraTrustAnchors(request);
  }
  const mapped = project.sendInputFor(request.requestId, {
    endpoint: request.input.endpoint,
    envelopeXml: request.input.envelopeXml,
    ...(request.input.headers !== undefined ? { headers: { ...request.input.headers } } : {}),
  });
  // The client identity is resolved separately (and asynchronously): it means reading a file
  // and decrypting a secret, and it must never reach the renderer or the cURL export — which
  // is exactly why `sendInputFor` stays synchronous and material-free. A selected keystore
  // that will not load throws here, failing the send loudly rather than quietly going out
  // without the certificate the user asked for.
  const tls = await project.tlsFor?.(request.requestId);
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
 * session — SoapUI's dump file can point anywhere the *user* has explicitly picked, but a
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
 * SoapUI's "Dump File": writes the response body of a completed send to the path the request
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
    await writeFile(resolved.path, Buffer.from(summary.http.bodyBase64, 'base64'));
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
 * SoapUI's "Recreate Request": regenerate the operation's envelope, merge the saved one into
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
  await project.mutate({ kind: 'update-request', requestId: request.requestId, patch: { envelopeXml } });
  return { envelopeXml, kept: merged.kept, added: merged.added, removed: merged.removed };
}

/**
 * The `curl` command equivalent to sending this request today: the same live input
 * `request.send` builds, with the effective auth applied and properties expanded — but with
 * secret-bearing headers masked unless the session's show-secrets flag is on, since the
 * command is about to land on a clipboard.
 */
async function curl(
  service: EngineService,
  deps: RequestChannelDeps,
  request: RequestCurlRequest,
): Promise<RequestCurlResponse> {
  const live = deps.project.buildLiveSendInput(request.requestId);
  if (live === undefined) {
    throw unknownRequest(request.requestId);
  }
  const auth = deps.project.authFor(request.requestId);
  const effective = await service.effectiveSendInput(live, {
    scopes: deps.project.scopesFor(),
    ...(auth !== undefined ? { auth } : {}),
  });
  const show = deps.showSecrets?.get() ?? false;
  const headers = redactHeaders(effective.headers ?? {}, { show });
  const envelopeXml = redactXml(effective.envelopeXml, { show });
  const command = toCurl(
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
  // `toCurl` builds a single-part request and gains no multipart support here, so a request
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
    const proxy = await project.proxyFor?.(endpoint);
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
  project: RequestChannelProject,
  request: RequestImportCurlRequest,
): Promise<RequestImportCurlResponse> {
  const parsed = fromCurl(request.command);
  const created = await project.mutate({
    kind: 'add-request',
    interfaceId: request.interfaceId,
    bindingName: request.bindingName,
    operationName: request.operationName,
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
  await project.mutate({ kind: 'update-request', requestId, patch });
  return { requestId, problems: [...parsed.problems] };
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

  registerHandler(channels.request.cancel, (request) => Promise.resolve(service.cancel(request.sendId)));

  registerHandler(channels.request.preflight, (request) => Promise.resolve(deps.project.preflight(request.requestId)));

  registerHandler(channels.request.recreate, (request) => recreate(service, deps, request));

  registerHandler(channels.request.curl, (request) => curl(service, deps, request));

  registerHandler(channels.request.importCurl, (request) => importCurl(deps.project, request));
}
