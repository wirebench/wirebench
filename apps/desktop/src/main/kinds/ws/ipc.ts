/**
 * websocket's IPC channels (spec §5.4), registered through its `registerChannels`.
 */
import type { AsyncApiOpRef, AsyncApiUpdatePlan, WsFrame } from '@wirebench/engine';
import { resolveWsUrl, WirebenchError } from '@wirebench/engine';
import { channels, events } from '../../../shared/ipc.js';
import type { AsyncApiUpdatePlanWire, WsExchangeSummary, WsRequestPatchWire } from '../../../shared/kinds/ws/wire.js';
import type { OpenApiSourceWire } from '../../../shared/wire-base.js';
import type { EngineService } from '../../engine-service.js';
import { toWsFrameWire } from '../../engine-wire.js';
import type { PreflightResult } from '../../expansion-preflight.js';
import { type ApiChannelDeps, fingerprintOf, sourceLabel, toDefinitionAuth, toEngineSource } from '../../ipc/api.js';
import { emitEvent } from '../../ipc/events.js';
import { registerHandler, type HandlerTable } from '../../ipc/register.js';
import {
  NO_PREFLIGHT,
  nothingToWarnAbout,
  openWsCalls,
  preflightAuth,
  preflightSecretRefs,
  preflightUnresolved,
  type RequestChannelDeps,
  toSendDeps,
} from '../../ipc/request.js';
import { checkedImportSource } from '../../path-access.js';
import type { SecretSourcesSnapshot } from '../../secret-sources-service.js';
import { previewWs, sendThroughEngine, type SendThroughEngineDeps } from '../../send/exchange.js';
import type { KindChannelDeps } from '../kind-main.js';

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

/** `true` when `text` is strictly valid base64 (including the empty string). */
function isValidBase64(text: string): boolean {
  return text.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(text);
}

/**
 * The dry run of opening a WebSocket session: where it would go and what would not expand, resolved
 * as the open resolves it. Nothing is dialled and no secret is read, so the editor can show the badge
 * while the user types.
 */
async function preflightWs(
  sendDeps: SendThroughEngineDeps,
  secretSources: SecretSourcesSnapshot | undefined,
  request: {
    readonly requestId: string;
    readonly draft?: WsRequestPatchWire | undefined;
    readonly secretsOnly?: boolean | undefined;
  },
): Promise<PreflightResult> {
  if (nothingToWarnAbout(request.secretsOnly, secretSources)) {
    return NO_PREFLIGHT;
  }
  const resolved = await previewWs(sendDeps, request.requestId, request.draft);
  if (resolved === undefined) {
    return NO_PREFLIGHT;
  }
  return {
    endpoint: wsDisplayUrl(resolved.input),
    endpointSource: resolved.urlSource === 'api' ? 'interface-default' : resolved.urlSource,
    unresolved: [
      ...preflightUnresolved(resolved.unresolved),
      ...preflightSecretRefs(resolved.secretNames, secretSources),
    ],
    auth: preflightAuth(resolved.auth),
    wsa: { enabled: false },
  };
}
/** Registers WebSocket's `request.*` channels (spec §5.4). */
export function registerWsRequestChannels(table: HandlerTable, service: EngineService, deps: RequestChannelDeps): void {
  const sendDeps = toSendDeps(service, deps);
  // The session as it happens: the invoke stays pending until it closes, while `ws.live` reports the
  // handshake, each frame and each frame's contract check. Its request side takes pushes and a close.
  // A reused `sendId` never replaces a session in flight, which nothing could reach again: the
  // registry refuses it with `ws-session-exists` from the moment the first open begins.
  registerHandler(table, channels.request.openWs, async (request, sender) => {
    return await trackOpenWs(
      request.requestId,
      sendThroughEngine(sendDeps, request.sendId, request.requestId, {
        draft: { kind: 'websocket', ...(request.draft !== undefined ? { draft: request.draft } : {}) },
        interactive: true,
        checkAssertions: true,
        onLive: (live) => {
          emitEvent(sender, events.ws.live, live);
        },
      }),
    );
  });
  // Pushed in the order the renderer sent them: a text waiting on the keychain holds back the next.
  registerHandler(table, channels.request.wsSend, async (request) => {
    const handle = sendDeps.registry.get(request.sendId, 'websocket');
    if (handle === undefined) {
      throw new WirebenchError('ws-session-unknown', 'That connection is no longer open.', {
        details: { sendId: request.sendId },
      });
    }
    // The engine sends what `Buffer.from` salvages of a bad base64: refused here, before the push.
    if (request.format === 'binary' && !isValidBase64(request.content)) {
      throw new WirebenchError('ws-bad-binary', 'The message is not valid base64.', {
        details: { sendId: request.sendId },
      });
    }
    // An expanded text reads the properties as they are now, an environment switched since the open
    // included; its escaping follows the request as the session opened it.
    const frame = await handle.push(
      request.format === 'binary'
        ? { base64: request.content }
        : request.expand
          ? { text: request.content, expand: true, scopes: deps.project.scopesFor(request.requestId) }
          : { text: request.content },
    );
    return toWsFrameWire(frame as WsFrame, { show: deps.showSecrets?.get() ?? false });
  });
  registerHandler(table, channels.request.wsClose, (request) =>
    Promise.resolve({ closed: sendDeps.registry.closeWs(request.sendId, request.code, request.reason) }),
  );
  registerHandler(table, channels.request.preflightWs, (request) =>
    preflightWs(sendDeps, deps.secretSources?.(), request),
  );
}

/** An update plan onto the wire: the engine's read-only arrays copied into the schema's own. */
function toAsyncApiUpdatePlanWire(plan: AsyncApiUpdatePlan): AsyncApiUpdatePlanWire {
  const ref = (op: AsyncApiOpRef) => ({ key: op.key, channel: op.channel, direction: op.direction });
  return {
    added: plan.added.map(ref),
    removed: plan.removed.map(ref),
    changed: plan.changed.map((change) => ({ op: ref(change.op), reasons: [...change.reasons] })),
  };
}
/** Registers WebSocket's `api.*` channels (spec §5.4). */
export function registerWsApiChannels(table: HandlerTable, deps: ApiChannelDeps): void {
  const { router } = deps;
  const readAsyncApiSource = async (apiId: string) => {
    const asyncApiImports = deps.asyncApiImports;
    if (asyncApiImports === undefined) {
      throw new WirebenchError('not-supported', 'This build cannot import AsyncAPI documents');
    }
    const { source: recorded, auth } = router.asyncApiSource(apiId);
    if (recorded.startsWith('inline:')) {
      throw new WirebenchError(
        'definition-source-unavailable',
        'This API was imported from pasted text, so there is no source to read again',
        {
          details: { apiId },
        },
      );
    }
    const wire: OpenApiSourceWire = /^https?:\/\//i.test(recorded)
      ? { kind: 'url', url: recorded }
      : { kind: 'file', path: recorded };
    const checked = await checkedImportSource(deps.projectDirs(), deps.picks, wire);
    // The credentials it was imported with, without asking again; a file is read without any.
    return asyncApiImports.readAsyncApi(toEngineSource(checked), checked.kind === 'url' ? auth : undefined);
  };
  registerHandler(table, channels.api.importAsyncApi, async (request, sender) => {
    const asyncApiImports = deps.asyncApiImports;
    if (asyncApiImports === undefined) {
      throw new WirebenchError('not-supported', 'This build cannot import AsyncAPI documents');
    }
    // Checked before anything is read or created, as `api.importOpenApi` does.
    const checked = await checkedImportSource(deps.projectDirs(), deps.picks, request.source);
    const auth = request.auth === undefined ? undefined : toDefinitionAuth(request.auth);
    const imported = await asyncApiImports.runAsyncApi(
      {
        source: toEngineSource(checked),
        ...(auth !== undefined ? { auth } : {}),
        ...(request.token !== undefined ? { token: request.token } : {}),
        ...(request.server !== undefined ? { server: request.server } : {}),
      },
      {
        onProgress: (progress) => {
          emitEvent(sender, events.engine.progress, progress);
        },
      },
    );
    const api =
      request.name !== undefined && request.name.trim() !== '' ? { ...imported.api, name: request.name } : imported.api;
    const summary = {
      name: api.name,
      title: imported.summary.title,
      declaredVersion: imported.summary.declaredVersion,
      ...(imported.summary.server !== undefined ? { server: imported.summary.server } : {}),
      servers: [...imported.summary.servers],
      requests: imported.summary.requests,
      messages: imported.summary.messages,
      skipped: imported.summary.skipped.map((entry) => ({ where: entry.where, reason: entry.reason })),
      unresolved: [...imported.summary.unresolved],
      unsupportedKeywords: [...imported.summary.unsupportedKeywords],
    };
    const place = {
      api,
      documents: imported.documents,
      source: checked.kind === 'text' ? (checked.location ?? 'inline:asyncapi') : sourceLabel(checked),
      declaredVersion: imported.declaredVersion,
      ...(imported.summary.server !== undefined ? { server: imported.summary.server } : {}),
      ...(auth !== undefined ? { auth } : {}),
      ...(request.cache !== undefined ? { cache: request.cache } : {}),
    };

    if ('projectId' in request.target) {
      const added = await router.importAsyncApi(request.target.projectId, place);
      return { ...added, projectId: request.target.projectId, summary };
    }
    // As for OpenAPI: the project is created only once the document has been read and mapped, and
    // is taken back if placing the API fails.
    const { projectId } = await deps.addProject(request.target.newProjectName);
    try {
      const added = await router.importAsyncApi(projectId, place);
      return { ...added, projectId, summary };
    } catch (error) {
      await deps.removeProject(projectId, { deleteFiles: true }).catch(() => undefined);
      throw error;
    }
  });
  registerHandler(table, channels.api.asyncApiServers, async (request) => {
    const asyncApiImports = deps.asyncApiImports;
    if (asyncApiImports === undefined) {
      throw new WirebenchError('not-supported', 'This build cannot import AsyncAPI documents');
    }
    // The same path check an import makes: a preview must not read what an import could not.
    const checked = await checkedImportSource(deps.projectDirs(), deps.picks, request.source);
    // The picker reads the same document the import will, so it needs the same credentials.
    const auth = request.auth === undefined ? undefined : toDefinitionAuth(request.auth);
    const { document } = await asyncApiImports.readAsyncApi(toEngineSource(checked), auth);
    return {
      servers: document.servers
        .filter((server) => ['ws', 'wss'].includes(server.protocol.toLowerCase()))
        .map((server) => ({ key: server.key, url: server.url })),
    };
  });
  registerHandler(table, channels.api.asyncApiPlanUpdate, async (request) => {
    const next = await readAsyncApiSource(request.apiId);
    const plan = toAsyncApiUpdatePlanWire(await router.asyncApiPlanUpdate(request.apiId, next.document));
    return { ...plan, fingerprint: fingerprintOf(next.documents) };
  });
  registerHandler(table, channels.api.asyncApiApplyUpdate, async (request) => {
    const next = await readAsyncApiSource(request.apiId);
    // The user agreed to the plan they were shown; a source edited since would apply something else.
    if (fingerprintOf(next.documents) !== request.fingerprint) {
      throw new WirebenchError(
        'definition-changed',
        'The definition changed after the update was planned. Plan the update again to see what it does now.',
        { details: { apiId: request.apiId } },
      );
    }
    const { project, plan, applied } = await router.asyncApiApplyUpdate(request.apiId, next);
    return {
      project,
      plan: toAsyncApiUpdatePlanWire(plan),
      applied: {
        requestsAdded: [...applied.requestsAdded],
        requestsOrphaned: [...applied.requestsOrphaned],
        requestsRestored: [...applied.requestsRestored],
        requestsRewritten: [...applied.requestsRewritten],
        messagesReplaced: [...applied.messagesReplaced],
        messagesAdded: [...applied.messagesAdded],
      },
    };
  });
}

/** Registers WebSocket's channels (spec §5.4). */
export function registerWsChannels(table: HandlerTable, deps: KindChannelDeps): void {
  registerWsRequestChannels(table, deps.engine, deps.request);
  registerWsApiChannels(table, deps.api);
}
