import { fromCurl, ProjectError, recreateRequest, toCurl } from '@wirebench/engine';
import { channels } from '../../shared/ipc.js';
import type { EngineService } from '../engine-service.js';
import type { ProjectService } from '../project-service.js';
import type { HistoryService } from '../history-service.js';
import { redactHeaders } from '../redact.js';
import { sendAndRecordHistory } from '../send-with-history.js';
import type {
  HistoryEntryWire,
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
  | 'mutate'
>;

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
  project: RequestChannelProject,
  request: RequestRecreateRequest,
): Promise<RequestRecreateResponse> {
  const source = project.requestSource(request.requestId);
  if (source === undefined) {
    throw unknownRequest(request.requestId);
  }
  const generated = service.generate({
    interfaceId: source.interfaceId,
    bindingName: source.bindingName,
    operationName: source.operationName,
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
  await project.mutate({ kind: 'update-request', requestId: request.requestId, patch: { envelopeXml: merged.xml } });
  return { envelopeXml: merged.xml, kept: merged.kept, added: merged.added, removed: merged.removed };
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
  return {
    command: toCurl(
      {
        endpoint: effective.endpoint,
        envelopeXml: effective.envelopeXml,
        soapVersion: effective.soapVersion,
        ...(effective.soapAction !== undefined ? { soapAction: effective.soapAction } : {}),
        headers,
        ...(effective.skipSoapAction !== undefined ? { skipSoapAction: effective.skipSoapAction } : {}),
      },
      { shell: request.shell },
    ),
  };
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
  registerHandler(channels.request.generate, (request) => Promise.resolve(service.generate(request)));

  registerHandler(channels.request.send, (request) => sendAndRecordHistory(service, deps, request));

  registerHandler(channels.request.cancel, (request) => Promise.resolve(service.cancel(request.sendId)));

  registerHandler(channels.request.preflight, (request) => Promise.resolve(deps.project.preflight(request.requestId)));

  registerHandler(channels.request.recreate, (request) => recreate(service, deps.project, request));

  registerHandler(channels.request.curl, (request) => curl(service, deps, request));

  registerHandler(channels.request.importCurl, (request) => importCurl(deps.project, request));
}
