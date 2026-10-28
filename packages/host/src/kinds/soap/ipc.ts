/**
 * soap's IPC channels (spec §5.4), registered through its `registerChannels`.
 */
import { nodeFs, prettyPrint, recreateRequest, WirebenchError, writeFileAtomic } from '@wirebench/engine';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path';
import { channels } from '@wirebench/wire/ipc';
import type { HistoryEntryWire } from '@wirebench/wire/wire-types';
import type { ExchangeSummary, RequestRecreateRequest, RequestRecreateResponse } from '@wirebench/wire/kinds/soap/wire';
import type { HeaderEntryWire } from '@wirebench/wire/wire-base';
import type { EngineService } from '../../engine-service.js';
import { generateOptionsFrom } from '../../generate-options.js';
import { type HistoryService } from '../../history-service.js';
import { holdsUrlMarker, refuseRedacted, sendDepsOf, type HistoryChannelDeps } from '../../ipc/history.js';
import { registerHandler, type HandlerTable } from '../../ipc/register.js';
import {
  ownerOf,
  toSendDeps,
  unknownRequest,
  type DumpFilePicks,
  type RequestChannelDeps,
  type RequestChannelProject,
} from '../../ipc/request.js';
import { currentPathRoot, resolveInside } from '../../path-access.js';
import { isInsideReal, realpathOfPrefix } from '../../path-containment.js';
import { containsRedaction } from '../../redact.js';
import { AD_HOC_ID, soapOverrideOf } from '../../send/draft.js';
import { sendThroughEngine } from '../../send/exchange.js';
import { AD_HOC_NAME } from '../../send/record.js';
import type { KindChannelDeps } from '../kind-main.js';
import { registerAttachmentChannels } from './channels/attachments.js';
import { registerDefinitionChannels } from './channels/definition.js';
import { registerValidateChannels } from './channels/validate.js';
import { registerWsaChannels } from './channels/wsa.js';
import { registerWsiChannels } from './channels/wsi.js';
import { registerWssChannels } from './channels/wss.js';
import { registerXmlChannels } from './channels/xml.js';
import { registerXpathChannels } from './channels/xpath.js';

/**
 * Resolves a dump-file target against the project folder and refuses one that would land
 * outside it, unless the exact path was chosen through the Dump File "Browse…" picker this
 * session — a dump file may point anywhere the *user* has explicitly picked, but a
 * relative path (or an absolute one merely typed into the property) must stay inside the
 * project.
 */
export async function resolveDumpPath(
  target: { path: string; projectDir: string },
  picks: DumpFilePicks | undefined,
): Promise<{ path: string } | { problem: ExchangeSummary['problems'][number] }> {
  const resolved = isAbsolute(target.path) ? target.path : resolvePath(target.projectDir, target.path);
  // A host with a root writes nowhere outside it, whatever was picked.
  const root = currentPathRoot();
  if (root !== undefined) {
    try {
      await resolveInside(root, resolved);
    } catch {
      return {
        problem: {
          code: 'host-path-outside-workspace',
          message: `The dump file "${target.path}" resolves outside the workspace`,
        },
      };
    }
  }
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
/** Registers SOAP's `request.*` channels (spec §5.4). */
export function registerSoapRequestChannels(
  table: HandlerTable,
  service: EngineService,
  deps: RequestChannelDeps,
): void {
  const sendDeps = toSendDeps(service, deps);
  registerHandler(table, channels.request.generate, (request) => {
    const options = request.options ?? generateOptionsFrom(deps.preferences?.get());
    return Promise.resolve(service.generate({ ...request, ...(options !== undefined ? { options } : {}) }));
  });
  // The editor's envelope, endpoint and headers ride over the saved request as its override; a send
  // with no saved request behind it goes as the renderer built it, as a synthetic item.
  registerHandler(table, channels.request.send, async (request) => {
    const summary = await sendThroughEngine(sendDeps, request.sendId, request.requestId ?? AD_HOC_ID, {
      draft: { kind: 'soap', override: soapOverrideOf(request.input) },
      checkAssertions: true,
      ...(request.requestId === undefined ? { adHoc: { input: request.input, names: AD_HOC_NAME } } : {}),
    });
    return request.requestId === undefined
      ? summary
      : writeDumpFile(deps.project, request.requestId, summary, deps.dialogPicks);
  });
  registerHandler(table, channels.request.preflight, (request) =>
    Promise.resolve(deps.project.preflight(request.requestId)),
  );
  registerHandler(table, channels.request.recreate, (request) => recreate(service, deps, request));
}

/** Drops headers the history store redacted (`<redacted>`) before resending — never resent verbatim. */
function liveHeaders(headers: readonly HeaderEntryWire[]): Record<string, string> {
  return Object.fromEntries(headers.filter((header) => header.value !== '<redacted>').map((h) => [h.name, h.value]));
}

/**
 * True when an orphaned entry (its original request no longer exists) carries a redacted
 * secret anywhere a resend would replay: the request envelope, a request header value, or the
 * SOAP fault reason. Such an entry must never be resent — the redaction marker itself would go
 * out as the literal credential.
 */
function isRedacted(entry: HistoryEntryWire): boolean {
  return (
    containsRedaction(entry.request.envelopeXml) ||
    entry.request.headers.some((header) => containsRedaction(header.value)) ||
    (entry.fault?.reason !== undefined && containsRedaction(entry.fault.reason))
  );
}
/** Registers SOAP's `history.*` channels (spec §5.4). */
export function registerSoapHistoryChannels(
  table: HandlerTable,
  history: HistoryService,
  deps: HistoryChannelDeps,
): void {
  registerHandler(table, channels.history.resend, (request) => {
    const entry = history.get(request.id);
    if (entry === undefined) {
      throw new WirebenchError('unknown-history-entry', 'This entry is no longer in History.', {
        details: { id: request.id },
      });
    }

    // Only a SOAP send can be replayed here: both paths below build a SOAP send input, so a REST,
    // gRPC or WebSocket entry would go out as a POST of its body wrapped as an envelope — a
    // different request from the one recorded. Refuse it, typed, rather than misfire. (An entry
    // without a kind predates the other protocols and is SOAP.)
    const kind = entry.kind ?? 'soap';
    if (kind !== 'soap') {
      throw new WirebenchError(
        'history-resend-unsupported',
        kind === 'websocket'
          ? 'A WebSocket session is re-sent from its request, not from History.'
          : `This ${kind === 'grpc' ? 'gRPC' : 'REST'} entry can't be re-sent as a SOAP request.`,
        { details: { id: request.id, kind } },
      );
    }

    // Path 1: the original request still exists — replay the LIVE request (current envelope,
    // headers and effective endpoint, its scripts, TLS and auth), exactly like a normal
    // `request.send`. The stored entry was redacted before being written to disk, so it must never
    // be the source of a resend while a live copy is available.
    const { requestId } = entry;
    if (requestId !== undefined && deps.project.projectId(requestId) !== undefined) {
      // No endpoint resolves for it now (an environment that maps none): it goes to the one it went
      // to, still as its project sends it — properties, auth, keychain, WS-Security, proxy, scripts.
      const live = deps.project.endpointFor(requestId) !== undefined;
      if (!live && holdsUrlMarker(entry.endpoint)) {
        refuseRedacted(entry.id, 'URL');
      }
      return sendThroughEngine(sendDepsOf(deps, request.id, kind), randomUUID(), requestId, {
        draft: { kind: 'soap', override: live ? {} : { endpoint: entry.endpoint } },
      });
    }
    // Path 2: the original request is gone. An entry that carries a redacted secret can never
    // be resent — the marker itself would go out as the literal credential — so refuse it.
    if (isRedacted(entry)) {
      throw new WirebenchError(
        'history-resend-redacted',
        "This entry holds values History redacted and the request it was sent from no longer exists, so it can't be re-sent.",
        { details: { id: request.id } },
      );
    }
    const input = {
      endpoint: entry.endpoint,
      envelopeXml: entry.request.envelopeXml,
      soapVersion: entry.soapVersion === 'none' ? ('1.1' as const) : entry.soapVersion,
      ...(entry.soapAction !== undefined ? { soapAction: entry.soapAction } : {}),
      headers: liveHeaders(entry.request.headers),
    };
    // Sent as it was recorded, as a synthetic item, back into the History it came from.
    return sendThroughEngine(sendDepsOf(deps, request.id, kind), randomUUID(), AD_HOC_ID, {
      draft: { kind: 'soap', override: {} },
      adHoc: {
        input,
        names: {
          requestName: entry.requestName,
          interfaceName: entry.interfaceName,
          operationName: entry.operationName,
          projectId: entry.projectId,
        },
        ...(requestId !== undefined ? { requestId } : {}),
      },
    });
  });
}

/**
 * Registers SOAP's channels (spec §5.4): its requests and History resend, and its own modules —
 * definitions, WS-Addressing, WS-Security, WS-I, XML, XPath, validation and attachments.
 */
export function registerSoapChannels(table: HandlerTable, deps: KindChannelDeps): void {
  registerSoapRequestChannels(table, deps.engine, deps.request);
  registerSoapHistoryChannels(table, deps.history, deps.historyDeps);
  registerDefinitionChannels(table, deps.engine, {
    project: deps.router,
    picks: deps.picks,
    projectDirs: deps.projectDirs,
    dialogs: deps.dialogs,
  });
  registerXmlChannels(table, deps.engine);
  registerXpathChannels(table);
  registerValidateChannels(table, deps.engine, deps.router);
  registerWsiChannels(table, deps.engine, {
    project: deps.router,
    picks: deps.picks,
    dialog: { showSave: deps.showSaveHtml },
  });
  registerAttachmentChannels(table, {
    exchanges: deps.engine.exchanges,
    project: deps.router,
    picks: deps.picks,
    userDataDir: deps.userDataDir,
    platform: deps.platform,
  });
  registerWsaChannels(table, { project: deps.router });
  registerWssChannels(table, { project: deps.router });
}
