/**
 * grpc's IPC channels (spec §5.4), registered through its `registerChannels`.
 */
import { grpcItemFor, WirebenchError } from '@wirebench/engine';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { channels, events } from '../../../shared/ipc.js';
import type { GrpcRequestPatchWire, ProtoSourceWire } from '../../../shared/kinds/grpc/wire.js';
import type { ReadPicks } from '../../dialog-picks.js';
import type { EngineService } from '../../engine-service.js';
import type { PreflightResult } from '../../expansion-preflight.js';
import { type HistoryService } from '../../history-service.js';
import { type ApiChannelDeps } from '../../ipc/api.js';
import { emitEvent } from '../../ipc/events.js';
import { grpcResendDraft, sendDepsOf, type HistoryChannelDeps } from '../../ipc/history.js';
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
import { allowsReadPath } from '../../path-access.js';
import type { SecretSourcesSnapshot } from '../../secret-sources-service.js';
import { previewGrpc, sendThroughEngine, type SendThroughEngineDeps } from '../../send/exchange.js';
import type { KindChannelDeps } from '../kind-main.js';

/** What a push on a call that is not open, or never was, is refused with. */
const GRPC_STREAM_UNKNOWN_MESSAGE = 'That call is no longer open for sending.';

/**
 * The dry run of a gRPC call: the target it would go to and what would not expand, resolved as the
 * send resolves it. Nothing is sent and no secret is read, so the editor can show the badge while
 * the user types.
 */
async function preflightGrpc(
  sendDeps: SendThroughEngineDeps,
  secretSources: SecretSourcesSnapshot | undefined,
  request: {
    readonly requestId: string;
    readonly draft?: GrpcRequestPatchWire | undefined;
    readonly secretsOnly?: boolean | undefined;
  },
): Promise<PreflightResult> {
  if (nothingToWarnAbout(request.secretsOnly, secretSources)) {
    return NO_PREFLIGHT;
  }
  const resolved = await previewGrpc(sendDeps, request.requestId, request.draft);
  if (resolved === undefined) {
    return NO_PREFLIGHT;
  }
  return {
    endpoint: resolved.input.target,
    endpointSource: resolved.targetSource === 'api' ? 'interface-default' : resolved.targetSource,
    unresolved: [
      ...preflightUnresolved(resolved.unresolved),
      ...preflightSecretRefs(resolved.secretNames, secretSources),
    ],
    auth: preflightAuth(resolved.auth),
    wsa: { enabled: false },
  };
}
/** Registers gRPC's `request.*` channels (spec §5.4). */
export function registerGrpcRequestChannels(
  table: HandlerTable,
  service: EngineService,
  deps: RequestChannelDeps,
): void {
  const sendDeps = toSendDeps(service, deps);
  // The call as it happens, its request side open for pushes when `interactive`; the `closed` event
  // of a half-close comes from the engine with the rest of the call's events.
  registerHandler(table, channels.request.sendGrpc, (request, sender) =>
    sendThroughEngine(sendDeps, request.sendId, request.requestId, {
      draft: { kind: 'grpc', ...(request.draft !== undefined ? { draft: request.draft } : {}) },
      checkAssertions: true,
      interactive: request.interactive === true,
      onLive: (live) => {
        emitEvent(sender, events.grpc.live, live);
      },
    }),
  );
  registerHandler(table, channels.request.grpcPush, async ({ sendId, messageText }) => {
    const handle = sendDeps.registry.get(sendId);
    if (handle === undefined) {
      throw new WirebenchError('grpc-stream-unknown', GRPC_STREAM_UNKNOWN_MESSAGE, { details: { sendId } });
    }
    return { json: JSON.stringify(await handle.push({ text: messageText }), null, 2) };
  });
  registerHandler(table, channels.request.grpcHalfClose, ({ sendId }) =>
    Promise.resolve({ closed: sendDeps.registry.halfClose(sendId) }),
  );
  registerHandler(table, channels.request.preflightGrpc, (request) =>
    preflightGrpc(sendDeps, deps.secretSources?.(), request),
  );
}

/**
 * The path-access check for a `.proto` source: a folder or each file must be inside an open project
 * or picked this session; text and URLs are not paths and pass as they are.
 *
 * @throws WirebenchError `import-path-refused`
 */
async function checkedProtoSource(
  roots: readonly string[],
  picks: ReadPicks | undefined,
  source: ProtoSourceWire,
): Promise<ProtoSourceWire> {
  const refuse = (path: string): never => {
    throw new WirebenchError(
      'import-path-refused',
      `Wirebench will not read "${path}": use Browse… to pick .proto files outside the project folder`,
      { details: { path } },
    );
  };
  if (source.kind === 'folder') {
    const resolved = resolve(source.path);
    if (!(await allowsReadPath(roots, picks, resolved))) {
      refuse(source.path);
    }
    return { kind: 'folder', path: resolved };
  }
  if (source.kind === 'files') {
    const paths: string[] = [];
    for (const path of source.paths) {
      const resolved = resolve(path);
      if (!(await allowsReadPath(roots, picks, resolved))) {
        refuse(path);
      }
      paths.push(resolved);
    }
    return { kind: 'files', paths };
  }
  return source;
}
/** Registers gRPC's `api.*` channels (spec §5.4). */
export function registerGrpcApiChannels(table: HandlerTable, deps: ApiChannelDeps): void {
  const { router } = deps;
  registerHandler(table, channels.api.importProto, async (request, sender) => {
    const protoImports = deps.protoImports;
    if (protoImports === undefined) {
      throw new WirebenchError('not-supported', 'This build cannot import .proto files');
    }
    // A folder or a file is a read at a renderer-named path: each must be inside an open project or
    // have been picked in a native dialog this session, checked before anything is created.
    const source = await checkedProtoSource(deps.projectDirs(), deps.picks, request.source);
    const run = await protoImports.run(
      {
        source,
        ...(request.token !== undefined ? { token: request.token } : {}),
        ...(request.name !== undefined ? { name: request.name } : {}),
        ...(request.grpcTarget !== undefined ? { target: request.grpcTarget } : {}),
        ...(request.tls !== undefined ? { tls: request.tls } : {}),
      },
      {
        onProgress: (progress) => {
          emitEvent(sender, events.engine.progress, progress);
        },
      },
    );
    const summary = {
      name: run.imported.api.name,
      target: run.imported.api.target,
      ...run.imported.summary,
      roots: [...run.roots],
      kind: run.kind === 'proto' ? ('proto' as const) : ('reflection' as const),
      ...(run.kind === 'reflection' ? { reflectionVersion: run.version } : {}),
    };
    const place = {
      api: run.imported.api,
      roots: run.roots,
      source: run.sourceLabel,
      ...(request.cache !== undefined ? { cache: request.cache } : {}),
      ...(request.source.kind === 'reflection' && request.source.version !== undefined
        ? { requestedVersion: request.source.version }
        : {}),
      ...(run.kind === 'proto'
        ? { kind: 'proto' as const, sources: run.sources }
        : {
            kind: 'reflection' as const,
            descriptors: run.descriptors,
            version: run.version,
            trustInvalid: run.trustInvalid,
          }),
    };
    if ('projectId' in request.target) {
      const added = await router.addGrpcApi(request.target.projectId, place);
      return { ...added, projectId: request.target.projectId, summary };
    }
    const { projectId } = await deps.addProject(request.target.newProjectName);
    try {
      const added = await router.addGrpcApi(projectId, place);
      return { ...added, projectId, summary };
    } catch (error) {
      await deps.removeProject(projectId, { deleteFiles: true }).catch(() => undefined);
      throw error;
    }
  });
  registerHandler(table, channels.api.grpcDefinition, async (request) => {
    const definition = await router.grpcDefinition(request.apiId);
    return {
      services: definition.services.map((service) => ({
        name: service.name,
        fullName: service.fullName,
        package: service.package,
        ...(service.comment !== undefined ? { comment: service.comment } : {}),
        methods: service.methods.map((method) => ({ ...method })),
      })),
      files: definition.files.map((file) => ({ ...file })),
      source: definition.source,
      fetchedAt: definition.fetchedAt,
      roots: [...definition.roots],
      kind: definition.kind,
      ...(definition.reflectionVersion !== undefined ? { reflectionVersion: definition.reflectionVersion } : {}),
    };
  });
  registerHandler(table, channels.api.grpcSample, async (request) => ({
    text: await router.grpcSample(request.apiId, request.type),
  }));
  registerHandler(table, channels.api.grpcFields, async (request) => {
    const descriptor = await router.grpcFields(request.apiId, request.type, request.path);
    if (descriptor === undefined) {
      return { fields: [] };
    }
    return {
      fullName: descriptor.fullName,
      fields: descriptor.fields.map((field) => ({
        name: field.name,
        type: field.type,
        valueKind: field.valueKind,
        repeated: field.repeated,
        ...(field.oneof !== undefined ? { oneof: field.oneof } : {}),
        ...(field.enumValues !== undefined ? { enumValues: [...field.enumValues] } : {}),
        ...(field.comment !== undefined ? { comment: field.comment } : {}),
      })),
    };
  });
  registerHandler(table, channels.api.grpcRefresh, async (request) => {
    const refreshed = await router.grpcRefresh(request.apiId, {
      ...(request.version !== undefined ? { version: request.version } : {}),
    });
    return {
      projectId: refreshed.project.id,
      project: refreshed.project,
      summary: {
        ...refreshed.summary,
        roots: [...(refreshed.project.grpcApis.find((api) => api.id === request.apiId)?.definition?.roots ?? [])],
        kind: 'reflection' as const,
        reflectionVersion: refreshed.version,
      },
      requestsAdded: refreshed.reconciled.requestsAdded.length,
      requestsOrphaned: refreshed.reconciled.requestsOrphaned.length,
      requestsRestored: refreshed.reconciled.requestsRestored.length,
      foldersAdded: refreshed.reconciled.foldersAdded.length,
    };
  });
}

/** Registers gRPC's `history.*` channels (spec §5.4). */
export function registerGrpcHistoryChannels(
  table: HandlerTable,
  history: HistoryService,
  deps: HistoryChannelDeps,
): void {
  registerHandler(table, channels.history.resendGrpc, (request) => {
    const entry = history.get(request.id);
    if (entry === undefined) {
      throw new WirebenchError('unknown-history-entry', 'This entry is no longer in History.', {
        details: { id: request.id },
      });
    }
    const { grpc } = entry;
    if (entry.kind !== 'grpc' || grpc === undefined) {
      throw new WirebenchError(
        'history-resend-unsupported',
        "This entry isn't a gRPC call, so it can't be re-sent as one.",
        { details: { id: request.id, kind: entry.kind ?? 'soap' } },
      );
    }
    // The call goes out through the saved request (its endpoint, metadata, auth and TLS), so an
    // entry whose request is gone has nothing to resend through.
    const { requestId } = entry;
    const send = sendDepsOf(deps, request.id, 'grpc');
    const located = requestId === undefined ? undefined : send.project.runContextFor?.(requestId);
    if (requestId === undefined || located === undefined || grpcItemFor(located.project, requestId) === undefined) {
      throw new WirebenchError(
        'history-resend-orphan',
        "The request this call was sent from no longer exists, so it can't be re-sent.",
        { details: { id: request.id } },
      );
    }
    // No live hook: nothing on screen holds this send id, so its events would be dropped.
    return sendThroughEngine(send, randomUUID(), requestId, {
      draft: { kind: 'grpc', draft: grpcResendDraft({ ...entry, grpc }) },
    });
  });
}

/** Registers gRPC's channels (spec §5.4). */
export function registerGrpcChannels(table: HandlerTable, deps: KindChannelDeps): void {
  registerGrpcRequestChannels(table, deps.engine, deps.request);
  registerGrpcApiChannels(table, deps.api);
  registerGrpcHistoryChannels(table, deps.history, deps.historyDeps);
}
