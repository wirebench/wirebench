/**
 * rest's IPC channels (spec §5.4), registered through its `registerChannels`.
 */
import type { DefinitionAuth, RestOpRef, RestUpdatePlan, WebhookItemRef } from '@wirebench/engine';
import { composeUrl, joinBase, webhookItemsOf, WirebenchError } from '@wirebench/engine';
import { randomUUID } from 'node:crypto';
import { channels, events } from '../../../shared/ipc.js';
import type { HistoryEntryWire } from '../../../shared/wire-types.js';
import type {
  RestRequestPatchWire,
  RestUpdatePlanWire,
  RestUpdateSourceWire,
  WebhookItemWire,
} from '../../../shared/kinds/rest/wire.js';
import type { EndpointSourceWire } from '../../../shared/kinds/soap/wire.js';
import type { OpenApiSourceWire, UnresolvedRefWire } from '../../../shared/wire-base.js';
import type { EngineService } from '../../engine-service.js';
import type { PreflightResult } from '../../expansion-preflight.js';
import { type HistoryService } from '../../history-service.js';
import { fingerprintOf, sourceLabel, toDefinitionAuth, toEngineSource, type ApiChannelDeps } from '../../ipc/api.js';
import { emitEvent } from '../../ipc/events.js';
import { restResendDraft, sendDepsOf, type HistoryChannelDeps, type SavedRest } from '../../ipc/history.js';
import { registerHandler, type HandlerTable } from '../../ipc/register.js';
import {
  NO_PREFLIGHT,
  nothingToWarnAbout,
  preflightAuth,
  preflightSecretRefs,
  preflightUnresolved,
  toSendDeps,
  type RequestChannelDeps,
} from '../../ipc/request.js';
import { checkedImportSource } from '../../path-access.js';
import { toAuthConfigWire } from '../../project-wire.js';
import type { SecretSourcesSnapshot } from '../../secret-sources-service.js';
import {
  previewRest,
  sendThroughEngine,
  type RestPreview,
  type RestUrlSource,
  type SendThroughEngineDeps,
} from '../../send/exchange.js';
import { type WebhookUrlSource } from '../../webhook-send.js';
import type { KindChannelDeps } from '../kind-main.js';
import { restHeaders } from './header-preview.js';
import { registerRestDocsChannels } from './docs-export.js';
import { registerGraphqlApiChannels, registerGraphqlRequestChannels } from '../graphql/ipc.js';

/** True for a base URL the webhook collection supplied: its target, or a callback's own URL. */
function isWebhookUrlSource(source: RestUrlSource): source is WebhookUrlSource {
  return source === 'target' || source === 'callback' || source === 'callback-fallback';
}

/** A REST base URL's source in the endpoint vocabulary the editor's badge reads. */
function endpointSourceOf(source: RestUrlSource): EndpointSourceWire {
  return source === 'api' || isWebhookUrlSource(source) ? 'interface-default' : source;
}

/**
 * The dry run of a REST send: where it would go, what would not expand, and which credentials it
 * would use. It resolves as the send resolves, through the engine, so the two never disagree; nothing
 * is sent and no secret is read — which is what lets the editor show the badge while the user types.
 */
async function preflightRest(
  sendDeps: SendThroughEngineDeps,
  secretSources: SecretSourcesSnapshot | undefined,
  request: {
    readonly requestId: string;
    readonly draft?: RestRequestPatchWire | undefined;
    readonly secretsOnly?: boolean | undefined;
  },
): Promise<PreflightResult> {
  if (nothingToWarnAbout(request.secretsOnly, secretSources)) {
    return NO_PREFLIGHT;
  }
  const resolved = await previewRest(sendDeps, request.requestId, request.draft);
  if (resolved === undefined) {
    return NO_PREFLIGHT;
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
    // the editor reads identically for either protocol. A webhook item's target is its default,
    // and where it actually went is reported in `target`.
    endpointSource: endpointSourceOf(resolved.baseUrlSource),
    unresolved: [
      ...preflightUnresolved(resolved.unresolved),
      ...preflightSecretRefs(resolved.secretNames, secretSources),
      ...missing,
    ],
    auth: preflightAuth(resolved.auth),
    wsa: { enabled: false },
    ...(isWebhookUrlSource(resolved.baseUrlSource)
      ? {
          target: {
            source: resolved.baseUrlSource,
            ...(resolved.targetDetail !== undefined ? { detail: resolved.targetDetail } : {}),
          },
        }
      : {}),
  };
}

/** Registers one editor REST send in `openCalls.rest` until it has recorded its History entry. */
function trackRestSend<T>(
  openCalls: RequestChannelDeps['hostState']['openCalls'],
  requestId: string,
  call: Promise<T>,
): Promise<T> {
  const settled = call.then(
    () => undefined,
    () => undefined,
  );
  openCalls.rest.set(settled, requestId);
  void settled.finally(() => openCalls.rest.delete(settled));
  return call;
}
/** Registers REST's `request.*` channels (spec §5.4). */
export function registerRestRequestChannels(
  table: HandlerTable,
  service: EngineService,
  deps: RequestChannelDeps,
): void {
  const sendDeps = toSendDeps(service, deps);
  // The stream as it happens, alongside the invoke that is still open and will resolve with the
  // whole exchange. A window that has gone away swallows its own events.
  registerHandler(table, channels.request.sendRest, (request, sender) =>
    trackRestSend(
      deps.hostState.openCalls,
      request.requestId,
      sendThroughEngine(sendDeps, request.sendId, request.requestId, {
        draft: { kind: 'rest', ...(request.draft !== undefined ? { draft: request.draft } : {}) },
        checkAssertions: true,
        onLive: (live) => {
          emitEvent(sender, events.rest.live, live);
        },
      }),
    ),
  );
  registerHandler(table, channels.request.preflightRest, (request) =>
    preflightRest(sendDeps, deps.secretSources?.(), request),
  );
  registerHandler(table, channels.request.restHeaders, (request) => restHeaders(deps, sendDeps, request));
  registerHandler(table, channels.request.restBodySchema, async (request) => {
    // The operation is found from what a send would call — the draft laid over the saved request and
    // its properties expanded — the same method and URL the contract check matches after a send, so
    // the form and the check never disagree about the operation.
    const resolved = await previewRest(sendDeps, request.requestId, request.draft);
    const sent =
      resolved === undefined ? undefined : { method: resolved.input.request.method, url: resolved.input.request.url };
    const found = await deps.project.restBodySchema?.(request.requestId, sent);
    // The wire keeps the schema as plain JSON data; the renderer reads it back as a `JsonSchema`.
    return found === undefined ? null : { mediaType: found.mediaType, schema: found.schema as Record<string, unknown> };
  });
  registerGraphqlRequestChannels(table, sendDeps, deps);
}

/** A webhook/callback item onto the wire: the engine's ref, minus the fields the wire has no use for. */
function toWebhookItemWire(item: WebhookItemRef): WebhookItemWire {
  return { key: item.key, kind: item.kind, name: item.name, method: item.method, label: item.label };
}

/** A REST update plan onto the wire: the engine's read-only arrays copied into the schema's own. */
function toRestUpdatePlanWire(plan: RestUpdatePlan, linked: boolean): RestUpdatePlanWire {
  const ref = (op: RestOpRef) => ({
    method: op.method,
    path: op.path,
    ...(op.summary !== undefined ? { summary: op.summary } : {}),
  });
  return {
    added: plan.added.map(ref),
    removed: plan.removed.map(ref),
    changed: plan.changed.map((change) => ({ op: ref(change.op), reasons: [...change.reasons] })),
    api: [...plan.api],
    webhooks: {
      added: plan.webhooks.added.map(toWebhookItemWire),
      removed: plan.webhooks.removed.map(toWebhookItemWire),
      changed: plan.webhooks.changed.map((change) => ({
        item: toWebhookItemWire(change.item),
        reasons: [...change.reasons],
      })),
      linked,
    },
  };
}
/** Registers REST's `api.*` channels (spec §5.4). */
export function registerRestApiChannels(table: HandlerTable, deps: ApiChannelDeps): void {
  const { router } = deps;
  const readRestSource = async (apiId: string, chosen: RestUpdateSourceWire | undefined) => {
    let wire: OpenApiSourceWire;
    let auth: DefinitionAuth | undefined;
    if (chosen !== undefined) {
      if (chosen.kind === 'url') {
        wire = { kind: 'url', url: chosen.url };
        auth = chosen.auth === undefined ? undefined : toDefinitionAuth(chosen.auth);
      } else {
        wire = chosen;
      }
    } else {
      const recorded = router.restSource(apiId);
      if (recorded.source.startsWith('inline:')) {
        throw new WirebenchError(
          'definition-source-unavailable',
          'This API was imported from pasted text, so there is no source to read again',
          { details: { apiId } },
        );
      }
      wire = /^https?:\/\//i.test(recorded.source)
        ? { kind: 'url', url: recorded.source }
        : { kind: 'file', path: recorded.source };
      auth = wire.kind === 'url' ? recorded.auth : undefined;
    }
    const checked = await checkedImportSource(deps.projectDirs(), deps.picks, wire);
    const parsed = await deps.imports.readOpenApi(toEngineSource(checked), auth);
    return { parsed, label: sourceLabel(checked), auth };
  };
  registerGraphqlApiChannels(table, deps);
  registerHandler(table, channels.api.importOpenApi, async (request, sender) => {
    // A `file` source is a read at a renderer-named path, answered before any project is created,
    // so a refusal changes nothing — the same order `project.addInterface` uses.
    const checked = await checkedImportSource(deps.projectDirs(), deps.picks, request.source);
    const auth = request.auth === undefined ? undefined : toDefinitionAuth(request.auth);
    const imported = await deps.imports.run(
      {
        source: toEngineSource(checked),
        ...(auth !== undefined ? { auth } : {}),
        ...(request.token !== undefined ? { token: request.token } : {}),
        ...(request.name !== undefined ? { name: request.name } : {}),
        ...(request.baseUrl !== undefined ? { baseUrl: request.baseUrl } : {}),
        ...(request.securityScheme !== undefined ? { securityScheme: request.securityScheme } : {}),
        ...(request.webhooks !== undefined ? { webhooks: request.webhooks } : {}),
      },
      {
        onProgress: (progress) => {
          emitEvent(sender, events.engine.progress, progress);
        },
      },
    );
    // Full order, no `only`: the mapped folder's requests line up one to one with the document's
    // own webhook/callback list, so a label is pulled from there rather than the plain request name.
    const webhookItems = imported.webhooks !== undefined ? webhookItemsOf(imported.document) : [];
    const webhookGroup =
      imported.webhooks !== undefined
        ? {
            folderId: imported.webhooks.id,
            name: imported.webhooks.name,
            items: imported.webhooks.requests.map((item, index) => ({
              id: item.id,
              label: webhookItems[index]?.label ?? item.name,
            })),
          }
        : undefined;
    const summary = {
      ...imported.summary,
      servers: imported.summary.servers.map((server) => ({ ...server })),
      securitySchemes: imported.summary.securitySchemes.map((scheme) => ({
        name: scheme.name,
        type: scheme.type,
        applied: scheme.applied,
        ...(scheme.description !== undefined ? { description: scheme.description } : {}),
        ...(scheme.reason !== undefined ? { reason: scheme.reason } : {}),
        // Flattened here rather than spread with the rest, so the field carries the wire shape
        // alone: a spread would leave the engine's own union in the type beside it.
        ...(scheme.auth !== undefined ? { auth: toAuthConfigWire(scheme.auth) } : {}),
      })),
      skipped: imported.summary.skipped.map((entry) => ({ ...entry })),
    };
    const place = {
      api: imported.api,
      documents: imported.documents,
      source: sourceLabel(checked),
      declaredVersion: imported.document.declaredVersion,
      ...(auth !== undefined ? { auth } : {}),
      ...(request.cache !== undefined ? { cache: request.cache } : {}),
      ...(imported.webhooks !== undefined ? { webhooks: imported.webhooks } : {}),
    };

    if ('projectId' in request.target) {
      const added = await router.addApi(request.target.projectId, place);
      return {
        ...added,
        projectId: request.target.projectId,
        summary,
        ...(webhookGroup !== undefined ? { webhookGroup } : {}),
      };
    }
    // A `newProjectName` target creates the project only once the document has been read, so a
    // document that cannot be imported never leaves a project behind; if placing it fails anyway,
    // the project goes again and the placement's own error is what the caller hears.
    const { projectId } = await deps.addProject(request.target.newProjectName);
    try {
      const added = await router.addApi(projectId, place);
      return { ...added, projectId, summary, ...(webhookGroup !== undefined ? { webhookGroup } : {}) };
    } catch (error) {
      await deps.removeProject(projectId, { deleteFiles: true }).catch(() => undefined);
      throw error;
    }
  });
  registerHandler(table, channels.api.restPlanUpdate, async (request) => {
    const { parsed, label } = await readRestSource(request.apiId, request.source);
    const { plan, cached, linked } = await router.restPlanUpdate(request.apiId, parsed.document);
    // Both halves of the diff: a cache rewritten since (another update) changes the plan too.
    // The label says what was actually read, so the dialog can name the recorded source it planned
    // against — which the renderer does not otherwise know, having passed no source at all.
    return {
      ...toRestUpdatePlanWire(plan, linked),
      source: label,
      fingerprint: fingerprintOf([...cached, ...parsed.documents]),
    };
  });
  registerHandler(table, channels.api.restApplyUpdate, async (request) => {
    const { parsed, label, auth } = await readRestSource(request.apiId, request.source);
    const { project, plan, linked, applied, warning } = await router.restApplyUpdate(request.apiId, parsed, {
      // A chosen source brings its own credentials, or none: a file, or a URL given without any.
      ...(request.source !== undefined ? { source: label, ...(auth !== undefined ? { auth } : {}) } : {}),
      // The user agreed to the plan they were shown; a source or cache changed since would apply
      // something else.
      check: (cached) => {
        if (fingerprintOf([...cached, ...parsed.documents]) !== request.fingerprint) {
          throw new WirebenchError(
            'definition-changed',
            'The definition changed after the update was planned. Plan the update again to see what it does now.',
            { details: { apiId: request.apiId } },
          );
        }
      },
    });
    return {
      project,
      plan: toRestUpdatePlanWire(plan, linked),
      applied: { ...applied, webhooks: { ...applied.webhooks } },
      ...(warning !== undefined ? { warning } : {}),
    };
  });
  registerHandler(table, channels.api.restLint, async (request) => {
    try {
      const report = await router.restLint(request.apiId);
      return { findings: report.findings.map((finding) => ({ ...finding })) };
    } catch (error) {
      // A rule set that is not valid is the project's problem to fix, so it shows in Problems
      // with the file it is in, rather than as a failed call.
      if (error instanceof WirebenchError && error.code === 'lint-ruleset-invalid') {
        const file = typeof error.details?.['file'] === 'string' ? error.details['file'] : 'lint/';
        return {
          findings: [
            {
              rule: 'lint-ruleset-invalid',
              severity: 'error' as const,
              message: error.message,
              path: '',
              source: file,
            },
          ],
        };
      }
      throw error;
    }
  });
  registerHandler(table, channels.api.webhookItems, async (request) => {
    const { items, imported } = await router.webhookItems(request.apiId);
    return { items: items.map(toWebhookItemWire), imported: [...imported] };
  });
  registerHandler(table, channels.api.importWebhooks, async (request) => {
    const { folderId, added } = await router.importWebhooks(request.apiId, request.keys);
    return { folderId, added };
  });
}

/** The saved request a REST resend goes out through, resolved as its send resolves it. */
function savedRestOf(preview: RestPreview): SavedRest {
  const { signing } = preview.item;
  return {
    request: preview.item.request,
    auth: preview.auth,
    ...(signing?.signing.mode === 'sign' ? { webhookSigning: signing } : {}),
  };
}

/**
 * True when a REST entry was an event stream, or, with no response to say, asked for one with an
 * `Accept` header — the line `log.resend` draws.
 */
function isStreamEntry(entry: HistoryEntryWire): boolean {
  return (
    entry.sse !== undefined ||
    (entry.response === undefined &&
      entry.request.headers.some(
        (header) => header.name.toLowerCase() === 'accept' && header.value.toLowerCase().includes('text/event-stream'),
      ))
  );
}

/**
 * The saved request's resolved origin: the base and path joined as its send resolves them, with a
 * `${secret:…}` token kept as typed. Only a reference left unresolved *in that joined URL itself*
 * makes this `undefined` — a `${secret:…}` (or any other property reference) in a header, the body,
 * or elsewhere on the saved request expands on its own path and must not affect this. Also
 * `undefined` when the joined text doesn't parse as a URL. `restResendDraft` refuses an entry with
 * a response in either case.
 */
function savedOriginOf(saved: Pick<RestPreview, 'input'>): string | undefined {
  const joined = joinBase(saved.input.baseUrl, saved.input.request.url);
  if (joined.includes('${')) {
    return undefined;
  }
  try {
    return new URL(joined).origin;
  } catch {
    return undefined;
  }
}
/** Registers REST's `history.*` channels (spec §5.4). */
export function registerRestHistoryChannels(
  table: HandlerTable,
  history: HistoryService,
  deps: HistoryChannelDeps,
): void {
  registerHandler(table, channels.history.resendRest, async (request) => {
    const entry = history.get(request.id);
    if (entry === undefined) {
      throw new WirebenchError('unknown-history-entry', 'This entry is no longer in History.', {
        details: { id: request.id },
      });
    }
    if (entry.kind !== 'rest') {
      throw new WirebenchError(
        'history-resend-unsupported',
        "This entry isn't a REST request, so it can't be re-sent as one.",
        { details: { id: request.id, kind: entry.kind ?? 'soap' } },
      );
    }
    // A resend has no live pane, so a stream the server never closes would never finish.
    if (isStreamEntry(entry)) {
      throw new WirebenchError('rest-resend-streaming', 'Event streams resend from the editor.', {
        details: { id: request.id },
      });
    }
    // Auth, TLS, proxy and settings come from the saved request, so an entry whose request is gone
    // has nothing to resend through.
    const { requestId } = entry;
    const send = sendDepsOf(deps, request.id, 'rest');
    const saved = requestId === undefined ? undefined : await previewRest(send, requestId, undefined);
    if (requestId === undefined || saved === undefined) {
      throw new WirebenchError(
        'history-resend-orphan',
        "The request this entry was sent from no longer exists, so it can't be re-sent.",
        { details: { id: request.id } },
      );
    }
    return await sendThroughEngine(send, randomUUID(), requestId, {
      draft: { kind: 'rest', draft: restResendDraft(entry, savedRestOf(saved), savedOriginOf(saved)) },
    });
  });
}

/** Registers REST's channels (spec §5.4). */
export function registerRestChannels(table: HandlerTable, deps: KindChannelDeps): void {
  registerRestRequestChannels(table, deps.engine, deps.request);
  registerRestApiChannels(table, deps.api);
  registerRestDocsChannels(table, { router: deps.router, picks: deps.picks, dialogs: deps.dialogs });
  registerRestHistoryChannels(table, deps.history, deps.historyDeps);
}
